import { useEffect, useRef, useState } from 'react';
import { createOwnedCardOperationSessionRegistry, type OwnedCardOperationNotice } from './owned-card-operation-notice';
import type { OnlineDataCardVisibility, OwnedDataCardReplacementTarget } from '@mahoshojo/contracts/data-cards';

export interface OwnedCardMetadataDraft { name: string; description: string; isPublic: OnlineDataCardVisibility }
export type OwnedCardMetadataOutcome = { kind: 'saved' } | { kind: 'rejected' | 'conflict' | 'uncertain'; message: string };
export type OwnedCardMetadataRead = { kind: 'ready'; target: OwnedDataCardReplacementTarget } | { kind: 'rejected'; message: string };
/** Hosts own credentials, transport and the single page leave guard; this owner owns the edit lifecycle. */
export interface OwnedCardMetadataPort {
  readonly session?: OwnedCardMetadataSession;
  isCurrent(): boolean;
  isBlocked?(): boolean;
  read(id: string): Promise<OwnedCardMetadataRead>;
  write(target: OwnedDataCardReplacementTarget, draft: OwnedCardMetadataDraft): Promise<OwnedCardMetadataOutcome>;
  /** A returned release belongs to this acquisition and remains safe after identity changes. */
  onBusyChange?(busy: boolean): void | (() => void);
  onSaved?(): void;
}
export const METADATA_UNCERTAIN_MESSAGE = '修改结果不确定，服务器可能已保存。输入已保留，不会自动重发；请重新读取云端信息并核对，再决定是否提交新的修改。';
type Phase = 'reading' | 'editing' | 'saving' | 'conflict' | 'uncertain' | 'checking';
interface Selection {
  card: Record<string, unknown> & { id: string };
  draft: OwnedCardMetadataDraft;
  phase: Phase;
  target: OwnedDataCardReplacementTarget | null;
  candidate: OwnedDataCardReplacementTarget | null;
  error: string | null;
}
/** One unconfirmed edit per authenticated session; no card body or persistent retry ledger. */
export type OwnedCardMetadataSession = OwnedCardOperationNotice & {
  edit?: {
    card: { id: string; name: string; description?: string | null; is_public: OnlineDataCardVisibility };
    draft: OwnedCardMetadataDraft;
    target: null;
  };
};
export const getOwnedCardMetadataSession = createOwnedCardOperationSessionRegistry<OwnedCardMetadataSession>(() => ({ uncertain: false }));

