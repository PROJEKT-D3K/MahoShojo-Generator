'use client';

import type { ReactNode } from 'react';
import { mergeNarrativeDrafts, type NarrativeDraft } from '@mahoshojo/domain/narrative-drafts';

export type NarrativeDraftStatus = 'idle' | 'available' | 'stored' | 'memory-only';
export type NarrativeDraftsPanelProps = Readonly<{
  drafts: readonly NarrativeDraft[];
  candidate?: NarrativeDraft | null;
  status: NarrativeDraftStatus;
  onSave?: () => void;
  onExport: (drafts: readonly NarrativeDraft[]) => void;
  renderMarkdown?: (markdown: string) => ReactNode;
}>;

const completionLabel: Record<NarrativeDraft['completion']['kind'], string> = {
  'server-failed': '服务端生成失败',
  'trusted-length': '达到输出长度上限',
  'trusted-stop-metadata-invalid': '模型已正常结束，但元数据无效',
  'missing-terminal': '未收到结束信号',
  'unconfirmed': '完成状态未确认',
};

/** Read-only archive: hosts own persistence and export. Drafts never become prompt history here. */
export function NarrativeDraftsPanel({ drafts, candidate, status, onSave, onExport, renderMarkdown }: NarrativeDraftsPanelProps) {
  const existing = candidate ? drafts.find(draft => draft.requestId === candidate.requestId) : null;
  const conflict = candidate && existing && !mergeNarrativeDrafts([existing], [candidate]).ok;
  const items = candidate && !existing
    ? [...drafts, candidate] : drafts;
  return <section aria-label="未完成叙事草稿" className="my-3 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
    <div className="font-semibold">未完成叙事草稿 · {items.length} 条</div>
    <p className="text-xs text-gray-600">仅供查看与导出，不会用于前情、角色状态、历战或排名。</p>
    {status === 'stored' && <p role="status">草稿已保存到本机</p>}
    {status === 'available' && <p role="status">有未保存草稿，可显式保存或导出</p>}
    {status === 'memory-only' && <p role="alert">本机保存失败或存在冲突；当前草稿仅保留在内存，请导出后再离开</p>}
    {candidate && status !== 'stored' && onSave && <button type="button" className="rounded border px-2 py-1" onClick={onSave}>保存未完成草稿</button>}
    {items.length > 0 && <button type="button" className="ml-2 rounded border px-2 py-1" onClick={() => onExport(items)}>导出未完成草稿</button>}
    {conflict && candidate && <details className="rounded border border-amber-300 p-2">
      <summary>{candidate.title} · 当前未保存草稿（与归档内容冲突）</summary>
      <div className="mt-2 whitespace-pre-wrap break-words">{renderMarkdown ? renderMarkdown(candidate.markdown) : candidate.markdown}</div>
      <button type="button" className="mt-2 rounded border px-2 py-1" onClick={() => onExport([candidate])}>导出当前未保存草稿</button>
    </details>}
    {items.map(draft => <details key={draft.requestId} className="rounded border border-amber-100 p-2">
      <summary>{draft.title} · {completionLabel[draft.completion.kind]} · {draft.createdAt}</summary>
      <div className="mt-2 whitespace-pre-wrap break-words">{renderMarkdown ? renderMarkdown(draft.markdown) : draft.markdown}</div>
      <button type="button" className="mt-2 rounded border px-2 py-1" onClick={() => onExport([draft])}>导出此草稿</button>
    </details>)}
  </section>;
}
