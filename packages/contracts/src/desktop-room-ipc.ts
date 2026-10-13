import { z } from './zod';

import {
  DESKTOP_ROOM_SESSION_LIMITS,
  DESKTOP_ROOM_SESSION_RESPONSE_SCHEMAS,
  DesktopRoomSessionErrorCodeSchema,
  DesktopRoomSessionErrorOutcomeSchema,
  DesktopRoomSessionUserIdSchema,
  parseDesktopRoomSessionResponse,
} from './desktop-room-session';
import { JsonValueSchema, type JsonValue } from './json-value';
import { OpaqueKeySchema } from './primitives';
import { RoomDirectoryPageQuerySchema } from './room-directory';
import { ArenaRoomCreateRequestSchema, ArenaRoomJoinRequestSchema } from './room-http';
import { RoomServerTransportMessageSchema } from './websocket-transport';
import { jsonUtf8ByteLength } from './wire-size';

/** Local wrappers only. HTTP and socket bodies keep their existing versioned schemas. */
export const DESKTOP_ROOM_IPC_COMMANDS = Object.freeze({
  attach: 'arena_room_attach', request: 'arena_room_request',
  subscribe: 'arena_room_subscribe', detach: 'arena_room_detach',
} as const);
export const DESKTOP_ROOM_IPC_LIMITS = Object.freeze({
  requestBytes: 67 * 1_024,
  batchBytes: 256 * 1_024,
  notificationBytes: 1_024,
  smallResponseBytes: 1_024,
  nativeQueueBytes: 256 * 1_024,
  frameworkUnackedBytes: 1_024 * 1_024,
  maxJsonDepth: DESKTOP_ROOM_SESSION_LIMITS.maxJsonDepth,
});
export const DESKTOP_ROOM_ERROR_MESSAGE = '多人房间操作未完成' as const;
export const DesktopRoomErrorCodeSchema = z.enum([
  'invalid-request', 'invalid-response', 'not-authenticated', 'scope-changed',
  'storage-unavailable', 'network-error', 'response-too-large', 'busy',
  'backpressure', 'document-unavailable', 'presence-unsupported', 'service-rejected', 'internal-error',
]);
export type DesktopRoomErrorCode = z.infer<typeof DesktopRoomErrorCodeSchema>;

// The Native Rust string boundary requires Unicode scalar text; JSON/Web schemas are unchanged.
// Do not repair or normalize a malformed string.
const isScalarText = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
};

/** Preflight the original object, before defaults/trim/projection or recursive DTO parsing. */
const boundedObject = (maxBytes: number) => z.custom<unknown>((input) => {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)
      || !JsonValueSchema.safeParse(input).success) return false;
    const stack: Array<{ value: JsonValue; depth: number }> = [{ value: input as JsonValue, depth: 0 }];
    while (stack.length) {
      const { value, depth } = stack.pop()!;
      if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) return false;
      if (typeof value === 'string' && !isScalarText(value)) return false;
      if (value === null || typeof value !== 'object') continue;
      if (depth > DESKTOP_ROOM_IPC_LIMITS.maxJsonDepth) return false;
      for (const key of Object.keys(value)) {
        if (!isScalarText(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') return false;
      }
      for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
    }
    return jsonUtf8ByteLength(input) <= maxBytes;
  } catch { return false; }
}, { message: 'invalid bounded Room IPC object' });

const small = <T extends z.ZodType>(schema: T) => boundedObject(DESKTOP_ROOM_IPC_LIMITS.smallResponseBytes).pipe(schema);
const request = <T extends z.ZodType>(schema: T) => boundedObject(DESKTOP_ROOM_IPC_LIMITS.requestBytes).pipe(schema);
const LocalIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const SequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const DesktopRoomHttpOperationSchema = z.enum(['discover', 'create', 'join', 'session', 'leave', 'close']);
export const DesktopRoomMutationOperationSchema = z.enum(['create', 'join', 'leave', 'close']);
export type DesktopRoomHttpOperation = z.infer<typeof DesktopRoomHttpOperationSchema>;
export const DesktopRoomPendingIntentSchema = z.object({
  intentId: LocalIdSchema, operation: DesktopRoomMutationOperationSchema, roomId: OpaqueKeySchema.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.operation === 'create') !== (value.roomId === null)) {
    context.addIssue({ code: 'custom', message: 'mutation room scope mismatch' });
  }
});
export const DesktopRoomErrorSchema = small(z.object({
  code: DesktopRoomErrorCodeSchema,
  message: z.literal(DESKTOP_ROOM_ERROR_MESSAGE),
  outcome: DesktopRoomSessionErrorOutcomeSchema,
  serverCode: DesktopRoomSessionErrorCodeSchema.optional(),
}).strict());
export type DesktopRoomError = z.infer<typeof DesktopRoomErrorSchema>;
export class DesktopRoomContractError extends Error {
  readonly code: DesktopRoomErrorCode;
  constructor(code: DesktopRoomErrorCode) {
    super(DESKTOP_ROOM_ERROR_MESSAGE);
    this.name = 'DesktopRoomContractError';
    this.code = code;
  }
}

