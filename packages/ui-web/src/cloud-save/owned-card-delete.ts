import {
  OwnedDataCardDeletionPreviewSchema,
  OwnedDataCardPurgeActiveAcknowledgementSchema,
  OwnedDataCardSoftDeleteAcknowledgementSchema,
  OwnedRecycleBinPurgeAcknowledgementSchema,
  type OwnedDataCardDeletionReference,
  type OwnedDataCardDeletionTarget,
} from '@mahoshojo/contracts/data-cards';

export type DeleteOperation = 'soft-delete' | 'purge-active' | 'purge-recycle';
export type DeleteResponse = { status: number; body: unknown };
export type DeleteWrite = { operation: 'soft-delete' | 'purge-active'; target: OwnedDataCardDeletionReference }
  | { operation: 'purge-recycle'; targets: OwnedDataCardDeletionReference[]; continuationTarget?: OwnedDataCardDeletionReference };
export interface OwnedCardDeletePort {
  readonly expectedUserId: number;
  isCurrent(): boolean;
  isBlocked?(): boolean;
  onBusyChange?(busy: boolean): void;
  onChanged?(): void;
  preview(scope: 'active' | 'recycle', id: string | undefined, signal: AbortSignal): Promise<DeleteResponse>;
  write(request: DeleteWrite, signal: AbortSignal): Promise<DeleteResponse>;
}
export const DELETE_UNKNOWN_MESSAGE = '删除结果不确定，服务器可能已执行。不会自动重发或继续移动原卡；请核对原账号的数据卡与回收站。读取到空列表也不能证明刚才的请求成功。';
export type OwnedCardDeleteState = {
  phase: 'idle' | 'reading' | 'confirm-soft' | 'writing' | 'full' | 'confirm-purge-active' | 'confirm-purge-recycle' | 'success' | 'rejected' | 'unknown';
  active: OwnedDataCardDeletionTarget | null;
  targets: OwnedDataCardDeletionTarget[];
  message: string | null;
  refresh: number;
};
const reference = ({ id, version }: OwnedDataCardDeletionReference): OwnedDataCardDeletionReference => ({ id, version });
const initial: OwnedCardDeleteState = { phase: 'idle', active: null, targets: [], message: null, refresh: 0 };
const sameIds = (actual: string[], expected: string[]) => actual.length === expected.length && new Set(actual).size === actual.length && expected.every(id => actual.includes(id));

/** A reply is evidence only for this exact owner, operation and requested target set. */
export function verifyOwnedDeleteResponse(response: DeleteResponse, owner: number, request: DeleteWrite): 'success' | 'full' | 'blocked' | 'changed' | 'rejected' | 'unknown' {
  if (response.status >= 200 && response.status < 300) {
    if (request.operation === 'purge-recycle') {
      const parsed = OwnedRecycleBinPurgeAcknowledgementSchema.safeParse(response.body);
      return parsed.success && parsed.data.ownerUserId === owner && sameIds(parsed.data.ids, request.targets.map(target => target.id)) ? 'success' : 'unknown';
    }
    const schema = request.operation === 'soft-delete' ? OwnedDataCardSoftDeleteAcknowledgementSchema : OwnedDataCardPurgeActiveAcknowledgementSchema;
    const parsed = schema.safeParse(response.body);
    return parsed.success && parsed.data.ownerUserId === owner && parsed.data.id === request.target.id ? 'success' : 'unknown';
  }
  if (response.status >= 500 || response.status < 400) return 'unknown';
  const code = response.body && typeof response.body === 'object' && 'code' in response.body ? response.body.code : null;
  if (response.status === 409 && code === 'RECYCLE_BIN_FULL' && request.operation === 'soft-delete') return 'full';
  if (response.status === 409 && code === 'RECYCLE_BIN_FULL' && request.operation === 'purge-recycle') return 'blocked';
  if (response.status === 409 && code === 'TARGET_CHANGED') return 'changed';
  return 'rejected';
}

