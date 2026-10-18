import { DesktopRoomInjectedProviderSchema } from '@mahoshojo/contracts/desktop-room-session';
/** Synthetic producer beneath the real Room service/materializer/publisher. No model service or transport. */
import { canonicalizeNodeArenaGenerationSemanticPayload, deriveArenaGenerationId } from '@mahoshojo/hosted-runtime/arena-generation';
import type { ArenaGenerationOwnedProjection } from '@mahoshojo/hosted-api/arena-generation/service';
import { hashArenaRoomGenerationPayload, type ArenaRoomGenerationEvent, type ArenaRoomGenerationPort, type ArenaRoomGenerationSubscription } from '../src/arena-generation/room-generation-port';
import { createArenaRoomGenerationService } from '../src/arena-room/room-generation-service';
import { createArenaRoomGenerationMaterializer } from '../src/arena-room/room-generation-materializer';
import { ArenaRoomGenerationContentResolverError } from '../src/arena-room/room-generation-content-resolver';
import { createArenaRoomGenerationPresetResolver } from '../src/arena-room/room-generation-preset-registry';
import type { ArenaRoomMembershipService } from '../src/arena-room/room-membership-service';
import { ROOM_ACCEPTANCE_GENERATION_LARGE_BYTES, ROOM_ACCEPTANCE_GENERATION_TAIL } from './desktop-room-acceptance-generation';

// Public, deliberately non-working fixture value. Never accept a real provider Key in the synthetic producer.
export const ROOM_ACCEPTANCE_BYOK_KEY = 'maho-room-synthetic-byok-key';
export const ROOM_ACCEPTANCE_START_SCENARIOS = ['start-reserve-only', 'start-unavailable', 'start-available', 'start-large', 'start-delta', 'start-complete', 'start-cancel-wait', 'start-cancel-complete'] as const;
export type RoomAcceptanceStartScenario = typeof ROOM_ACCEPTANCE_START_SCENARIOS[number];
type RecordState = { roomId: string; projection: ArenaGenerationOwnedProjection; sequence: number;
  listeners: Set<ReadableStreamDefaultController<ArenaRoomGenerationEvent>> };
const refuse = (): never => { throw new Error('ACCEPTANCE_START_CONTROL_REFUSED'); };
const terminal = (value: RecordState) => ['completed', 'failed', 'cancelled', 'producer_lost'].includes(value.projection.status);