export function useOwnedCardMetadataEditor(port: OwnedCardMetadataPort | undefined, open: boolean) {
  const fallback = useRef<OwnedCardMetadataSession>({ uncertain: false });
  const session = port?.session ?? fallback.current;
  const restore = (): Selection | null => session.uncertain && session.edit && port?.isCurrent()
    ? { ...session.edit, draft: { ...session.edit.draft }, phase: 'uncertain', candidate: null, error: METADATA_UNCERTAIN_MESSAGE } : null;
  const [selection, setSelection] = useState<Selection | null>(restore);
  const [status, setStatus] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const selected = useRef<Selection | null>(selection);
  const observedOwner = useRef(selection ? session.owner : undefined);
  const owner = useRef<OwnedCardMetadataPort | null>(selection ? port ?? null : null);
  const active = useRef(true);
  const pending = useRef(false);
  const operation = useRef(0);
  const assign = (next: Selection | null) => { selected.current = next; setSelection(next); };
  const ownedRelease = useRef(false);
  const busy = (value: boolean) => { pending.current = value; return owner.current?.onBusyChange?.(value); };
  const holdBusy = () => {
    const release = busy(true);
    ownedRelease.current = typeof release === 'function';
    // Legacy boolean hosts keep their existing hide/unmount lifecycle.
    return () => { if (typeof release === 'function') { pending.current = false; release(); } };
  };
  const clearObserved = () => {
    if (observedOwner.current && session.owner === observedOwner.current) {
      session.uncertain = false; session.owner = undefined; session.edit = undefined;
    }
    observedOwner.current = undefined;
  };
  const hide = () => {
    operation.current += 1;
    if (pending.current && !ownedRelease.current) busy(false);
    const saved = session.owner === observedOwner.current ? restore() : null;
    if (saved) { observedOwner.current = session.owner; owner.current = port ?? null; }
    assign(saved);
  };
  useEffect(() => { active.current = true; return () => { active.current = false; operation.current += 1; if (pending.current && !ownedRelease.current && owner.current?.isCurrent()) owner.current.onBusyChange?.(false); }; }, []);
  const visibilityAction = useRef<() => void>(() => {});
  visibilityAction.current = () => {
    if (!open) hide();
    else if (session.uncertain && session.edit && port?.isCurrent()) {
      observedOwner.current = session.owner; owner.current = port; assign(restore());
    }
  };
  // Observe the latest host only on visibility/session transitions, not every draft render.
  useEffect(() => visibilityAction.current(), [open, session]);
  const owns = (captured: OwnedCardMetadataPort, ticket: number) => active.current && ticket === operation.current && captured.isCurrent();
  const read = async (card: Selection['card'], checking = false) => {
    const captured = checking ? owner.current : port;
    if (!captured || pending.current || !captured.isCurrent() || captured.isBlocked?.()) return;
    const previous = selected.current;
    if (checking && !previous) return;
    owner.current = captured;
    const base: Selection = checking ? previous! : { card, draft: { name: String(card.name ?? ''), description: String(card.description ?? ''), isPublic: card.is_public === -1 ? -1 : card.is_public === 1 ? 1 : 0 }, phase: 'reading', target: null, candidate: null, error: null };
    const next = { ...base, phase: checking ? 'checking' as const : 'reading' as const, candidate: null };
    assign(next); setStatus(null); const releaseBusy = holdBusy();
    const ticket = ++operation.current;
    const observed = observedOwner.current;
    let result: OwnedCardMetadataRead;
    try { result = await captured.read(card.id); }
    catch { result = { kind: 'rejected', message: '读取云端信息失败，输入已保留，请重试' }; }
    releaseBusy();
    if (!active.current || ticket !== operation.current) return;
    if (!ownedRelease.current) busy(false);
    if (checking && observed && session.owner !== observed) { assign(null); return; }
    if (!owns(captured, ticket)) { assign({ ...next, phase: 'conflict', error: '登录状态已变化，请重新打开当前账号的数据卡管理' }); return; }
    if (result.kind !== 'ready' || result.target.id !== card.id) {
      const failure = result.kind === 'rejected' ? result.message : '云端目标不匹配，请重新选择';
      assign({ ...next, phase: checking ? previous!.phase : 'conflict', error: checking && previous!.phase === 'uncertain' ? `${METADATA_UNCERTAIN_MESSAGE} ${failure}` : failure }); return;
    }
    if (checking) {
      assign({ ...next, phase: previous!.phase, candidate: result.target, error: previous!.error });
    } else {
      const target = result.target;
      assign({ ...next, target, phase: 'editing', draft: { name: target.name, description: target.description ?? '', isPublic: target.isPublic }, error: null });
    }
  };
  const save = async () => {
    const captured = owner.current;
    const current = selected.current;
    if (!captured || !current?.target || current.phase !== 'editing' || session.uncertain || pending.current || !captured.isCurrent() || captured.isBlocked?.()) return;
    if (!current.draft.name.trim() || current.draft.name.trim().length > 20 || current.draft.description.length > 300) {
      assign({ ...current, error: '名称须为 1–20 字，描述最多 300 字' }); return;
    }
    const next = { ...current, phase: 'saving' as const, error: null };
    assign(next); const releaseBusy = holdBusy();
    const ticket = ++operation.current;
    const token = {};
    observedOwner.current = token; session.owner = token; session.uncertain = true;
    session.edit = { card: { id: current.target.id, name: current.target.name, description: current.target.description, is_public: current.target.isPublic }, draft: { ...current.draft }, target: null };
    let result: OwnedCardMetadataOutcome;
    try { result = await captured.write(current.target, { ...current.draft, name: current.draft.name.trim() }); }
    catch { result = { kind: 'uncertain', message: METADATA_UNCERTAIN_MESSAGE }; }
    releaseBusy();
    if (!active.current || ticket !== operation.current) return;
    if (!ownedRelease.current) busy(false);
    if (session.owner !== token) { assign(null); return; }
    if (!owns(captured, ticket)) {
      assign({ ...next, phase: 'uncertain', error: '登录状态已变化，刚才的修改结果可能不确定，请核对原账号的云端卡' }); return;
    }
    if (result.kind !== 'uncertain') clearObserved();
    if (result.kind === 'saved') { assign(null); setStatus('数据卡信息已更新'); setRefresh((value) => value + 1); captured.onSaved?.(); }
    else assign({ ...next, phase: result.kind === 'rejected' ? 'editing' : result.kind, error: result.message });
  };
  return {
    selection, status, refresh, hide, isBusy: () => pending.current,
    begin: (card: Selection['card']) => selected.current || session.uncertain ? Promise.resolve() : read(card),
    save,
    change: (draft: OwnedCardMetadataDraft) => { if (selected.current && !pending.current) { assign({ ...selected.current, draft }); if (session.edit && session.owner === observedOwner.current) session.edit = { ...session.edit, draft: { ...draft } }; } },
    cancel: () => { if (!pending.current) { operation.current += 1; clearObserved(); assign(null); } },
    check: () => selected.current ? read(selected.current.card, true) : Promise.resolve(),
    acceptCandidate: () => {
      const current = selected.current;
      if (!current?.candidate || pending.current || !owner.current?.isCurrent()) return;
      if (observedOwner.current && session.owner !== observedOwner.current) { assign(null); return; }
      clearObserved();
      assign({ ...current, target: current.candidate, draft: { ...current.draft, isPublic: current.candidate.isPublic === -1 ? -1 : current.draft.isPublic === -1 ? 0 : current.draft.isPublic }, candidate: null, phase: 'editing', error: '已采用刚核对的云端版本；点击保存会提交一次新的修改' });
    },
  };
}