export const DesktopRoomAttachRequestSchema = request(z.object({
  documentNonce: z.string().regex(/^[0-9a-f]{64}$/u),
  attachIntent: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedUserId: DesktopRoomSessionUserIdSchema,
}).strict());
export const DesktopRoomAttachResponseSchema = small(z.object({
  handle: LocalIdSchema, subscriptionId: LocalIdSchema, pendingIntent: DesktopRoomPendingIntentSchema.nullable(),
}).strict());
export const DesktopRoomSubscribeRequestSchema = request(z.object({
  handle: LocalIdSchema, roomId: OpaqueKeySchema, expectedRoomEpoch: OpaqueKeySchema,
}).strict());
export const DesktopRoomSubscribeResponseSchema = small(z.object({
  handle: LocalIdSchema, subscriptionId: LocalIdSchema,
}).strict());
export const DesktopRoomDetachRequestSchema = request(z.object({ handle: LocalIdSchema }).strict());
export const DesktopRoomDetachResponseSchema = small(z.object({ detached: z.boolean() }).strict());

const createRequest = boundedObject(DESKTOP_ROOM_SESSION_LIMITS.originalRequestBodyBytes).pipe(ArenaRoomCreateRequestSchema);
const joinRequest = boundedObject(DESKTOP_ROOM_SESSION_LIMITS.originalRequestBodyBytes).pipe(ArenaRoomJoinRequestSchema);
export const DesktopRoomActionSchema = request(z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('discover'), query: RoomDirectoryPageQuerySchema }).strict(),
  z.object({ kind: z.literal('create'), request: createRequest }).strict(),
  z.object({ kind: z.literal('resume-create'), intentId: LocalIdSchema }).strict(),
  z.object({ kind: z.literal('join'), roomId: OpaqueKeySchema, request: joinRequest }).strict(),
  z.object({ kind: z.literal('session'), roomId: OpaqueKeySchema }).strict(),
  z.object({ kind: z.literal('leave'), roomId: OpaqueKeySchema, expectedRoomEpoch: OpaqueKeySchema }).strict(),
  z.object({ kind: z.literal('close'), roomId: OpaqueKeySchema, expectedRoomEpoch: OpaqueKeySchema }).strict(),
  z.object({ kind: z.literal('pull'), subscriptionId: LocalIdSchema }).strict(),
  z.object({ kind: z.literal('ack'), subscriptionId: LocalIdSchema, batchId: LocalIdSchema, sequence: SequenceSchema }).strict(),
]));
export const DesktopRoomRequestSchema = request(z.object({ handle: LocalIdSchema, request: DesktopRoomActionSchema }).strict());
export type DesktopRoomAction = z.infer<typeof DesktopRoomActionSchema>;
export type DesktopRoomHttpAction = Exclude<DesktopRoomAction, { kind: 'pull' | 'ack' }>;

