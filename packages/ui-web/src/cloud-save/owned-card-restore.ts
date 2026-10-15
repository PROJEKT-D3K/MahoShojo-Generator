import { OwnedDataCardDeletionPreviewSchema, OwnedDataCardRestoreAcknowledgementSchema, type OwnedDataCardDeletionReference } from '@mahoshojo/contracts/data-cards';
export type RestoreResponse = { status: number; body: unknown };
export type OwnedCardRestoreNotice = { uncertain: boolean; owner?: object };
const notices = new WeakMap<object, { generation: number; owner: number; notice: OwnedCardRestoreNotice }>();
/** One ephemeral notice per session, not a receipt or a retry ledger. */
export function getOwnedCardRestoreNotice(scope: object, generation: number, owner: number): OwnedCardRestoreNotice {
  const existing = notices.get(scope);
  if (existing?.generation === generation && existing.owner === owner) return existing.notice;
  const notice = { uncertain: false }; notices.set(scope, { generation, owner, notice }); return notice;
}
export interface OwnedCardRestorePort {
  readonly notice?: OwnedCardRestoreNotice;
  readonly expectedUserId: number;
  isCurrent(): boolean;
  isBlocked?(): boolean;
  onBusyChange?(busy: boolean): void;
  onChanged?(): void;
  preview(id: string, signal: AbortSignal): Promise<RestoreResponse>;
  write(target: OwnedDataCardDeletionReference, signal: AbortSignal): Promise<RestoreResponse>;
}
export const RESTORE_UNKNOWN_MESSAGE = '恢复结果不确定，服务器可能已执行；请刷新核对，不会自动重试。核对只反映当前状态，不能证明本次恢复成功。';
export type OwnedCardRestoreState = { phase: 'idle' | 'reading' | 'writing' | 'success' | 'rejected' | 'unknown'; message: string | null; refresh: number };
const initial: OwnedCardRestoreState = { phase: 'idle', message: null, refresh: 0 };
export function verifyOwnedRestoreResponse(response: RestoreResponse, owner: number, target: OwnedDataCardDeletionReference) {
  if (response.status >= 200 && response.status < 300) {
    const ack = OwnedDataCardRestoreAcknowledgementSchema.safeParse(response.body);
    return response.status === 200 && ack.success && ack.data.ownerUserId === owner && ack.data.id === target.id && ack.data.version === target.version ? 'success' : 'unknown';
  }
  if (!response.body || typeof response.body !== 'object' || Array.isArray(response.body)) return 'unknown';
  const body = response.body as Record<string, unknown>;
  if (typeof body.code !== 'string' || body.error !== body.code || Object.keys(body).some(key => !['error', 'code'].includes(key))) return 'unknown';
  if (response.status === 409 && body.code === 'CAPACITY_EXCEEDED') return 'capacity';
  if (response.status === 409 && body.code === 'TARGET_CHANGED') return 'changed';
  if ((response.status === 409 && body.code === 'ACCOUNT_MISMATCH') || (response.status === 401 && body.code === 'UNAUTHORIZED')) return 'account';
  if (response.status === 404 && body.code === 'NOT_FOUND') return 'changed';
  if (response.status === 400 && body.code === 'INVALID_REQUEST') return 'rejected';
  // A validated pre-dispatch service refusal is distinct from a lost write receipt.
  if (response.status === 503 && ['STORAGE_UNAVAILABLE', 'AUTH_UNAVAILABLE'].includes(body.code)) return 'rejected';
  return 'unknown';
}
export function createOwnedCardRestoreController(port: OwnedCardRestorePort) {
  const notice: OwnedCardRestoreNotice = port.notice ?? { uncertain: false };
  let noticeOwner: object | undefined;
  let observedNoticeOwner = notice.uncertain ? notice.owner : undefined;
  let state: OwnedCardRestoreState = notice.uncertain && port.isCurrent() ? { ...initial, phase: 'unknown', message: RESTORE_UNKNOWN_MESSAGE } : initial; let epoch = 0; let held = false; let request: AbortController | null = null;
  const listeners = new Set<() => void>();
  const emit = (patch: Partial<OwnedCardRestoreState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const release = () => { if (held) { held = false; if (port.isCurrent()) port.onBusyChange?.(false); } };
  const invalidate = () => { epoch++; request?.abort(); request = null; release(); if ((state.phase === 'unknown' && notice.owner === observedNoticeOwner) || (noticeOwner && notice.owner === noticeOwner)) notice.uncertain = false; emit({ ...initial, refresh: state.refresh }); };
  const suspend = () => {
    const uncertain = state.phase === 'writing' || state.phase === 'unknown';
    epoch++; request?.abort(); request = null; release();
    emit(uncertain ? { phase: 'unknown', message: RESTORE_UNKNOWN_MESSAGE } : { ...initial, refresh: state.refresh });
  };
  const current = (ticket: number) => ticket === epoch && port.isCurrent();
  const settle = (phase: 'success' | 'rejected' | 'unknown', message: string) => {
    request = null; if (notice.owner === noticeOwner) notice.uncertain = phase === 'unknown'; if (phase !== 'unknown') release();
    if (phase === 'unknown') observedNoticeOwner = notice.owner;
    emit({ phase, message, ...(phase === 'success' ? { refresh: state.refresh + 1 } : {}) });
    if (phase === 'success') port.onChanged?.();
  };
  const activate = () => {
    if (notice.uncertain && !held && port.isCurrent()) { observedNoticeOwner = notice.owner; emit({ phase: 'unknown', message: RESTORE_UNKNOWN_MESSAGE }); }
  };
  return {
    activate,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    invalidate,
    suspend,
    check: () => { if (state.phase === 'unknown') release(); },
    dismiss: () => { if (state.phase === 'writing' || state.phase === 'reading') return false; invalidate(); return true; },
    restore: async (id: string) => {
      if (notice.uncertain && !held) { activate(); return; }
      if (held || !['idle', 'success', 'rejected'].includes(state.phase) || !port.isCurrent() || port.isBlocked?.()) return;
      held = true; port.onBusyChange?.(true); const ticket = ++epoch;
      const controller = new AbortController(); request = controller;
      emit({ phase: 'reading', message: null });
      let target: OwnedDataCardDeletionReference;
      try {
        const response = await port.preview(id, controller.signal); if (!current(ticket)) return;
        const parsed = OwnedDataCardDeletionPreviewSchema.safeParse(response.body);
        if (response.status !== 200 || !parsed.success || parsed.data.ownerUserId !== port.expectedUserId || parsed.data.operation !== 'preview-recycle' || parsed.data.targets.length !== 1 || parsed.data.targets[0]?.id !== id) throw Error('invalid-preview');
        target = { id, version: parsed.data.targets[0].version };
      } catch { if (current(ticket)) settle('rejected', '无法核对当前数据卡，尚未发送恢复请求；请重新选择'); return; }
      if (!current(ticket)) return;
      if (notice.uncertain) { settle('rejected', '同一会话有尚未核对的恢复结果，请先核对'); return; }
      noticeOwner = {}; notice.owner = noticeOwner; observedNoticeOwner = noticeOwner;
      // Publish before React can render a replacement owner, whose render precedes old effect cleanup.
      notice.uncertain = true;
      emit({ phase: 'writing', message: null });
      let result: ReturnType<typeof verifyOwnedRestoreResponse>;
      try { result = verifyOwnedRestoreResponse(await port.write(target, controller.signal), port.expectedUserId, target); }
      catch { result = 'unknown'; }
      if (!current(ticket)) return;
      if (result === 'success') settle('success', '数据卡已恢复');
      else if (result === 'unknown') settle('unknown', RESTORE_UNKNOWN_MESSAGE);
      else settle('rejected', result === 'capacity' ? '当前数据卡容量不足，未恢复；请先整理容量' : result === 'changed' ? '目标已变化或已不在回收站，未恢复；请刷新核对' : result === 'account' ? '登录状态已改变，未恢复；请重新打开数据卡管理' : '恢复请求在写入前被拒绝；请核对后重新选择');
    },
  };
}