/** Owns one page guard for the whole preview/confirmation sequence, never reacquires its own guard. */
export function createOwnedCardDeleteController(port: OwnedCardDeletePort) {
  let state = initial;
  let epoch = 0;
  let disposed = false;
  let held = false;
  let request: AbortController | null = null;
  const listeners = new Set<() => void>();
  const emit = (patch: Partial<OwnedCardDeleteState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const release = () => { if (held) { held = false; port.onBusyChange?.(false); } };
  const invalidate = () => { epoch++; request?.abort(); request = null; release(); };
  const current = (token: number) => !disposed && token === epoch && port.isCurrent();
  const settle = (phase: 'success' | 'rejected' | 'unknown', message: string, changed = false) => {
    request = null;
    if (phase !== 'unknown') release();
    emit({ phase, message, ...(changed ? { refresh: state.refresh + 1 } : {}) });
    if (changed) port.onChanged?.();
  };
  const begin = () => {
    if (disposed || state.phase !== 'idle' || held || !port.isCurrent() || port.isBlocked?.()) return null;
    held = true; port.onBusyChange?.(true);
    return ++epoch;
  };
  const preview = async (scope: 'active' | 'recycle', id: string | undefined, token: number) => {
    const controller = new AbortController(); request = controller;
    const response = await port.preview(scope, id, controller.signal);
    if (!current(token)) return null;
    if (response.status === 409 && response.body && typeof response.body === 'object' && 'code' in response.body && response.body.code === 'RECYCLE_TARGET_LIMIT') {
      throw new Error('回收站记录超过单次安全确认上限，请先进入回收站逐个整理；不会截断清单或自动删除');
    }
    const parsed = OwnedDataCardDeletionPreviewSchema.safeParse(response.body);
    if (response.status !== 200 || !parsed.success || parsed.data.ownerUserId !== port.expectedUserId || parsed.data.operation !== `preview-${scope}` || (id !== undefined && (parsed.data.targets.length !== 1 || parsed.data.targets[0]?.id !== id))) {
      throw new Error('无法核对删除目标，记录或登录状态可能已改变；请关闭后重新选择');
    }
    if (request === controller) request = null;
    return parsed.data;
  };
  const read = async (scope: 'active' | 'recycle', id?: string) => {
    const token = begin(); if (token === null) return;
    emit({ phase: 'reading', active: null, targets: [], message: null });
    try {
      const result = await preview(scope, id, token);
      if (!result) { if (!disposed && token === epoch) settle('rejected', '登录状态已改变，请重新打开当前账号的数据卡管理'); return; }
      if (result.targets.length === 0) { settle('rejected', '回收站当前为空，没有可确认删除的目标'); return; }
      emit(scope === 'active' ? { phase: 'confirm-soft', active: result.targets[0]!, targets: [] } : { phase: 'confirm-purge-recycle', targets: result.targets });
    } catch (cause) { if (!disposed && token === epoch) settle('rejected', cause instanceof Error ? cause.message : '读取删除预览失败，请重试'); }
  };
  const write = async (input: DeleteWrite, token: number) => {
    if (!current(token)) return 'stale' as const;
    const controller = new AbortController(); request = controller;
    try { return verifyOwnedDeleteResponse(await port.write(input, controller.signal), port.expectedUserId, input); }
    catch { return 'unknown' as const; }
    finally { if (request === controller) request = null; }
  };
  const confirm = async () => {
    if (!held || !port.isCurrent() || !['confirm-soft', 'confirm-purge-active', 'confirm-purge-recycle'].includes(state.phase)) return;
    const before = state;
    const token = epoch;
    const input: DeleteWrite = before.phase === 'confirm-purge-recycle'
      ? { operation: 'purge-recycle', targets: before.targets.map(reference), ...(before.active ? { continuationTarget: reference(before.active) } : {}) }
      : { operation: before.phase === 'confirm-soft' ? 'soft-delete' : 'purge-active', target: reference(before.active!) };
    emit({ phase: 'writing', message: null });
    const result = await write(input, token);
    if (disposed || token !== epoch) return;
    if (!current(token)) { settle('unknown', DELETE_UNKNOWN_MESSAGE); return; }
    if (result === 'success' && input.operation === 'purge-recycle' && before.active) {
      // Only a strict successful phase-one receipt authorizes phase two. Never refresh its version.
      const next = await write({ operation: 'soft-delete', target: reference(before.active) }, token);
      if (disposed || token !== epoch) return;
      if (!current(token) || next === 'unknown' || next === 'stale') { settle('unknown', `本次确认清单中的数据卡已永久删除；原卡是否移入无法确认。${DELETE_UNKNOWN_MESSAGE}`, true); return; }
      if (next === 'success') settle('success', '本次确认清单中的数据卡已永久删除，原卡已移入回收站', true);
      else settle('rejected', `本次确认清单中的数据卡已永久删除，但原卡未移入回收站。${next === 'full' ? '间隙中回收站再次满额。' : next === 'changed' ? '原卡版本已改变。' : '移动请求被拒绝。'}请核对后重新选择原卡。`, true);
      return;
    }
    if (result === 'success') settle('success', input.operation === 'soft-delete' ? '数据卡已移入回收站' : '已永久删除确认清单中的数据卡', true);
    else if (result === 'full') emit({ phase: 'full', message: '回收站已满，当前卡尚未移入。请选择下一步' });
    else if (result === 'unknown' || result === 'stale') settle('unknown', DELETE_UNKNOWN_MESSAGE);
    else settle('rejected', `${input.operation === 'purge-recycle' && before.active ? '回收站未清空，原卡也未移入。' : ''}${result === 'blocked' ? '可用回收站名额已变化，已停止清空。请重新整理后再试。' : result === 'changed' ? '确认后目标已变化，未执行删除。请关闭后重新读取并确认' : '请求被拒绝，未继续删除。请核对登录状态或等待服务更新'}`);
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    beginActive: (id: string) => read('active', id),
    beginRecycle: (id?: string) => read('recycle', id),
    confirm,
    choosePurgeActive: () => { if (state.phase === 'full' && port.isCurrent()) emit({ phase: 'confirm-purge-active', message: null }); },
    chooseClear: async () => {
      if (state.phase !== 'full' || !port.isCurrent()) return;
      const token = epoch; emit({ phase: 'reading', message: null });
      try {
        const result = await preview('recycle', undefined, token);
        if (!result) { if (!disposed && token === epoch) settle('rejected', '账号会话已改变，未继续删除'); return; }
        if (result.targets.length === 0) { settle('rejected', '回收站当前为空。未据此认定任何先前删除成功，也未继续移动原卡；请关闭后重新选择原卡'); return; }
        emit({ phase: 'confirm-purge-recycle', targets: result.targets });
      } catch (cause) { if (!disposed && token === epoch) settle('rejected', cause instanceof Error ? cause.message : '读取清空预览失败'); }
    },
    cancel: () => { if (state.phase === 'writing') return false; invalidate(); emit({ ...initial, refresh: state.refresh }); return true; },
    invalidate: () => { invalidate(); emit({ ...initial, refresh: state.refresh }); },
    dispose: () => { disposed = true; invalidate(); state = { ...initial, refresh: state.refresh }; listeners.clear(); },
  };
}
export type OwnedCardDeleteController = ReturnType<typeof createOwnedCardDeleteController>;
