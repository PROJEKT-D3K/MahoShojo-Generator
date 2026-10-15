import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import type { OnlineDataCardType, OwnedRecycleBinCardDetail, OwnedRecycleBinPage } from '@mahoshojo/contracts/data-cards';
import type { CardLibraryDetailsModalProps } from '../card-library/host';
import { getDataCardStatus } from '../card-library/status';
import { isQuestionnairePayload } from '@mahoshojo/domain/questionnaire-card';
import { BaseModal } from '../modal/BaseModal';

export interface OwnedRecycleBinReadPort {
  isCurrent(): boolean;
  readPage(query: { limit: number; offset: number; type?: OnlineDataCardType }, signal: AbortSignal): Promise<OwnedRecycleBinPage>;
  readDetail(id: string, signal: AbortSignal): Promise<OwnedRecycleBinCardDetail>;
}
export interface RecycleBinModalProps {
  isOpen: boolean;
  onClose(): void;
  port: OwnedRecycleBinReadPort;
  limit?: number;
  type?: OnlineDataCardType;
  refreshKey?: number;
  busy?: boolean;
  operationGuard?: { isBlocked(): boolean; onBusyChange(busy: boolean): void };
  DetailsModal?: ComponentType<CardLibraryDetailsModalProps & { isOwner?: boolean }>;
  onRestore?: (id: string) => void | Promise<void>;
  onDelete?: (id: string) => void | Promise<void>;
}
const labels: Record<OnlineDataCardType, string> = { character: '角色', scenario: '情景', history: '叙事历史', questionnaire: '问卷' };
const reviewLabels = { pending: '待审核', approved: '已通过', rejected: '未通过' };
const formatTime = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN'); };

