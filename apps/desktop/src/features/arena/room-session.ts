import { createArenaMemberProposalModel, type ArenaMemberProposalModel } from '@mahoshojo/multiplayer-core/member-proposal';
import { observeArenaRoomConfigPublish, validateProposalChanges, type ArenaRoomConfigPublishTarget, type ArenaRoomConfigPublishObservation, type ArenaRoomProposalReconciliationObservation } from '@mahoshojo/multiplayer-core';
import { ArenaProposalSchema, ArenaRoomProposalResolveRequestSchema, ArenaRoomProposalSubmitRequestSchema, ArenaRoomPublishConfigRequestSchema, ArenaRoomSessionResponseSchema, jsonUtf8ByteLength, type ArenaProposal, type ArenaRoomProposalResolveRequest, type ArenaRoomProposalSubmitRequest, type ArenaRoomCreateRequest, type ArenaRoomSessionResponse, type ArenaRoomSharedConfig, type RoomDirectoryEntry, type RoomDirectoryVisibility, type RoomPresenceSnapshot, type RoomServerTransportMessage } from '@mahoshojo/contracts/arena-room';
import { DesktopRoomSessionRoomIdSchema } from '@mahoshojo/contracts/desktop-room-session';
import { DesktopRoomActionSchema, DESKTOP_ROOM_IPC_LIMITS, getDesktopRoomHttpOperation, type DesktopRoomMutationOperation, type DesktopRoomBatch, type DesktopRoomHttpAction, type DesktopRoomHttpOperation } from '@mahoshojo/contracts/desktop-room-ipc';
import { ArenaRoomBridgeError, createArenaRoomBridge, type ArenaRoomAcceptance, type ArenaRoomChannel } from '../../platform/arena-room-bridge';
import type { InvokeFn } from '../../platform/cloud-bridge';
import type { DesktopCloudSessionStore } from '../account/cloud-session-store';

