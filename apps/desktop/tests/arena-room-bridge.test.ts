import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_ROOM_ERROR_MESSAGE, DESKTOP_ROOM_IPC_COMMANDS,
  DesktopRoomBatchSchema, type DesktopRoomBatch,
} from '@mahoshojo/contracts/desktop-room-ipc';
import {
  ArenaRoomBridgeError, createArenaRoomBridge, createArenaRoomInbox, normalizeArenaRoomFailure,
  type ArenaRoomAcceptance, type ArenaRoomChannel,
} from '../src/platform/arena-room-bridge';

const fixture = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/desktop-room-ipc.json', import.meta.url), 'utf8'));
const tick = async () => { for (let i = 0; i < 24; i += 1) await Promise.resolve(); };
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const batchAt = (sequence = 0, subscriptionId = fixture.attach.subscriptionId): DesktopRoomBatch => DesktopRoomBatchSchema.parse({
  ...fixture.pulls[0].batch, sequence, batchId: `batch-${sequence}`, subscriptionId,
});
function harness(accept?: (batch: DesktopRoomBatch, context: ArenaRoomAcceptance) => boolean | Promise<boolean>, onAcknowledged?: (batch: DesktopRoomBatch, context: ArenaRoomAcceptance) => void) {
  const channels: ArenaRoomChannel[] = [];
  const accepted: DesktopRoomBatch[] = [];
  let current = true;
  let documentNonce: string | undefined; let documentReadFails = false;
  let subscriptionId = fixture.attach.subscriptionId;
  let batch: unknown = batchAt();
  let active = 0, maximumActive = 0;
  const errors: ArenaRoomBridgeError[] = [];
  let errorHook: ((error: ArenaRoomBridgeError) => void) | undefined;
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    active += 1; maximumActive = Math.max(maximumActive, active);
    try {
      if (command === DESKTOP_ROOM_IPC_COMMANDS.attach) return fixture.attach;
      if (command === DESKTOP_ROOM_IPC_COMMANDS.detach) return fixture.detach;
      if (command === DESKTOP_ROOM_IPC_COMMANDS.subscribe) return { handle: fixture.attach.handle, subscriptionId };
      if (command !== DESKTOP_ROOM_IPC_COMMANDS.request) throw new Error('unexpected command');
      const request = args!.request as { handle: string; request: { kind: string; subscriptionId?: string; batchId?: string; sequence?: number; intentId?: string } };
      if (request.request.kind === 'end-config-tracking') return { kind: 'config-tracking-ended', intentId: request.request.intentId, ended: true };
      if (request.request.kind === 'pull') return { kind: 'batch', batch };
      if (request.request.kind === 'ack') return { kind: 'acknowledged', handle: request.handle,
        subscriptionId: request.request.subscriptionId, batchId: request.request.batchId, sequence: request.request.sequence, accepted: true };
      return { ...fixture.accepted, subscriptionId };
    } finally { active -= 1; }
  });
  const bridge = createArenaRoomBridge(invoke, {
    acceptBatch: accept ?? ((value) => { accepted.push(value); return true; }),
    onAcknowledged,
    isCurrent: () => current, getDocumentNonce: () => { if (documentReadFails) throw new Error("document-unavailable"); return documentNonce; }, onError: (error) => { errors.push(error); errorHook?.(error); },
    createChannel: () => { const channel = { onmessage: (_value: unknown) => undefined }; channels.push(channel); return channel; },
  });
  const actions = () => invoke.mock.calls.filter(([command]) => command === DESKTOP_ROOM_IPC_COMMANDS.request)
    .map(([, args]) => (args!.request as { request: { kind: string } }).request.kind);
  return { bridge, invoke, accepted, errors, channels, actions,
    start: () => bridge.attach(fixture.attachRequest),
    notify: (sequence = 0, sub = subscriptionId, channel = channels.at(-1)!) => channel.onmessage({
      handle: fixture.attach.handle, subscriptionId: sub, sequence, type: 'available',
    }),
    setBatch: (value: unknown) => { batch = value; },
    setSubscription: (value: string) => { subscriptionId = value; },
    setCurrent: (value: boolean) => { current = value; },
    setErrorHook: (hook: (error: ArenaRoomBridgeError) => void) => { errorHook = hook; },
    setDocumentNonce: (value: string | undefined) => { documentNonce = value; },
    setDocumentReadFails: () => { documentReadFails = true; },
    maximumActive: () => maximumActive,
  };
}

