import { z } from './zod';

import {
  DESKTOP_ROOM_SESSION_LIMITS, isDesktopRoomStartWithinNodeBudget,
  DESKTOP_ROOM_SESSION_RESPONSE_SCHEMAS,
  DesktopRoomSessionErrorCodeSchema,
  DesktopRoomSessionErrorOutcomeSchema,
  DesktopRoomSessionUserIdSchema,
  DesktopRoomSessionRoomIdSchema,
  DesktopRoomSessionProposalIdSchema,
  DesktopRoomSessionGenerationIdSchema,
  DesktopRoomGenerationStartRequestSchema, DesktopRoomPresetConfigSchema,
  parseDesktopRoomSessionResponse,
} from './desktop-room-session';
import { JsonValueSchema, type JsonValue } from './json-value';
import { OpaqueKeySchema } from './primitives';
import { ResolvedArenaProposalStatusSchema } from './proposals';
import { RoomDirectoryPageQuerySchema } from './room-directory';
import { ArenaRoomCreateRequestSchema, ArenaRoomJoinRequestSchema, ArenaRoomPublishConfigRequestSchema,
  ArenaRoomProposalSubmitRequestSchema, ArenaRoomProposalWithdrawRequestSchema, ArenaRoomProposalResolveRequestSchema } from './room-http';
import { RoomServerTransportMessageSchema } from './websocket-transport';
import { jsonUtf8ByteLength, utf8ByteLength } from './wire-size';