const httpResult = <O extends DesktopRoomHttpOperation>(operation: O) => z.object({
  kind: z.literal('http-result'), requestId: LocalIdSchema, operation: z.literal(operation),
  response: DESKTOP_ROOM_SESSION_RESPONSE_SCHEMAS[operation],
}).strict();
const socketMessage = boundedObject(DESKTOP_ROOM_SESSION_LIMITS.websocketMessageBytes).pipe(RoomServerTransportMessageSchema);
export const DesktopRoomEventSchema = z.union([
  httpResult('discover'), httpResult('create'), httpResult('join'), httpResult('session'), httpResult('leave'), httpResult('close'),
  z.object({ kind: z.literal('request-error'), requestId: LocalIdSchema,
    operation: DesktopRoomHttpOperationSchema, error: DesktopRoomErrorSchema }).strict().superRefine((value, context) => {
    const read = value.operation === 'discover' || value.operation === 'session';
    if (read !== (value.error.outcome === 'not-applicable')) context.addIssue({ code: 'custom', message: 'operation outcome mismatch' });
  }),
  z.object({ kind: z.literal('socket'), message: socketMessage }).strict(),
  z.object({
    kind: z.literal('status'),
    state: z.enum(['connecting', 'online', 'offline', 'reconnecting', 'detached', 'closed', 'resync-required', 'backpressure']),
    code: DesktopRoomErrorCodeSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal('mutation-unknown'), intentId: LocalIdSchema, operation: DesktopRoomMutationOperationSchema, roomId: OpaqueKeySchema.nullable() }).strict()
    .superRefine((value, context) => {
      if ((value.operation === 'create') !== (value.roomId === null)) context.addIssue({ code: 'custom', message: 'mutation room scope mismatch' });
    }),
]);
export const DesktopRoomBatchSchema = boundedObject(DESKTOP_ROOM_IPC_LIMITS.batchBytes).pipe(z.object({
  handle: LocalIdSchema, subscriptionId: LocalIdSchema, batchId: LocalIdSchema, sequence: SequenceSchema,
  event: DesktopRoomEventSchema,
}).strict());
export const DesktopRoomAvailableNotificationSchema = boundedObject(DESKTOP_ROOM_IPC_LIMITS.notificationBytes).pipe(z.object({
  handle: LocalIdSchema, subscriptionId: LocalIdSchema, sequence: SequenceSchema, type: z.literal('available'),
}).strict());
/** Small terminal delivery: independently acknowledged even when a prior body is still unacknowledged. */
const revokedScope = {
  type: z.literal('revoked'), handle: LocalIdSchema, subscriptionId: LocalIdSchema,
  batchId: LocalIdSchema, sequence: SequenceSchema,
};
export const DesktopRoomRevokedNotificationSchema = boundedObject(DESKTOP_ROOM_IPC_LIMITS.notificationBytes).pipe(z.union([
  z.object({ ...revokedScope, requestId: LocalIdSchema,
    operation: DesktopRoomHttpOperationSchema, error: DesktopRoomErrorSchema,
  }).strict().superRefine((value, context) => {
    const read = value.operation === 'discover' || value.operation === 'session';
    if (read !== (value.error.outcome === 'not-applicable')) context.addIssue({ code: 'custom', message: 'operation outcome mismatch' });
  }),
  z.object({ ...revokedScope, requestId: z.null(), operation: z.literal('subscribe'),
    error: DesktopRoomErrorSchema.refine((error) => error.outcome === 'not-applicable', { message: 'subscription outcome must be not-applicable' }),
  }).strict(),
]));
export const DesktopRoomNotificationSchema = z.union([
  DesktopRoomAvailableNotificationSchema, DesktopRoomRevokedNotificationSchema,
]);
export const DesktopRoomAcceptedResponseSchema = small(z.object({
  kind: z.literal('accepted'), handle: LocalIdSchema, subscriptionId: LocalIdSchema, requestId: LocalIdSchema,
}).strict());
export const DesktopRoomPullResponseSchema = boundedObject(DESKTOP_ROOM_IPC_LIMITS.batchBytes).pipe(z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty'), handle: LocalIdSchema, subscriptionId: LocalIdSchema }).strict(),
  z.object({ kind: z.literal('batch'), batch: DesktopRoomBatchSchema }).strict(),
]));
export const DesktopRoomAckResponseSchema = small(z.object({
  kind: z.literal('acknowledged'), handle: LocalIdSchema, subscriptionId: LocalIdSchema,
  batchId: LocalIdSchema, sequence: SequenceSchema, accepted: z.boolean(),
}).strict());
export type DesktopRoomAttachRequest = z.infer<typeof DesktopRoomAttachRequestSchema>;
export type DesktopRoomAttachResponse = z.infer<typeof DesktopRoomAttachResponseSchema>;
export type DesktopRoomSubscribeRequest = z.infer<typeof DesktopRoomSubscribeRequestSchema>;
export type DesktopRoomSubscribeResponse = z.infer<typeof DesktopRoomSubscribeResponseSchema>;
export type DesktopRoomBatch = z.infer<typeof DesktopRoomBatchSchema>;
export type DesktopRoomEvent = z.infer<typeof DesktopRoomEventSchema>;
export type DesktopRoomAvailableNotification = z.infer<typeof DesktopRoomAvailableNotificationSchema>;
export type DesktopRoomRevokedNotification = z.infer<typeof DesktopRoomRevokedNotificationSchema>;
export type DesktopRoomNotification = z.infer<typeof DesktopRoomNotificationSchema>;
export type DesktopRoomAcceptedResponse = z.infer<typeof DesktopRoomAcceptedResponseSchema>;
export type DesktopRoomPullResponse = z.infer<typeof DesktopRoomPullResponseSchema>;
export type DesktopRoomAckResponse = z.infer<typeof DesktopRoomAckResponseSchema>;

/** Match the existing negotiated owner before a body reaches the renderer consumer. */
export const parseDesktopRoomBatch = (raw: unknown, expectedUserId: number): DesktopRoomBatch => {
  const parsed = DesktopRoomBatchSchema.safeParse(raw);
  if (!parsed.success || !DesktopRoomSessionUserIdSchema.safeParse(expectedUserId).success) throw new DesktopRoomContractError('invalid-response');
  if (parsed.data.event.kind === 'http-result') {
    try { parseDesktopRoomSessionResponse(parsed.data.event.operation, parsed.data.event.response, expectedUserId); }
    catch { throw new DesktopRoomContractError('invalid-response'); }
  }
  return parsed.data;
};
