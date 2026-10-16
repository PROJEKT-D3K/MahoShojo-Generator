'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { NarrativeDraft } from '@mahoshojo/domain/narrative-drafts';
import { haveSameNarrativeDraftVersions, NarrativeDraftsPanel, type NarrativeDraftActionResult } from './NarrativeDraftsPanel';

export type NarrativeLegacyDraftsSnapshot = Readonly<{
  status: 'absent' | 'available' | 'protected' | 'unavailable';
  drafts: readonly NarrativeDraft[];
  raw: string | null;
}>;
export type NarrativeLegacyDraftsSectionProps = Readonly<{
  legacy: NarrativeLegacyDraftsSnapshot | null;
  scopeKey: string;
  onLoad: () => void | Promise<void>;
  onDelete: (ids: readonly string[]) => NarrativeDraftActionResult | Promise<NarrativeDraftActionResult>;
  onCopyToCurrent: (ids: readonly string[]) => NarrativeDraftActionResult | Promise<NarrativeDraftActionResult>;
  confirmAction: (message: string) => boolean | Promise<boolean>;
  onExport: (drafts: readonly NarrativeDraft[]) => void;
  onExportRaw: (raw: string) => void;
  onCopy?: (markdown: string) => void | Promise<void>;
  renderMarkdown?: (markdown: string) => ReactNode;
}>;
const buttonClass = 'rounded border border-gray-300 px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50';

/** Legacy bytes have no account ownership. Only the host reads, copies or hides them. */
export function NarrativeLegacyDraftsSection(props: NarrativeLegacyDraftsSectionProps) {
  return <ScopedLegacyDraftsSection key={props.scopeKey} {...props} />;
}

function ScopedLegacyDraftsSection({ legacy, scopeKey, onLoad, onDelete, onCopyToCurrent, confirmAction,
  onExport, onExportRaw, onCopy, renderMarkdown }: NarrativeLegacyDraftsSectionProps) {
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const mounted = useRef(true), loadPending = useRef(false), copyPending = useRef(false);
  const latest = useRef(legacy);
  latest.current = legacy;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (legacy !== null) { loadPending.current = false; setLoading(false); }
  }, [legacy]);

  const load = (force = false) => {
    setOpened(true);
    if (loadPending.current || copyPending.current) return;
    setFeedback(null);
    if (legacy !== null && !force) return;
    loadPending.current = true; setLoading(true);
    const failed = () => {
      loadPending.current = false;
      if (mounted.current) { setLoading(false); setFeedback({ error: true, text: '旧设备草稿读取失败，请重试' }); }
    };
    try { void Promise.resolve(onLoad()).catch(failed); } catch { failed(); }
  };

  const copyToCurrent = async () => {
    if (copyPending.current || loadPending.current || legacy?.status !== 'available' || !legacy.drafts.length) return;
    const versions = [...legacy.drafts], ids = versions.map(draft => draft.requestId);
    copyPending.current = true; setCopying(true); setFeedback(null);
    try {
      const confirmed = await confirmAction(`确认将这 ${ids.length} 条旧设备草稿复制到当前账号/本机范围？\n这些草稿未记录账号归属，请先确认它们属于你。旧设备原件仍保留；不会写入正式叙事历史。`);
      if (!mounted.current || !confirmed) return;
      const current = latest.current;
      const currentVersions = current?.drafts.filter(draft => ids.includes(draft.requestId)) ?? [];
      if (current?.status !== 'available' || !haveSameNarrativeDraftVersions(versions, currentVersions)) {
        setFeedback({ error: true, text: '旧设备草稿已变化，请核对后重试' });
        return;
      }
      const result = await onCopyToCurrent(ids);
      if (mounted.current) setFeedback(result.ok
        ? { error: false, text: '已复制到当前账号/本机范围，旧设备原件仍保留' }
        : { error: true, text: result.error || '复制到当前范围失败，请重试' });
    } catch {
      if (mounted.current) setFeedback({ error: true, text: '复制到当前范围失败，请重试' });
    } finally {
      copyPending.current = false;
      if (mounted.current) setCopying(false);
    }
  };

  if (!opened) return <button type="button" className={buttonClass} aria-expanded={false} onClick={() => load()}>查看旧设备草稿</button>;
  return <section aria-label="旧设备草稿" aria-busy={loading || copying} className="w-full space-y-2 rounded border border-gray-200 p-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs font-semibold">旧设备草稿</span>
      <button type="button" className={buttonClass} aria-expanded={true} disabled={copying} onClick={() => setOpened(false)}>收起旧设备草稿</button>
    </div>
    <p className="text-xs text-gray-600">这些旧草稿未记录账号归属，只有本机副本；请自行确认是否属于你。同一操作系统用户可以访问这些内容，账号隔离不提供本机保密。</p>
    <p className="text-xs text-gray-600">这里的列表与当前账号/本机范围独立。删除仅从旧列表移除，保留旧设备原始数据，不会删除当前范围的草稿。</p>
    {loading && <p role="status" className="text-xs text-gray-600">正在读取旧设备草稿…</p>}
    {feedback && <p role={feedback.error ? 'alert' : 'status'} className={`text-xs ${feedback.error ? 'text-red-700' : 'text-gray-600'}`}>{feedback.text}</p>}
    {!loading && legacy?.status === 'absent' && <p className="text-xs text-gray-600">未找到旧设备草稿</p>}
    {!loading && legacy?.status === 'unavailable' && <p role="alert" className="text-xs text-red-700">旧设备草稿暂时无法读取，可稍后重试</p>}
    {!loading && legacy?.status === 'protected' && <p role="alert" className="text-xs text-red-700">旧数据无法安全解析，原件已保留；请先导出原件检查</p>}
    {!loading && (legacy?.status === 'unavailable' || legacy === null && feedback?.error) && <button type="button" className={buttonClass} disabled={copying} onClick={() => load(true)}>重新读取旧设备草稿</button>}
    {!loading && legacy?.raw !== null && legacy?.raw !== undefined && <button type="button" className={buttonClass} onClick={() => onExportRaw(legacy.raw!)}>导出旧设备原件</button>}
    {!loading && legacy?.status === 'available' && <fieldset className="min-w-0 space-y-2" disabled={copying}>
      {legacy.drafts.length > 0 && <button type="button" className={buttonClass} disabled={copying} onClick={() => void copyToCurrent()}>复制这些草稿到当前账号/本机范围</button>}
      <NarrativeDraftsPanel scopeKey={`legacy:${scopeKey}`} drafts={legacy.drafts} status="idle"
        onDelete={ids => copyPending.current ? { ok: false, error: '请等待复制完成后重试' } : onDelete(ids)}
        confirmAction={async () => !copyPending.current && await confirmAction('确认从旧设备列表删除这些草稿？删除仅移除旧列表中的条目，保留旧设备原始数据；不会删除当前账号/本机范围的草稿。') && !copyPending.current}
        onExport={onExport} onCopy={onCopy} renderMarkdown={renderMarkdown} />
    </fieldset>}
  </section>;
}
