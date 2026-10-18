import { describe, expect, it } from 'vitest';
import {
  ArenaRoomAuthorityStateSchema,
  ARENA_ROOM_GENERATION_START_GATE_VERSION,
  issueArenaRoomGenerationReservationAuthority,
  type ArenaRoomAuthorityState,
} from '../src';
import {
  createRoomCommand, hostAuthority, generationPayloadDigest, snapshotDigest, transitionArenaRoomAt,
} from './state-machine-fixtures';

const at = '2026-08-27T16:01:00.000Z';
const token = `sha256:${'c'.repeat(64)}`;
const request = 'request-1';
const scope = (gated = true) => issueArenaRoomGenerationReservationAuthority({
  actorUserId: 'host-1', accountUserId: 101, roomId: 'room-1', roomEpoch: 'epoch-1',
  configRevision: 0, generationRequestId: request, generationId: 'generation-1', attempt: 1,
  snapshotDigest: snapshotDigest(request), generationPayloadDigest: generationPayloadDigest(request),
  expiresAt: '2026-08-27T16:30:00.000Z',
  ...(gated ? { startGateVersion: ARENA_ROOM_GENERATION_START_GATE_VERSION } : {}),
});
const reserve = (state: ArenaRoomAuthorityState, gated: boolean) => transitionArenaRoomAt(state, {
  type: 'reserve-generation', expectedRoomEpoch: 'epoch-1', expectedRevision: 0,
  expectedControlSeq: 0, generationRequestId: request, generationId: 'generation-1', attempt: 1,
  generationPayloadDigest: generationPayloadDigest(request), timestamp: at,
  ...(gated ? { startGateVersion: ARENA_ROOM_GENERATION_START_GATE_VERSION } : {}),
}, scope(gated));
const create = () => {
  const result = transitionArenaRoomAt(null, createRoomCommand(), hostAuthority());
  if (!result.ok) throw new Error(result.reason);
  return result.nextState;
};
const reserved = () => {
  const result = reserve(create(), true);
  if (!result.ok) throw new Error(result.reason);
  return result.nextState;
};
const control = (state: ArenaRoomAuthorityState, type: 'bind-generation-producer' | 'cancel-generation-start', extra = {}) => transitionArenaRoomAt(state, {
  type, expectedRoomEpoch: 'epoch-1', generationRequestId: request, generationId: 'generation-1', attempt: 1,
  timestamp: at, ...(type === 'bind-generation-producer' ? { producerTokenDigest: token } : {}), ...extra,
}, scope());

describe('Room gated starting cancellation authority', () => {
  it('keeps default legacy v2 and upgrades only a new enabled reservation', () => {
    const original = create();
    expect(original.authorityStateVersion).toBe(2);
    const legacy = reserve(original, false);
    expect(legacy.ok && legacy.nextState.authorityStateVersion).toBe(2);
    const gated = reserved();
    expect(gated.authorityStateVersion).toBe(3);
    expect(gated.generationLedger[0]?.startGate).toEqual({
      version: ARENA_ROOM_GENERATION_START_GATE_VERSION, roomEpoch: 'epoch-1', hostUserId: 'host-1',
      mode: 'classic', producerTokenDigest: null, cancellationRequested: false,
    });
    expect(gated.snapshot.activeGeneration).not.toHaveProperty('startGate');
    expect(ArenaRoomAuthorityStateSchema.safeParse({ ...gated, authorityStateVersion: 2 }).success).toBe(false);
    expect(ArenaRoomAuthorityStateSchema.safeParse(gated).success).toBe(true);
    if (!legacy.ok) throw new Error('legacy required');
    const retried = reserve(legacy.nextState, true);
    expect(retried.ok && retried.kind).toBe('idempotent');
    expect(retried.ok && retried.nextState.authorityStateVersion).toBe(2);
    expect(retried.ok && retried.nextState.generationLedger[0]?.startGate).toBeUndefined();
  });

  it('binds only the original producer and fences delayed binding after cancel', () => {
    const state = reserved();
    const bound = control(state, 'bind-generation-producer');
    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error(bound.reason);
    expect(control(bound.nextState, 'bind-generation-producer')).toMatchObject({ ok: true, kind: 'idempotent' });
    expect(control(bound.nextState, 'bind-generation-producer', { producerTokenDigest: `sha256:${'d'.repeat(64)}` })).toMatchObject({ ok: false, reason: 'generation-start-fenced' });
    const cancelled = control(bound.nextState, 'cancel-generation-start');
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) throw new Error(cancelled.reason);
    expect(cancelled.nextState.generationLedger[0]?.startGate).toMatchObject({ producerTokenDigest: token, cancellationRequested: true });
    expect(cancelled.nextState.snapshot.activeGeneration?.state).toBe('starting');
    expect(control(cancelled.nextState, 'bind-generation-producer')).toMatchObject({ ok: false, reason: 'generation-start-fenced' });
    expect(control(cancelled.nextState, 'cancel-generation-start')).toMatchObject({ ok: true, kind: 'idempotent' });
  });

  it('rejects legacy, serialized, wrong host, epoch and exact identity authority', () => {
    const state = reserved();
    const command = { type: 'cancel-generation-start', expectedRoomEpoch: 'epoch-1', generationId: 'generation-1', generationRequestId: request, attempt: 1, timestamp: at };
    expect(transitionArenaRoomAt(state, command, scope(false))).toMatchObject({ ok: false, reason: 'generation-start-gate-required' });
    expect(transitionArenaRoomAt(state, command, JSON.parse(JSON.stringify(scope())))).toMatchObject({ ok: false, reason: 'invalid-authority-context' });
    expect(control(state, 'cancel-generation-start', { expectedRoomEpoch: 'epoch-other' })).toMatchObject({ ok: false });
    expect(control(state, 'cancel-generation-start', { generationRequestId: 'other' })).toMatchObject({ ok: false });
    const forged = issueArenaRoomGenerationReservationAuthority({
      ...scope().scope, actorUserId: 'host-other', accountUserId: 101,
    });
    expect(transitionArenaRoomAt(state, command, forged)).toMatchObject({ ok: false, reason: 'host-required' });
  });
});
