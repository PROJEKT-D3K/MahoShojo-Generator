import { describe, expect, it, vi } from 'vitest';
import { createMemoryGenerationReplayStore } from '../src/arena-generation/memory-replay-store';
import {
  createArenaGenerationService, issueArenaGenerationRoomCancelContext, issueArenaGenerationRoomStartContext,
  ROOM_GENERATION_START_GATE_VERSION, type ArenaGenerationTerminalRecord, type ArenaGenerationNoProviderCancellationRecorder,
  type RoomGenerationAdmission,
} from '../src/arena-generation/service';
import { hashRoomProducerToken } from '../src/arena-generation/room-start';

const admission: RoomGenerationAdmission = {
  version: ROOM_GENERATION_START_GATE_VERSION, roomId: 'room-1', roomEpoch: 'epoch-1', hostUserId: 'host-1', hostAccountUserId: 42,
  generationId: 'generation-1', generationRequestId: 'request-1', attempt: 1, configRevision: 0,
  snapshotDigest: `sha256:${'a'.repeat(64)}`, generationPayloadDigest: `sha256:${'b'.repeat(64)}`,
  mode: 'classic', startedAt: '2026-08-27T16:00:00.000Z',
};
const actorKey = 'pvp-room:room-1';
const fixture = (recorderKind: 'recorded' | 'unknown' | 'conflict' | 'pending' | 'unavailable' = 'recorded') => {
  let timestamp = Date.parse(admission.startedAt);
  let liveGate = true;
  let terminal: ArenaGenerationTerminalRecord | null = null;
  const store = createMemoryGenerationReplayStore({ now: () => timestamp, activeTtlMs: 60_000,
    verifyRoomAdmission: () => liveGate });
  const recorder = vi.fn<ArenaGenerationNoProviderCancellationRecorder['record']>(async () => {
    if (recorderKind === 'recorded') terminal = {
      generationId: admission.generationId, generationRequestId: admission.generationRequestId,
      payloadHash: 'b'.repeat(64), status: 'cancelled', errorCode: 'USER_CANCELLED',
      updatedAt: new Date(timestamp).toISOString(), resultRef: null, markdown: '', reasoning: '',
    };
    return { kind: recorderKind };
  });
  const execute = vi.fn(async () => ({ status: 'cancelled' as const, code: 'USER_CANCELLED' }));
  const reaper = vi.fn<() => Promise<ArenaGenerationTerminalRecord>>(async () => { throw new Error('No fake producer loss'); });
  const service = createArenaGenerationService({ store, executor: { execute },
    noProviderCancellationRecorder: { record: recorder },
    terminalStore: { readOwnedTerminal: async () => terminal, reconcileExpiredLease: reaper },
    deriveGenerationId: async () => admission.generationId, hashPayload: async () => 'b'.repeat(64),
    resolveActor: async () => ({ actorKey }), now: () => new Date(timestamp), createProducerToken: () => 'original-token',
    replayPollMs: 1, heartbeatIntervalMs: 10,
  });
  const reserve = async () => store.reserve({ actorKey, generationId: admission.generationId, generationRequestId: admission.generationRequestId,
    payloadHash: 'b'.repeat(64), producerToken: 'original-token', producerTokenDigest: await hashRoomProducerToken('original-token'),
    roomAdmission: admission, now: new Date(timestamp).toISOString(), leaseExpiresAt: new Date(timestamp + 30_000).toISOString() });
  const cancel = async (bound: boolean) => service.cancelRoomOwned({ context: issueArenaGenerationRoomCancelContext({ admission,
    producerTokenDigest: bound ? await hashRoomProducerToken('original-token') : null }) });
  return { store, service, recorder, execute, reaper, reserve, cancel,
    expireLease: () => { timestamp += 31_000; }, disappearCore: () => { timestamp += 61_000; },
    allowLostProducerRecovery: () => { reaper.mockImplementation(async () => {
      terminal = { generationId: admission.generationId, generationRequestId: admission.generationRequestId, payloadHash: 'b'.repeat(64),
        status: 'producer_lost', errorCode: 'PRODUCER_LEASE_EXPIRED', updatedAt: new Date(timestamp).toISOString(), resultRef: null, markdown: '', reasoning: '' };
      return terminal;
    }); },
    fence: () => { liveGate = false; }, recoverD1: () => { recorderKind = 'recorded'; },
  };
};