export type RoomUnknownIntent = { operation: DesktopRoomMutationOperation; roomId: string | null; intentId: string | null };
export type DesktopConfigTracking = { id: string; roomId: string; phase: 'publishing' | 'unknown' | 'ended-needs-read'; target: ArenaRoomConfigPublishTarget | null; observation: ArenaRoomConfigPublishObservation };
type ProposalAction = Extract<DesktopRoomHttpAction, { kind: 'proposal-submit' | 'proposal-withdraw' | 'proposal-resolve' }>;
export type DesktopProposalTracking = { id: string | null; roomId: string; proposalId: string | null; operation: 'proposalSubmit' | 'proposalWithdraw' | 'proposalResolve'; phase: 'resolving' | 'unknown' | 'settled' | 'ended-needs-read'; observation: ArenaRoomProposalReconciliationObservation | null; intent?: ProposalAction | null };
export interface DesktopRoomState {
  opened: boolean; busy: boolean; constrained: boolean;
  phase: 'detached' | 'attaching' | 'ready' | 'connecting' | 'online' | 'offline' | 'reconnecting' | 'closed' | 'unavailable';
  session: ArenaRoomSessionResponse | null; presence: RoomPresenceSnapshot | null; snapshotReceived: boolean;
  rooms: readonly RoomDirectoryEntry[]; nextCursor: string | null;
  configTracking: DesktopConfigTracking | null; proposalTracking: DesktopProposalTracking | null;
  memberModel: ArenaMemberProposalModel | null;
  unknown: RoomUnknownIntent | null; error: string | null; notice: string | null;
  sourceIssues: readonly string[];
}
const initial = (): DesktopRoomState => ({ opened: false, busy: false, constrained: false, phase: 'detached', session: null, presence: null, snapshotReceived: false, rooms: [], nextCursor: null, unknown: null, error: null, notice: null, sourceIssues: [], configTracking: null, proposalTracking: null, memberModel: null });
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
const isProposalOperation = (operation: string | undefined): operation is DesktopProposalTracking['operation'] => operation === 'proposalSubmit' || operation === 'proposalWithdraw' || operation === 'proposalResolve';
const blocksProposalTracking = (tracking: DesktopProposalTracking | null) => !!tracking && tracking.phase !== 'settled';
const unavailableProposalObservation = (): ArenaRoomProposalReconciliationObservation => ({ observation: 'target-unavailable', linked: false, settle: false, outcome: null, terminalStatus: null });
const sameProposalIdentity = (left: ArenaProposal, right: ArenaProposal): boolean => {
  const a = ArenaProposalSchema.safeParse(left), b = ArenaProposalSchema.safeParse(right);
  return a.success && b.success && a.data.proposalVersion === b.data.proposalVersion
    && a.data.proposalId === b.data.proposalId && a.data.roomId === b.data.roomId
    && a.data.authorUserId === b.data.authorUserId && a.data.baseRevision === b.data.baseRevision
    && JSON.stringify(a.data.changes) === JSON.stringify(b.data.changes);
};
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const freezeIntent = <T>(value: T): T => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeIntent); Object.freeze(value); }
  return value;
};
const requiresTrackedObservation = (operation: string | undefined) => operation === 'config' || isProposalOperation(operation);
const isMutation = (action: DesktopRoomHttpAction) => action.kind !== 'discover' && action.kind !== 'session';
const unknownFor = (action: DesktopRoomHttpAction): RoomUnknownIntent | null => {
  if (action.kind === 'create' || action.kind === 'resume-create') return { operation: 'create', roomId: null, intentId: action.kind === 'resume-create' ? action.intentId : null };
  if (action.kind === 'join' || action.kind === 'leave' || action.kind === 'close' || action.kind === 'config') return { operation: action.kind, roomId: action.roomId, intentId: null };
  if (action.kind === 'proposal-submit' || action.kind === 'proposal-withdraw' || action.kind === 'proposal-resolve') return { operation: getDesktopRoomHttpOperation(action) as DesktopRoomMutationOperation, roomId: action.roomId, intentId: null };
  return null;
};
export const describeDesktopRoomError = (error: ArenaRoomBridgeError): string => {
  if (error.code === 'not-authenticated') return '当前房间登录已失效，请重新验证账号后打开房间。';
  if (error.code === 'storage-unavailable') return '本机登录信息暂不可读取。房间已断开，请修复后明确恢复；未确认的操作仍可能已发生。';
  if (error.code === 'backpressure') return '房间消费容量已用尽。请关闭并重新打开应用窗口；刷新页面不会清除未确认的投递。';
  if (error.code === 'busy') return '上一项房间操作尚未结束，请稍后明确重试。';
  if (error.code === 'scope-changed') return '房间、账号或页面已变化，旧操作不再应用。';
  if (error.serverCode === 'ROOM_DESKTOP_OPERATION_UNSUPPORTED') return '服务器不支持此桌面操作，请更新服务端后再明确重试。';
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
  private memberAuthority: ArenaRoomSessionResponse | null = null;
  private proposalRecoveryIntent: string | null = null;
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
  private publish(patch: Partial<DesktopRoomState>, retainMemberDraft = false) {
    const previousModel = this.state.memberModel;
    const wasFresh = this.state.phase === 'online' && this.state.snapshotReceived;
    this.state = { ...this.state, ...patch };
    const tracking = this.state.configTracking;
    if ('session' in patch && tracking?.phase === 'unknown') this.state = { ...this.state,
      configTracking: { ...tracking, observation: observeArenaRoomConfigPublish(tracking.target, this.state.session, true) } };
    if ('session' in patch || 'memberModel' in patch) {
      const session = this.state.session;
      if (previousModel && previousModel !== this.state.memberModel) previousModel.dispose();
      if ((!session && !retainMemberDraft) || (session && (session.self.role !== 'member' || session.self.membershipState !== 'active')) || !this.current()) {
        this.state.memberModel?.dispose();
        this.state = { ...this.state, memberModel: null }; this.memberAuthority = null;
      } else if (session && this.state.memberModel) {
        try { this.state.memberModel.sync(session.snapshot); this.memberAuthority = session; }
        catch { this.state = { ...this.state, snapshotReceived: false, phase: 'offline', error: '房间权威配置不一致，请重新读取后再同步。' }; }
      } else if (session) { this.state = { ...this.state, memberModel: createArenaMemberProposalModel(session.snapshot) }; this.memberAuthority = session; }
    }
    if (this.state.memberModel && !this.state.session) this.state = { ...this.state, constrained: true };
    // Losing trusted freshness permanently expires confirmation and in-flight source
    // generations, even when the same authority returns. Keep the detached draft.
    // Check the final state so a failed model.sync is covered as well as transport loss.
    if (wasFresh && (this.state.phase !== 'online' || !this.state.snapshotReceived)) this.state.memberModel?.invalidatePreview();
    this.listeners.forEach(listener => listener());
  }
  private current(owner = this.owner): boolean {
    if (!owner || owner !== this.owner || this.disposed) return false;
    try { const account = this.deps.account.getSnapshot();
    return account.account?.userId === owner.userId && this.deps.account.getCredentialEpoch() === owner.epoch
      && account.verification === 'verified' && account.authFlow.kind === 'idle' && this.deps.documentNonce() === owner.nonce; } catch { return false; }
  }
  private invalidate() { this.state.memberModel?.dispose(); this.memberAuthority = null; this.proposalRecoveryIntent = null; this.owner = null; this.flight = null; this.bridge.detach(); this.state = { ...staleView }; this.listeners.forEach(listener => listener()); }
  detach = () => { this.proposalRecoveryIntent = null; this.owner = null; this.flight = null; this.bridge.detach(); this.publish({ ...initial(), notice: '已断开本机连接；这不表示已离开房间或停止服务器任务。' }); };
  dispose = () => { this.detach(); this.disposed = true; this.unsubscribe?.(); this.unsubscribe = null; };
  /** Last verified projection is for retained read-only draft presentation, never write authority. */
  memberWorkspaceSession = (): ArenaRoomSessionResponse | null => this.current() && this.state.memberModel ? this.memberAuthority : null;
  confirmationOwner = (): symbol | null => this.current() ? this.owner!.token : null;
  isBusy = () => this.current() && this.state.busy;
  isConstrained = () => this.current() && this.state.constrained;
  needsLeaveConfirmation = () => this.current() && (this.state.busy || this.state.memberModel !== null || this.state.session !== null || this.state.unknown !== null || this.state.configTracking !== null || blocksProposalTracking(this.state.proposalTracking));
  async open(): Promise<symbol | null> {
    if (this.disposed) return null;
    if (this.owner && !this.current()) this.invalidate();
    this.activate();
    if (this.disposed || this.state.busy || this.deps.canStart?.() === false) return null;
    const account = this.deps.account.getSnapshot(); let nonce: string | undefined; try { nonce = this.deps.documentNonce(); } catch { nonce = undefined; }
    if (!account.account || account.verification !== 'verified' || account.authFlow.kind !== 'idle') { this.publish({ opened: true, error: '请先验证并登录账号，再打开多人房间。' }); return null; }
    if (!nonce) { this.publish({ opened: true, error: '当前窗口无法验证房间页面身份，请重新打开应用窗口。' }); return null; }
    const previousTracking = this.current() ? this.state.configTracking : null;
    const previousProposalTracking = this.current() ? this.state.proposalTracking : null;
    const previousSession = this.current() ? this.state.session : null;
    const previousEditor = this.current() ? this.state.memberModel?.store.getState().editor : null;
    const previousMemberAuthority = this.current() ? this.memberAuthority : null;
    const previousUnknown = this.current() ? this.state.unknown : null;
    const owner = { userId: account.account.userId, epoch: this.deps.account.getCredentialEpoch(), nonce, token: Symbol() };
    // Same-account/document recovery retains values, never old callbacks or preview capabilities.
    let memberModel: ArenaMemberProposalModel | null = null;
    if (previousEditor && previousMemberAuthority?.self.role === 'member' && previousMemberAuthority.self.membershipState === 'active') {
      memberModel = createArenaMemberProposalModel({ roomId: previousEditor.roomId, roomEpoch: previousEditor.baselineEpoch,
        revision: previousEditor.baselineRevision, sharedConfig: previousEditor.baselineConfig });
      if (previousEditor.dirty) memberModel.update(() => structuredClone(previousEditor.workingConfig));
      memberModel.sync(previousMemberAuthority.snapshot);
    }
    this.owner = owner; this.flight = null; this.proposalRecoveryIntent = null;
    this.publish({ ...initial(), opened: true, busy: true, phase: 'attaching', session: previousSession, memberModel, constrained: !!previousSession,
      ...(blocksProposalTracking(previousProposalTracking) ? { unknown: previousUnknown, constrained: true,
        proposalTracking: { ...previousProposalTracking!, proposalId: null, observation: unavailableProposalObservation() } } : {}) }, !!memberModel);
    try {
      const attached = await this.bridge.attach({ documentNonce: nonce, attachIntent: nextAttachIntent(nonce), expectedUserId: owner.userId });
      if (!this.current(owner)) return null;
      const unknown = attached.pendingIntent;
      const configTracking: DesktopConfigTracking | null = unknown?.operation === 'config' && unknown.roomId
        ? { id: unknown.intentId, roomId: unknown.roomId, phase: 'unknown', target: null, observation: 'target-unavailable' }
        : previousTracking?.phase === 'ended-needs-read' ? previousTracking : null;
      const proposalTracking: DesktopProposalTracking | null = unknown?.roomId && isProposalOperation(unknown.operation)
        ? { id: unknown.intentId, roomId: unknown.roomId, proposalId: previousProposalTracking?.id === unknown.intentId ? previousProposalTracking.proposalId : null, operation: unknown.operation, phase: 'unknown', observation: unavailableProposalObservation(),
          intent: previousProposalTracking?.id === unknown.intentId && previousProposalTracking.roomId === unknown.roomId && previousProposalTracking.operation === unknown.operation ? previousProposalTracking.intent : null }
        : !unknown && previousProposalTracking && previousProposalTracking.phase !== 'settled'
          ? { ...previousProposalTracking, phase: 'ended-needs-read', proposalId: null, observation: null } : null;
      this.publish({ busy: false, phase: previousSession ? 'offline' : 'ready', session: previousSession, memberModel, unknown, configTracking, proposalTracking,
        constrained: !!unknown || !!previousSession || !!configTracking || blocksProposalTracking(proposalTracking), notice: unknown ? '发现本机尚未确认的原操作，请明确核对；不会自动重发。' : null }, !!memberModel);
      return owner.token;
    } catch (cause) { if (this.current(owner)) this.failed(cause instanceof ArenaRoomBridgeError ? cause : new ArenaRoomBridgeError('internal-error')); }
    return null;
  }
  async create(details: { title: string; visibility: RoomDirectoryVisibility; displayName: string }, prepare: () => Promise<DesktopRoomSource>, sourceCurrent: () => boolean): Promise<void> {
    if (!this.current() || this.state.busy || this.state.session || this.state.memberModel || this.state.unknown || this.state.configTracking || blocksProposalTracking(this.state.proposalTracking) || this.deps.canStart?.() === false) return;
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
      || this.state.unknown || this.state.configTracking || blocksProposalTracking(this.state.proposalTracking) || this.deps.canStart?.() === false || !sourceCurrent()
      || session.self.role !== 'host' || session.self.membershipState !== 'active') return;
    const request = ArenaRoomPublishConfigRequestSchema.safeParse({ expectedRoomEpoch: session.roomEpoch,
      expectedRevision: session.snapshot.revision, expectedControlSeq: session.snapshot.controlSeq, sharedConfig });
    if (!request.success) { this.publish({ error: '当前设置不能完整共享，请重新比较。' }); return; }
    const target: ArenaRoomConfigPublishTarget = { roomId: session.roomId, selfUserId: session.self.userId, request: structuredClone(request.data) };
    this.publish({ configTracking: { id: `local-config-${++this.configSequence}`, roomId: session.roomId, phase: 'publishing', target, observation: 'unobserved' } });
    await this.dispatch({ kind: 'config', roomId: session.roomId, request: target.request });
  }
  /** Snapshot freshness gates actions, never the retained detached draft itself. */
  memberProposalBlockedReason = (): string | null => {
    const state = this.getSnapshot(), session = state.session;
    if (!this.current() || !session || session.self.role !== 'member' || session.self.membershipState !== 'active') return '当前没有可写的成员资格，此处是本页保留的只读草稿，不代表最新房间权威状态；可明确断开本机连接并丢弃草稿，恢复普通 Arena。';
    if (!DesktopRoomSessionRoomIdSchema.safeParse(session.roomId).success) return '此房间标识不支持桌面安全寻址，仅可查看。';
    if (state.busy || this.flight || state.unknown || state.configTracking || blocksProposalTracking(state.proposalTracking)) return '上一项房间操作尚未结束，请先核对当前状态。';
    if (state.phase !== 'online' || !state.snapshotReceived) return '等待当前连接的完整房间快照；提案草稿仍保留。';
    if (this.deps.canStart?.() === false) return '其他本机操作尚未结束，提案草稿仍保留。';
    return null;
  };
  private memberScope(session: ArenaRoomSessionResponse, identity: symbol): boolean {
    const current = this.state.session;
    return this.confirmationOwner() === identity && this.memberProposalBlockedReason() === null && !!current
      && current.roomId === session.roomId && current.roomEpoch === session.roomEpoch && current.self.userId === session.self.userId
      && session.self.role === 'member' && session.self.membershipState === 'active';
  }
  syncMemberProposal(session: ArenaRoomSessionResponse, identity: symbol): void {
    if (!this.memberScope(session, identity) || this.state.session !== session) return;
    this.state.memberModel?.replace(session.snapshot);
  }
  async submitProposal(session: ArenaRoomSessionResponse, intent: ArenaRoomProposalSubmitRequest, identity: symbol): Promise<void> {
    if (!this.memberScope(session, identity)) return;
    const current = this.state.session!;
    const parsed = ArenaRoomProposalSubmitRequestSchema.safeParse(intent);
    if (!parsed.success || canonicalJson(parsed.data) !== canonicalJson(intent)
      || intent.expectedRoomEpoch !== current.roomEpoch || intent.baseRevision > current.snapshot.revision
      || !validateProposalChanges(intent.changes, intent.changes.map(change => change.changeId)).valid) {
      this.publish({ error: '提案意图无效或房间实例已变化，请重新预览。' }); return;
    }
    // baseRevision is diagnostic; expectedBase within each frozen change drives ordinary merges.
    const action: ProposalAction = freezeIntent({ kind: 'proposal-submit', roomId: current.roomId, request: structuredClone(intent) });
    if (!DesktopRoomActionSchema.safeParse(action).success) { this.publish({ error: '此房间或提案标识不支持桌面写入，仍可只读查看。' }); return; }
    if (current.snapshot.proposals.some(proposal => proposal.proposalId === intent.proposalId)) { this.publish({ error: '此提案标识已存在，请先核对原提案。' }); return; }
    this.publish({ proposalTracking: { id: null, roomId: current.roomId, proposalId: intent.proposalId, operation: 'proposalSubmit', phase: 'resolving', observation: null, intent: action } });
    await this.dispatch(action);
  }
  async withdrawProposal(session: ArenaRoomSessionResponse, proposalId: string, identity: symbol): Promise<void> {
    if (!this.memberScope(session, identity)) return;
    const current = this.state.session!;
    const proposal = current.snapshot.proposals.find(item => item.proposalId === proposalId);
    const reviewed = session.snapshot.proposals.find(item => item.proposalId === proposalId);
    if (!proposal || !reviewed || proposal.status !== 'submitted' || reviewed.status !== 'submitted'
      || proposal.authorUserId !== current.self.userId || !sameProposalIdentity(proposal, reviewed)) return;
    const action: ProposalAction = freezeIntent({ kind: 'proposal-withdraw', roomId: current.roomId, proposalId, request: { expectedRoomEpoch: current.roomEpoch } });
    if (!DesktopRoomActionSchema.safeParse(action).success) { this.publish({ error: '此提案标识不支持桌面安全寻址，仅可查看。' }); return; }
    this.publish({ proposalTracking: { id: null, roomId: current.roomId, proposalId, operation: 'proposalWithdraw', phase: 'resolving', observation: null, intent: action } });
    await this.dispatch(action);
  }
  async resolveProposal(session: ArenaRoomSessionResponse, proposal: ArenaProposal, request: ArenaRoomProposalResolveRequest, identity: symbol): Promise<void> {
    const current = this.state.session;
    if (!this.current() || this.confirmationOwner() !== identity || !current || this.state.busy || this.flight
      || this.state.phase !== 'online' || !this.state.snapshotReceived
      || this.state.unknown || this.state.configTracking || blocksProposalTracking(this.state.proposalTracking) || this.deps.canStart?.() === false
      || current.roomId !== session.roomId || current.roomEpoch !== session.roomEpoch || current.self.userId !== session.self.userId
      || current.self.role !== 'host' || current.self.membershipState !== 'active'
      || session.self.role !== 'host' || session.self.membershipState !== 'active') return;
    const pending = current.snapshot.proposals.find(item => item.proposalId === proposal.proposalId);
    const reviewed = session.snapshot.proposals.find(item => item.proposalId === proposal.proposalId);
    if (!pending || !reviewed || pending.status !== 'submitted' || proposal.status !== 'submitted' || reviewed.status !== 'submitted'
      || proposal.roomId !== current.roomId || !sameProposalIdentity(proposal, pending) || !sameProposalIdentity(proposal, reviewed)) {
      this.publish({ error: '提案身份或状态已变化，请重新读取后选择。' }); return;
    }
    const parsed = ArenaRoomProposalResolveRequestSchema.safeParse(request);
    if (!parsed.success || request.expectedRoomEpoch !== current.roomEpoch
      || parsed.data.expectedRoomEpoch !== request.expectedRoomEpoch
      || JSON.stringify(parsed.data.selectedChangeIds) !== JSON.stringify(request.selectedChangeIds)
      || JSON.stringify(parsed.data.overrideChangeIds) !== JSON.stringify(request.overrideChangeIds)
      || (request.resolution === 'accept-selected' && !validateProposalChanges(pending.changes, request.selectedChangeIds).valid)) {
      this.publish({ error: '提案选择无效，请重新检查依赖、原子组与所选变更。' }); return;
    }
    // Ordinary merges retain the user's original selection and diagnostic revision.
    // Only explicit overrides require the exact revision that was reviewed.
    if (request.overrideChangeIds?.length && (request.expectedRevision !== session.snapshot.revision
      || request.expectedRevision !== current.snapshot.revision)) {
      this.publish({ error: '房间配置已变化，请重新审阅冲突后再确认覆盖。' }); return;
    }
    const action = { kind: 'proposal-resolve' as const, roomId: current.roomId, proposalId: proposal.proposalId, request: parsed.data };
    if (!DesktopRoomActionSchema.safeParse(action).success) {
      this.publish({ error: '此房间或提案标识不支持桌面写入，仍可只读查看。' }); return;
    }
    this.publish({ proposalTracking: { id: null, roomId: current.roomId, proposalId: proposal.proposalId, operation: 'proposalResolve', phase: 'resolving', observation: null, intent: freezeIntent(structuredClone(action)) } });
    await this.dispatch(action);
  }
  async checkProposalTracking(): Promise<void> {
    const tracking = this.state.proposalTracking, owner = this.owner;
    if (!this.current() || this.state.busy || tracking?.phase !== 'unknown') return;
    if (this.state.phase === 'unavailable') {
      const token = await this.open();
      if (!token || this.confirmationOwner() !== token || !this.current() || this.owner?.userId !== owner?.userId
        || this.owner?.epoch !== owner?.epoch || this.owner?.nonce !== owner?.nonce
        || this.state.proposalTracking?.phase !== 'unknown' || this.state.proposalTracking.roomId !== tracking.roomId
        || this.state.proposalTracking.operation !== tracking.operation
        || (tracking.id && this.state.proposalTracking.id !== tracking.id)) return;
    }
    await this.dispatch({ kind: 'session', roomId: tracking.roomId });
  }
  async endProposalTracking(intentId: string): Promise<void> {
    const tracking = this.state.proposalTracking, pending = this.state.unknown, owner = this.owner;
    if (!this.current() || this.state.busy || tracking?.phase !== 'unknown' || tracking.id !== intentId
      || !isProposalOperation(pending?.operation) || pending?.intentId !== intentId) return;
    this.flight = null; this.proposalRecoveryIntent = null;
    this.publish({ busy: true, session: null, presence: null, snapshotReceived: false }, true);
    try {
      await this.bridge.endProposalTracking(intentId);
      if (!this.current(owner) || this.state.proposalTracking?.id !== intentId) return;
      this.publish({ busy: false, unknown: null, session: null, phase: 'ready', constrained: true,
        proposalTracking: { ...tracking, phase: 'ended-needs-read', proposalId: null, observation: null },
        notice: '已结束本机提案跟踪；服务器请求不会因此取消。请重新读取房间后再选择。', error: null }, true);
    } catch {
      if (this.current(owner) && this.state.proposalTracking?.id === intentId) this.publish({ busy: false, phase: 'unavailable',
        error: '结束提案跟踪的回执无法确认，请重新核对本机跟踪与当前房间。' });
    }
  }
  async readProposalAfterEnd(): Promise<void> {
    const tracking = this.state.proposalTracking, owner = this.owner;
    if (!this.current() || this.state.busy || tracking?.phase !== 'ended-needs-read') return;
    const token = await this.open();
    const current = this.state.proposalTracking;
    if (!token || !this.current() || current?.phase !== 'ended-needs-read' || current.id !== tracking.id || current.roomId !== tracking.roomId
      || this.owner?.userId !== owner?.userId || this.owner?.epoch !== owner?.epoch || this.owner?.nonce !== owner?.nonce) return;
    await this.dispatch({ kind: 'session', roomId: tracking.roomId });
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
    if (this.state.session || this.state.memberModel || this.state.unknown || this.state.configTracking || blocksProposalTracking(this.state.proposalTracking) || this.deps.canStart?.() === false || !/^[\w-]{1,128}$/u.test(roomId.trim())) return Promise.resolve();
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
    if (this.state.proposalTracking?.phase === 'resolving' && action !== this.state.proposalTracking.intent && action.kind !== 'proposal-resolve') return;
    if ((this.state.configTracking?.phase === 'ended-needs-read' || this.state.proposalTracking?.phase === 'ended-needs-read') && action.kind !== 'session') return;
    if (this.state.unknown && !['session', 'resume-create'].includes(action.kind)) return;
    if (this.state.unknown?.operation === 'create' && action.kind !== 'resume-create') return;
    const owner = this.owner;
    const flight: Flight = { action, operation: getDesktopRoomHttpOperation(action), requestId: null, accepted: false, acknowledged: false, result: null, subscribe: false, settlesUnknown: false, knownNotApplied: false };
    this.flight = flight;
    this.publish({ busy: true, error: null, constrained: this.state.constrained || isMutation(action),
      ...(action.kind === 'session' ? { presence: null, snapshotReceived: false } : {}),
      ...(isMutation(action) ? { presence: null, ...(this.state.proposalTracking?.phase === 'settled' ? { proposalTracking: null } : {}) } : {}) });
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
          else if (event.operation === 'proposalSubmit' || event.operation === 'proposalWithdraw') {
            // Summary receipts never install a complete replica cursor, even if optional state is present.
            const proposalId = flight.action.kind === 'proposal-submit' ? flight.action.request.proposalId
              : flight.action.kind === 'proposal-withdraw' ? flight.action.proposalId : null;
            if (!proposalId || event.response.result.proposalId !== proposalId) return false;
            this.publish({ presence: null, snapshotReceived: false, phase: 'offline', notice: '提案操作回执已确认；请读取房间查看当前状态。' });
          } else if (event.operation === 'proposalResolve') {
            const previous = this.state.session, snapshot = event.response.result.snapshot;
            if (flight.action.kind !== 'proposal-resolve' || event.response.result.proposalId !== flight.action.proposalId
              || !previous || !snapshot || previous.roomId !== snapshot.roomId || previous.roomEpoch !== snapshot.roomEpoch
              || snapshot.controlSeq < previous.snapshot.controlSeq || snapshot.revision < previous.snapshot.revision) return false;
            const result = this.checkedSession({ ...previous, snapshot });
            flight.subscribe = true;
            this.publish({ session: result, presence: null, snapshotReceived: false, rooms: [], nextCursor: null, notice: '提案处理回执已确认，正在建立在线连接。' });
          } else {
            const result = event.response.result;
            // Recovery's observation is a separate delivery; do not retire it by subscribing after the GET ACK.
            flight.subscribe = !(event.operation === 'session' && isProposalOperation(this.state.unknown?.operation));
            if (!flight.subscribe) this.proposalRecoveryIntent = this.state.unknown?.intentId ?? null;
            this.publish({ session: result, presence: null, snapshotReceived: false, rooms: [], nextCursor: null, notice: event.operation === 'config' ? '原配置请求已获确认，正在建立在线连接。' : event.operation === 'session' ? '已读取服务器当前房间状态。' : '成员资格已确认，正在建立在线连接。' });
          }
        }
      }
    } else if (event.kind === 'mutation-unknown') {
      if (event.operation === 'config' && event.roomId) this.publish({ configTracking: { id: event.intentId, roomId: event.roomId, phase: 'unknown', target: this.state.configTracking?.target ?? null, observation: this.state.configTracking?.observation ?? 'target-unavailable' } });
      if (isProposalOperation(event.operation) && event.roomId) {
        const previous = this.state.proposalTracking;
        this.publish({ proposalTracking: { id: event.intentId, roomId: event.roomId, operation: event.operation, phase: 'unknown',
          proposalId: previous?.roomId === event.roomId && previous.operation === event.operation ? previous.proposalId : null,
          intent: previous?.roomId === event.roomId && previous.operation === event.operation ? previous.intent : null, observation: null } });
      }
      this.publish({ unknown: event, constrained: true, notice: '操作结果尚未确认，请明确核对原意图。' });
    } else if (event.kind === 'proposal-observation') {
      // Consumer acceptance alone cannot release the pending intent; wait for its exact Native ACK.
      if (!isProposalOperation(this.state.unknown?.operation) || this.state.unknown?.intentId !== event.intentId) return false;
      if (this.state.proposalTracking?.id === event.intentId) this.publish({ proposalTracking: { ...this.state.proposalTracking, observation: event.observation } });
    } else if (event.kind === 'status') {
      if (event.state === 'closed') this.publish({ session: null, presence: null, snapshotReceived: false, constrained: !!this.flight || !!this.state.unknown || !!this.state.configTracking || blocksProposalTracking(this.state.proposalTracking), phase: 'closed', notice: '房间或当前成员资格已结束。' }, true);
      else if (event.state === 'detached' || event.state === 'backpressure' || event.state === 'resync-required') this.publish({ presence: null, snapshotReceived: false, phase: event.state === 'detached' ? 'detached' : 'offline' });
      else this.publish({ phase: event.state, ...(event.state === 'online' ? {} : { presence: null, snapshotReceived: false }) });
    } else this.applySocket(event.message);
    return context.isCurrent() && this.current();
  }
  private acknowledged(batch: DesktopRoomBatch, context: ArenaRoomAcceptance) {
    if (!context.isCurrent() || !this.current()) return;
    const event = batch.event;
    if (event.kind === 'proposal-observation') {
      if (!isProposalOperation(this.state.unknown?.operation) || this.state.unknown?.intentId !== event.intentId) return;
      const observation = event.observation;
      this.publish({ ...(observation.settle ? { unknown: null } : {}),
        ...(this.state.proposalTracking?.id === event.intentId ? { proposalTracking: { ...this.state.proposalTracking, observation, phase: observation.settle ? 'settled' as const : 'unknown' as const } } : {}),
        constrained: this.state.session !== null || !observation.settle || this.state.configTracking !== null,
        notice: observation.settle
          ? observation.outcome === 'scope-unverified' ? '已观察到提案部分接受；具体接受范围尚无法确认。'
            : observation.outcome === 'different' ? '已观察到提案结束，结果与原意图不同。' : '已观察到与原意图一致的提案状态；这不证明由原请求造成。'
          : '尚未取得足够关联证据，保留原提案防重发状态。',
      });
      if (this.proposalRecoveryIntent === event.intentId) {
        this.proposalRecoveryIntent = null;
        if (this.flight?.operation === 'session') this.flight.subscribe = true;
        else if (!this.flight && this.state.session) void this.startSubscription();
      }
      return;
    }
    if (event.kind !== 'http-result' && event.kind !== 'request-error') return;
    const flight = this.correlate(event.requestId, event.operation); if (!flight) return;
    flight.acknowledged = true; this.finishFlight(flight);
  }
  private finishFlight(flight: Flight) {
    if (this.flight !== flight || !flight.accepted || !flight.acknowledged || !this.current()) return;
    this.flight = null;
    const settled = flight.settlesUnknown || flight.result === 'success' && flight.operation !== 'discover'
      && (flight.operation !== 'session' || (this.state.unknown?.operation !== 'create' && !requiresTrackedObservation(this.state.unknown?.operation)));
    if (settled) this.publish({ unknown: null });
    if (flight.result === 'success' && (flight.operation === 'config' || (flight.operation === 'session' && this.state.configTracking?.phase === 'ended-needs-read'))) this.publish({ configTracking: null });
    if (flight.result === 'success' && isProposalOperation(flight.operation) && this.state.proposalTracking) this.publish({ proposalTracking: { ...this.state.proposalTracking, phase: 'settled', observation: null } });
    if (flight.result === 'success' && flight.operation === 'session' && this.state.proposalTracking?.phase === 'ended-needs-read') this.publish({ proposalTracking: null });
    this.publish({ busy: false, constrained: this.state.session !== null || this.state.unknown !== null || this.state.configTracking !== null || blocksProposalTracking(this.state.proposalTracking) });
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
    if (isProposalOperation(flight?.operation) && this.state.proposalTracking) this.publish({ proposalTracking: error.outcome === 'not-applied' ? null : { ...this.state.proposalTracking, phase: 'unknown' } });
    if (flight?.operation === 'session' && this.state.configTracking?.phase === 'unknown') this.publish({ configTracking: { ...this.state.configTracking, observation: 'authority-unavailable' } });
    if (ended && flight && this.state.unknown?.operation !== 'create' && !requiresTrackedObservation(this.state.unknown?.operation)) flight.settlesUnknown = true;
    this.publish({ error: describeDesktopRoomError(error), unknown,
      ...(ended ? { session: null, presence: null, snapshotReceived: false, phase: 'closed' as const } : {}) }, ended);
  }
  private failed(error: ArenaRoomBridgeError) {
    if (!this.current()) return;
    const flight = this.flight;
    if (flight?.acknowledged && flight.result === 'success') { flight.accepted = true; this.finishFlight(flight); return; }
    const incompleteMutation = flight && isMutation(flight.action) && !flight.acknowledged
      && !flight.knownNotApplied && error.outcome !== 'not-applied';
    this.applyFailure(incompleteMutation ? new ArenaRoomBridgeError(error.code, 'unknown', error.serverCode) : error, flight); this.flight = null;
    this.publish({ busy: false, constrained: this.state.session !== null || this.state.unknown !== null || this.state.configTracking !== null || blocksProposalTracking(this.state.proposalTracking), presence: null, snapshotReceived: false, phase: 'unavailable' });
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
    if (message.type === 'room.closing') { this.publish({ session: null, presence: null, snapshotReceived: false, phase: 'closed', constrained: !!this.flight || !!this.state.unknown || !!this.state.configTracking || blocksProposalTracking(this.state.proposalTracking), notice: '房间已关闭。' }, true); return; }
    if (message.type === 'room.snapshot') {
      const self = message.payload.members.find(member => member.userId === session.self.userId && member.membershipState === 'active');
      if (!self) { this.publish({ session: null, presence: null, snapshotReceived: false, phase: 'closed', constrained: !!this.flight || !!this.state.unknown || !!this.state.configTracking || blocksProposalTracking(this.state.proposalTracking), notice: '当前成员资格已结束。' }, true); return; }
      this.publish({ session: this.checkedSession({ ...session, roomEpoch: message.roomEpoch, self, snapshot: message.payload }), presence: null, snapshotReceived: true }); return;
    }
    if (message.controlSeq !== session.snapshot.controlSeq + 1) { this.publish({ presence: null, snapshotReceived: false, phase: 'reconnecting' }); return; }
    let snapshot = { ...session.snapshot, controlSeq: message.controlSeq }; let self = session.self;
    if (message.type === 'room.member.joined' || message.type === 'room.member.left' || message.type === 'room.host.online' || message.type === 'room.host.offline') {
      const member = message.payload.member;
      snapshot = { ...snapshot, members: snapshot.members.filter(item => item.userId !== member.userId).concat(member) };
      if (member.userId === self.userId) { if (member.membershipState !== 'active') { this.publish({ session: null, presence: null, snapshotReceived: false, phase: 'closed', constrained: !!this.flight || !!this.state.unknown || !!this.state.configTracking || blocksProposalTracking(this.state.proposalTracking), notice: '当前成员资格已结束。' }, true); return; } self = member; }
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
