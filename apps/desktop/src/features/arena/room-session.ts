import { observeArenaRoomConfigPublish, type ArenaRoomConfigPublishTarget, type ArenaRoomConfigPublishObservation } from '@mahoshojo/multiplayer-core';
import { ArenaRoomPublishConfigRequestSchema, ArenaRoomSessionResponseSchema, jsonUtf8ByteLength, type ArenaRoomCreateRequest, type ArenaRoomSessionResponse, type ArenaRoomSharedConfig, type RoomDirectoryEntry, type RoomDirectoryVisibility, type RoomPresenceSnapshot, type RoomServerTransportMessage } from '@mahoshojo/contracts/arena-room';
import { DESKTOP_ROOM_IPC_LIMITS, type DesktopRoomBatch, type DesktopRoomHttpAction, type DesktopRoomHttpOperation } from '@mahoshojo/contracts/desktop-room-ipc';
import { ArenaRoomBridgeError, createArenaRoomBridge, type ArenaRoomAcceptance, type ArenaRoomChannel } from '../../platform/arena-room-bridge';
import type { InvokeFn } from '../../platform/cloud-bridge';
import type { DesktopCloudSessionStore } from '../account/cloud-session-store';

export type RoomUnknownIntent = { operation: 'create' | 'join' | 'leave' | 'close' | 'config'; roomId: string | null; intentId: string | null };
export type DesktopConfigTracking = { id: string; roomId: string; phase: 'publishing' | 'unknown' | 'ended-needs-read'; target: ArenaRoomConfigPublishTarget | null; observation: ArenaRoomConfigPublishObservation };
export interface DesktopRoomState {
  opened: boolean; busy: boolean; constrained: boolean;
  phase: 'detached' | 'attaching' | 'ready' | 'connecting' | 'online' | 'offline' | 'reconnecting' | 'closed' | 'unavailable';
  session: ArenaRoomSessionResponse | null; presence: RoomPresenceSnapshot | null; snapshotReceived: boolean;
  rooms: readonly RoomDirectoryEntry[]; nextCursor: string | null;
  configTracking: DesktopConfigTracking | null;
  unknown: RoomUnknownIntent | null; error: string | null; notice: string | null;
  sourceIssues: readonly string[];
}
const initial = (): DesktopRoomState => ({ opened: false, busy: false, constrained: false, phase: 'detached', session: null, presence: null, snapshotReceived: false, rooms: [], nextCursor: null, unknown: null, error: null, notice: null, sourceIssues: [], configTracking: null });
const staleView: DesktopRoomState = { ...initial(), error: '账号或页面身份已变化，请重新打开多人房间。' };
export interface DesktopRoomDeps {
  invoke: InvokeFn;
  account: Pick<DesktopCloudSessionStore, 'getSnapshot' | 'getCredentialEpoch' | 'subscribe'>;
  documentNonce: () => string | undefined;
  canStart?: () => boolean;
  createChannel?: () => ArenaRoomChannel;
  randomId?: () => string;
}
export type DesktopRoomSource = { ok: true; sharedConfig: ArenaRoomSharedConfig } | { ok: false; issues: readonly string[] };
type Owner = { userId: number; epoch: number; nonce: string; token: symbol };
type Flight = { action: DesktopRoomHttpAction; operation: DesktopRoomHttpOperation; requestId: string | null; accepted: boolean; acknowledged: boolean; result: 'success' | 'error' | null; subscribe: boolean; settlesUnknown: boolean; knownNotApplied: boolean };
// Remounts share the explicit intent counter within this actual Document. Reload
// receives a different immutable nonce; no handle or credential is persisted.
let lastDocument: string | undefined; let attachIntent = 0;
const nextAttachIntent = (nonce: string): number => { if (lastDocument !== nonce) { lastDocument = nonce; attachIntent = 0; } if (attachIntent >= Number.MAX_SAFE_INTEGER) throw new Error('attach intent exhausted'); return ++attachIntent; };
export const readDesktopRoomDocumentNonce = (): string | undefined => {
  const value: unknown = Reflect.get(window, '__MAHOSHOJO_ROOM_DOCUMENT_V1__');
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value) ? value : undefined;
};
const isMutation = (action: DesktopRoomHttpAction) => action.kind !== 'discover' && action.kind !== 'session';
const unknownFor = (action: DesktopRoomHttpAction): RoomUnknownIntent | null => {
  if (action.kind === 'create' || action.kind === 'resume-create') return { operation: 'create', roomId: null, intentId: action.kind === 'resume-create' ? action.intentId : null };
  if (action.kind === 'join' || action.kind === 'leave' || action.kind === 'close' || action.kind === 'config') return { operation: action.kind, roomId: action.roomId, intentId: null };
  return null;
};
export const describeDesktopRoomError = (error: ArenaRoomBridgeError): string => {
  if (error.code === 'not-authenticated') return '当前房间登录已失效，请重新验证账号后打开房间。';
  if (error.code === 'storage-unavailable') return '本机登录信息暂不可读取。房间已断开，请修复后明确恢复；未确认的操作仍可能已发生。';
  if (error.code === 'backpressure') return '房间消费容量已用尽。请关闭并重新打开应用窗口；刷新页面不会清除未确认的投递。';
  if (error.code === 'busy') return '上一项房间操作尚未结束，请稍后明确重试。';
  if (error.code === 'scope-changed') return '房间、账号或页面已变化，旧操作不再应用。';
  if (error.serverCode === 'ROOM_NOT_FOUND') return '房间已结束或当前不可找到。';
  if (error.serverCode === 'ROOM_FORBIDDEN') return '当前账号不再具有此房间的访问资格。';
  if (error.code === 'presence-unsupported' || error.code === 'invalid-response') return '服务器尚未支持受检房间协议，或回执无法验证。';
  return '多人房间操作未完成，请按当前状态明确核对或重试。';
};