describe('trusted Room starting cancellation core boundary', () => {
  it('allows a never-bound absent core only after the durable cancellation record exists', async () => {
    const f = fixture();
    expect(await f.cancel(false)).toEqual({ kind: 'terminal', status: 'cancelled' });
    expect(f.recorder).toHaveBeenCalledOnce();
    expect(f.execute).not.toHaveBeenCalled();
    expect(await f.service.readOwnedProjection({ actorKey, generationId: admission.generationId })).toMatchObject({
      kind: 'found', projection: { status: 'cancelled', finalAuthoritative: true, resultAvailable: false },
    });
  });

  it('requires durable proof when a previously bound core disappeared', async () => {
    const f = fixture();
    await f.reserve(); f.disappearCore();
    expect(await f.cancel(true)).toMatchObject({ kind: 'unavailable' });
    expect(f.recorder).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('atomically distinguishes reserved from running and commits no-provider only for reserved', async () => {
    const f = fixture();
    await f.reserve(); f.fence();
    expect(await f.cancel(true)).toEqual({ kind: 'terminal', status: 'cancelled' });
    expect((await f.store.readState({ actorKey, generationId: admission.generationId }))?.terminal?.status).toBe('cancelled');
    expect(f.recorder).toHaveBeenCalledOnce();
    const running = fixture();
    await running.reserve();
    await running.store.markRunning({ generationId: admission.generationId, producerToken: 'original-token', roomAdmission: admission,
      now: admission.startedAt, leaseExpiresAt: '2026-08-27T16:00:30.000Z' });
    running.fence();
    expect(await running.cancel(true)).toEqual({ kind: 'accepted', cancelReason: 'user' });
    expect(running.recorder).not.toHaveBeenCalled();
  });

  it('keeps normal durable reaper recovery for the running winner that disappears after cancellation', async () => {
    const f = fixture();
    await f.reserve();
    await f.store.markRunning({ generationId: admission.generationId, producerToken: 'original-token', roomAdmission: admission,
      now: admission.startedAt, leaseExpiresAt: '2026-08-27T16:00:30.000Z' });
    f.fence();
    expect(await f.cancel(true)).toEqual({ kind: 'accepted', cancelReason: 'user' });
    f.allowLostProducerRecovery(); f.expireLease();
    expect(await f.service.readOwnedProjection({ actorKey, generationId: admission.generationId })).toMatchObject({
      kind: 'found', projection: { status: 'producer_lost', finalAuthoritative: true },
    });
    expect(f.reaper).toHaveBeenCalledOnce();
    expect(f.recorder).not.toHaveBeenCalled();
  });

  it('reconciles an expired reserved lease only after exact durable cancellation exists', async () => {
    const f = fixture();
    await f.reserve(); f.fence(); f.expireLease();
    expect(await f.cancel(true)).toEqual({ kind: 'terminal', status: 'cancelled' });
    expect(f.reaper).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'conflict', 'pending', 'unavailable'] as const)('keeps %s durable outcome pending, without done or a fake producer_lost', async (kind) => {
    const f = fixture(kind);
    await f.reserve(); f.fence();
    expect(await f.cancel(true)).toMatchObject({ kind: 'unavailable' });
    const state = await f.store.readState({ actorKey, generationId: admission.generationId });
    expect(state).toMatchObject({ status: 'reserved', terminal: null, cancelRequested: true });
    f.expireLease();
    expect(await f.service.readOwnedProjection({ actorKey, generationId: admission.generationId })).toMatchObject({ kind: 'unavailable' });
    expect(f.reaper).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect((await f.store.readAfter({ generationId: admission.generationId, after: null, blockMs: 0 })).events).toEqual([]);
  });

  it('adopts an actual preflight rejection if cancel arrives before the Room mirror catches up', async () => {
    const store = createMemoryGenerationReplayStore({ now: () => Date.parse(admission.startedAt) });
    const terminal: ArenaGenerationTerminalRecord = { generationId: admission.generationId, generationRequestId: admission.generationRequestId,
      payloadHash: 'b'.repeat(64), status: 'failed', errorCode: 'CONTENT_POLICY_VIOLATION', updatedAt: admission.startedAt,
      resultRef: null, markdown: '', reasoning: '' };
    const execute = vi.fn();
    const noProvider = vi.fn<ArenaGenerationNoProviderCancellationRecorder['record']>(async () => ({ kind: 'already-terminal' }));
    const service = createArenaGenerationService({ store, executor: {
      prepare: async () => ({ kind: 'auditable-rejection', response: Response.json({ code: 'CONTENT_POLICY_VIOLATION' }, { status: 400 }),
        actorKey, generationRequestId: admission.generationRequestId, code: 'CONTENT_POLICY_VIOLATION', stage: 'preflight', fingerprintPayload: {},
        audit: { endpoint: 'api/arena/generate-stream', generationMode: 'stream', startedAt: admission.startedAt,
          mode: 'classic', pvpContext: { roomId: 'room-1', matchId: admission.generationId, roundId: 'attempt-1' } } }), execute,
    }, rejectedTerminalRecorder: { record: async () => ({ kind: 'recorded' }) }, noProviderCancellationRecorder: { record: noProvider },
    terminalStore: { readOwnedTerminal: async () => terminal }, deriveGenerationId: async () => admission.generationId,
    hashPayload: async () => 'b'.repeat(64), resolveActor: async () => ({ actorKey }), now: () => new Date(admission.startedAt),
    });
    const context = issueArenaGenerationRoomStartContext({ admission, bindProducer: async () => { throw new Error('No producer for preflight rejection'); } });
    const started = await service.createParsedSubscription(new Request('https://synthetic.invalid', { method: 'POST' }), {
      generationRequestId: admission.generationRequestId, payload: {}, bodyBytes: 2, trustedRoomContext: context,
    });
    expect((started as Response).status).toBe(400);
    expect((await store.readState({ actorKey, generationId: admission.generationId }))?.terminal?.status).toBe('failed');
    expect(await service.cancelRoomOwned({ context: issueArenaGenerationRoomCancelContext({ admission, producerTokenDigest: null }) }))
      .toEqual({ kind: 'terminal', status: 'failed' });
    expect(noProvider).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects serialized capabilities and generic signed-PVP starts before reserving', async () => {
    const f = fixture();
    const context = issueArenaGenerationRoomStartContext({ admission, bindProducer: async () => true });
    const response = await f.service.createParsedSubscription(new Request('https://synthetic.invalid', { method: 'POST' }), {
      generationRequestId: admission.generationRequestId, payload: {}, bodyBytes: 2,
      trustedRoomContext: JSON.parse(JSON.stringify(context)),
    });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(403);
    expect(await f.store.readState({ actorKey, generationId: admission.generationId })).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(['recorded', 'unknown'] as const)('reserved-cancel launch fast path requires %s durable evidence before done', async (kind) => {
    const f = fixture(kind);
    const context = issueArenaGenerationRoomStartContext({ admission, bindProducer: async () => {
      await f.store.requestCancel({ generationId: admission.generationId, actorKey, reason: 'user', now: admission.startedAt });
      return true;
    } });
    const result = await f.service.createParsedSubscription(new Request('https://synthetic.invalid', { method: 'POST' }), {
      generationRequestId: admission.generationRequestId, payload: {}, bodyBytes: 2, trustedRoomContext: context,
    });
    const state = await f.store.readState({ generationId: admission.generationId, actorKey });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.recorder).toHaveBeenCalledOnce();
    if (kind === 'unknown') {
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(503);
      expect(state?.terminal).toBeNull();
      f.recoverD1();
      expect(await f.cancel(true)).toEqual({ kind: 'terminal', status: 'cancelled' });
    } else {
      expect(result).not.toBeInstanceOf(Response);
      expect(state?.terminal?.status).toBe('cancelled');
    }
  });
});