/** Local wrappers only. HTTP and socket bodies keep their existing versioned schemas. */
export const DESKTOP_ROOM_IPC_COMMANDS = Object.freeze({
  attach: 'arena_room_attach', request: 'arena_room_request',
  subscribe: 'arena_room_subscribe', detach: 'arena_room_detach',
} as const);
export const DESKTOP_ROOM_IPC_LIMITS = Object.freeze({
  requestBytes: 67 * 1_024,
  generationStartRequestBytes: DESKTOP_ROOM_SESSION_LIMITS.generationStartOriginalBytes + 3 * 1_024,
  batchBytes: 256 * 1_024,
  notificationBytes: 1_024,
  smallResponseBytes: 1_024,
  generationStartRecoveryBytes: 8 * 1_024,
  nativeQueueBytes: 256 * 1_024,
  generationFragmentBytes: 16 * 1_024,
  frameworkUnackedBytes: 1_024 * 1_024,
  maxJsonDepth: DESKTOP_ROOM_SESSION_LIMITS.maxJsonDepth,
});
export const DESKTOP_ROOM_ERROR_MESSAGE = '多人房间操作未完成' as const;
export const DesktopRoomErrorCodeSchema = z.enum([
  'invalid-request', 'input-too-complex', 'input-too-large', 'invalid-response', 'not-authenticated', 'scope-changed',
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
export const DesktopRoomHttpOperationSchema = z.enum(['discover', 'create', 'join', 'session', 'generationRead', 'generationStart', 'generationCancel', 'leave', 'close', 'config', 'proposalSubmit', 'proposalWithdraw', 'proposalResolve']);
export const DesktopRoomMutationOperationSchema = z.enum(['create', 'join', 'generationStart', 'generationCancel', 'leave', 'close', 'config', 'proposalSubmit', 'proposalWithdraw', 'proposalResolve']);
export type DesktopRoomMutationOperation = z.infer<typeof DesktopRoomMutationOperationSchema>;
export type DesktopRoomHttpOperation = z.infer<typeof DesktopRoomHttpOperationSchema>;
export const DesktopRoomGenerationTargetSchema = z.object({
  roomEpoch: OpaqueKeySchema, generationId: DesktopRoomSessionGenerationIdSchema,
  attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const DesktopRoomPendingIntentSchema = z.object({
  intentId: LocalIdSchema, operation: DesktopRoomMutationOperationSchema, roomId: OpaqueKeySchema.nullable(),
  generationTarget: DesktopRoomGenerationTargetSchema.optional(),
  generationStart: z.object({ roomEpoch: OpaqueKeySchema, generationRequestId: OpaqueKeySchema, retryable: z.boolean(), presetConfig: DesktopRoomPresetConfigSchema.optional() }).strict().optional(),
}).strict().superRefine((value, context) => {
  if ((value.operation === 'generationCancel' && value.generationTarget === undefined)
    || (value.generationTarget !== undefined && value.operation !== 'generationCancel' && value.operation !== 'generationStart')) {
    context.addIssue({ code: 'custom', message: 'cancel target scope mismatch' });
  }
  if ((value.operation === 'generationStart') !== (value.generationStart !== undefined)) {
    context.addIssue({ code: 'custom', message: 'start intent scope mismatch' });
  }
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
export const DesktopRoomGenerationStartFenceSchema = z.object({ roomId: OpaqueKeySchema, generationRequestId: OpaqueKeySchema }).strict();
const attachBudget = (input: unknown) => {
  const value = input as { pendingIntent?: { operation?: unknown }; generationStartFence?: unknown } | null;
  return value?.pendingIntent?.operation === 'generationStart' || value?.generationStartFence != null
    ? DESKTOP_ROOM_IPC_LIMITS.generationStartRecoveryBytes : DESKTOP_ROOM_IPC_LIMITS.smallResponseBytes;
};
export const DesktopRoomAttachResponseSchema = z.custom<unknown>(input => boundedObject(attachBudget(input)).safeParse(input).success).pipe(z.object({
  handle: LocalIdSchema, subscriptionId: LocalIdSchema, pendingIntent: DesktopRoomPendingIntentSchema.nullable(),
  generationStartBlocked: z.boolean(), generationStartFence: DesktopRoomGenerationStartFenceSchema.nullable(),
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
const configRequest = boundedObject(DESKTOP_ROOM_SESSION_LIMITS.originalRequestBodyBytes).pipe(ArenaRoomPublishConfigRequestSchema);
const joinRequest = boundedObject(DESKTOP_ROOM_SESSION_LIMITS.originalRequestBodyBytes).pipe(ArenaRoomJoinRequestSchema);
const proposalSubmitRequest = boundedObject(DESKTOP_ROOM_SESSION_LIMITS.originalRequestBodyBytes).pipe(
  ArenaRoomProposalSubmitRequestSchema.extend({ proposalId: DesktopRoomSessionProposalIdSchema }),
);
const proposalWithdrawRequest = boundedObject(DESKTOP_ROOM_SESSION_LIMITS.originalRequestBodyBytes).pipe(ArenaRoomProposalWithdrawRequestSchema);
const proposalResolveRequest = boundedObject(DESKTOP_ROOM_SESSION_LIMITS.originalRequestBodyBytes).pipe(ArenaRoomProposalResolveRequestSchema);
const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('generation-start'), roomId: DesktopRoomSessionRoomIdSchema,
    request: boundedObject(DESKTOP_ROOM_SESSION_LIMITS.generationStartOriginalBytes).pipe(DesktopRoomGenerationStartRequestSchema),
    presetConfig: DesktopRoomPresetConfigSchema.optional() }).strict(),
  z.object({ kind: z.literal('retry-generation-start'), intentId: LocalIdSchema }).strict(),
  z.object({ kind: z.literal('discover'), query: RoomDirectoryPageQuerySchema }).strict(),
  z.object({ kind: z.literal('create'), request: createRequest }).strict(),
  z.object({ kind: z.literal('resume-create'), intentId: LocalIdSchema }).strict(),
  z.object({ kind: z.literal('join'), roomId: OpaqueKeySchema, request: joinRequest }).strict(),
  z.object({ kind: z.literal('session'), roomId: OpaqueKeySchema }).strict(),
  z.object({ kind: z.literal('generation-read'), generationId: DesktopRoomSessionGenerationIdSchema,
    expectedRoomEpoch: OpaqueKeySchema, expectedAttempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ kind: z.literal('generation-cancel'), roomId: DesktopRoomSessionRoomIdSchema,
    generationId: DesktopRoomSessionGenerationIdSchema, expectedRoomEpoch: OpaqueKeySchema,
    expectedAttempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ kind: z.literal('config'), roomId: OpaqueKeySchema, request: configRequest }).strict(),
  z.object({ kind: z.literal('end-generation-start-tracking'), intentId: LocalIdSchema }).strict(),
  z.object({ kind: z.literal('end-config-tracking'), intentId: LocalIdSchema }).strict(),
  z.object({ kind: z.literal('proposal-submit'), roomId: DesktopRoomSessionRoomIdSchema, request: proposalSubmitRequest }).strict(),
  z.object({ kind: z.literal('proposal-withdraw'), roomId: DesktopRoomSessionRoomIdSchema, proposalId: DesktopRoomSessionProposalIdSchema, request: proposalWithdrawRequest }).strict(),
  z.object({ kind: z.literal('proposal-resolve'), roomId: DesktopRoomSessionRoomIdSchema, proposalId: DesktopRoomSessionProposalIdSchema, request: proposalResolveRequest }).strict(),
  z.object({ kind: z.literal('end-proposal-tracking'), intentId: LocalIdSchema }).strict(),
  z.object({ kind: z.literal('leave'), roomId: OpaqueKeySchema, expectedRoomEpoch: OpaqueKeySchema }).strict(),
  z.object({ kind: z.literal('close'), roomId: OpaqueKeySchema, expectedRoomEpoch: OpaqueKeySchema }).strict(),
  z.object({ kind: z.literal('pull'), subscriptionId: LocalIdSchema }).strict(),
  z.object({ kind: z.literal('ack'), subscriptionId: LocalIdSchema, batchId: LocalIdSchema, sequence: SequenceSchema }).strict(),
] );
const startBudget = (input: unknown, nested = false): number => {
  const value = input as { kind?: unknown; request?: { kind?: unknown } } | null;
  return (nested ? value?.request?.kind : value?.kind) === 'generation-start'
    ? DESKTOP_ROOM_IPC_LIMITS.generationStartRequestBytes : DESKTOP_ROOM_IPC_LIMITS.requestBytes;
};
const startNodes = (input: unknown, nested = false): boolean => {
  const action = nested ? (input as { request?: unknown } | null)?.request : input;
  return (action as { kind?: unknown } | null)?.kind !== 'generation-start'
    || (isDesktopRoomStartWithinNodeBudget((action as { request?: unknown }).request)
      && (!Object.hasOwn(action as object, 'presetConfig') || DesktopRoomPresetConfigSchema.safeParse((action as { presetConfig?: unknown }).presetConfig).success));
};
export const DesktopRoomActionSchema = z.custom<unknown>(input => startNodes(input) && boundedObject(startBudget(input)).safeParse(input).success).pipe(actionSchema);
export const DesktopRoomRequestSchema = z.custom<unknown>(input => startNodes(input, true) && boundedObject(startBudget(input, true)).safeParse(input).success)
  .pipe(z.object({ handle: LocalIdSchema, request: DesktopRoomActionSchema }).strict());
/** Includes the actual Tauri command argument envelope, not just its request member. */
export const DesktopRoomStartInvokeSchema = z.custom<unknown>(input => startNodes((input as { request?: unknown } | null)?.request, true))
  .pipe(boundedObject(DESKTOP_ROOM_IPC_LIMITS.generationStartRequestBytes))
  .pipe(z.object({ request: DesktopRoomRequestSchema }).strict());
export type DesktopRoomAction = z.infer<typeof DesktopRoomActionSchema>;
export type DesktopRoomHttpAction = Exclude<DesktopRoomAction, { kind: 'pull' | 'ack' | 'end-generation-start-tracking' | 'end-config-tracking' | 'end-proposal-tracking' }>;
/** Local action spelling is intentionally distinct from the negotiated producer operation. */
export const getDesktopRoomHttpOperation = (action: DesktopRoomHttpAction): DesktopRoomHttpOperation => {
  switch (action.kind) {
    case 'resume-create': return 'create';
    case 'generation-start': case 'retry-generation-start': return 'generationStart';
    case 'generation-read': return 'generationRead';
    case 'generation-cancel': return 'generationCancel';
    case 'proposal-submit': return 'proposalSubmit';
    case 'proposal-withdraw': return 'proposalWithdraw';
    case 'proposal-resolve': return 'proposalResolve';
    default: return action.kind;
  }
};

const httpResult = <O extends Exclude<DesktopRoomHttpOperation, 'generationRead'>>(operation: O) => z.object({
  kind: z.literal('http-result'), requestId: LocalIdSchema, operation: z.literal(operation),
  response: DESKTOP_ROOM_SESSION_RESPONSE_SCHEMAS[operation],
}).strict();
const socketMessage = boundedObject(DESKTOP_ROOM_SESSION_LIMITS.websocketMessageBytes).pipe(RoomServerTransportMessageSchema);
/** Current evidence only: neither a POST receipt nor a reusable authorization. */
export const DesktopRoomProposalObservationSchema = z.object({
  observation: z.enum(['pending', 'absent', 'conflict', 'scope-changed', 'target-unavailable', 'submitted', 'terminal']),
  linked: z.boolean(),
  settle: z.boolean(),
  outcome: z.enum(['satisfied', 'different', 'scope-unverified']).nullable(),
  terminalStatus: ResolvedArenaProposalStatusSchema.nullable(),
}).strict().superRefine((value, context) => {
  const terminal = value.observation === 'terminal';
  const submitted = value.observation === 'submitted';
  if (value.settle !== (terminal || submitted)
    || (value.settle && !value.linked)
    || (terminal !== (value.terminalStatus !== null))
    || (value.settle !== (value.outcome !== null))
    || (submitted && value.outcome !== 'satisfied')
    || ((value.observation === 'scope-changed' || value.observation === 'conflict') && value.linked)) {
    context.addIssue({ code: 'custom', message: 'inconsistent proposal observation' });
  }
});
/** Describes exact checked HTTP envelope bytes, never a completed or authoritative view by itself. */
export const DesktopRoomGenerationDescriptorSchema = z.object({
  kind: z.literal('generation-descriptor'), requestId: LocalIdSchema,
  roomId: DesktopRoomSessionRoomIdSchema, roomEpoch: OpaqueKeySchema,
  generationId: DesktopRoomSessionGenerationIdSchema,
  attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  byteLength: z.number().int().positive().max(DESKTOP_ROOM_SESSION_LIMITS.generationResponseBodyBytes),
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
/** Scalar fragment text preserves raw JSON escapes, including legal escaped lone surrogates. */
export const DesktopRoomGenerationFragmentSchema = z.object({
  kind: z.literal('generation-fragment'), requestId: LocalIdSchema,
  offset: z.number().int().nonnegative().max(DESKTOP_ROOM_SESSION_LIMITS.generationResponseBodyBytes),
  text: z.string().min(1).refine((value) => isScalarText(value)
    && utf8ByteLength(value) <= DESKTOP_ROOM_IPC_LIMITS.generationFragmentBytes),
  final: z.boolean(),
}).strict();
export type DesktopRoomGenerationDescriptor = z.infer<typeof DesktopRoomGenerationDescriptorSchema>;
export type DesktopRoomGenerationFragment = z.infer<typeof DesktopRoomGenerationFragmentSchema>;

export const DesktopRoomEventSchema = z.union([
  DesktopRoomGenerationDescriptorSchema, DesktopRoomGenerationFragmentSchema,
  httpResult('discover'), httpResult('create'), httpResult('join'), httpResult('session'), httpResult('leave'), httpResult('close'), httpResult('config'),
  httpResult('generationStart'), httpResult('generationCancel'), httpResult('proposalSubmit'), httpResult('proposalWithdraw'), httpResult('proposalResolve'),
  z.object({ kind: z.literal('proposal-observation'), intentId: LocalIdSchema, observation: DesktopRoomProposalObservationSchema }).strict(),
  z.object({ kind: z.literal('request-error'), requestId: LocalIdSchema,
    operation: DesktopRoomHttpOperationSchema, error: DesktopRoomErrorSchema }).strict().superRefine((value, context) => {
    const read = value.operation === 'discover' || value.operation === 'session' || value.operation === 'generationRead';
    if (read !== (value.error.outcome === 'not-applicable')) context.addIssue({ code: 'custom', message: 'operation outcome mismatch' });
  }),
  z.object({ kind: z.literal('socket'), message: socketMessage }).strict(),
  z.object({
    kind: z.literal('status'),
    state: z.enum(['connecting', 'online', 'offline', 'reconnecting', 'detached', 'closed', 'resync-required', 'backpressure']),
    code: DesktopRoomErrorCodeSchema.optional(),
  }).strict(),
  DesktopRoomPendingIntentSchema.safeExtend({ kind: z.literal('mutation-unknown') }),
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
    const read = value.operation === 'discover' || value.operation === 'session' || value.operation === 'generationRead';
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
  /** Only an exact terminal receipt ACK can release this frozen cancellation intent. */
  generationStart: z.object({ intentId: LocalIdSchema, current: z.boolean() }).strict().optional(),
  generationStartFence: DesktopRoomGenerationStartFenceSchema.extend({ cleared: z.literal(true) }).strict().optional(),
  generationCancel: z.object({ intentId: LocalIdSchema, current: z.boolean() }).strict().optional(),
  /** Only the first exact final-fragment receipt can grant current-generation completion. */
  generationRead: z.object({ requestId: LocalIdSchema, current: z.boolean() }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (!value.accepted && (value.generationRead !== undefined || value.generationCancel !== undefined || value.generationStart !== undefined || value.generationStartFence !== undefined)) context.addIssue({ code: 'custom', message: 'duplicate ACK cannot grant generation completion' });
}));
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

/** Ends local tracking only; never a server cancellation or write receipt. */
export const DesktopRoomConfigTrackingEndedSchema = small(z.object({ kind: z.literal('config-tracking-ended'), intentId: LocalIdSchema, ended: z.literal(true) }).strict());

/** Ends local proposal tracking only; it does not cancel the server operation. */
export const DesktopRoomProposalTrackingEndedSchema = small(z.object({ kind: z.literal('proposal-tracking-ended'), intentId: LocalIdSchema, ended: z.literal(true) }).strict());

export const DesktopRoomGenerationStartTrackingEndedSchema = boundedObject(DESKTOP_ROOM_IPC_LIMITS.generationStartRecoveryBytes).pipe(z.object({ kind: z.literal('generation-start-tracking-ended'), intentId: LocalIdSchema, ended: z.literal(true), generationStartBlocked: z.literal(true), generationStartFence: DesktopRoomGenerationStartFenceSchema }).strict());
