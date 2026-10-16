'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { classifyNarrativeDraftRetention, type NarrativeDraft } from '@mahoshojo/domain/narrative-drafts';

export type NarrativeDraftStatus = 'idle' | 'available' | 'stored' | 'memory-only';
export type NarrativeDraftActionResult = Readonly<{ ok: true } | { ok: false; error?: string }>;
export type NarrativeDraftDeleteResult = NarrativeDraftActionResult;
export type NarrativeDraftsPanelProps = Readonly<{
  drafts: readonly NarrativeDraft[];
  candidate?: NarrativeDraft | null;
  status: NarrativeDraftStatus;
  onSave?: () => void;
  onExport: (drafts: readonly NarrativeDraft[]) => void;
  onDelete?: (ids: readonly string[]) => NarrativeDraftDeleteResult | Promise<NarrativeDraftDeleteResult>;
  confirmAction?: (message: string) => boolean | Promise<boolean>;
  onCopy?: (markdown: string) => void | Promise<void>;
  renderMarkdown?: (markdown: string) => ReactNode;
  renderLegacyAction?: () => ReactNode;
  autoRetain?: boolean;
  onAutoRetainChange?: (value: boolean) => NarrativeDraftActionResult | Promise<NarrativeDraftActionResult>;
  unsavedRequestIds?: readonly string[];
  unsavedDrafts?: readonly NarrativeDraft[];
  conflictingDrafts?: readonly NarrativeDraft[];
  onRetryUnsaved?: () => NarrativeDraftActionResult | Promise<NarrativeDraftActionResult>;
  /** Hosts must also fence writes by account/owner; this key cancels stale UI work. */
  scopeKey?: string;
}>;

const completionLabel: Record<NarrativeDraft['completion']['kind'], string> = {
  'server-failed': '服务端生成失败',
  'trusted-length': '达到输出长度上限',
  'trusted-stop-metadata-invalid': '模型已正常结束，但元数据无效',
  'missing-terminal': '未收到结束信号',
  'unconfirmed': '完成状态未确认',
};
const buttonClass = 'rounded border border-gray-300 px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50';

// Confirmation compares visible content, not whether it fits a persistent archive.
export function isSameNarrativeDraftVersion(left: NarrativeDraft, right: NarrativeDraft): boolean {
  return left.requestId === right.requestId && left.title === right.title && left.createdAt === right.createdAt
    && left.source === right.source && left.markdown === right.markdown && left.completion.kind === right.completion.kind
    && (left.completion.kind !== 'server-failed' || right.completion.kind === 'server-failed' && left.completion.code === right.completion.code);
}

export function haveSameNarrativeDraftVersions(left: readonly NarrativeDraft[], right: readonly NarrativeDraft[]): boolean {
  if (left.length !== right.length) return false;
  const byId = new Map<string, NarrativeDraft[]>();
  for (const draft of right) {
    const versions = byId.get(draft.requestId);
    if (versions) versions.push(draft); else byId.set(draft.requestId, [draft]);
  }
  return left.every(draft => {
    const versions = byId.get(draft.requestId);
    const index = versions?.findIndex(current => isSameNarrativeDraftVersion(draft, current)) ?? -1;
    if (!versions || index < 0) return false;
    versions.splice(index, 1);
    return true;
  });
}

function formatLocalTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

/** Hosts own storage, confirmation, clipboard and export. Drafts never become prompt history here. */
export function NarrativeDraftsPanel(props: NarrativeDraftsPanelProps) {
  return <ScopedNarrativeDraftsPanel key={props.scopeKey} {...props} />;
}