export const createRoomAcceptanceStart = (options: {
  memberships: Pick<ArenaRoomMembershipService, 'resolveActiveByAccount'>;
  publicCharacter: { id: string; name: string; updated_at: string; data: string };
}) => {
  const reservations = new Set<string>();
  const records = new Map<string, RecordState>();
  let latest: RecordState | null = null, reserveOnly = false, unavailable = false, large = false, cancelWait = false, cancelPending = false, disposed = false;
  const counts = { startDispatches: 0, cancelDispatches: 0, readDispatches: 0, startPortCalls: 0, syntheticProducers: 0, startReservations: 0, byokStartPortCalls: 0 };
  const bump = (key: keyof typeof counts) => { if (counts[key] >= 65_536) refuse(); counts[key] += 1; };
  const key = (roomId: string, generationId: string) => JSON.stringify([roomId, generationId]);
  const get = (roomId: string, generationId: string) => records.get(key(roomId, generationId));
  const subscription = (value: RecordState): ArenaRoomGenerationSubscription => {
    let owned: ReadableStreamDefaultController<ArenaRoomGenerationEvent> | undefined;
    return ({
    generationId: value.projection.generationId, generationRequestId: value.projection.generationRequestId,
    events: new ReadableStream<ArenaRoomGenerationEvent>({
      start(controller) {
        if (disposed || value.listeners.size >= 2) { controller.error(new Error('ACCEPTANCE_STREAM_BOUND')); return; }
        owned = controller; value.listeners.add(controller);
        controller.enqueue({ id: `event-${++value.sequence}`, type: 'snapshot', status: value.projection.status,
          markdown: value.projection.markdown, updatedAt: value.projection.updatedAt, lastEventId: null });
      }, cancel() { if (owned) value.listeners.delete(owned); owned = undefined; },
    }),
  }); };
  const emit = (value: RecordState, event: ArenaRoomGenerationEvent) => {
    for (const listener of value.listeners) {
      if ((listener.desiredSize ?? 0) < -16) return refuse();
      listener.enqueue(event);
    }
  };
  const finish = (value: RecordState, status: 'completed' | 'cancelled') => {
    if (terminal(value)) return;
    value.projection = { ...value.projection, status, updatedAt: new Date().toISOString(),
      finalAuthoritative: status === 'completed', resultAvailable: status === 'completed',
      generationRecordId: status === 'completed' ? `synthetic-record-${value.projection.generationId}` : null,
      ...(status === 'completed' ? { roomSafeResult: { version: 1, format: 'stream-markdown', mode: 'daily' } } : {}) };
    emit(value, { id: `event-${++value.sequence}`, type: 'done', status, generationRecordId: value.projection.generationRecordId, resultAvailable: status === 'completed' });
    for (const listener of value.listeners) listener.close(); value.listeners.clear();
  };
  const port: ArenaRoomGenerationPort = {
    deriveGenerationId: input => deriveArenaGenerationId({ actorKey: `pvp-room:${input.roomId}`, generationRequestId: input.generationRequestId }),
    hashSemanticPayload: input => hashArenaRoomGenerationPayload(input, value => canonicalizeNodeArenaGenerationSemanticPayload({
      ...value, signatures: { generateSignature: async () => null, verifySignature: async () => false },
    })),
    async startFromHostRequest(input) {
      bump('startPortCalls');
      const reservation = key(input.roomId, input.generationRequestId);
      if (!reservations.has(reservation)) { if (reservations.size >= 64) return refuse(); reservations.add(reservation); bump('startReservations'); }
      if (disposed) return refuse();
      if (Object.hasOwn(input.payload, 'customProvider')) {
        const provider = DesktopRoomInjectedProviderSchema.safeParse(input.payload.customProvider);
        if (!provider.success || provider.data.apiKey !== ROOM_ACCEPTANCE_BYOK_KEY) return refuse();
        bump('byokStartPortCalls');
      }
      if (reserveOnly) { reserveOnly = false; throw new Error('SYNTHETIC_RESERVATION_ONLY'); }
      const generationId = await port.deriveGenerationId(input), existing = get(input.roomId, generationId);
      if (existing) return { kind: 'subscribed', subscription: subscription(existing) };
      if (records.size >= 64) return refuse();
      const value: RecordState = { roomId: input.roomId, sequence: 0, listeners: new Set(), projection: {
        generationId, generationRequestId: input.generationRequestId, status: 'running',
        markdown: large ? 'x'.repeat(ROOM_ACCEPTANCE_GENERATION_LARGE_BYTES - Buffer.byteLength(ROOM_ACCEPTANCE_GENERATION_TAIL)) + ROOM_ACCEPTANCE_GENERATION_TAIL : '# Synthetic started report' + ROOM_ACCEPTANCE_GENERATION_TAIL,
        resumeCursor: null, updatedAt: new Date().toISOString(), finalAuthoritative: false, resultAvailable: false, generationRecordId: null, errorCode: null,
      } };
      large = false; records.set(key(input.roomId, generationId), value); latest = value; bump('syntheticProducers');
      return { kind: 'subscribed', subscription: subscription(value) };
    },
    async readOwnedProjection(input) {
      if (disposed || unavailable) return { kind: 'unavailable', code: 'SYNTHETIC_UNAVAILABLE' };
      const value = get(input.roomId, input.generationId);
      return value ? { kind: 'found', projection: value.projection } : { kind: 'not-found' };
    },
    async resumeOwnedSubscription(input) {
      if (disposed || unavailable) return { kind: 'unavailable', code: 'SYNTHETIC_UNAVAILABLE' };
      const value = get(input.roomId, input.generationId);
      return value ? { kind: 'subscribed', subscription: subscription(value) } : { kind: 'not-found' };
    },
    async cancelOwned(input) {
      const value = get(input.roomId, input.generationId); if (!value) return { kind: 'not-found' };
      if (cancelWait) { cancelWait = false; cancelPending = true; }
      else finish(value, 'cancelled');
      return { kind: 'accepted', cancelReason: 'user' };
    },
  };
  const presets = createArenaRoomGenerationPresetResolver();
  const service = createArenaRoomGenerationService({ memberships: options.memberships,
    materializer: createArenaRoomGenerationMaterializer({ content: {
      resolvePreset: input => presets.resolve(input),
      async resolveOnline({ ref, hostAccountUserId }) {
        if (ref.id !== options.publicCharacter.id || ref.kind !== 'character' || ![101, 202].includes(hostAccountUserId)) throw new ArenaRoomGenerationContentResolverError('ARENA_ROOM_REFERENCE_NOT_READABLE');
        return { ref: { ...ref, versionToken: options.publicCharacter.updated_at }, payload: JSON.parse(options.publicCharacter.data) as Record<string, unknown>, displayName: options.publicCharacter.name, sourceType: 'character' };
      },
    } }), generation: port,
    onBackgroundError: () => { /* No raw input or exceptions escape the synthetic control protocol. */ },
  });
  return {
    service: { ...service,
      start: (input: Parameters<typeof service.start>[0]) => { bump('startDispatches'); return service.start(input); },
      read: (input: Parameters<typeof service.read>[0]) => { bump('readDispatches'); return service.read(input); },
      cancel: (input: Parameters<typeof service.cancel>[0]) => { bump('cancelDispatches'); return service.cancel(input); },
    },
    observe: () => ({ ...counts, startEnabled: true as const, fixture: latest ? terminal(latest) ? latest.projection.status === 'cancelled' ? 'cancelled' as const : 'completed' as const : 'running' as const : 'none' as const }),
    control(scenario: RoomAcceptanceStartScenario) {
      if (disposed || !ROOM_ACCEPTANCE_START_SCENARIOS.includes(scenario)) return refuse();
      if (scenario === 'start-reserve-only') { if (reserveOnly) return refuse(); reserveOnly = true; return; }
      if (scenario === 'start-unavailable') { unavailable = true; return; }
      if (scenario === 'start-available') { unavailable = false; return; }
      if (scenario === 'start-large') { large = true; return; }
      if (!latest || terminal(latest)) return refuse();
      if (scenario === 'start-complete') { finish(latest, 'completed'); return; }
      if (scenario === 'start-cancel-wait') { cancelWait = true; return; }
      if (scenario === 'start-cancel-complete') { if (!cancelPending) return refuse(); cancelPending = false; finish(latest, 'cancelled'); return; }
      if (scenario === 'start-delta') {
        const chunk = '\n合成启动增量🌙';
        latest.projection = { ...latest.projection, markdown: latest.projection.markdown + chunk };
        emit(latest, { id: `event-${++latest.sequence}`, type: 'markdown', chunk }); return;
      }
      return refuse();
    },
    dispose() { disposed = true; for (const value of records.values()) { for (const listener of value.listeners) listener.close(); value.listeners.clear(); } records.clear(); latest = null; },
  };
};
