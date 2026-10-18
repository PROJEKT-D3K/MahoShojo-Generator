/** Server-only Room admission. None of these capabilities survive JSON/HTTP. */
export const ROOM_GENERATION_START_GATE_VERSION = 'room-generation-start-gate-v1' as const;
export const ROOM_GENERATION_LEGACY_START_VERSION = 'room-generation-legacy-start-v1' as const;

export type RoomGenerationAdmission = Readonly<{
  version: typeof ROOM_GENERATION_START_GATE_VERSION | typeof ROOM_GENERATION_LEGACY_START_VERSION;
  roomId: string;
  roomEpoch: string;
  hostUserId: string;
  hostAccountUserId: number;
  generationId: string;
  generationRequestId: string;
  attempt: 1;
  configRevision: number;
  snapshotDigest: string;
  generationPayloadDigest: string | null;
  mode: string;
  startedAt: string;
}>;

const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const key = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
export const isRoomGenerationAdmission = (value: unknown): value is RoomGenerationAdmission => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (input.version === ROOM_GENERATION_START_GATE_VERSION || input.version === ROOM_GENERATION_LEGACY_START_VERSION)
    && ['roomId', 'roomEpoch', 'hostUserId', 'generationId', 'generationRequestId'].every((field) => key(input[field]))
    && Number.isSafeInteger(input.hostAccountUserId) && Number(input.hostAccountUserId) > 0
    && input.attempt === 1 && Number.isSafeInteger(input.configRevision) && Number(input.configRevision) >= 0
    && digest(input.snapshotDigest)
    && (digest(input.generationPayloadDigest) || (input.version === ROOM_GENERATION_LEGACY_START_VERSION && input.generationPayloadDigest === null))
    && ['classic', 'kizuna', 'daily', 'scenario'].includes(String(input.mode))
    && typeof input.startedAt === 'string' && Number.isFinite(Date.parse(input.startedAt));
};

export const sameRoomGenerationAdmission = (left: unknown, right: RoomGenerationAdmission): boolean => (
  isRoomGenerationAdmission(left)
  && (Object.keys(right) as Array<keyof RoomGenerationAdmission>).every((field) => left[field] === right[field])
);

/** Hlegacy is already the canonical semantic hash; it is never rehashed. */
export const roomGenerationLegacyPayloadHash = (admission: RoomGenerationAdmission): string => {
  if (admission.version !== ROOM_GENERATION_START_GATE_VERSION || !digest(admission.generationPayloadDigest)) {
    throw new Error('ARENA_ROOM_START_GATE_INVALID');
  }
  return admission.generationPayloadDigest.slice('sha256:'.length);
};

export const hashRoomProducerToken = async (token: string): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

declare const roomStartCapability: unique symbol;
declare const roomCancelCapability: unique symbol;
export type ArenaGenerationRoomStartContext = { readonly [roomStartCapability]: true };
export type ArenaGenerationRoomCancelContext = { readonly [roomCancelCapability]: true };
export type RoomStartContextData = Readonly<{
  admission: RoomGenerationAdmission;
  bindProducer?: (_producerTokenDigest: string) => Promise<boolean>;
}>;
export type RoomCancelContextData = Readonly<{
  admission: RoomGenerationAdmission;
  producerTokenDigest: string | null;
}>;
const starts = new WeakMap<object, RoomStartContextData>();
const cancels = new WeakMap<object, RoomCancelContextData>();
export const issueArenaGenerationRoomStartContext = (input: RoomStartContextData): ArenaGenerationRoomStartContext => {
  if (!isRoomGenerationAdmission(input.admission)
    || (input.admission.version === ROOM_GENERATION_START_GATE_VERSION && typeof input.bindProducer !== 'function')) {
    throw new Error('ARENA_ROOM_START_GATE_INVALID');
  }
  const context = Object.freeze(Object.create(null)) as ArenaGenerationRoomStartContext;
  starts.set(context, { ...input, admission: Object.freeze({ ...input.admission }) });
  return context;
};
export const issueArenaGenerationRoomCancelContext = (input: RoomCancelContextData): ArenaGenerationRoomCancelContext => {
  if (!isRoomGenerationAdmission(input.admission) || input.admission.version !== ROOM_GENERATION_START_GATE_VERSION
    || (input.producerTokenDigest !== null && !digest(input.producerTokenDigest))) {
    throw new Error('ARENA_ROOM_START_GATE_INVALID');
  }
  const context = Object.freeze(Object.create(null)) as ArenaGenerationRoomCancelContext;
  cancels.set(context, { ...input, admission: Object.freeze({ ...input.admission }) });
  return context;
};
export const readRoomStartContext = (input: unknown): RoomStartContextData | null => (
  input !== null && typeof input === 'object' ? starts.get(input) ?? null : null
);
export const readRoomCancelContext = (input: unknown): RoomCancelContextData | null => (
  input !== null && typeof input === 'object' ? cancels.get(input) ?? null : null
);
