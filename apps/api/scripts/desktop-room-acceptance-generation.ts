/** Bounded synthetic current-generation fixture. Never constructs a generation/model service. */
import { createHash } from 'node:crypto';
import { ArenaRoomGenerationViewResponseSchema, type ArenaRoomGenerationViewResponse } from '@mahoshojo/contracts/arena-room';
import {
  issueArenaRoomGenerationPublisherAuthority, issueArenaRoomGenerationReservationAuthority,
  issueArenaRoomTrustedTime, type ArenaRoomAuthorityState,
} from '@mahoshojo/multiplayer-core';
import type { RoomActor } from '../src/arena-room/room-actor-registry';
import type { ArenaRoomMembershipService } from '../src/arena-room/room-membership-service';
import { ArenaRoomGenerationError } from '../src/arena-room/room-generation-service';
import type { RoomWebSocketAuthorization, RoomWebSocketPeer } from '../src/arena-room/room-websocket-gateway';

export const ROOM_ACCEPTANCE_GENERATION_SCENARIOS = ['seed', 'seed-large', 'delta', 'gap', 'disconnect', 'complete', 'hold-read', 'release-read'] as const;
export type RoomAcceptanceGenerationScenario = typeof ROOM_ACCEPTANCE_GENERATION_SCENARIOS[number];
export const ROOM_ACCEPTANCE_GENERATION_LARGE_BYTES = 1024 * 1024;
export const ROOM_ACCEPTANCE_GENERATION_TAIL = '\n验收尾标：月光🌙终章';
export const ROOM_ACCEPTANCE_GENERATION_HOLD_MS = 30_000;
const MAX_COUNT = 65_536;
const counters = () => ({ readRequests: 0, readDispatches: 0, startRequests: 0, cancelRequests: 0, modelRequests: 0,
  startDispatches: 0, cancelDispatches: 0, modelDispatches: 0, deltaFrames: 0, droppedFrames: 0, disconnections: 0 });
export type RoomAcceptanceGenerationObservation = ReturnType<typeof counters> & { fixture: 'none' | 'running' | 'completed'; readHeld: boolean };
type Fixture = { roomId: string; roomEpoch: string; generationId: string; generationRequestId: string; attempt: number;
  actor: RoomActor; markdown: string; nextChunkSeq: number; completed: boolean; dropSequence: number | null };
const refuse = (): never => { throw new Error('ACCEPTANCE_CONTROL_REFUSED'); };
const unavailable = () => new ArenaRoomGenerationError('ROOM_GENERATION_UNAVAILABLE');

