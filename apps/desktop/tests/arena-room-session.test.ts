import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArenaRoomCreateRequestSchema, ArenaRoomSessionResponseSchema } from '@mahoshojo/contracts/arena-room';
import {
  DESKTOP_ROOM_ERROR_MESSAGE, DESKTOP_ROOM_IPC_COMMANDS,
  DesktopRoomBatchSchema, DesktopRoomEventSchema, DesktopRoomRequestSchema,
  type DesktopRoomAttachResponse, type DesktopRoomEvent, type DesktopRoomHttpAction,
  type DesktopRoomHttpOperation,
} from '@mahoshojo/contracts/desktop-room-ipc';
import { DesktopCloudSessionStore } from '../src/features/account/cloud-session-store';
import { DesktopArenaRoomSession, type DesktopRoomSource, type DesktopRoomState } from '../src/features/arena/room-session';
import { type ArenaRoomChannel } from '../src/platform/arena-room-bridge';
import { CLOUD_AUTH_STATUS_COMMAND, CLOUD_SIGN_OUT_COMMAND } from '../src/platform/cloud-bridge';

const fixture = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/desktop-room-ipc.json', import.meta.url), 'utf8'));
const events: DesktopRoomEvent[] = fixture.pulls.map((pull: { batch: unknown }) => DesktopRoomBatchSchema.parse(pull.batch).event);
const createRequest = ArenaRoomCreateRequestSchema.parse(fixture.requests.find((entry: { request: { kind: string } }) => entry.request.kind === 'create').request.request);
const host = ArenaRoomSessionResponseSchema.parse(fixture.pulls[2].batch.event.response.result);
const member = ArenaRoomSessionResponseSchema.parse({ ...host, self: host.snapshot.members.find(value => value.role === 'member') });
const details = { ...createRequest.directory, displayName: createRequest.displayName };
const source = (): Promise<DesktopRoomSource> => Promise.resolve({ ok: true, sharedConfig: createRequest.sharedConfig });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const success = (operation: DesktopRoomHttpOperation, requestId: string, result?: unknown): DesktopRoomEvent => {
  const event = events.find(value => value.kind === 'http-result' && value.operation === operation && 'result' in value.response);
  if (!event || event.kind !== 'http-result') throw new Error(`Missing canonical ${operation} success`);
  return DesktopRoomEventSchema.parse({ ...event, requestId, response: { ...event.response, ...(result === undefined ? {} : { result }) } });
};
const socket = (type: string): DesktopRoomEvent => {
  const event = events.find(value => value.kind === 'socket' && value.message.type === type);
  if (!event) throw new Error(`Missing canonical ${type} message`);
  return event;
};
const whenState = (session: DesktopArenaRoomSession, predicate: (state: DesktopRoomState) => boolean): Promise<void> => {
  if (predicate(session.getSnapshot())) return Promise.resolve();
  return new Promise(resolve => {
    const unsubscribe = session.subscribe(() => {
      if (predicate(session.getSnapshot())) { unsubscribe(); resolve(); }
    });
  });
};

const sessions: DesktopArenaRoomSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); });