function ScopedNarrativeDraftsPanel({ drafts, candidate: suppliedCandidate, status, onSave, onExport, onDelete,
  confirmAction, onCopy, renderMarkdown, renderLegacyAction, autoRetain = false, onAutoRetainChange,
  unsavedRequestIds = [], unsavedDrafts = [], conflictingDrafts = [], onRetryUnsaved }: NarrativeDraftsPanelProps) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [operation, setOperation] = useState<'delete' | 'copy' | 'preference' | 'retry' | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const persistedConflicts: NarrativeDraft[] = [];
  for (const draft of conflictingDrafts) {
    if (!persistedConflicts.some(current => isSameNarrativeDraftVersion(draft, current))) persistedConflicts.push(draft);
  }
  const matchesPersistedConflict = (draft: NarrativeDraft) => persistedConflicts.some(current => isSameNarrativeDraftVersion(draft, current));
  const persistedConflictIds = new Set(persistedConflicts.map(draft => draft.requestId));
  const candidate = suppliedCandidate && !matchesPersistedConflict(suppliedCandidate) ? suppliedCandidate : null;
  const ordinaryDrafts = drafts.filter(draft => !matchesPersistedConflict(draft));
  const existing = candidate ? ordinaryDrafts.find(draft => draft.requestId === candidate.requestId) : null;
  const conflict = Boolean(candidate && existing && !isSameNarrativeDraftVersion(existing, candidate));
  const items = candidate && !existing ? [...ordinaryDrafts, candidate] : ordinaryDrafts;
  // Never choose a canonical version for a persisted conflict through bulk export.
  const bulkExportItems = items.filter(draft => !persistedConflictIds.has(draft.requestId));
  const displayedVersions = [...items, ...(conflict && candidate ? [candidate] : []), ...persistedConflicts];
  const unpersistedDrafts = unsavedDrafts.filter(draft => !matchesPersistedConflict(draft));
  const extraUnsaved: NarrativeDraft[] = [];
  for (const draft of unpersistedDrafts) {
    if (!displayedVersions.some(current => isSameNarrativeDraftVersion(draft, current))) {
      extraUnsaved.push(draft); displayedVersions.push(draft);
    }
  }
  const versionCounts = new Map<string, number>();
  for (const draft of displayedVersions) versionCounts.set(draft.requestId, (versionCounts.get(draft.requestId) ?? 0) + 1);
  const ids = [...versionCounts.keys()];
  const conflictingIds = new Set([...versionCounts].filter(([, count]) => count > 1).map(([id]) => id));
  const selectedIds = selected.filter(id => ids.includes(id));
  const canDelete = Boolean(onDelete && confirmAction);
  const blocked = operation !== null;
  const unpersistedIds = new Set(unpersistedDrafts.map(draft => draft.requestId));
  const unsavedIds = new Set([...unsavedRequestIds.filter(id => !unsavedDrafts.some(draft => draft.requestId === id)
    || unpersistedIds.has(id) || candidate?.requestId === id), ...unpersistedIds]);
  const candidateRetention = candidate ? classifyNarrativeDraftRetention(candidate) : null;
  // Keep the displayed versions as well as their IDs stable across an asynchronous confirmation.
  const visible = useRef(displayedVersions);
  visible.current = displayedVersions;
  useEffect(() => {
    const currentIds = new Set(drafts.map(draft => draft.requestId));
    if (suppliedCandidate) currentIds.add(suppliedCandidate.requestId);
    for (const draft of unsavedDrafts) currentIds.add(draft.requestId);
    for (const draft of conflictingDrafts) currentIds.add(draft.requestId);
    setSelected(current => current.every(id => currentIds.has(id)) ? current : current.filter(id => currentIds.has(id)));
  }, [drafts, suppliedCandidate, unsavedDrafts, conflictingDrafts]);

  const deleteDrafts = async (requestedIds: readonly string[], kind: 'single' | 'selected' | 'all') => {
    if (pending.current || !onDelete || !confirmAction || requestedIds.length === 0) return;
    const snapshot = [...new Set(requestedIds)];
    const versions = displayedVersions.filter(draft => snapshot.includes(draft.requestId));
    const description = kind === 'all' ? `清空当前可见的 ${snapshot.length} 条未完成叙事草稿`
      : kind === 'selected' ? `删除选中的 ${snapshot.length} 条未完成叙事草稿` : '删除此未完成叙事草稿';
    const conflictWarning = snapshot.some(id => conflictingIds.has(id)) ? '\n其中有同编号的不同版本，该编号的全部已保存及未落盘版本都会删除，请先分别导出。' : '';
    pending.current = true;
    setOperation('delete'); setFeedback(null);
    try {
      const confirmed = await confirmAction(`${description}？删除后无法恢复，建议先导出。\n草稿与正式叙事历史独立，此操作不会清除正式历史。${conflictWarning}`);
      if (!mounted.current || !confirmed) return;
      const currentVersions = visible.current.filter(draft => snapshot.includes(draft.requestId));
      if (!haveSameNarrativeDraftVersions(versions, currentVersions)) {
        setFeedback({ error: true, text: '待删除草稿已变化，请核对后重试' });
        return;
      }
      const result = await onDelete(snapshot);
      if (!mounted.current) return;
      if (result.ok) {
        setSelected(current => current.filter(id => !snapshot.includes(id)));
        setFeedback({ error: false, text: '草稿已删除' });
      } else {
        setFeedback({ error: true, text: result.error || '删除失败，请重试' });
      }
    } catch {
      if (mounted.current) setFeedback({ error: true, text: '删除失败，请重试' });
    } finally {
      pending.current = false;
      if (mounted.current) setOperation(null);
    }
  };

  const copyDraft = async (draft: NarrativeDraft) => {
    if (pending.current || !onCopy) return;
    pending.current = true;
    setOperation('copy'); setFeedback(null);
    try {
      await onCopy(draft.markdown);
      if (mounted.current) setFeedback({ error: false, text: '草稿正文已复制' });
    } catch {
      if (mounted.current) setFeedback({ error: true, text: '复制失败，请重试或导出草稿' });
    } finally {
      pending.current = false;
      if (mounted.current) setOperation(null);
    }
  };

  const changeAutoRetain = async (value: boolean) => {
    if (pending.current || !onAutoRetainChange) return;
    pending.current = true;
    setOperation('preference'); setFeedback(null);
    try {
      const result = await onAutoRetainChange(value);
      if (mounted.current) setFeedback(result.ok
        ? { error: false, text: value ? '已开启自动保留未完成草稿' : '已关闭自动保留未完成草稿，已有草稿仍保留' }
        : { error: true, text: result.error || '设置保存失败，请重试' });
    } catch {
      if (mounted.current) setFeedback({ error: true, text: '设置保存失败，请重试' });
    } finally {
      pending.current = false;
      if (mounted.current) setOperation(null);
    }
  };

  const retryUnsaved = async () => {
    if (pending.current || !onRetryUnsaved || unsavedIds.size === 0) return;
    pending.current = true;
    setOperation('retry'); setFeedback(null);
    try {
      const result = await onRetryUnsaved();
      if (mounted.current) setFeedback(result.ok
        ? { error: false, text: '已重试保存未落盘草稿' }
        : { error: true, text: result.error || '草稿保存失败，请重试或导出' });
    } catch {
      if (mounted.current) setFeedback({ error: true, text: '草稿保存失败，请重试或导出' });
    } finally {
      pending.current = false;
      if (mounted.current) setOperation(null);
    }
  };

  const renderActions = (draft: NarrativeDraft, version?: 'candidate' | 'unsaved' | 'persisted-conflict') => <div className="mt-2 flex flex-wrap gap-2">
    {onCopy && <button type="button" className={buttonClass} disabled={blocked} onClick={() => void copyDraft(draft)}>复制正文</button>}
    <button type="button" className={buttonClass} onClick={() => onExport([draft])}>{version === 'candidate' ? '导出当前未保存草稿' : version === 'unsaved' ? '导出未落盘版本' : version === 'persisted-conflict' ? '导出此冲突版本' : '导出此草稿'}</button>
    {canDelete && <button type="button" className={buttonClass} disabled={blocked}
      onClick={() => void deleteDrafts([draft.requestId], 'single')}>{conflictingIds.has(draft.requestId) ? '删除草稿及冲突版本' : '删除此草稿'}</button>}
  </div>;

  return <section aria-label="未完成叙事草稿" aria-busy={blocked} className="my-3 space-y-2 rounded-lg border border-gray-200 p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="font-semibold">未完成叙事草稿 · {ids.length} 条{displayedVersions.length > ids.length ? `（另有 ${displayedVersions.length - ids.length} 份冲突版本）` : ''}</div>
      {renderLegacyAction?.()}
    </div>
    <p className="text-xs text-gray-600">草稿与正式叙事历史独立，不会用于前情、角色状态、历战或排名；正式历史为 0 条也可清空草稿。</p>
    {onAutoRetainChange && <div className="space-y-1">
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={autoRetain} disabled={blocked}
        onChange={event => void changeAutoRetain(event.target.checked)} />自动保留未完成草稿（仅本机）</label>
      <p className="text-xs text-gray-500">与“战报后写入正式历史”独立；疑似错误或拒绝回复等内容仍需核对后手动保存。</p>
    </div>}
    {unsavedIds.size > 0 && <p className="text-xs text-red-700" role="alert">有 {unsavedIds.size} 条草稿尚未保存到本机，离开前请重试或导出</p>}
    {persistedConflicts.length > 0 && <p className="text-xs text-red-700" role="alert">存在同编号的已保存冲突版本，请分别导出核对；删除该编号会移除全部版本。</p>}
    {status === 'stored' && unsavedIds.size === 0 && <p className="text-xs text-gray-600" role="status">草稿已保存到本机</p>}
    {status === 'available' && (candidate || unsavedIds.size > 0 || persistedConflicts.length === 0) && <p className="text-xs text-gray-600" role="status">有未保存草稿，可核对后保存或导出</p>}
    {candidate && status !== 'stored' && candidateRetention?.mode === 'explicit-only' && <p className="text-xs text-gray-600">
      {candidateRetention.reason === 'suspected-non-narrative' ? '内容可能是错误或拒绝回复，请核对后手动保留' : '完成状态尚未确认，请核对正文后再保存'}
    </p>}
    {status === 'memory-only' && (candidate || unsavedIds.size > 0 || persistedConflicts.length === 0) && <p className="text-xs text-red-700" role="alert">本机保存失败或存在冲突；当前草稿仅保留在内存，请导出后再离开</p>}
    <div className="flex flex-wrap items-center gap-2">
      {unsavedIds.size > 0 && onRetryUnsaved && <button type="button" className={buttonClass} disabled={blocked} onClick={() => void retryUnsaved()}>重试保存未落盘草稿</button>}
      {candidate && status !== 'stored' && onSave && <button type="button" className={buttonClass} disabled={blocked} onClick={onSave}>保存未完成草稿</button>}
      {bulkExportItems.length > 0 && <button type="button" className={buttonClass} onClick={() => onExport(bulkExportItems)}>导出未完成草稿</button>}
      {canDelete && ids.length > 0 && <>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" disabled={blocked} checked={selectedIds.length === ids.length}
          onChange={event => setSelected(event.target.checked ? ids : [])} />全选</label>
        <button type="button" className={buttonClass} disabled={blocked || selectedIds.length === 0}
          onClick={() => void deleteDrafts(selectedIds, 'selected')}>删除所选（{selectedIds.length}）</button>
        <button type="button" className={buttonClass} disabled={blocked} onClick={() => void deleteDrafts(ids, 'all')}>清空当前草稿</button>
      </>}
    </div>
    {feedback && <p role={feedback.error ? 'alert' : 'status'} className={`text-xs ${feedback.error ? 'text-red-700' : 'text-gray-600'}`}>{feedback.text}</p>}
    {conflict && candidate && <details className="rounded border border-gray-200 p-2">
      <summary className="cursor-pointer break-words">{candidate.title} · 当前未保存草稿（与列表内容冲突）</summary>
      <p className="mt-1 text-xs text-gray-600">同一编号保留了不同内容，请分别查看、复制或导出；删除此编号会同时删除全部版本。</p>
      <div className="mt-2 whitespace-pre-wrap break-words">{renderMarkdown ? renderMarkdown(candidate.markdown) : candidate.markdown}</div>
      {renderActions(candidate, 'candidate')}
    </details>}
    {extraUnsaved.map((draft, index) => <details key={`${draft.requestId}:${index}`} className="rounded border border-gray-200 p-2">
      <summary className="cursor-pointer break-words">{draft.title} · 未落盘版本</summary>
      <p className="mt-1 text-xs text-red-700">此版本仅保留在内存，离开前请单独导出；同编号删除会移除全部版本。</p>
      <div className="mt-2 whitespace-pre-wrap break-words">{renderMarkdown ? renderMarkdown(draft.markdown) : draft.markdown}</div>
      {renderActions(draft, 'unsaved')}
    </details>)}
    {persistedConflicts.map((draft, index) => <div key={`persisted:${draft.requestId}:${index}`} className="flex items-start gap-2 rounded border border-gray-200 p-2">
      {canDelete && <input type="checkbox" className="mt-1" aria-label={`选择已保存冲突草稿：${draft.title}（同编号全部版本）`} disabled={blocked}
        checked={selectedIds.includes(draft.requestId)} onChange={event => setSelected(current => event.target.checked
          ? [...new Set([...current, draft.requestId])] : current.filter(id => id !== draft.requestId))} />}
      <details className="min-w-0 flex-1">
        <summary className="cursor-pointer break-words">{draft.title} · 已保存的冲突版本 {index + 1}</summary>
        <p className="mt-1 text-xs text-gray-600">此版本已保存在本机，请与同编号其他版本分别导出核对；删除该编号会移除全部版本。</p>
        <div className="mt-2 whitespace-pre-wrap break-words">{renderMarkdown ? renderMarkdown(draft.markdown) : draft.markdown}</div>
        {renderActions(draft, 'persisted-conflict')}
      </details>
    </div>)}
    {items.map(draft => <div key={draft.requestId} className="flex items-start gap-2 rounded border border-gray-200 p-2">
      {canDelete && <input type="checkbox" className="mt-1" aria-label={`选择草稿：${draft.title}`} disabled={blocked}
        checked={selectedIds.includes(draft.requestId)} onChange={event => setSelected(current => event.target.checked
          ? [...current, draft.requestId] : current.filter(id => id !== draft.requestId))} />}
      <details className="min-w-0 flex-1">
        <summary className="cursor-pointer break-words">
          {draft.title}
          {unsavedIds.has(draft.requestId) && <span className="ml-2 text-xs text-red-700">{conflictingIds.has(draft.requestId) ? '含未落盘版本' : '未保存到本机'}</span>}
          <span className="ml-2 text-xs text-gray-500">{completionLabel[draft.completion.kind]} · <time dateTime={draft.createdAt} title={draft.createdAt}>{formatLocalTime(draft.createdAt)}</time></span>
        </summary>
        <div className="mt-2 whitespace-pre-wrap break-words">{renderMarkdown ? renderMarkdown(draft.markdown) : draft.markdown}</div>
        {renderActions(draft)}
      </details>
    </div>)}
    {ids.length === 0 && <p className="text-xs text-gray-500">暂无未完成叙事草稿</p>}
  </section>;
}