/** 摘要、按需详情与代次由两端共用；认证、文件和既有 Web 写操作留在宿主。 */
export function RecycleBinModal({ isOpen, onClose, port, limit, type: fixedType, refreshKey = 0, busy = false,
  operationGuard, DetailsModal, onRestore, onDelete }: RecycleBinModalProps) {
  const [type, setType] = useState<OnlineDataCardType | undefined>(fixedType);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<OwnedRecycleBinPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selected, setSelected] = useState<OwnedRecycleBinCardDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const latest = useRef({ isOpen, port, operationGuard, busy });
  latest.current = { isOpen, port, operationGuard, busy };
  const operation = useRef<{ controller: AbortController; release?: () => void; write: boolean; port: OwnedRecycleBinReadPort } | null>(null);
  const invalidate = useCallback(() => {
    const old = operation.current;
    operation.current = null;
    old?.controller.abort();
    old?.release?.();
  }, []);
  const begin = (write = false) => {
    const current = latest.current;
    if (operation.current || !current.isOpen || !current.port.isCurrent() || current.busy || current.operationGuard?.isBlocked()) return null;
    const guard = current.operationGuard;
    const ticket = { controller: new AbortController(), port: current.port, release: guard ? () => guard.onBusyChange(false) : undefined, write };
    operation.current = ticket;
    guard?.onBusyChange(true);
    return ticket;
  };
  const current = (ticket: NonNullable<typeof operation.current>) => operation.current === ticket && latest.current.isOpen && latest.current.port === ticket.port && ticket.port.isCurrent() && !ticket.controller.signal.aborted;
  const finish = (ticket: NonNullable<typeof operation.current>) => { if (operation.current === ticket) { operation.current = null; ticket.release?.(); } };
  useEffect(() => {
    setOffset(0); setType(fixedType); setPage(null); setSelected(null); setDetailError(null);
  }, [isOpen, fixedType]);
  useEffect(() => {
    if (!isOpen) { invalidate(); setLoading(false); setDetailLoading(null); setWriting(false); return; }
    if (operation.current?.write) return;
    invalidate(); setDetailLoading(null);
    const ticket = begin();
    setPage(null); setSelected(null); setDetailError(null);
    if (!ticket) { setLoading(false); setError('当前有其他云端操作，请稍后刷新'); return; }
    setLoading(true); setError(null);
    void port.readPage({ limit: 12, offset, ...(type ? { type } : {}) }, ticket.controller.signal).then((value) => {
      if (current(ticket)) setPage(value);
    }, (cause: unknown) => { if (current(ticket)) setError(cause instanceof Error ? cause.message : '读取云端回收站失败，请重试'); })
      .finally(() => { if (current(ticket)) setLoading(false); finish(ticket); });
    return () => { if (operation.current === ticket) invalidate(); };
    // Host guards are read through latest; inline host objects must not restart requests.
  }, [isOpen, offset, type, refresh, refreshKey, port, invalidate]);
  useEffect(() => invalidate, [invalidate]);
  const close = () => {
    if (operation.current?.write || latest.current.busy) return;
    invalidate(); setSelected(null); onClose();
  };
  const detail = async (id: string) => {
    const ticket = begin(); if (!ticket) return;
    setDetailLoading(id); setSelected(null); setDetailError(null);
    try { const card = await port.readDetail(id, ticket.controller.signal); if (current(ticket)) setSelected(card); }
    catch (cause) { if (current(ticket)) setDetailError(cause instanceof Error ? cause.message : '读取详情失败，请重试'); }
    finally { if (current(ticket)) setDetailLoading(null); finish(ticket); }
  };
  const action = async (id: string, handler: (id: string) => void | Promise<void>) => {
    const ticket = begin(true); if (!ticket) return;
    setWriting(true); setDetailError(null);
    try { await handler(id); if (current(ticket)) { setSelected(null); setRefresh((value) => value + 1); } }
    catch (cause) { if (current(ticket)) setDetailError(cause instanceof Error ? cause.message : '操作失败，请刷新后核对'); }
    finally { if (current(ticket)) setWriting(false); finish(ticket); }
  };
  const detailsCard = useMemo(() => {
    if (!selected) return null;
    let author = '我';
    try { const parsed: unknown = JSON.parse(selected.data); if (parsed && typeof parsed === 'object' && '_author' in parsed && typeof parsed._author === 'string') author = parsed._author; } catch { /* Preserve the exact source for the host's viewer/download. */ }
    return { id: selected.id, name: selected.name, description: selected.description ?? '', type: selected.isLegacyQuestionnaire && isQuestionnairePayload(selected.data) ? 'questionnaire' as const : selected.type,
      data: selected.data, isPublic: selected.is_public === 1, usageCount: selected.usage_count, likeCount: selected.like_count,
      author, createdAt: selected.created_at ?? undefined, updatedAt: selected.updated_at ?? undefined };
  }, [selected]);
  const disabled = busy || loading || writing || detailLoading !== null;
  return <>
    <BaseModal isOpen={isOpen} title="云端回收站" onClose={close} closeOnBackdrop={!writing && !busy} description={
      <span>{limit === undefined ? '账号所有类型共享回收站容量' : `账号所有类型共用 ${limit} 个回收站名额`}，满时会停止移入，不会自动清理已有卡片。</span>}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="text-sm text-gray-600">账号回收站：{page ? (limit === undefined ? `${page.total} 个` : `${page.total}/${limit}`) : '未知'}{type && page ? ` · 当前类型 ${page.filteredCount} 个` : ''}</p>
        {!fixedType && <select aria-label="回收站类型" value={type ?? ''} disabled={disabled} className="rounded border border-gray-300 p-1 text-sm" onChange={(event) => { setOffset(0); setType((event.target.value || undefined) as OnlineDataCardType | undefined); }}>
          <option value="">全部类型</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>}
        <button type="button" disabled={disabled} className="rounded border border-gray-300 px-3 py-1 text-sm" onClick={() => setRefresh((value) => value + 1)}>刷新</button>
      </div>
      {loading && <p role="status" className="py-8 text-center text-gray-500">正在加载云端回收站…</p>}
      {error && <p role="alert" className="rounded bg-red-50 p-3 text-red-700">{error}</p>}
      {detailError && <p role="alert" className="mb-3 rounded bg-red-50 p-3 text-red-700">{detailError}</p>}
      {detailLoading && <p role="status">正在读取详情…</p>}
      {page && page.cards.length === 0 && <p className="py-8 text-center text-gray-500">{page.total === 0 ? '回收站为空' : '当前筛选或分页没有数据卡，请切换类型或刷新'}</p>}
      {page && <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{page.cards.map((card) => <div key={card.id} className="flex h-full flex-col rounded-lg border border-gray-200 bg-gray-50 p-4">
        <div className="flex items-start justify-between gap-2"><div className="min-w-0 flex-1"><h3 title={card.name} className="break-words text-base font-semibold text-gray-800">{card.name || '未命名'}</h3><p className="mt-1 text-xs text-gray-500">类型：{labels[card.type]}{card.isLegacyQuestionnaire ? '（旧类型问卷候选）' : ''}</p></div>
          <span className="text-xs text-gray-500">删除于 {formatTime(card.deleted_at)}</span></div>
        <p className="mt-2 text-xs text-gray-500">原可见性：{getDataCardStatus(card).label} · 审核：{card.review_status ? reviewLabels[card.review_status] : '未知'}</p>
        <p className="mt-3 min-h-[40px] text-sm text-gray-600 line-clamp-2">{card.description || '（无描述）'}</p>
        <div className="mt-auto flex flex-wrap justify-end gap-2 pt-4">
          {DetailsModal && <button type="button" disabled={disabled} className="rounded border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700" onClick={() => void detail(card.id)}>查看详情</button>}
          {onRestore && <button type="button" disabled={disabled} className="rounded bg-green-500 px-3 py-1 text-xs text-white" onClick={() => void action(card.id, onRestore)}>恢复</button>}
          {onDelete && <button type="button" disabled={disabled} className="rounded bg-red-500 px-3 py-1 text-xs text-white" onClick={() => void action(card.id, onDelete)}>彻底删除</button>}
        </div>
      </div>)}</div>}
      {page && <div className="mt-4 flex items-center justify-center gap-3 text-sm"><button type="button" disabled={disabled || offset === 0} onClick={() => setOffset(Math.max(0, offset - 12))}>上一页</button><span>第 {Math.floor(offset / 12) + 1} 页</span><button type="button" disabled={disabled || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) setOffset(page.nextOffset); }}>下一页</button></div>}
    </BaseModal>
    {isOpen && selected && detailsCard && DetailsModal && <DetailsModal isOpen onClose={() => setSelected(null)} source={{ kind: 'owned' }} isOwner card={detailsCard} />}
  </>;
}