async function harness() {
  // Use the real account store, session and bridge. Only the Native boundary and
  // immutable Document identity are controlled; no private methods are replaced.
  const account = new DesktopCloudSessionStore({ invoke: async command => {
    if (command === CLOUD_AUTH_STATUS_COMMAND) return { state: 'active', account: { userId: fixture.expectedUserId, username: 'room-test', displayName: '房间测试' } };
    if (command === CLOUD_SIGN_OUT_COMMAND) return { revoked: true };
    throw new Error(`Unexpected account command: ${command}`);
  } });
  await account.refresh();
  let nonce: string | undefined = fixture.attachRequest.documentNonce;
  let nonceThrows = false;
  let canStart = true;
  let subscriptionId = '';
  let attachCount = 0;
  let subscribeCount = 0;
  let sequence = 0;
  let requestCount = 0;
  let pendingIntent: DesktopRoomAttachResponse['pendingIntent'] = null;
  const attachGates: Array<{
    entered: ReturnType<typeof deferred<DesktopRoomAttachResponse>>;
    response: ReturnType<typeof deferred<unknown>>;
  }> = [];
  const channels: ArenaRoomChannel[] = [];
  const requests: DesktopRoomHttpAction[] = [];
  type HttpPlan = {
    kind: DesktopRoomHttpAction['kind']; requestId: string;
    entered: ReturnType<typeof deferred<DesktopRoomHttpAction>>;
    response: ReturnType<typeof deferred<unknown>>;
  };
  const plans: HttpPlan[] = [];
  type Delivery = {
    batch: ReturnType<typeof DesktopRoomBatchSchema.parse>;
    pulled: ReturnType<typeof deferred<void>>;
    ackEntered: ReturnType<typeof deferred<void>>;
    ack: ReturnType<typeof deferred<unknown>>;
  };
  const deliveries: Delivery[] = [];
  const awaitingAck = new Map<string, Delivery>();
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === DESKTOP_ROOM_IPC_COMMANDS.attach) {
      subscriptionId = `lobby-${++attachCount}`;
      const response: DesktopRoomAttachResponse = { ...fixture.attach, subscriptionId, pendingIntent };
      const gate = attachGates.shift();
      if (gate) { gate.entered.resolve(response); return gate.response.promise; }
      return response;
    }
    if (command === DESKTOP_ROOM_IPC_COMMANDS.detach) return fixture.detach;
    if (command === DESKTOP_ROOM_IPC_COMMANDS.subscribe) {
      subscriptionId = `socket-${++subscribeCount}`;
      return { handle: fixture.attach.handle, subscriptionId };
    }
    if (command !== DESKTOP_ROOM_IPC_COMMANDS.request) throw new Error(`Unexpected room command: ${command}`);
    const { request } = DesktopRoomRequestSchema.parse(args?.request);
    if (request.kind === 'pull') {
      const next = deliveries.shift();
      if (!next) throw new Error('Unexpected pull');
      expect(request.subscriptionId).toBe(next.batch.subscriptionId);
      next.pulled.resolve();
      return { kind: 'batch', batch: next.batch };
    }
    if (request.kind === 'ack') {
      const delivery = awaitingAck.get(request.batchId);
      if (!delivery) throw new Error('Unexpected acknowledgement');
      expect(request).toMatchObject({ subscriptionId: delivery.batch.subscriptionId, sequence: delivery.batch.sequence });
      awaitingAck.delete(request.batchId);
      delivery.ackEntered.resolve();
      return delivery.ack.promise;
    }
    requests.push(request);
    const plan = plans.shift();
    if (!plan || request.kind !== plan.kind) throw new Error(`Unexpected HTTP action: ${request.kind}`);
    plan.entered.resolve(request);
    return plan.response.promise;
  });
  const randomId = vi.fn(() => createRequest.creationRequestId);
  const session = new DesktopArenaRoomSession({
    invoke, account, randomId, canStart: () => canStart,
    documentNonce: () => { if (nonceThrows) throw new Error('Document unavailable'); return nonce; },
    createChannel: () => { const channel = { onmessage: (_value: unknown) => undefined }; channels.push(channel); return channel; },
  });
  sessions.push(session);
  const plan = (kind: HttpPlan['kind']) => {
    const value = { kind, requestId: `request-${++requestCount}`, entered: deferred<DesktopRoomHttpAction>(), response: deferred<unknown>() };
    plans.push(value);
    return { ...value, accept: () => value.response.resolve({ kind: 'accepted', handle: fixture.attach.handle, subscriptionId, requestId: value.requestId }) };
  };
  const emit = (event: DesktopRoomEvent) => {
    const batch = DesktopRoomBatchSchema.parse({ handle: fixture.attach.handle, subscriptionId, sequence: sequence++, batchId: `batch-${sequence}`, event });
    const delivery = { batch, pulled: deferred<void>(), ackEntered: deferred<void>(), ack: deferred<unknown>() };
    deliveries.push(delivery); awaitingAck.set(batch.batchId, delivery);
    channels.at(-1)!.onmessage({ type: 'available', handle: batch.handle, subscriptionId, sequence: batch.sequence });
    return { ...delivery, acknowledge: (patch: Record<string, unknown> = {}) => delivery.ack.resolve({
      kind: 'acknowledged', handle: batch.handle, subscriptionId: batch.subscriptionId,
      batchId: batch.batchId, sequence: batch.sequence, accepted: true, ...patch,
    }) };
  };
  const receive = async (event: DesktopRoomEvent) => {
    const delivery = emit(event);
    await delivery.ackEntered.promise;
    delivery.acknowledge();
  };
  return { session, account, invoke, randomId, requests, channels, plan, emit, receive,
    holdAttach: () => {
      const gate = { entered: deferred<DesktopRoomAttachResponse>(), response: deferred<unknown>() };
      attachGates.push(gate); return gate;
    },
    subscriptions: () => invoke.mock.calls.filter(([command]) => command === DESKTOP_ROOM_IPC_COMMANDS.subscribe),
    setNonce: (value: string | undefined) => { nonce = value; },
    throwNonce: () => { nonceThrows = true; },
    setCanStart: (value: boolean) => { canStart = value; },
    setPending: (value: DesktopRoomAttachResponse['pendingIntent']) => { pendingIntent = value; },
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;

async function joinRoom(h: Harness, result = member) {
  await h.session.open();
  const request = h.plan('join');
  const joining = h.session.join(member.roomId, member.self.displayName);
  await request.entered.promise;
  request.accept(); await joining;
  const ready = whenState(h.session, state => !state.busy && state.phase === 'connecting');
  await h.receive(success('join', request.requestId, result));
  await ready;
}

describe('Desktop Arena Room session through the real Native bridge', () => {
  it.each(['create', 'join'] as const)('keeps early %s availability behind accepted and exact ACK before subscribing, then permits the role-appropriate exit', async kind => {
    const h = await harness(); await h.session.open();
    const request = h.plan(kind);
    const operation = kind === 'create' ? h.session.create(details, source, () => true) : h.session.join(member.roomId, member.self.displayName);
    await request.entered.promise;
    const result = kind === 'create' ? host : member;
    const delivery = h.emit(success(kind, request.requestId, result));
    // Native invokes use one lane: early availability cannot pull its body until
    // accepted returns. This deliberately does not fabricate an earlier ACK.
    expect(h.subscriptions()).toHaveLength(0);
    expect(h.invoke.mock.calls.filter(([, args]) => (args?.request as { request?: { kind: string } })?.request?.kind === 'pull')).toHaveLength(0);
    request.accept(); await operation;
    await delivery.ackEntered.promise;
    expect(h.session.getSnapshot()).toMatchObject({ busy: true, constrained: true, session: { roomId: result.roomId }, snapshotReceived: false, presence: null });
    expect(h.subscriptions()).toHaveLength(0);
    const ready = whenState(h.session, state => !state.busy && state.phase === 'connecting');
    delivery.acknowledge(); await ready;
    expect(h.subscriptions()).toEqual([[DESKTOP_ROOM_IPC_COMMANDS.subscribe, { request: { handle: fixture.attach.handle, roomId: result.roomId, expectedRoomEpoch: result.roomEpoch } }]]);
    expect(h.session.needsLeaveConfirmation()).toBe(true);
    await (kind === 'create' ? h.session.leave() : h.session.close());
    expect(h.requests).toHaveLength(1);

    const exitKind = kind === 'create' ? 'close' : 'leave';
    const exit = h.plan(exitKind);
    const exiting = kind === 'create' ? h.session.close() : h.session.leave();
    expect(await exit.entered.promise).toEqual({ kind: exitKind, roomId: result.roomId, expectedRoomEpoch: result.roomEpoch });
    exit.accept(); await exiting;
    const idle = whenState(h.session, state => !state.busy && state.session === null);
    await h.receive(success(exitKind, exit.requestId)); await idle;
    expect(h.session.isConstrained()).toBe(false);
    expect(h.session.needsLeaveConfirmation()).toBe(false);
    expect(h.subscriptions()).toHaveLength(1);
  });

  it.each([{ accepted: false }, { batchId: 'wrong-batch' }])('never subscribes on an invalid ACK receipt %j', async patch => {
    const h = await harness(); await h.session.open();
    const request = h.plan('join'); const joining = h.session.join(member.roomId, member.self.displayName);
    await request.entered.promise; request.accept(); await joining;
    const delivery = h.emit(success('join', request.requestId, member)); await delivery.ackEntered.promise;
    const unavailable = whenState(h.session, state => state.phase === 'unavailable');
    delivery.acknowledge(patch); await unavailable;
    expect(h.subscriptions()).toHaveLength(0);
    expect(h.session.getSnapshot()).toMatchObject({ busy: false, presence: null, snapshotReceived: false });
  });

  it('requires explicit reopen and resume-create for an unknown create without allocating a replacement creation ID', async () => {
    const h = await harness(); await h.session.open();
    const request = h.plan('create'); const creating = h.session.create(details, source, () => true);
    await request.entered.promise;
    request.response.reject({ code: 'network-error', message: DESKTOP_ROOM_ERROR_MESSAGE, outcome: 'unknown' });
    await creating;
    expect(h.session.getSnapshot()).toMatchObject({ phase: 'unavailable', unknown: { operation: 'create', intentId: null, roomId: null } });
    expect(h.requests.map(value => value.kind)).toEqual(['create']);
    expect(h.randomId).toHaveBeenCalledTimes(1);
    const pending = { operation: 'create' as const, roomId: null, intentId: 'original-create-intent' };
    h.setPending(pending); await h.session.reconcile();
    expect(h.session.getSnapshot()).toMatchObject({ phase: 'ready', unknown: pending, constrained: true });
    await h.session.create(details, source, () => true); await h.session.join(member.roomId, '成员'); await h.session.discover();
    expect(h.requests.map(value => value.kind)).toEqual(['create']);
    const resume = h.plan('resume-create'); const reconciling = h.session.reconcile();
    expect(await resume.entered.promise).toEqual({ kind: 'resume-create', intentId: pending.intentId });
    resume.accept(); await reconciling;
    const ready = whenState(h.session, state => !state.busy && state.phase === 'connecting');
    await h.receive(success('create', resume.requestId, host)); await ready;
    expect(h.randomId).toHaveBeenCalledTimes(1);
    expect(h.requests.map(value => value.kind)).toEqual(['create', 'resume-create']);
    expect(h.session.getSnapshot().unknown).toBeNull();
  });

  it.each(['native-rejected', 'invalid-receipt'] as const)('preserves create uncertainty after an %s ACK and resumes only the original Native intent', async failure => {
    const h = await harness(); await h.session.open();
    const request = h.plan('create'); const creating = h.session.create(details, source, () => true);
    await request.entered.promise; request.accept(); await creating;
    const delivery = h.emit(success('create', request.requestId, host)); await delivery.ackEntered.promise;
    expect(h.session.getSnapshot()).toMatchObject({ busy: true, constrained: true, session: host, snapshotReceived: false });
    const unavailable = whenState(h.session, state => state.phase === 'unavailable');
    delivery.acknowledge(failure === 'native-rejected' ? { accepted: false } : { batchId: 'not-the-accepted-batch' });
    await unavailable;
    expect(h.session.getSnapshot()).toMatchObject({
      busy: false, constrained: true, unknown: { operation: 'create', roomId: null },
      presence: null, snapshotReceived: false,
    });
    expect(h.subscriptions()).toHaveLength(0);
    expect(h.requests.map(value => value.kind)).toEqual(['create']);

    const pending = { operation: 'create' as const, roomId: null, intentId: 'native-unacknowledged-create' };
    h.setPending(pending);
    await h.session.reconnect();
    expect(h.session.getSnapshot()).toMatchObject({ unknown: pending, constrained: true });
    // A reconnect button cannot reinterpret an unacknowledged create as a GET
    // membership recovery or allocate a replacement mutation identity.
    await h.session.reconnect();
    await h.session.create(details, source, () => true);
    expect(h.requests.map(value => value.kind)).toEqual(['create']);
    expect(h.randomId).toHaveBeenCalledTimes(1);
    expect(h.subscriptions()).toHaveLength(0);

    const resume = h.plan('resume-create'); const reconciling = h.session.reconcile();
    expect(await resume.entered.promise).toEqual({ kind: 'resume-create', intentId: pending.intentId });
    resume.accept(); await reconciling;
    const resumed = h.emit(success('create', resume.requestId, host)); await resumed.ackEntered.promise;
    expect(h.session.getSnapshot().unknown).toEqual(pending);
    expect(h.subscriptions()).toHaveLength(0);
    const ready = whenState(h.session, state => !state.busy && state.phase === 'connecting');
    resumed.acknowledge(); await ready;
    expect(h.session.getSnapshot().unknown).toBeNull();
    expect(h.requests.map(value => value.kind)).toEqual(['create', 'resume-create']);
    expect(h.randomId).toHaveBeenCalledTimes(1);
  });

  it('retains the verified room without claiming online when Native committed the create ACK but its reply was lost', async () => {
    const h = await harness(); await h.session.open();
    const request = h.plan('create'); const creating = h.session.create(details, source, () => true);
    await request.entered.promise; request.accept(); await creating;
    const delivery = h.emit(success('create', request.requestId, host)); await delivery.ackEntered.promise;
    // Native's next attach is the authority for its receipt. The renderer sees
    // only a rejected invoke and must not infer whether that receipt committed.
    h.setPending(null);
    const unavailable = whenState(h.session, state => state.phase === 'unavailable');
    delivery.ack.reject(new Error('ACK response transport lost')); await unavailable;
    expect(h.session.getSnapshot()).toMatchObject({
      session: host, constrained: true, unknown: { operation: 'create', roomId: null },
      presence: null, snapshotReceived: false,
    });
    expect(h.requests.map(value => value.kind)).toEqual(['create']);
    expect(h.subscriptions()).toHaveLength(0);

    await h.session.open();
    expect(h.session.getSnapshot()).toMatchObject({ session: host, unknown: null, constrained: true, presence: null, snapshotReceived: false, busy: false });
    expect(h.session.getSnapshot().phase).not.toBe('online');
    expect(h.subscriptions()).toHaveLength(0);
    expect(h.requests.map(value => value.kind)).toEqual(['create']);
    const read = h.plan('session'); const reconnecting = h.session.reconnect();
    expect(await read.entered.promise).toEqual({ kind: 'session', roomId: host.roomId });
    read.accept(); await reconnecting;
    const ready = whenState(h.session, state => !state.busy && state.phase === 'connecting');
    await h.receive(success('session', read.requestId, host)); await ready;
    expect(h.requests.map(value => value.kind)).toEqual(['create', 'session']);
    expect(h.subscriptions()).toHaveLength(1);
    expect(h.randomId).toHaveBeenCalledTimes(1);
  });

  it.each(
    (['join', 'leave', 'close'] as const).flatMap(operation =>
      (['ROOM_NOT_FOUND', 'ROOM_FORBIDDEN'] as const).flatMap(code =>
        (['exact', 'rejected'] as const).map(ack => ({ operation, code, ack })))),
  )('settles an unknown $operation on matched $code only after an $ack ACK', async ({ operation, code, ack }) => {
    const h = await harness();
    const pending = { operation, roomId: member.roomId, intentId: `unknown-${operation}` };
    h.setPending(pending); await h.session.open();
    const read = h.plan('session'); const reconciling = h.session.reconcile();
    expect(await read.entered.promise).toEqual({ kind: 'session', roomId: pending.roomId });
    read.accept(); await reconciling;
    const error = DesktopRoomEventSchema.parse({
      ...fixture.pulls[7].batch.event, requestId: read.requestId,
      response: {
        desktopRoom: { version: 'desktop-room-session-v1', viewerUserId: fixture.expectedUserId },
        error: { code, message: '房间或成员资格已结束', outcome: 'not-applicable' },
      },
    });
    const delivery = h.emit(error); await delivery.ackEntered.promise;
    expect(h.session.getSnapshot()).toMatchObject({ busy: true, constrained: true, unknown: pending });
    expect(h.session.needsLeaveConfirmation()).toBe(true);
    const finished = whenState(h.session, state => !state.busy);
    delivery.acknowledge({ accepted: ack === 'exact' }); await finished;
    if (ack === 'exact') {
      expect(h.session.getSnapshot()).toMatchObject({ phase: 'closed', unknown: null, constrained: false, session: null });
      expect(h.session.needsLeaveConfirmation()).toBe(false);
    } else {
      expect(h.session.getSnapshot()).toMatchObject({ phase: 'unavailable', unknown: pending, constrained: true });
      expect(h.session.needsLeaveConfirmation()).toBe(true);
    }
    expect(h.requests).toEqual([{ kind: 'session', roomId: pending.roomId }]);
    expect(h.subscriptions()).toHaveLength(0); expect(h.randomId).not.toHaveBeenCalled();
  });

  it.each(['source-changed', 'other-operation', 'signed-out', 'document-changed'] as const)('does not POST or allocate an ID when %s invalidates source preparation', async change => {
    const h = await harness(); await h.session.open();
    const prepared = deferred<DesktopRoomSource>(); let current = true;
    const prepare = vi.fn(() => prepared.promise);
    const creating = h.session.create(details, prepare, () => current);
    expect(prepare).toHaveBeenCalledTimes(1); expect(h.session.isBusy()).toBe(true);
    if (change === 'source-changed') current = false;
    if (change === 'other-operation') h.setCanStart(false);
    if (change === 'signed-out') await h.account.signOut();
    if (change === 'document-changed') h.setNonce('b'.repeat(64));
    prepared.resolve({ ok: true, sharedConfig: createRequest.sharedConfig }); await creating;
    expect(h.requests).toEqual([]); expect(h.randomId).not.toHaveBeenCalled();
    expect(h.session.isConstrained()).toBe(false); expect(h.session.isBusy()).toBe(false);
  });

  it('keeps unshareable source diagnostics and never silently creates an empty room', async () => {
    const h = await harness(); await h.session.open();
    await h.session.create(details, async () => ({ ok: false, issues: ['来源无法验证'] }), () => true);
    expect(h.session.getSnapshot()).toMatchObject({ sourceIssues: ['来源无法验证'], busy: false, constrained: false });
    expect(h.requests).toEqual([]); expect(h.randomId).not.toHaveBeenCalled();
  });

  it.each(['signed-out', 'detach', 'document-changed'] as const)('retires %s while an ACK is in flight without subscribing or reviving its old room', async change => {
    const h = await harness(); await h.session.open();
    const request = h.plan('join'); const joining = h.session.join(member.roomId, member.self.displayName);
    await request.entered.promise; request.accept(); await joining;
    const delivery = h.emit(success('join', request.requestId, member)); await delivery.ackEntered.promise;
    if (change === 'signed-out') await h.account.signOut();
    if (change === 'detach') h.session.detach();
    if (change === 'document-changed') h.setNonce('b'.repeat(64));
    expect(h.session.getSnapshot()).toMatchObject({ session: null, presence: null, snapshotReceived: false });
    expect(h.session.isBusy()).toBe(false); expect(h.session.isConstrained()).toBe(false);
    delivery.acknowledge();
    if (change === 'signed-out') await h.account.refresh();
    // The new attach shares the Native lane, so completing it also proves that
    // the delayed old receipt and retirement have passed through that lane.
    await h.session.open();
    expect(h.session.getSnapshot()).toMatchObject({ phase: 'ready', session: null, busy: false, unknown: null });
    expect(h.subscriptions()).toHaveLength(0);
    expect(h.requests.map(value => value.kind)).toEqual(['join']);
  });

  it('does not reconnect an old room into a replacement owner after same-account verification retires a delayed attach', async () => {
    const h = await harness(); await joinRoom(h);
    const delivery = h.emit({ kind: 'status', state: 'offline' }); await delivery.ackEntered.promise;
    const unavailable = whenState(h.session, state => state.phase === 'unavailable');
    delivery.ack.reject(new Error('Socket status ACK transport lost')); await unavailable;
    expect(h.session.getSnapshot()).toMatchObject({ session: member, unknown: null });
    const userId = h.account.getSnapshot().account!.userId;
    const credentialEpoch = h.account.getCredentialEpoch();
    const gate = h.holdAttach();
    const reconnecting = h.session.reconnect();
    const oldAttach = await gate.entered.promise;
    const oldOwner = h.session.confirmationOwner();
    expect(oldOwner).not.toBeNull();

    const verifying = h.account.refresh();
    expect(h.account.getSnapshot().verification).toBe('checking');
    expect(h.session.confirmationOwner()).toBeNull();
    await verifying;
    expect(h.account.getSnapshot()).toMatchObject({ verification: 'verified', account: { userId } });
    expect(h.account.getCredentialEpoch()).toBe(credentialEpoch);
    const reopening = h.session.open();
    const replacementOwner = h.session.confirmationOwner();
    expect(replacementOwner).not.toBeNull(); expect(replacementOwner).not.toBe(oldOwner);
    gate.response.resolve(oldAttach);
    await reconnecting;
    expect(await reopening).toBe(replacementOwner);
    expect(h.session.confirmationOwner()).toBe(replacementOwner);
    expect(h.session.getSnapshot()).toMatchObject({ phase: 'ready', session: null, unknown: null, busy: false });
    expect(h.requests.map(value => value.kind)).toEqual(['join']);
    expect(h.subscriptions()).toHaveLength(1);
  });

  it.each(['leave', 'close'] as const)('rejects a %s success for another room without presenting success or clearing its original membership', async operation => {
    const h = await harness();
    const original = operation === 'leave' ? member : host;
    await joinRoom(h, original);
    const notices: Array<string | null> = [];
    const unsubscribe = h.session.subscribe(() => { notices.push(h.session.getSnapshot().notice); });
    const request = h.plan(operation);
    const exiting = operation === 'leave' ? h.session.leave() : h.session.close();
    await request.entered.promise; request.accept(); await exiting;
    const unavailable = whenState(h.session, state => state.phase === 'unavailable');
    const delivery = h.emit(success(operation, request.requestId, {
      protocolVersion: 1, roomId: 'another-room', outcome: operation === 'leave' ? 'left' : 'closed',
    }));
    await unavailable; unsubscribe();
    expect(h.session.getSnapshot()).toMatchObject({
      session: original, constrained: true, busy: false,
      unknown: { operation, roomId: original.roomId },
    });
    expect(notices).not.toContain('已离开房间。'); expect(notices).not.toContain('房间已关闭。');
    expect(h.invoke.mock.calls.some(([, args]) => {
      const request = (args?.request as { request?: { kind: string; batchId?: string } })?.request;
      return request?.kind === 'ack' && request.batchId === delivery.batch.batchId;
    })).toBe(false);
    expect(h.subscriptions()).toHaveLength(1);
  });

  it.each(['missing', 'throws'] as const)('fails closed on a %s Document nonce in pure snapshot reads', async mode => {
    const h = await harness(); await joinRoom(h);
    const calls = h.invoke.mock.calls.length;
    if (mode === 'missing') h.setNonce(undefined); else h.throwNonce();
    expect(() => h.session.getSnapshot()).not.toThrow();
    expect(h.session.getSnapshot()).toMatchObject({ opened: false, session: null, presence: null, snapshotReceived: false });
    expect(h.session.isBusy()).toBe(false); expect(h.session.isConstrained()).toBe(false); expect(h.session.needsLeaveConfirmation()).toBe(false);
    expect(h.invoke.mock.calls).toHaveLength(calls);
  });

  it('keeps the lobby unconstrained and replaces bounded directory pages instead of accumulating them', async () => {
    const h = await harness(); await h.session.open();
    expect(h.session.isConstrained()).toBe(false); expect(h.session.needsLeaveConfirmation()).toBe(false);
    const item = fixture.pulls[0].batch.event.response.result.items[0];
    for (const page of [0, 1]) {
      const request = h.plan('discover'); const discovering = h.session.discover(page === 1);
      expect(await request.entered.promise).toEqual({ kind: 'discover', query: { limit: 50, ...(page === 1 ? { cursor: 'next_page' } : {}) } });
      expect(h.session.isConstrained()).toBe(false);
      request.accept(); await discovering;
      const items = Array.from({ length: 50 }, (_, index) => ({ ...item, roomId: `page-${page}-room-${index}` }));
      const idle = whenState(h.session, state => !state.busy);
      await h.receive(success('discover', request.requestId, { items, nextCursor: page === 0 ? 'next_page' : null })); await idle;
      expect(h.session.getSnapshot().rooms).toEqual(items);
      expect(h.session.getSnapshot().rooms).toHaveLength(50);
      expect(h.session.needsLeaveConfirmation()).toBe(false);
    }
    expect(h.session.getSnapshot().nextCursor).toBeNull(); expect(h.subscriptions()).toHaveLength(0);
  });

  it('requires fresh socket snapshot and valid presence, clears proof offline, and never accumulates story deltas', async () => {
    const h = await harness(); await joinRoom(h);
    await h.receive({ kind: 'status', state: 'online' });
    expect(h.session.getSnapshot()).toMatchObject({ phase: 'online', snapshotReceived: false, presence: null });
    await h.receive(socket('room.presence'));
    expect(h.session.getSnapshot().presence).toBeNull();
    await h.receive(socket('room.snapshot'));
    expect(h.session.getSnapshot()).toMatchObject({ snapshotReceived: true, presence: null });
    await h.receive(socket('room.presence'));
    expect(h.session.getSnapshot().presence?.onlineUserIds).toEqual(['user-host']);
    const online = h.session.getSnapshot();
    const delta = socket('story.delta');
    if (delta.kind !== 'socket' || delta.message.type !== 'story.delta') throw new Error('Missing story fixture');
    for (let chunkSeq = 0; chunkSeq < 3; chunkSeq += 1) {
      await h.receive({ kind: 'socket', message: { ...delta.message, chunkSeq, payload: { delta: `story-canary-${chunkSeq}` } } });
      expect(h.session.getSnapshot()).toBe(online);
    }
    expect(JSON.stringify(h.session.getSnapshot())).not.toContain('story-canary');
    await h.receive({ kind: 'status', state: 'offline' });
    expect(h.session.getSnapshot()).toMatchObject({ phase: 'offline', snapshotReceived: false, presence: null, session: { roomId: member.roomId } });
    await h.receive({ kind: 'status', state: 'online' });
    await h.receive(socket('room.presence'));
    expect(h.session.getSnapshot()).toMatchObject({ snapshotReceived: false, presence: null });
    await h.receive(socket('room.snapshot'));
    await h.receive({ kind: 'socket', message: { protocolVersion: 1, type: 'room.presence', roomId: member.roomId, roomEpoch: member.roomEpoch, onlineUserIds: ['not-a-member'] } });
    expect(h.session.getSnapshot().presence).toBeNull();
    await h.receive(socket('room.presence'));
    expect(h.session.getSnapshot().presence?.onlineUserIds).toEqual(['user-host']);
    expect(h.requests.map(value => value.kind)).toEqual(['join']);
  });
});