export const createRoomAcceptanceGeneration = (options: {
  states: () => readonly ArenaRoomAuthorityState[];
  memberships: () => Pick<ArenaRoomMembershipService, 'resolveActiveByAccount'>;
}) => {
  const counts = counters();
  let fixture: Fixture | null = null;
  let sequence = 0, controlling = false, disposed = false, holdArmed = false;
  let held: { value: ArenaRoomGenerationViewResponse; resolve(value: ArenaRoomGenerationViewResponse): void;
    reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
  const peers = new Set<{ roomId: string; roomEpoch: string | null; peer: RoomWebSocketPeer }>();
  const checkCount = (key: keyof typeof counts, increment = 1) => { if (counts[key] + increment > MAX_COUNT) refuse(); };
  const bump = (key: keyof typeof counts, increment = 1) => { checkCount(key, increment); counts[key] += increment; };
  const current = () => {
    if (!fixture || disposed) return refuse();
    const state = fixture.actor.getSnapshot(), mirror = state?.snapshot.activeGeneration;
    if (!state || state.lifecycle.status !== 'open' || state.snapshot.roomEpoch !== fixture.roomEpoch
      || mirror?.generationId !== fixture.generationId || mirror.attempt !== fixture.attempt) return refuse();
    return { fixture, state };
  };
  const timestamp = (state: ArenaRoomAuthorityState) => new Date(Math.max(Date.now(), Date.parse(state.lifecycle.updatedAt))).toISOString();
  const publisher = (value: Fixture, now: string) => issueArenaRoomGenerationPublisherAuthority({
    roomId: value.roomId, roomEpoch: value.roomEpoch, generationId: value.generationId,
    generationRequestId: value.generationRequestId, attempt: value.attempt,
    expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
  });
  const mirror = async (value: Fixture, target: 'running' | 'completed') => {
    const state = value.actor.getSnapshot(); if (!state) return refuse();
    const now = timestamp(state);
    const result = await value.actor.execute({ authority: publisher(value, now), trustedTime: issueArenaRoomTrustedTime({ now }),
      command: { type: 'mirror-generation', expectedRoomEpoch: value.roomEpoch, generationRequestId: value.generationRequestId,
        generationId: value.generationId, attempt: value.attempt, state: target, timestamp: now,
        ...(target === 'completed' ? { generationRecordId: `acceptance-record-${value.attempt}` } : {}) } });
    if (!result.ok) refuse();
  };
  const publish = async (value: Fixture, delta: string) => {
    checkCount('deltaFrames');
    const state = value.actor.getSnapshot(); if (!state) return refuse();
    const now = timestamp(state);
    const result = await value.actor.publishStory({ authority: publisher(value, now), trustedTime: issueArenaRoomTrustedTime({ now }),
      event: { protocolVersion: 1, type: 'story.delta', roomId: value.roomId, roomEpoch: value.roomEpoch,
        generationId: value.generationId, chunkSeq: value.nextChunkSeq, timestamp: now, payload: { delta } } });
    if (!result.ok || result.kind !== 'published') refuse();
    value.markdown += delta; value.nextChunkSeq += 1; bump('deltaFrames');
  };
  const seed = async (large: boolean) => {
    if (fixture && !fixture.completed) return refuse();
    const open = options.states().filter(state => state.lifecycle.status === 'open');
    if (open.length !== 1 || sequence >= MAX_COUNT) return refuse();
    const selected = open[0]!;
    if (fixture && (fixture.roomId !== selected.snapshot.roomId || fixture.roomEpoch !== selected.snapshot.roomEpoch)) return refuse();
    const active = selected.memberAuthority.filter(record => record.member.membershipState === 'active');
    if (active.length !== 2 || ![101, 202].every(id => active.some(record => record.accountUserId === id))) return refuse();
    const host = active.find(record => record.member.role === 'host'); if (!host) return refuse();
    const member = await options.memberships().resolveActiveByAccount({ roomId: selected.snapshot.roomId, accountUserId: host.accountUserId });
    if (disposed) return refuse();
    const state = member.actor.getSnapshot();
    if (!state || state.snapshot.roomEpoch !== selected.snapshot.roomEpoch
      || options.states().filter(value => value.lifecycle.status === 'open').length !== 1
      || state.memberAuthority.filter(record => record.member.membershipState === 'active').length !== 2
      || ![101, 202].every(id => state.memberAuthority.some(record => record.accountUserId === id && record.member.membershipState === 'active'))) return refuse();
    const attempt = sequence + 1, now = timestamp(state);
    const value: Fixture = { roomId: state.snapshot.roomId, roomEpoch: state.snapshot.roomEpoch,
      generationId: `acceptance-generation-${attempt}`, generationRequestId: `acceptance-generation-request-${attempt}`,
      attempt, actor: member.actor, markdown: large
        ? 'x'.repeat(ROOM_ACCEPTANCE_GENERATION_LARGE_BYTES - Buffer.byteLength(ROOM_ACCEPTANCE_GENERATION_TAIL)) + ROOM_ACCEPTANCE_GENERATION_TAIL
        : '# Synthetic current report' + ROOM_ACCEPTANCE_GENERATION_TAIL,
      nextChunkSeq: 0, completed: false, dropSequence: null };
    const snapshotDigest = `sha256:${createHash('sha256').update(JSON.stringify(state.snapshot)).digest('hex')}`;
    const generationPayloadDigest = `sha256:${createHash('sha256').update(value.markdown).digest('hex')}`;
    const prior = fixture; fixture = value;
    const result = await member.actor.execute({ authority: issueArenaRoomGenerationReservationAuthority({
      actorUserId: host.member.userId, accountUserId: host.accountUserId, roomId: value.roomId, roomEpoch: value.roomEpoch,
      configRevision: state.snapshot.revision, generationRequestId: value.generationRequestId, generationId: value.generationId,
      attempt, snapshotDigest, generationPayloadDigest, expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
    }), trustedTime: issueArenaRoomTrustedTime({ now }), command: { type: 'reserve-generation',
      expectedRoomEpoch: value.roomEpoch, expectedRevision: state.snapshot.revision, expectedControlSeq: state.snapshot.controlSeq,
      generationRequestId: value.generationRequestId, generationId: value.generationId, attempt, generationPayloadDigest, timestamp: now } });
    if (disposed) return refuse();
    if (!result.ok) { fixture = prior; return refuse(); }
    sequence = attempt;
    await mirror(value, 'running');
  };
  return {
    observe: (): RoomAcceptanceGenerationObservation => ({ fixture: fixture ? fixture.completed ? 'completed' : 'running' : 'none', readHeld: held !== null, ...counts }),
    recordRequest(request: Request) {
      const url = new URL(request.url), path = url.pathname;
      if (request.method === 'GET' && /^\/api\/arena\/rooms\/v1\/[^/]+\/generations\/[^/]+$/u.test(path)) bump('readRequests');
      if (request.method === 'POST' && /^\/api\/arena\/rooms\/v1\/[^/]+\/generations$/u.test(path)) bump('startRequests');
      if (request.method === 'POST' && /^\/api\/arena\/rooms\/v1\/[^/]+\/generations\/[^/]+\/cancel$/u.test(path)) bump('cancelRequests');
      if (request.method === 'POST' && ['/api/arena/generate-stream', '/api/arena/session/generate-next',
        '/api/creator/generate', '/api/creator/generate-stream'].includes(path)) bump('modelRequests');
    },
    refusedDispatch(kind: 'start' | 'cancel'): never { bump(kind === 'start' ? 'startDispatches' : 'cancelDispatches'); return refuse(); },
    async read(input: { roomId: string; generationId: string; accountUserId: number }): Promise<ArenaRoomGenerationViewResponse> {
      bump('readDispatches');
      const member = await options.memberships().resolveActiveByAccount({ roomId: input.roomId, accountUserId: input.accountUserId });
      const value = fixture, state = member.actor.getSnapshot(), active = state?.snapshot.activeGeneration;
      if (disposed || !value || !state || state.lifecycle.status !== 'open' || value.roomId !== input.roomId
        || value.roomEpoch !== state.snapshot.roomEpoch || input.generationId !== value.generationId
        || active?.generationId !== value.generationId || active.attempt !== value.attempt) throw new ArenaRoomGenerationError('ROOM_GENERATION_NOT_FOUND');
      const completed = active.state === 'completed';
      const response = ArenaRoomGenerationViewResponseSchema.parse({ protocolVersion: 1, roomId: value.roomId,
        roomEpoch: value.roomEpoch, generation: active, status: completed ? 'completed' : active.state === 'starting' ? 'reserved' : 'running',
        markdown: value.markdown, nextChunkSeq: completed ? 0 : value.nextChunkSeq, finalAuthoritative: completed,
        ...(completed ? { generationRecordId: `acceptance-record-${value.attempt}`, result: { version: 1, format: 'stream-markdown', mode: 'classic' } } : {}) });
      if (held) throw unavailable();
      if (!holdArmed) return response;
      holdArmed = false;
      return new Promise((resolve, reject) => {
        const slot = { value: response, resolve, reject, timer: setTimeout(() => {
          if (held !== slot) return;
          held = null; reject(unavailable());
        }, ROOM_ACCEPTANCE_GENERATION_HOLD_MS) };
        held = slot;
      });
    },
    wrapAuthorization(decision: RoomWebSocketAuthorization): RoomWebSocketAuthorization {
      if (!decision.accepted || !decision.connectionAuthority) return decision;
      const authority = decision.connectionAuthority;
      return { ...decision, connectionAuthority: { async activate(peer) {
        const entry: { roomId: string; roomEpoch: string | null; peer: RoomWebSocketPeer } = { roomId: decision.roomId, roomEpoch: null, peer }; peers.add(entry);
        try {
          const connection = await authority.activate({ close: (code, reason) => peer.close(code, reason), send: message => {
            if (message.type === 'room.snapshot') entry.roomEpoch = message.roomEpoch;
            if (fixture && message.type === 'story.delta' && message.roomId === fixture.roomId
              && message.roomEpoch === fixture.roomEpoch && message.generationId === fixture.generationId
              && message.chunkSeq === fixture.dropSequence) { bump('droppedFrames'); return true; }
            return peer.send(message);
          } });
          return { onMessage: connection.onMessage?.bind(connection), async dispose() { peers.delete(entry); await connection.dispose?.(); } };
        } catch (error) { peers.delete(entry); throw error; }
      } } };
    },
    async control(scenario: RoomAcceptanceGenerationScenario) {
      if (disposed || controlling || !ROOM_ACCEPTANCE_GENERATION_SCENARIOS.includes(scenario)) return refuse();
      controlling = true;
      try {
        if (scenario === 'release-read') {
          if (!held) return refuse();
          const slot = held; held = null; clearTimeout(slot.timer); slot.resolve(slot.value); return;
        }
        if (scenario === 'seed' || scenario === 'seed-large') { await seed(scenario === 'seed-large'); return; }
        const { fixture: value } = current();
        if (scenario === 'hold-read') {
          if (held || holdArmed) return refuse();
          holdArmed = true; return;
        }
        if (scenario === 'disconnect') {
          const targets = [...peers].filter(entry => entry.roomId === value.roomId && entry.roomEpoch === value.roomEpoch);
          if (!targets.length) return refuse();
          checkCount('disconnections', targets.length);
          for (const target of targets) { peers.delete(target); target.peer.close(1012, 'Synthetic recovery'); bump('disconnections'); }
          return;
        }
        if (value.completed) return refuse();
        if (scenario === 'complete') { await mirror(value, 'completed'); value.completed = true; return; }
        if (scenario === 'delta') { await publish(value, '\n受控增量🌙'); return; }
        if (scenario === 'gap') {
          const targets = [...peers].filter(entry => entry.roomId === value.roomId && entry.roomEpoch === value.roomEpoch);
          if (!targets.length) return refuse();
          checkCount('deltaFrames', 2); checkCount('droppedFrames', targets.length);
          value.dropSequence = value.nextChunkSeq;
          await publish(value, '\n受控缺口（仅传输丢帧）'); await publish(value, '\n缺口之后🌙'); return;
        }
        return refuse();
      } finally { controlling = false; }
    },
    dispose() {
      disposed = true; holdArmed = false;
      if (held) { const slot = held; held = null; clearTimeout(slot.timer); slot.reject(unavailable()); }
      peers.clear(); fixture = null;
    },
  };
};