describe('Native Room bounded pull/accept/ack bridge', () => {
  it('exposes the transition boundary only after a valid exact ACK, not consumer acceptance', async () => {
    const done = vi.fn(); const h = harness(undefined, done); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start();
    const original = h.invoke.getMockImplementation()!; const gate = deferred<unknown>();
    h.invoke.mockImplementation(async (command, args) => {
      if (command === DESKTOP_ROOM_IPC_COMMANDS.request && (args!.request as { request: { kind: string } }).request.kind === 'ack') return gate.promise;
      return original(command, args);
    });
    h.notify(); await tick(); expect(h.accepted).toHaveLength(1); expect(done).not.toHaveBeenCalled();
    const batch = batchAt(); gate.resolve({ kind: 'acknowledged', handle: batch.handle, subscriptionId: batch.subscriptionId,
      batchId: batch.batchId, sequence: batch.sequence, accepted: true });
    await tick(); expect(done).toHaveBeenCalledTimes(1); expect(done.mock.calls[0]![1].isCurrent()).toBe(true);
    h.notify(); await tick(); expect(done).toHaveBeenCalledTimes(1);
    h.setDocumentNonce('b'.repeat(64)); expect(done.mock.calls[0]![1].isCurrent()).toBe(false);
  });
  it.each(['wrong-receipt', 'retired-owner', 'changed-document', 'missing-document', 'unreadable-document'])('never grants an ACK boundary for %s', async (reason) => {
    const done = vi.fn(); const h = harness(undefined, done); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start();
    const original = h.invoke.getMockImplementation()!; const gate = deferred<unknown>();
    h.invoke.mockImplementation(async (command, args) => {
      if (command === DESKTOP_ROOM_IPC_COMMANDS.request && (args!.request as { request: { kind: string } }).request.kind === 'ack') return gate.promise;
      return original(command, args);
    });
    h.notify(); await tick(); if (reason === 'retired-owner') h.setCurrent(false);
    if (reason === 'changed-document') h.setDocumentNonce('b'.repeat(64));
    if (reason === 'missing-document') h.setDocumentNonce(undefined);
    if (reason === 'unreadable-document') h.setDocumentReadFails();
    const batch = batchAt(); gate.resolve({ kind: 'acknowledged', handle: batch.handle, subscriptionId: batch.subscriptionId,
      batchId: reason === 'wrong-receipt' ? 'wrong' : batch.batchId, sequence: batch.sequence, accepted: true });
    await tick(); expect(done).not.toHaveBeenCalled();
  });
  it('keeps ACK irreversible when its callback throws, including reentrant detach', async () => {
    for (const change of ['none', 'detach', 'document-changed', 'document-unreadable']) {
      const h = harness(undefined, () => {
        if (change === 'detach') h.bridge.detach();
        if (change === 'document-changed') h.setDocumentNonce('b'.repeat(64));
        if (change === 'document-unreadable') h.setDocumentReadFails();
        throw new Error('consumer-private-text');
      });
      h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start(); h.notify(); await tick(); h.notify(); await tick();
      expect(h.actions().filter(action => action === 'ack')).toHaveLength(1);
      expect(h.actions().filter(action => action === 'pull')).toHaveLength(1);
      expect(h.errors.map(error => error.code)).toEqual(change === 'none' ? ['internal-error'] : []);
      expect(JSON.stringify(h.errors)).not.toContain('consumer-private-text');
    }
  });

  it('retires synchronously on revoked while a consumer is stuck and releases only the small notification debt', async () => {
    const acceptance = deferred<boolean>(); let captured: ArenaRoomAcceptance | undefined;
    const h = harness((_batch, context) => { captured = context; return acceptance.promise; });
    h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start(); h.notify(); await tick();
    const revoked = fixture.revokedNotifications[0]; h.channels[0].onmessage(revoked);
    expect(captured!.signal.aborted).toBe(true); expect(captured!.isCurrent()).toBe(false);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({ ...revoked.error, requestId: revoked.requestId, operation: revoked.operation });
    await tick();
    const acknowledgements = () => h.invoke.mock.calls.filter(([command, args]) => command === DESKTOP_ROOM_IPC_COMMANDS.request
      && (args!.request as { request: { kind: string } }).request.kind === 'ack')
      .map(([, args]) => (args!.request as { request: { batchId: string; sequence: number } }).request);
    expect(acknowledgements()).toHaveLength(1);
    expect(acknowledgements()[0]).toMatchObject({ batchId: revoked.batchId, sequence: revoked.sequence });
    h.channels[0].onmessage(revoked); await tick(); expect(acknowledgements()).toHaveLength(1); expect(h.errors).toHaveLength(1);
    acceptance.resolve(true); await tick();
    expect(acknowledgements()).toHaveLength(2);
    expect(acknowledgements()[1]).toMatchObject({ batchId: 'batch-0', sequence: 0 });
    expect(h.actions().filter((action) => action === 'pull')).toHaveLength(1);
  });
  it('reports a valid revoked error without claiming same-document ACK permission when the nonce is unavailable', async () => {
    const h = harness(); await h.start(); h.channels[0].onmessage(fixture.revokedNotifications[0]);
    expect(h.errors[0]).toMatchObject({ code: 'not-authenticated', outcome: 'not-applied' });
    await tick(); expect(h.actions()).toEqual([]); expect(h.accepted).toEqual([]);
  });
  it('keeps the original correlated revoked error when accepted returns late', async () => {
    const h = harness(); await h.start(); const accepted = deferred<unknown>();
    h.invoke.mockImplementationOnce(() => accepted.promise);
    const mutation = fixture.requests.find((entry: { request: { kind: string } }) => entry.request.kind === 'create').request;
    const result = h.bridge.request(mutation).catch((error: unknown) => error); await tick();
    const revoked = fixture.revokedNotifications[0]; h.channels[0].onmessage(revoked);
    expect(h.errors[0]).toMatchObject({ requestId: revoked.requestId, operation: 'create' });
    accepted.resolve({ ...fixture.accepted, requestId: revoked.requestId });
    expect(await result).toMatchObject({ ...revoked.error, requestId: revoked.requestId, operation: 'create' });
    expect(h.actions()).toEqual(['create']);
  });
  it('publishes no old diagnostic when owner validation changed before the channel callback', async () => {
    const h = harness(); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start(); h.setCurrent(false);
    const revoked = fixture.revokedNotifications[0]; h.channels[0].onmessage(revoked);
    expect(h.errors).toEqual([]); await tick(); expect(h.actions()).toEqual(['ack']);
    expect(h.invoke.mock.calls.at(-1)).toEqual([DESKTOP_ROOM_IPC_COMMANDS.request, { request: {
      handle: revoked.handle, request: { kind: 'ack', subscriptionId: revoked.subscriptionId,
        batchId: revoked.batchId, sequence: revoked.sequence },
    } }]);
    expect(h.accepted).toEqual([]);
  });
  it('does not rethrow a recorded old auth diagnostic after the owner changes before late accepted', async () => {
    const h = harness(); await h.start(); const accepted = deferred<unknown>();
    h.invoke.mockImplementationOnce(() => accepted.promise);
    const action = fixture.requests.find((entry: { request: { kind: string } }) => entry.request.kind === 'create').request;
    const result = h.bridge.request(action).catch((error: unknown) => error); await tick();
    const revoked = fixture.revokedNotifications[0]; h.channels[0].onmessage(revoked);
    expect(h.errors).toHaveLength(1); h.setCurrent(false);
    accepted.resolve({ ...fixture.accepted, requestId: revoked.requestId });
    expect(await result).toMatchObject({ code: 'scope-changed', outcome: 'unknown', requestId: undefined });
    expect(h.errors).toHaveLength(1);
  });
  it.each(['attach', 'detach', 'subscribe'])('does not rethrow an old revoked error after synchronous onError starts a new %s intent', async (intent) => {
    const h = harness(); await h.start(); const accepted = deferred<unknown>();
    h.invoke.mockImplementationOnce(() => accepted.promise);
    const action = fixture.requests.find((entry: { request: { kind: string } }) => entry.request.kind === 'create').request;
    const result = h.bridge.request(action).catch((error: unknown) => error); await tick();
    let replacement: Promise<unknown> | undefined;
    h.setErrorHook(() => {
      if (intent === 'attach') replacement = h.start();
      else if (intent === 'subscribe') replacement = h.bridge.subscribe(fixture.subscribeRequest.roomId, fixture.subscribeRequest.expectedRoomEpoch).catch((error: unknown) => error);
      else h.bridge.detach();
    });
    const revoked = fixture.revokedNotifications[0]; h.channels[0].onmessage(revoked);
    expect(h.errors).toHaveLength(1);
    accepted.resolve({ ...fixture.accepted, requestId: revoked.requestId });
    expect(await result).toMatchObject({ code: 'scope-changed', outcome: 'unknown', requestId: undefined });
    if (replacement) await replacement;
    expect(h.errors).toHaveLength(1); expect(h.actions()).toEqual(['create']);
  });
  it('does not route a retired scope revocation into its replacement or release cross-document debt', async () => {
    const h = harness(); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start();
    const oldChannel = h.channels[0]; await h.start(); oldChannel.onmessage(fixture.revokedNotifications[0]); await tick();
    expect(h.errors).toEqual([]); expect(h.accepted).toEqual([]); expect(h.actions()).toEqual(['ack']);
    h.setDocumentNonce('b'.repeat(64)); h.channels[1].onmessage(fixture.revokedNotifications[1]); await tick();
    expect(h.errors).toEqual([]); expect(h.actions()).toEqual(['ack']);
  });
  it.each([
    { ...fixture.revokedNotifications[0], body: 'secret-canary' },
    { ...fixture.revokedNotifications[0], error: { ...fixture.revokedNotifications[0].error, message: 'secret-canary' } },
    { ...fixture.revokedNotifications[0], operation: 'ticket' },
  ])('rejects an invalid revoked notification without pulling, accepting, or acknowledging it', async (notification) => {
    const h = harness(); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start();
    h.channels[0].onmessage(notification); await tick();
    expect(h.errors[0]).toMatchObject({ code: 'invalid-response', message: DESKTOP_ROOM_ERROR_MESSAGE });
    expect(h.actions()).toEqual([]); expect(h.accepted).toEqual([]);
  });
  it('buffers a subscribe revocation before its receipt and correlates it only after the matching subscription is known', async () => {
    const h = harness(); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start();
    const receipt = deferred<unknown>(); h.invoke.mockImplementationOnce(() => receipt.promise);
    const subscribed = h.bridge.subscribe(fixture.subscribeRequest.roomId, fixture.subscribeRequest.expectedRoomEpoch).catch((error: unknown) => error);
    await tick(); const revoked = { ...fixture.revokedNotifications[3], subscriptionId: 'new-subscription' };
    // available and revoked may both precede the short invoke result; only the terminal notice is retained.
    h.channels[0].onmessage({ ...fixture.notifications[0], subscriptionId: revoked.subscriptionId });
    h.channels[0].onmessage(revoked); h.channels[0].onmessage(revoked);
    expect(h.errors).toEqual([]); expect(h.actions()).toEqual([]);
    receipt.resolve({ handle: revoked.handle, subscriptionId: revoked.subscriptionId });
    expect(await subscribed).toMatchObject({ ...revoked.error, requestId: null, operation: 'subscribe' });
    expect(h.errors).toHaveLength(1); await tick(); expect(h.actions()).toEqual(['ack']); expect(h.accepted).toEqual([]);
  });
  it('does not publish a mismatched early subscribe revocation and permits the actual subscription to receive data', async () => {
    const h = harness(); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start();
    const receipt = deferred<unknown>(); h.invoke.mockImplementationOnce(() => receipt.promise);
    const subscribed = h.bridge.subscribe(fixture.subscribeRequest.roomId, fixture.subscribeRequest.expectedRoomEpoch); await tick();
    const retired = { ...fixture.revokedNotifications[3], subscriptionId: 'older-pending-subscription' };
    h.channels[0].onmessage(retired);
    receipt.resolve({ handle: fixture.attach.handle, subscriptionId: 'actual-subscription' }); await subscribed; await tick();
    expect(h.errors).toEqual([]); expect(h.actions()).toEqual(['ack']);
    h.setBatch(batchAt(0, 'actual-subscription')); h.notify(0, 'actual-subscription'); await tick();
    expect(h.accepted).toHaveLength(1); expect(h.actions()).toEqual(['ack', 'pull', 'ack']);
  });
  it('buffers an available notice before subscribe receipt without pulling through an unconfirmed scope', async () => {
    const h = harness(); await h.start(); const receipt = deferred<unknown>(); h.invoke.mockImplementationOnce(() => receipt.promise);
    const subscribed = h.bridge.subscribe(fixture.subscribeRequest.roomId, fixture.subscribeRequest.expectedRoomEpoch); await tick();
    h.setBatch(batchAt(0, 'new-subscription')); h.notify(0, 'new-subscription'); await tick(); expect(h.actions()).toEqual([]);
    receipt.resolve({ handle: fixture.attach.handle, subscriptionId: 'new-subscription' }); await subscribed; await tick();
    expect(h.actions()).toEqual(['pull', 'ack']); expect(h.accepted).toHaveLength(1);
  });
  it('bounds early subscription notifications and never opens a body pull on overflow', async () => {
    const h = harness(); await h.start(); const receipt = deferred<unknown>(); h.invoke.mockImplementationOnce(() => receipt.promise);
    const subscribed = h.bridge.subscribe(fixture.subscribeRequest.roomId, fixture.subscribeRequest.expectedRoomEpoch).catch((error: unknown) => error); await tick();
    for (let index = 0; index < 17; index += 1) h.notify(0, `pending-subscription-${index}`);
    expect(h.errors[0]).toMatchObject({ code: 'backpressure' }); expect(h.actions()).toEqual([]);
    receipt.resolve({ handle: fixture.attach.handle, subscriptionId: 'pending-subscription-16' });
    expect(await subscribed).toMatchObject({ code: 'scope-changed' });
  });
  it('does not terminate the active subscription from a revoked message for an older subscription', async () => {
    const h = harness(); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start();
    h.setSubscription('replacement-subscription'); await h.bridge.subscribe(fixture.subscribeRequest.roomId, fixture.subscribeRequest.expectedRoomEpoch);
    h.channels[0].onmessage(fixture.revokedNotifications[0]); await tick();
    expect(h.errors).toEqual([]); expect(h.actions()).toEqual(['ack']);
    h.setBatch(batchAt(0, 'replacement-subscription')); h.notify(0); await tick();
    expect(h.accepted).toHaveLength(1); expect(h.actions()).toEqual(['ack', 'pull', 'ack']);
  });
  it('accepts validated complete batches before acknowledging and never duplicates pull/ack', async () => {
    const acceptance = deferred<boolean>();
    const accept = vi.fn(() => acceptance.promise);
    const h = harness(accept); await h.start(); h.notify(); await tick();
    expect(accept).toHaveBeenCalledTimes(1);
    expect(h.actions()).toEqual(['pull']);
    h.notify(); h.notify(); await tick(); expect(h.actions()).toEqual(['pull']);
    acceptance.resolve(true); await tick();
    expect(h.actions()).toEqual(['pull', 'ack']);
    h.notify(); await tick(); expect(h.actions()).toEqual(['pull', 'ack']);
    expect(h.maximumActive()).toBe(1);
  });
  it('retains one bounded pending consumer and closes without ack if acceptance fails', async () => {
    const h = harness(async () => false); await h.start(); h.notify(); await tick();
    expect(h.actions()).toEqual(['pull']);
    expect(h.errors).toHaveLength(1); expect(h.errors[0].code).toBe('backpressure');
    expect(h.invoke.mock.calls.at(-1)![0]).toBe(DESKTOP_ROOM_IPC_COMMANDS.detach);
  });
  it('invalidates a stuck consumer synchronously and permits detach without waiting for it', async () => {
    const acceptance = deferred<boolean>(); let context: ArenaRoomAcceptance | undefined;
    const h = harness((_batch, captured) => { context = captured; return acceptance.promise; });
    await h.start(); h.notify(); await tick();
    h.bridge.detach();
    expect(context!.signal.aborted).toBe(true); expect(context!.isCurrent()).toBe(false);
    await tick(); expect(h.invoke.mock.calls.at(-1)![0]).toBe(DESKTOP_ROOM_IPC_COMMANDS.detach);
    acceptance.resolve(true); h.notify(); await tick(); expect(h.actions()).toEqual(['pull']);
  });
  it('fences an old batch when subscribe starts and ignores retired notification callbacks', async () => {
    const acceptance = deferred<boolean>(); let oldContext: ArenaRoomAcceptance | undefined;
    const h = harness((_batch, context) => { oldContext = context; return acceptance.promise; });
    await h.start(); h.notify(); await tick();
    const oldSub = fixture.attach.subscriptionId;
    h.setSubscription('new-subscription');
    const subscribed = h.bridge.subscribe(fixture.subscribeRequest.roomId, fixture.subscribeRequest.expectedRoomEpoch);
    expect(oldContext!.signal.aborted).toBe(true); expect(oldContext!.isCurrent()).toBe(false);
    h.notify(0, oldSub); await subscribed;
    acceptance.resolve(true); h.notify(0, oldSub); await tick();
    expect(h.actions()).toEqual(['pull']); expect(h.errors).toEqual([]);
  });
  it('does not let an old attach completion renew the current scope', async () => {
    const old = deferred<unknown>(); const h = harness();
    h.invoke.mockImplementationOnce(() => old.promise);
    const first = h.start().catch((error: unknown) => error); await tick();
    const second = h.start();
    old.resolve({ ...fixture.attach, handle: 'retired-handle' });
    expect(await first).toMatchObject({ code: 'scope-changed' });
    await second; await tick();
    const detachRequests = h.invoke.mock.calls.filter(([command]) => command === DESKTOP_ROOM_IPC_COMMANDS.detach).map(([, args]) => args);
    expect(detachRequests).toContainEqual({ request: { handle: 'retired-handle' } });
    h.channels[0].onmessage(fixture.notifications[0]); await tick(); expect(h.actions()).toEqual([]);
    expect(h.invoke.mock.calls.filter(([command]) => command === DESKTOP_ROOM_IPC_COMMANDS.attach)).toHaveLength(2);
  });
  it('checks a late pull before consumer delivery and never silently acknowledges lost data', async () => {
    const delayed = deferred<unknown>(); const h = harness(); await h.start();
    h.invoke.mockImplementationOnce(() => delayed.promise);
    h.notify(); await tick(); h.bridge.detach();
    delayed.resolve({ kind: 'batch', batch: batchAt() }); await tick();
    expect(h.accepted).toEqual([]); expect(h.actions()).toEqual(['pull']);
  });
  it('releases only a validated discarded same-document batch using its exact retired scope', async () => {
    const delayed = deferred<unknown>(); const h = harness(); await h.start();
    h.setDocumentNonce(fixture.attachRequest.documentNonce);
    h.invoke.mockImplementationOnce(() => delayed.promise); h.notify(); await tick();
    h.bridge.detach(); delayed.resolve({ kind: 'batch', batch: batchAt() }); await tick();
    expect(h.accepted).toEqual([]); expect(h.actions()).toEqual(['pull', 'ack']);
    expect(h.invoke.mock.calls).toContainEqual([DESKTOP_ROOM_IPC_COMMANDS.request, { request: {
      handle: fixture.attach.handle, request: { kind: 'ack', subscriptionId: fixture.attach.subscriptionId,
        batchId: 'batch-0', sequence: 0 },
    } }]);
  });
  it('does not pull, accept, or ack a notification after the document has already changed', async () => {
    const h = harness(); await h.start(); h.setDocumentNonce('b'.repeat(64));
    h.notify();
    expect(h.actions()).toEqual([]); expect(h.accepted).toEqual([]);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it.each(['changed-document', 'invalid-batch'])('does not retire-ack an already entered pull after %s', async (failure) => {
    const delayed = deferred<unknown>(), entered = deferred<void>(), detached = deferred<void>();
    const h = harness(); await h.start(); h.setDocumentNonce(fixture.attachRequest.documentNonce);
    h.invoke.mockImplementationOnce(() => { entered.resolve(); return delayed.promise; });
    h.invoke.mockImplementationOnce(async (command) => {
      expect(command).toBe(DESKTOP_ROOM_IPC_COMMANDS.detach);
      detached.resolve(); return fixture.detach;
    });
    h.notify(); await entered.promise;
    if (failure === 'changed-document') h.setDocumentNonce('b'.repeat(64));
    h.bridge.detach();
    delayed.resolve({ kind: 'batch', batch: failure === 'invalid-batch' ? { ...batchAt(), secret: 'secret-canary' } : batchAt() });
    await detached.promise;
    expect(h.actions()).toEqual(['pull']); expect(h.accepted).toEqual([]);
  });
  it('never releases an accepted-but-still-running consumer early, even in the same document', async () => {
    const acceptance = deferred<boolean>(); const h = harness(() => acceptance.promise);
    h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start(); h.notify(); await tick();
    h.bridge.detach(); await tick(); expect(h.actions()).toEqual(['pull']);
    acceptance.resolve(true); await tick(); expect(h.actions()).toEqual(['pull', 'ack']);
  });
  it.each([
    { ...batchAt(), ticket: 'secret-canary' },
    { ...batchAt(), handle: 'another-handle' },
    { ...batchAt(), sequence: 9007199254740992 },
    { ...batchAt(), event: { kind: 'socket', message: { type: 'room.presence', secret: 'secret-canary' } } },
    { ...batchAt(), event: { ...fixture.pulls[0].batch.event, response: { ...fixture.pulls[0].batch.event.response,
      desktopRoom: { version: 'desktop-room-session-v1', viewerUserId: 99 } } } },
  ])('rejects malformed or foreign batches before callback or ack', async (batch) => {
    const h = harness(); h.setBatch(batch); await h.start(); h.notify(); await tick();
    expect(h.accepted).toEqual([]); expect(h.actions()).toEqual(['pull']);
    expect(h.errors[0]).toMatchObject({ code: 'invalid-response', message: DESKTOP_ROOM_ERROR_MESSAGE });
    expect(JSON.stringify(h.errors)).not.toContain('secret-canary');
  });
  it('never carries a malformed notification body into pull or callback', async () => {
    const h = harness(); await h.start(); h.channels[0].onmessage({ ...fixture.notifications[0], body: 'secret-canary' }); await tick();
    expect(h.actions()).toEqual([]); expect(h.accepted).toEqual([]); expect(h.errors[0].code).toBe('invalid-response');
  });
  it('makes exactly one requested mutation invoke, no implicit reattach or retry on unknown outcome', async () => {
    const h = harness(); await h.start();
    h.invoke.mockRejectedValueOnce(new Error('secret-canary'));
    const mutation = fixture.requests.find((entry: { request: { kind: string } }) => entry.request.kind === 'create').request;
    await expect(h.bridge.request(mutation)).rejects.toMatchObject({ code: 'internal-error', outcome: 'unknown', message: DESKTOP_ROOM_ERROR_MESSAGE });
    expect(h.actions()).toEqual(['create']);
    expect(h.invoke.mock.calls.filter(([command]) => command === DESKTOP_ROOM_IPC_COMMANDS.attach)).toHaveLength(1);
    expect(normalizeArenaRoomFailure({ ...fixture.error, message: 'secret-canary' }).message).toBe(DESKTOP_ROOM_ERROR_MESSAGE);
  });
  it.each(['create', 'resume-create', 'join', 'leave', 'close'])('keeps %s outcome unknown after an invalid dispatched acceptance', async (kind) => {
    const h = harness(); await h.start(); h.invoke.mockResolvedValueOnce({ ...fixture.accepted, handle: 'foreign-handle' });
    const action = fixture.requests.find((entry: { request: { kind: string } }) => entry.request.kind === kind).request;
    await expect(h.bridge.request(action)).rejects.toMatchObject({ code: 'invalid-response', outcome: 'unknown' });
    expect(h.actions()).toEqual([kind]);
  });
  it('requires explicit current-document attach and never dispatches public pull/ack/ticket', async () => {
    const h = harness(); await expect(h.bridge.request({ kind: 'session', roomId: 'room' })).rejects.toMatchObject({ code: 'scope-changed' });
    h.setCurrent(false); await expect(h.start()).rejects.toMatchObject({ code: 'scope-changed' }); expect(h.invoke).not.toHaveBeenCalled();
    h.setCurrent(true); await h.start();
    for (const kind of ['pull', 'ack', 'ticket']) await expect(h.bridge.request({ kind } as never)).rejects.toMatchObject({ code: 'invalid-request' });
    expect(h.actions()).toEqual([]);
  });
  it('bounds serial invoke backlog and does not dispatch queued mutations after retirement', async () => {
    const h = harness(); await h.start(); const blocked = deferred<unknown>(); h.invoke.mockImplementationOnce(() => blocked.promise);
    const requests = Array.from({ length: 22 }, () => h.bridge.request({ kind: 'session', roomId: 'room' }).catch((error: unknown) => error));
    await tick(); h.bridge.detach(); blocked.resolve(fixture.accepted); const results = await Promise.all(requests); await tick();
    expect(results.some((error) => error instanceof ArenaRoomBridgeError && error.code === 'busy')).toBe(true);
    expect(h.actions()).toEqual(['session']);
    expect(h.invoke.mock.calls.at(-1)![0]).toBe(DESKTOP_ROOM_IPC_COMMANDS.detach);
  });
});

describe('explicit Native config tracking end boundary', () => {
  const intentId = 'config-intent:7';
  const receipt = { kind: 'config-tracking-ended', intentId, ended: true };
  const supersessions = ['attach', 'detach', 'subscribe', 'account', 'changed-document', 'missing-document', 'unreadable-document'] as const;
  const detachCalls = (h: ReturnType<typeof harness>) => h.invoke.mock.calls.filter(([command]) => command === DESKTOP_ROOM_IPC_COMMANDS.detach);

  it('accepts only the exact local end receipt, then cleans up the old handle without implicitly reattaching', async () => {
    const h = harness(); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start();
    expect(await h.bridge.endConfigTracking(intentId)).toEqual(receipt); await tick();
    expect(h.invoke.mock.calls.slice(1)).toEqual([
      [DESKTOP_ROOM_IPC_COMMANDS.request, { request: { handle: fixture.attach.handle, request: { kind: 'end-config-tracking', intentId } } }],
      [DESKTOP_ROOM_IPC_COMMANDS.detach, { request: { handle: fixture.attach.handle } }],
    ]);
    await expect(h.bridge.request({ kind: 'session', roomId: 'room' })).rejects.toMatchObject({ code: 'scope-changed', outcome: 'not-applied' });
    await expect(h.bridge.endConfigTracking(intentId)).rejects.toMatchObject({ code: 'scope-changed', outcome: 'not-applied' });
    expect(h.actions()).toEqual(['end-config-tracking']); expect(h.errors).toEqual([]);
  });

  it.each(['', '.leading-dot', 'space token', '配置', 'x'.repeat(129)])('rejects malformed intent token %s without retiring a valid delivery scope', async (token) => {
    const h = harness(); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start();
    await expect(h.bridge.endConfigTracking(token)).rejects.toMatchObject({ code: 'invalid-request', outcome: 'not-applied' });
    expect(h.invoke).toHaveBeenCalledTimes(1); expect(h.actions()).toEqual([]);
    h.notify(); await tick(); expect(h.accepted).toHaveLength(1); expect(h.actions()).toEqual(['pull', 'ack']);
    expect(detachCalls(h)).toEqual([]);
  });

  it.each([
    ['unrelated acceptance', fixture.accepted],
    ['wrong intent', { ...receipt, intentId: 'another-config-intent' }],
    ['missing intent', { kind: receipt.kind, ended: true }],
    ['unconfirmed end', { ...receipt, ended: false }],
    ['coerced end', { ...receipt, ended: 'true' }],
    ['foreign handle field', { ...receipt, handle: fixture.attach.handle }],
    ['unexpected body', { ...receipt, body: 'secret-canary' }],
  ])('rejects %s instead of claiming a successful end', async (_label, response) => {
    const h = harness(); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start();
    h.invoke.mockResolvedValueOnce(response);
    const result = await h.bridge.endConfigTracking(intentId).catch((error: unknown) => error); await tick();
    expect(result).toMatchObject({ code: 'invalid-response', outcome: 'not-applicable', message: DESKTOP_ROOM_ERROR_MESSAGE });
    expect(JSON.stringify(result)).not.toContain('secret-canary'); expect(h.actions()).toEqual(['end-config-tracking']);
    expect(detachCalls(h)).toEqual([[DESKTOP_ROOM_IPC_COMMANDS.detach, { request: { handle: fixture.attach.handle } }]]);
    expect(h.invoke.mock.calls.filter(([command]) => command === DESKTOP_ROOM_IPC_COMMANDS.attach)).toHaveLength(1);
  });

  it('retires a stuck old delivery synchronously but never detaches Native ahead of the explicit end receipt', async () => {
    const acceptance = deferred<boolean>(), ended = deferred<unknown>(); let oldContext: ArenaRoomAcceptance | undefined;
    const acknowledged = vi.fn();
    const h = harness((_batch, context) => { oldContext = context; return acceptance.promise; }, acknowledged);
    h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start(); h.notify(); await tick();
    const original = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation((command, args) => command === DESKTOP_ROOM_IPC_COMMANDS.request
      && (args!.request as { request: { kind: string } }).request.kind === 'end-config-tracking'
      ? ended.promise : original(command, args));
    const ending = h.bridge.endConfigTracking(intentId);
    expect(oldContext!.signal.aborted).toBe(true); expect(oldContext!.isCurrent()).toBe(false);
    h.notify(1); await tick(); expect(h.actions()).toEqual(['pull', 'end-config-tracking']); expect(detachCalls(h)).toEqual([]);
    acceptance.resolve(true); await tick(); expect(h.actions()).toEqual(['pull', 'end-config-tracking']); expect(detachCalls(h)).toEqual([]);
    ended.resolve(receipt); expect(await ending).toEqual(receipt); await tick();
    expect(h.actions()).toEqual(['pull', 'end-config-tracking', 'ack']);
    expect(h.invoke.mock.calls).toContainEqual([DESKTOP_ROOM_IPC_COMMANDS.request, { request: {
      handle: fixture.attach.handle, request: { kind: 'ack', subscriptionId: fixture.attach.subscriptionId, batchId: 'batch-0', sequence: 0 },
    } }]);
    expect(detachCalls(h)).toHaveLength(1); expect(acknowledged).not.toHaveBeenCalled(); expect(h.errors).toEqual([]);
    h.notify(2); await tick(); expect(h.actions()).toEqual(['pull', 'end-config-tracking', 'ack']);
  });

  it.each(supersessions)('never dispatches an end queued behind another invoke after %s supersedes it', async (reason) => {
    const h = harness(); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start();
    const blocked = deferred<unknown>(); h.invoke.mockImplementationOnce(() => blocked.promise);
    const previous = h.bridge.request({ kind: 'session', roomId: 'room' }).catch((error: unknown) => error); await tick();
    const ending = h.bridge.endConfigTracking(intentId).catch((error: unknown) => error);
    let replacement: Promise<unknown> | undefined;
    if (reason === 'attach') {
      const original = h.invoke.getMockImplementation()!;
      h.invoke.mockImplementation((command, args) => command === DESKTOP_ROOM_IPC_COMMANDS.attach
        ? Promise.resolve({ ...fixture.attach, handle: 'replacement-handle' }) : original(command, args));
      replacement = h.start();
    } else if (reason === 'detach') h.bridge.detach();
    else if (reason === 'subscribe') replacement = h.bridge.subscribe(fixture.subscribeRequest.roomId, fixture.subscribeRequest.expectedRoomEpoch).catch((error: unknown) => error);
    else if (reason === 'account') h.setCurrent(false);
    else if (reason === 'changed-document') h.setDocumentNonce('b'.repeat(64));
    else if (reason === 'missing-document') h.setDocumentNonce(undefined);
    else h.setDocumentReadFails();
    blocked.resolve(fixture.accepted);
    expect(await previous).toMatchObject({ code: 'scope-changed' });
    expect(await ending).toMatchObject({ code: 'scope-changed', outcome: 'not-applicable' });
    if (replacement) {
      const result = await replacement;
      if (reason === 'attach') expect(result).toMatchObject({ handle: 'replacement-handle' });
    }
    await tick(); expect(h.actions()).toEqual(['session']); expect(h.errors).toEqual([]);
    expect(detachCalls(h)).toEqual([[DESKTOP_ROOM_IPC_COMMANDS.detach, { request: { handle: fixture.attach.handle } }]]);
  });

  it.each(supersessions)('never accepts a late exact end receipt after %s supersedes it', async (reason) => {
    const h = harness(); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start();
    const ended = deferred<unknown>(); h.invoke.mockImplementationOnce(() => ended.promise);
    const ending = h.bridge.endConfigTracking(intentId).catch((error: unknown) => error); await tick();
    expect(h.actions()).toEqual(['end-config-tracking']); expect(detachCalls(h)).toEqual([]);
    let replacement: Promise<unknown> | undefined;
    if (reason === 'attach') {
      const original = h.invoke.getMockImplementation()!;
      h.invoke.mockImplementation((command, args) => command === DESKTOP_ROOM_IPC_COMMANDS.attach
        ? Promise.resolve({ ...fixture.attach, handle: 'replacement-handle' }) : original(command, args));
      replacement = h.start();
    } else if (reason === 'detach') h.bridge.detach();
    else if (reason === 'subscribe') replacement = h.bridge.subscribe(fixture.subscribeRequest.roomId, fixture.subscribeRequest.expectedRoomEpoch).catch((error: unknown) => error);
    else if (reason === 'account') h.setCurrent(false);
    else if (reason === 'changed-document') h.setDocumentNonce('b'.repeat(64));
    else if (reason === 'missing-document') h.setDocumentNonce(undefined);
    else h.setDocumentReadFails();
    ended.resolve(receipt); expect(await ending).toMatchObject({ code: 'scope-changed', outcome: 'not-applicable' });
    if (replacement) {
      const result = await replacement;
      if (reason === 'attach') expect(result).toMatchObject({ handle: 'replacement-handle' });
    }
    await tick(); expect(h.actions()).toEqual(['end-config-tracking']); expect(h.errors).toEqual([]);
    expect(detachCalls(h)).toEqual([[DESKTOP_ROOM_IPC_COMMANDS.detach, { request: { handle: fixture.attach.handle } }]]);
  });

  it('does not retry or report success when the end response is lost, and leaves no usable old scope', async () => {
    const h = harness(); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start();
    h.invoke.mockRejectedValueOnce(new Error('secret-lost-reply'));
    const result = await h.bridge.endConfigTracking(intentId).catch((error: unknown) => error); await tick();
    expect(result).toMatchObject({ code: 'internal-error', outcome: 'not-applicable', message: DESKTOP_ROOM_ERROR_MESSAGE });
    expect(JSON.stringify(result)).not.toContain('secret-lost-reply');
    await expect(h.bridge.endConfigTracking(intentId)).rejects.toMatchObject({ code: 'scope-changed', outcome: 'not-applied' });
    h.notify(); await tick(); expect(h.accepted).toEqual([]); expect(h.actions()).toEqual(['end-config-tracking']);
    expect(detachCalls(h)).toHaveLength(1);
    expect(h.invoke.mock.calls.filter(([command]) => command === DESKTOP_ROOM_IPC_COMMANDS.attach)).toHaveLength(1);
  });

  it('does not let a generic request bypass end retirement or receipt validation', async () => {
    const h = harness(); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start();
    await expect(h.bridge.request({ kind: 'end-config-tracking', intentId } as never)).rejects.toMatchObject({ code: 'invalid-request', outcome: 'not-applied' });
    expect(h.actions()).toEqual([]); expect(detachCalls(h)).toEqual([]);
    h.notify(); await tick(); expect(h.accepted).toHaveLength(1); expect(h.actions()).toEqual(['pull', 'ack']);
  });

  it('never interprets an ordinary detach as explicitly ending config tracking', async () => {
    const h = harness(); h.setDocumentNonce(fixture.attachRequest.documentNonce); await h.start();
    h.bridge.detach(); h.bridge.detach(); await tick();
    expect(h.actions()).toEqual([]);
    expect(detachCalls(h)).toEqual([[DESKTOP_ROOM_IPC_COMMANDS.detach, { request: { handle: fixture.attach.handle } }]]);
    await expect(h.bridge.endConfigTracking(intentId)).rejects.toMatchObject({ code: 'scope-changed', outcome: 'not-applied' });
    expect(h.actions()).toEqual([]);
  });
});

describe('bounded Room consumer inbox', () => {
  it('acks only actual queue capacity, then waits for take and refuses an additional waiter', async () => {
    const inbox = createArenaRoomInbox(); const controller = new AbortController();
    const context = { signal: controller.signal, isCurrent: () => true };
    expect(inbox.acceptBatch(batchAt(0), context)).toBe(true);
    const waiting = inbox.acceptBatch(batchAt(1), context); let settled = false;
    void Promise.resolve(waiting).then(() => { settled = true; }); await tick(); expect(settled).toBe(false);
    expect(inbox.acceptBatch(batchAt(2), context)).toBe(false);
    expect(inbox.take()?.sequence).toBe(0); expect(await waiting).toBe(true); expect(inbox.take()?.sequence).toBe(1);
    expect(inbox.take()).toBeUndefined();
  });
  it('discards retired data and cancels pending acceptance before consumer installation', async () => {
    const inbox = createArenaRoomInbox(); const controller = new AbortController();
    const context = { signal: controller.signal, isCurrent: () => !controller.signal.aborted };
    inbox.acceptBatch(batchAt(0), context); const waiting = inbox.acceptBatch(batchAt(1), context);
    controller.abort(); expect(await waiting).toBe(false); expect(inbox.take()).toBeUndefined();
    inbox.close(); expect(inbox.acceptBatch(batchAt(2), context)).toBe(false);
  });
});

const nativeOutput = process.env.MAHO_ROOM_NATIVE_IPC_FIXTURE;
it.skipIf(!nativeOutput)('passes unchanged Native-produced notification/pull objects through the real bridge', async () => {
  const native = JSON.parse(readFileSync(nativeOutput!, 'utf8'));
  expect(native.notifications.length).toBeGreaterThan(0);
  const channel: ArenaRoomChannel = { onmessage: () => undefined };
  const consumed: DesktopRoomBatch[] = []; let index = 0;
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === DESKTOP_ROOM_IPC_COMMANDS.attach) return native.attach;
    if (command === DESKTOP_ROOM_IPC_COMMANDS.detach) return { detached: true };
    const value = args!.request as { handle: string; request: { kind: string; subscriptionId: string; batchId: string; sequence: number } };
    if (value.request.kind === 'pull') return native.pulls[index];
    if (value.request.kind !== 'ack') throw new Error('unexpected command');
    if (native.pulls[index]?.batch.batchId === value.request.batchId
      && native.pulls[index]?.batch.sequence === value.request.sequence) index += 1;
    return { kind: 'acknowledged', handle: value.handle, subscriptionId: value.request.subscriptionId,
      batchId: value.request.batchId, sequence: value.request.sequence, accepted: true };
  });
  const errors: ArenaRoomBridgeError[] = [];
  const bridge = createArenaRoomBridge(invoke, { createChannel: () => channel, isCurrent: () => true,
    getDocumentNonce: () => fixture.attachRequest.documentNonce, onError: (error) => errors.push(error),
    acceptBatch: (batch) => { consumed.push(batch); return true; } });
  await bridge.attach({ ...fixture.attachRequest, expectedUserId: native.expectedUserId });
  for (const notification of native.notifications) { channel.onmessage(notification); await tick(); }
  expect(consumed).toEqual(native.pulls.map((pull: { batch: DesktopRoomBatch }) => pull.batch));
  expect(index).toBe(native.pulls.length);
  const revoked = native.notifications.find((notification: { type: string }) => notification.type === 'revoked');
  if (revoked) expect(errors[0]).toMatchObject({ ...revoked.error, requestId: revoked.requestId, operation: revoked.operation });
});