/** Page-owned read model for the fixed Native session transport. No networking,
 * automatic mutation retry, persistence, provider configuration or story body. */
export class DesktopArenaRoomSession {
  private state = initial(); private readonly listeners = new Set<() => void>();
  private owner: Owner | null = null; private flight: Flight | null = null;
  private configSequence = 0;
  private disposed = false; private unsubscribe: (() => void) | null = null;
  private readonly bridge: ReturnType<typeof createArenaRoomBridge>;
  constructor(private readonly deps: DesktopRoomDeps) {
    this.bridge = createArenaRoomBridge(deps.invoke, { createChannel: deps.createChannel, getDocumentNonce: deps.documentNonce,
      isCurrent: () => this.current(), acceptBatch: (batch, context) => this.accept(batch, context),
      onAcknowledged: (batch, context) => this.acknowledged(batch, context), onError: error => this.failed(error) });
  }
  activate = () => { this.disposed = false; this.unsubscribe ??= this.deps.account.subscribe(() => { if (this.owner && !this.current()) this.invalidate(); }); };
  getSnapshot = (): DesktopRoomState => this.owner && !this.current() ? staleView : this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(patch: Partial<DesktopRoomState>) {
    this.state = { ...this.state, ...patch };
    const tracking = this.state.configTracking;
    if ('session' in patch && tracking?.phase === 'unknown') this.state = { ...this.state,
      configTracking: { ...tracking, observation: observeArenaRoomConfigPublish(tracking.target, this.state.session, true) } };
    this.listeners.forEach(listener => listener());
  }
  private current(owner = this.owner): boolean {
    if (!owner || owner !== this.owner || this.disposed) return false;
    try { const account = this.deps.account.getSnapshot();
    return account.account?.userId === owner.userId && this.deps.account.getCredentialEpoch() === owner.epoch
      && account.verification === 'verified' && account.authFlow.kind === 'idle' && this.deps.documentNonce() === owner.nonce; } catch { return false; }
  }
  private invalidate() { this.owner = null; this.flight = null; this.bridge.detach(); this.state = { ...staleView }; this.listeners.forEach(listener => listener()); }
  detach = () => { this.owner = null; this.flight = null; this.bridge.detach(); this.publish({ ...initial(), notice: '已断开本机连接；这不表示已离开房间或停止服务器任务。' }); };
  dispose = () => { this.detach(); this.disposed = true; this.unsubscribe?.(); this.unsubscribe = null; };
  confirmationOwner = (): symbol | null => this.current() ? this.owner!.token : null;
  isBusy = () => this.current() && this.state.busy;
  isConstrained = () => this.current() && this.state.constrained;
  needsLeaveConfirmation = () => this.current() && (this.state.busy || this.state.session !== null || this.state.unknown !== null || this.state.configTracking !== null);
  async open(): Promise<symbol | null> {
    if (this.disposed) return null;
    if (this.owner && !this.current()) this.invalidate();
    this.activate();
    if (this.disposed || this.state.busy || this.deps.canStart?.() === false) return null;
    const account = this.deps.account.getSnapshot(); let nonce: string | undefined; try { nonce = this.deps.documentNonce(); } catch { nonce = undefined; }
    if (!account.account || account.verification !== 'verified' || account.authFlow.kind !== 'idle') { this.publish({ opened: true, error: '请先验证并登录账号，再打开多人房间。' }); return null; }
    if (!nonce) { this.publish({ opened: true, error: '当前窗口无法验证房间页面身份，请重新打开应用窗口。' }); return null; }
    const previousTracking = this.current() ? this.state.configTracking : null;
    const previousSession = this.current() ? this.state.session : null;
    const owner = { userId: account.account.userId, epoch: this.deps.account.getCredentialEpoch(), nonce, token: Symbol() };
    this.owner = owner; this.flight = null; this.publish({ ...initial(), opened: true, busy: true, phase: 'attaching' });
    try {
      const attached = await this.bridge.attach({ documentNonce: nonce, attachIntent: nextAttachIntent(nonce), expectedUserId: owner.userId });
      if (!this.current(owner)) return null;
      const unknown = attached.pendingIntent;
      const configTracking: DesktopConfigTracking | null = unknown?.operation === 'config' && unknown.roomId
        ? { id: unknown.intentId, roomId: unknown.roomId, phase: 'unknown', target: null, observation: 'target-unavailable' }
        : previousTracking?.phase === 'ended-needs-read' ? previousTracking : null;
      this.publish({ busy: false, phase: previousSession ? 'offline' : 'ready', session: previousSession, unknown, configTracking,
        constrained: !!unknown || !!previousSession || !!configTracking, notice: unknown ? '发现本机尚未确认的原操作，请明确核对；不会自动重发。' : null });
      return owner.token;
    } catch (cause) { if (this.current(owner)) this.failed(cause instanceof ArenaRoomBridgeError ? cause : new ArenaRoomBridgeError('internal-error')); }
    return null;
  }
  async create(details: { title: string; visibility: RoomDirectoryVisibility; displayName: string }, prepare: () => Promise<DesktopRoomSource>, sourceCurrent: () => boolean): Promise<void> {
    if (!this.current() || this.state.busy || this.state.session || this.state.unknown || this.state.configTracking || this.deps.canStart?.() === false) return;
    const owner = this.owner; this.publish({ busy: true, constrained: true, error: null, sourceIssues: [] });
    try {
      const source = await prepare();
      if (!this.current(owner)) return;
      if (!sourceCurrent() || this.deps.canStart?.() === false) { this.publish({ busy: false, constrained: false, error: '本机草稿或其他操作已变化，请重新确认创建。' }); return; }
      if (!source.ok) { this.publish({ busy: false, constrained: false, sourceIssues: source.issues, error: '当前设定不能完整共享。可重新选择来源，或明确选择创建空草稿房间；原草稿不会清除。' }); return; }
      const request: ArenaRoomCreateRequest = { creationRequestId: this.deps.randomId?.() ?? crypto.randomUUID(), displayName: details.displayName, directory: { title: details.title, visibility: details.visibility }, sharedConfig: source.sharedConfig };
      this.publish({ busy: false }); await this.dispatch({ kind: 'create', request });
    } catch { if (this.current(owner)) this.publish({ busy: false, constrained: false, error: '读取当前可共享设定失败，原草稿仍保留。' }); }
  }
  async publishConfig(session: ArenaRoomSessionResponse, sharedConfig: ArenaRoomSharedConfig, identity: symbol, sourceCurrent: () => boolean): Promise<void> {
    if (!this.current() || this.confirmationOwner() !== identity || this.state.session !== session || this.state.busy
      || this.state.unknown || this.state.configTracking || this.deps.canStart?.() === false || !sourceCurrent()
      || session.self.role !== 'host' || session.self.membershipState !== 'active') return;
    const request = ArenaRoomPublishConfigRequestSchema.safeParse({ expectedRoomEpoch: session.roomEpoch,
      expectedRevision: session.snapshot.revision, expectedControlSeq: session.snapshot.controlSeq, sharedConfig });
    if (!request.success) { this.publish({ error: '当前设置不能完整共享，请重新比较。' }); return; }
    const target: ArenaRoomConfigPublishTarget = { roomId: session.roomId, selfUserId: session.self.userId, request: structuredClone(request.data) };
    this.publish({ configTracking: { id: `local-config-${++this.configSequence}`, roomId: session.roomId, phase: 'publishing', target, observation: 'unobserved' } });
    await this.dispatch({ kind: 'config', roomId: session.roomId, request: target.request });
  }
  async checkConfigPublish(): Promise<void> {
    const tracking = this.state.configTracking;
    if (!tracking || tracking.phase !== 'unknown' || this.state.busy || !this.current()) return;
    const owner = this.owner, pendingId = this.state.unknown?.intentId;
    if (this.state.phase === 'unavailable') {
      const token = await this.open();
      if (!token || this.confirmationOwner() !== token || !this.current() || this.owner?.userId !== owner?.userId
        || this.owner?.epoch !== owner?.epoch || this.owner?.nonce !== owner?.nonce
        || (this.state.configTracking && (this.state.configTracking.roomId !== tracking.roomId
          || (pendingId && this.state.configTracking.id !== pendingId)))) return;
    }
    await this.dispatch({ kind: 'session', roomId: tracking.roomId });
  }
  async endConfigTracking(id: string): Promise<void> {
    const tracking = this.state.configTracking, pending = this.state.unknown, owner = this.owner;
    if (!this.current() || this.state.busy || tracking?.phase !== 'unknown' || tracking.id !== id
      || pending?.operation !== 'config' || pending.intentId !== id) return;
    this.flight = null;
    this.publish({ busy: true, session: null, presence: null, snapshotReceived: false });
    try {
      await this.bridge.endConfigTracking(id);
      if (!this.current(owner) || this.state.configTracking?.id !== id) return;
      this.publish({ busy: false, unknown: null, session: null, phase: 'ready', constrained: true,
        configTracking: { ...tracking, phase: 'ended-needs-read', target: null, observation: 'unobserved' },
        notice: '已结束本机跟踪；服务器请求不会因此取消。', error: null });
    } catch {
      if (this.current(owner) && this.state.configTracking?.id === id) this.publish({ busy: false, phase: 'unavailable',
        error: '结束跟踪的回执无法确认，请重新核对本机跟踪与当前房间。' });
    }
  }
  async readConfigAfterEnd(): Promise<void> {
    const tracking = this.state.configTracking, owner = this.owner;
    if (!this.current() || this.state.busy || tracking?.phase !== 'ended-needs-read') return;
    const token = await this.open();
    if (!token || !this.current() || this.state.configTracking !== tracking || this.owner?.userId !== owner?.userId
      || this.owner?.epoch !== owner?.epoch || this.owner?.nonce !== owner?.nonce) return;
    await this.dispatch({ kind: 'session', roomId: tracking.roomId });
  }
  discover = (more = false) => this.dispatch({ kind: 'discover', query: { limit: 50, ...(more && this.state.nextCursor ? { cursor: this.state.nextCursor } : {}) } });
  join = (roomId: string, displayName: string) => {
    if (this.state.session || this.state.unknown || this.state.configTracking || this.deps.canStart?.() === false || !/^[\w-]{1,128}$/u.test(roomId.trim())) return Promise.resolve();
    return this.dispatch({ kind: 'join', roomId: roomId.trim(), request: { displayName } });
  };
  leave = () => { const s = this.state.session; return s && s.self.role === 'member' ? this.dispatch({ kind: 'leave', roomId: s.roomId, expectedRoomEpoch: s.roomEpoch }) : Promise.resolve(); };
  close = () => { const s = this.state.session; return s && s.self.role === 'host' ? this.dispatch({ kind: 'close', roomId: s.roomId, expectedRoomEpoch: s.roomEpoch }) : Promise.resolve(); };
  reconcile = () => {
    const pending = this.state.unknown;
    if (this.state.phase === 'unavailable') return this.open();
    if (!pending) return Promise.resolve();
    if (pending.operation === 'create') return pending.intentId ? this.dispatch({ kind: 'resume-create', intentId: pending.intentId }) : this.open();
    return pending.roomId ? this.dispatch({ kind: 'session', roomId: pending.roomId }) : Promise.resolve();
  };
  reconnect = async () => {
    const session = this.state.session, owner = this.owner;
    if (!session) return this.open();
    if (!this.current(owner)) return;
    if (this.state.phase === 'unavailable') {
      const incarnation = await this.open();
      if (!incarnation || this.confirmationOwner() !== incarnation || !this.current() || this.owner?.userId !== owner?.userId || this.owner?.epoch !== owner?.epoch || this.owner?.nonce !== owner?.nonce) return;
    }
    if (this.state.unknown?.operation === 'create') return;
    return this.dispatch({ kind: 'session', roomId: session.roomId });
  };
  private async dispatch(action: DesktopRoomHttpAction): Promise<void> {
    if (!this.current() || this.state.busy || this.flight) return;
    if (this.state.configTracking?.phase === 'ended-needs-read' && action.kind !== 'session') return;
    if (this.state.unknown && !['session', 'resume-create'].includes(action.kind)) return;
    if (this.state.unknown?.operation === 'create' && action.kind !== 'resume-create') return;
    const owner = this.owner;
    const flight: Flight = { action, operation: action.kind === 'resume-create' ? 'create' : action.kind, requestId: null, accepted: false, acknowledged: false, result: null, subscribe: false, settlesUnknown: false, knownNotApplied: false };
    this.flight = flight;
    this.publish({ busy: true, error: null, constrained: this.state.constrained || isMutation(action), ...(isMutation(action) ? { presence: null } : {}) });
    try {
      const accepted = await this.bridge.request(action);
      if (!this.current(owner) || this.flight !== flight) return;
      if (flight.requestId && flight.requestId !== accepted.requestId) { this.failed(new ArenaRoomBridgeError('invalid-response', isMutation(action) ? 'unknown' : 'not-applicable')); return; }
      flight.requestId = accepted.requestId; flight.accepted = true; this.finishFlight(flight);
    } catch (cause) {
      if (this.current(owner) && this.flight === flight) this.failed(cause instanceof ArenaRoomBridgeError ? cause : new ArenaRoomBridgeError('internal-error', isMutation(action) ? 'unknown' : 'not-applicable'));
    }
  }
  private correlate(requestId: string, operation: DesktopRoomHttpOperation): Flight | null {
    const flight = this.flight;
    if (!flight || flight.operation !== operation || flight.requestId && flight.requestId !== requestId) return null;
    flight.requestId = requestId; return flight;
  }
  private accept(batch: DesktopRoomBatch, context: ArenaRoomAcceptance): boolean {
    if (!this.current() || !context.isCurrent()) return false;
    const event = batch.event;
    if (event.kind === 'http-result' || event.kind === 'request-error') {
      const flight = this.correlate(event.requestId, event.operation); if (!flight) return false;
      if (event.kind === 'request-error') {
        this.applyFailure(new ArenaRoomBridgeError(event.error.code, event.error.outcome, event.error.serverCode), flight); flight.result = 'error';
      } else {
        if (!('result' in event.response)) { this.applyFailure(new ArenaRoomBridgeError('service-rejected', event.response.error.outcome, event.response.error.code), flight); flight.result = 'error'; }
        else {
          if ('roomId' in flight.action && 'roomId' in event.response.result && event.response.result.roomId !== flight.action.roomId) return false;
          flight.result = 'success';
          if (event.operation === 'discover') this.publish({ rooms: event.response.result.items, nextCursor: event.response.result.nextCursor });
          else if (event.operation === 'leave' || event.operation === 'close') this.publish({ session: null, presence: null, snapshotReceived: false, phase: 'ready', notice: event.response.result.outcome === 'left' ? '已离开房间。' : '房间已关闭。' });
          else {
            const result = event.response.result;
            flight.subscribe = true;
            this.publish({ session: result, presence: null, snapshotReceived: false, rooms: [], nextCursor: null, notice: event.operation === 'config' ? '原配置请求已获确认，正在建立在线连接。' : event.operation === 'session' ? '已读取服务器当前房间状态。' : '成员资格已确认，正在建立在线连接。' });
          }
        }
      }
    } else if (event.kind === 'mutation-unknown') {
      if (event.operation === 'config' && event.roomId) this.publish({ configTracking: { id: event.intentId, roomId: event.roomId, phase: 'unknown', target: this.state.configTracking?.target ?? null, observation: this.state.configTracking?.observation ?? 'target-unavailable' } });
      this.publish({ unknown: event, constrained: true, notice: '操作结果尚未确认，请明确核对原意图。' });
    } else if (event.kind === 'status') {
      if (event.state === 'closed') this.publish({ session: null, presence: null, snapshotReceived: false, constrained: !!this.flight || !!this.state.unknown, phase: 'closed', notice: '房间或当前成员资格已结束。' });
      else if (event.state === 'detached' || event.state === 'backpressure' || event.state === 'resync-required') this.publish({ presence: null, snapshotReceived: false, phase: event.state === 'detached' ? 'detached' : 'offline' });
      else this.publish({ phase: event.state, ...(event.state === 'online' ? {} : { presence: null, snapshotReceived: false }) });
    } else this.applySocket(event.message);
    return context.isCurrent() && this.current();
  }
  private acknowledged(batch: DesktopRoomBatch, context: ArenaRoomAcceptance) {
    if (!context.isCurrent() || !this.current()) return;
    const event = batch.event;
    if (event.kind !== 'http-result' && event.kind !== 'request-error') return;
    const flight = this.correlate(event.requestId, event.operation); if (!flight) return;
    flight.acknowledged = true; this.finishFlight(flight);
  }
  private finishFlight(flight: Flight) {
    if (this.flight !== flight || !flight.accepted || !flight.acknowledged || !this.current()) return;
    this.flight = null;
    const settled = flight.settlesUnknown || flight.result === 'success' && flight.operation !== 'discover'
      && (flight.operation !== 'session' || (this.state.unknown?.operation !== 'create' && this.state.unknown?.operation !== 'config'));
    if (settled) this.publish({ unknown: null });
    if (flight.result === 'success' && (flight.operation === 'config' || (flight.operation === 'session' && this.state.configTracking?.phase === 'ended-needs-read'))) this.publish({ configTracking: null });
    this.publish({ busy: false, constrained: this.state.session !== null || this.state.unknown !== null || this.state.configTracking !== null });
    if (flight.subscribe && this.state.session) void this.startSubscription();
  }
  private async startSubscription() {
    const owner = this.owner; const session = this.state.session; if (!session || !this.current()) return;
    this.publish({ busy: true, phase: 'connecting', presence: null, snapshotReceived: false });
    try { await this.bridge.subscribe(session.roomId, session.roomEpoch); if (this.current(owner)) this.publish({ busy: false }); }
    catch (cause) { if (this.current(owner)) this.failed(cause instanceof ArenaRoomBridgeError ? cause : new ArenaRoomBridgeError('internal-error')); }
  }
  private applyFailure(error: ArenaRoomBridgeError, flight: Flight | null) {
    const unknown = flight && isMutation(flight.action) && error.outcome === 'unknown' ? this.state.unknown ?? unknownFor(flight.action) : this.state.unknown;
    const ended = flight?.operation === 'session' && ['ROOM_NOT_FOUND', 'ROOM_FORBIDDEN'].includes(error.serverCode ?? '');
    if (flight && error.outcome === 'not-applied') flight.knownNotApplied = true;
    if (flight?.operation === 'config' && this.state.configTracking) this.publish({ configTracking: error.outcome === 'not-applied' ? null : { ...this.state.configTracking, phase: 'unknown' } });
    if (flight?.operation === 'session' && this.state.configTracking?.phase === 'unknown') this.publish({ configTracking: { ...this.state.configTracking, observation: 'authority-unavailable' } });
    if (ended && flight && this.state.unknown?.operation !== 'create' && this.state.unknown?.operation !== 'config') flight.settlesUnknown = true;
    this.publish({ error: describeDesktopRoomError(error), unknown,
      ...(ended ? { session: null, presence: null, snapshotReceived: false, phase: 'closed' as const } : {}) });
  }
  private failed(error: ArenaRoomBridgeError) {
    if (!this.current()) return;
    const flight = this.flight;
    if (flight?.acknowledged && flight.result === 'success') { flight.accepted = true; this.finishFlight(flight); return; }
    const incompleteMutation = flight && isMutation(flight.action) && !flight.acknowledged
      && !flight.knownNotApplied && error.outcome !== 'not-applied';
    this.applyFailure(incompleteMutation ? new ArenaRoomBridgeError(error.code, 'unknown', error.serverCode) : error, flight); this.flight = null;
    this.publish({ busy: false, constrained: this.state.session !== null || this.state.unknown !== null || this.state.configTracking !== null, presence: null, snapshotReceived: false, phase: 'unavailable' });
  }
  private checkedSession(session: ArenaRoomSessionResponse): ArenaRoomSessionResponse {
    if (jsonUtf8ByteLength(session) > DESKTOP_ROOM_IPC_LIMITS.batchBytes) throw new ArenaRoomBridgeError('backpressure');
    const parsed = ArenaRoomSessionResponseSchema.safeParse(session);
    if (!parsed.success) throw new ArenaRoomBridgeError('invalid-response');
    return parsed.data;
  }
  private applySocket(message: RoomServerTransportMessage) {
    const session = this.state.session; if (!session) return;
    if (message.type === 'room.resync.required') { this.publish({ phase: 'reconnecting', presence: null, snapshotReceived: false }); return; }
    if (message.roomId !== session.roomId || (message.type !== 'room.snapshot' && message.roomEpoch !== session.roomEpoch)) return;
    if (message.type === 'room.presence') {
      if (this.state.snapshotReceived && message.onlineUserIds.every(id => session.snapshot.members.some(member => member.userId === id && member.membershipState === 'active'))) this.publish({ presence: message });
      return;
    }
    if (message.type === 'story.delta') return;
    if (message.type !== 'room.snapshot' && message.controlSeq <= session.snapshot.controlSeq) return;
    if (message.type === 'room.snapshot' && message.roomEpoch === session.roomEpoch && message.controlSeq < session.snapshot.controlSeq) return;
    if (message.type === 'room.closing') { this.publish({ session: null, presence: null, snapshotReceived: false, phase: 'closed', constrained: !!this.flight || !!this.state.unknown, notice: '房间已关闭。' }); return; }
    if (message.type === 'room.snapshot') {
      const self = message.payload.members.find(member => member.userId === session.self.userId && member.membershipState === 'active');
      if (!self) { this.publish({ session: null, presence: null, phase: 'closed', constrained: !!this.flight || !!this.state.unknown, notice: '当前成员资格已结束。' }); return; }
      this.publish({ session: this.checkedSession({ ...session, roomEpoch: message.roomEpoch, self, snapshot: message.payload }), presence: null, snapshotReceived: true }); return;
    }
    if (message.controlSeq !== session.snapshot.controlSeq + 1) { this.publish({ presence: null, snapshotReceived: false, phase: 'reconnecting' }); return; }
    let snapshot = { ...session.snapshot, controlSeq: message.controlSeq }; let self = session.self;
    if (message.type === 'room.member.joined' || message.type === 'room.member.left' || message.type === 'room.host.online' || message.type === 'room.host.offline') {
      const member = message.payload.member;
      snapshot = { ...snapshot, members: snapshot.members.filter(item => item.userId !== member.userId).concat(member) };
      if (member.userId === self.userId) { if (member.membershipState !== 'active') { this.publish({ session: null, presence: null, snapshotReceived: false, phase: 'closed', constrained: !!this.flight || !!this.state.unknown, notice: '当前成员资格已结束。' }); return; } self = member; }
    } else if (message.type === 'room.config.updated') snapshot = { ...snapshot, revision: message.payload.revision, sharedConfig: message.payload.sharedConfig };
    else if (message.type === 'proposal.submitted' || message.type === 'proposal.updated') snapshot = { ...snapshot, proposals: snapshot.proposals.filter(item => item.proposalId !== message.payload.proposal.proposalId).concat(message.payload.proposal) };
    else if (message.type === 'proposal.resolved') snapshot = { ...snapshot, proposals: snapshot.proposals.filter(item => item.proposalId !== message.payload.proposalId) };
    else {
      const current = snapshot.activeGeneration; const payload = message.payload;
      snapshot = { ...snapshot, activeGeneration: { generationRequestId: payload.generationRequestId, generationId: payload.generationId, attempt: payload.attempt,
        configRevision: payload.configRevision, snapshotDigest: payload.snapshotDigest, collaborativeInfluence: payload.collaborativeInfluence,
        participantUserIds: payload.participantUserIds, ...(payload.hostAccountUserId === undefined ? {} : { hostAccountUserId: payload.hostAccountUserId }),
        state: message.type === 'generation.started' ? 'running' : message.type === 'generation.completed' ? 'completed' : 'failed',
        startedAt: current?.generationId === payload.generationId && current.attempt === payload.attempt ? current.startedAt : message.timestamp,
        ...(message.type === 'generation.started' ? {} : { finishedAt: message.timestamp }) } };
    }
    this.publish({ session: this.checkedSession({ ...session, self, snapshot }) });
  }
}
