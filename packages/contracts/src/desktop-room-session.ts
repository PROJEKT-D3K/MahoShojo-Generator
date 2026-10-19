import { z } from './zod';
import { DesktopHostedGenerationOverridesSchema, DesktopHostedPresetConfigSchema } from './desktop-cloud';
import { ProviderModelIdSchema, ProviderPresetIdSchema } from './provider-target';

import { ARENA_COMPANION_JSON_LIMITS } from './arena-companion';
import { ARENA_ROOM_HTTP_ERROR_CODES } from './arena-error-taxonomy';
import { JsonValueSchema, SAFE_JSON_VALUE_MAX_DEPTH, type JsonValue } from './json-value';
import { MAX_CONTROL_FRAME_BYTES } from './limits';
import { OpaqueKeySchema, WireErrorMessageSchema } from './primitives';
import { ArenaProposalIdSchema } from './proposals';
import { RoomDirectoryPageSchema } from './room-directory';
import {
  ARENA_ROOM_HTTP_ROUTES,
  MAX_ARENA_ROOM_HTTP_TICKET_BYTES,
  ArenaRoomCreateRequestSchema,
  ArenaRoomGenerationCancelRequestSchema,
  ArenaRoomGenerationStartRequestSchema,
  MAX_ARENA_ROOM_GENERATION_START_BYTES,
  ArenaRoomGenerationProjectionStatusSchema,
  ArenaRoomEpochMutationRequestSchema,
  ArenaRoomGenerationViewResponseSchema,
  ArenaRoomJoinRequestSchema,
  ArenaRoomLeaveResponseSchema,
  ArenaRoomPublishConfigRequestSchema,
  ArenaRoomProposalSubmitRequestSchema,
  ArenaRoomProposalWithdrawRequestSchema,
  ArenaRoomProposalResolveRequestSchema,
  ArenaRoomProposalMutationResponseSchema,
  ArenaRoomSessionResponseSchema,
  ArenaRoomTicketRequestSchema,
  ArenaRoomTicketResponseSchema,
} from './room-http';
import { GenerationMirrorSchema } from './protocol';
import { jsonUtf8ByteLength, utf8ByteLength } from './wire-size';

/** Same-path, fail-closed Native opt-in; unnegotiated Web contracts stay unchanged. */
export const DESKTOP_ROOM_SESSION_PROTOCOL_VERSION = 'desktop-room-session-v1' as const;
/** Desktop-only preparation/request budget. Containers and scalar values count; keys do not. */
export const DESKTOP_ROOM_START_MAX_NODES = 100_000;
export const isDesktopRoomStartWithinNodeBudget = (input: unknown): boolean => {
  let count = 0;
  const visit = (value: unknown, depth: number): boolean => {
    if (++count > DESKTOP_ROOM_START_MAX_NODES || depth > SAFE_JSON_VALUE_MAX_DEPTH) return false;
    if (value === null || typeof value !== 'object') return true;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) if (!visit(value[index], depth + 1)) return false;
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property || property.get || property.set || !visit(property.value, depth + 1)) return false;
      }
    }
    return true;
  };
  try { return visit(input, 0); } catch { return false; }
};
export const DESKTOP_ROOM_SESSION_PROTOCOL_HEADER = 'x-mahoshojo-desktop-room-protocol' as const;
export const DESKTOP_ROOM_SESSION_EXPECTED_USER_ID_HEADER = 'x-mahoshojo-room-expected-user-id' as const;
export const DESKTOP_ROOM_SESSION_LIMITS = Object.freeze({
  originalRequestBodyBytes: 64 * 1_024,
  requestBodyBytes: 65 * 1_024,
  generationStartOriginalBytes: MAX_ARENA_ROOM_GENERATION_START_BYTES,
  generationStartRequestBytes: MAX_ARENA_ROOM_GENERATION_START_BYTES + 1_024,
  responseBodyBytes: 256 * 1_024,
  // Independent transport ceiling, not a bound for every theoretical DTO combination.
  generationResponseBodyBytes: ARENA_COMPANION_JSON_LIMITS.wireBytes,
  websocketMessageBytes: MAX_CONTROL_FRAME_BYTES,
  maxJsonDepth: SAFE_JSON_VALUE_MAX_DEPTH,
  retryAfterSeconds: 86_400,
});

export const DESKTOP_ROOM_SESSION_OPERATIONS = Object.freeze({
  discover: { method: 'GET', path: ARENA_ROOM_HTTP_ROUTES.collection },
  create: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.collection },
  join: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.join },
  session: { method: 'GET', path: ARENA_ROOM_HTTP_ROUTES.session },
  generationRead: { method: 'GET', path: ARENA_ROOM_HTTP_ROUTES.generation },
  generationStart: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.generations },
  generationCancel: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.generationCancel },
  ticket: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.ticket },
  leave: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.leave },
  close: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.close },
  config: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.config },
  proposalSubmit: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.proposals },
  proposalWithdraw: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.proposalWithdraw },
  proposalResolve: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.proposalResolve },
} as const);
export const DesktopRoomSessionOperationSchema = z.enum([
  'discover', 'create', 'join', 'session', 'generationRead', 'generationStart', 'generationCancel', 'ticket', 'leave', 'close', 'config', 'proposalSubmit', 'proposalWithdraw', 'proposalResolve',
]);
export const DesktopRoomSessionPostOperationSchema = z.enum(['create', 'join', 'generationStart', 'generationCancel', 'ticket', 'leave', 'close', 'config', 'proposalSubmit', 'proposalWithdraw', 'proposalResolve']);
export type DesktopRoomSessionOperation = z.infer<typeof DesktopRoomSessionOperationSchema>;
export type DesktopRoomSessionPostOperation = z.infer<typeof DesktopRoomSessionPostOperationSchema>;

/** Desktop path targets must be canonical single URL segments; legacy Web IDs stay unchanged. */
const desktopPathId = (schema: z.ZodType<string, string>) => z.string().refine((value) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data !== value || value === '.' || value === '..' || /[\\/%]/u.test(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
}).pipe(schema);
export const DesktopRoomSessionRoomIdSchema = desktopPathId(OpaqueKeySchema);
export const DesktopRoomSessionProposalIdSchema = desktopPathId(ArenaProposalIdSchema);
export const DesktopRoomSessionGenerationIdSchema = desktopPathId(OpaqueKeySchema);

export const DesktopRoomSessionUserIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const DesktopRoomSessionExpectedUserIdHeaderSchema = z.string()
  .regex(/^v1:[1-9][0-9]{0,15}$/u)
  .transform((value) => Number(value.slice(3)))
  .pipe(DesktopRoomSessionUserIdSchema);
export const DesktopRoomSessionCreateModeSchema = z.enum(['new', 'resume-only']);
export type DesktopRoomSessionCreateMode = z.infer<typeof DesktopRoomSessionCreateModeSchema>;

const requestMetadata = {
  version: z.literal(DESKTOP_ROOM_SESSION_PROTOCOL_VERSION),
  expectedUserId: DesktopRoomSessionUserIdSchema,
};
export const DesktopRoomSessionRequestMetadataSchema = z.object(requestMetadata).strict();
export const DesktopRoomSessionCreateMetadataSchema = z.object({
  ...requestMetadata,
  createMode: DesktopRoomSessionCreateModeSchema,
}).strict();
export const DesktopRoomSessionResponseMetadataSchema = z.object({
  version: z.literal(DESKTOP_ROOM_SESSION_PROTOCOL_VERSION),
  viewerUserId: DesktopRoomSessionUserIdSchema,
}).strict();

/** Iterative guard before schemas/stringification: no extra node cap on valid snapshots. */
const isBoundedJsonObject = (input: unknown): input is Record<string, JsonValue> => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  if (!JsonValueSchema.safeParse(input).success) return false;
  const stack: Array<{ value: JsonValue; depth: number }> = [
    { value: input as Record<string, JsonValue>, depth: 0 },
  ];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) return false;
    if (value === null || typeof value !== 'object') continue;
    if (depth > DESKTOP_ROOM_SESSION_LIMITS.maxJsonDepth) return false;
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false;
    }
    for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
  }
  return true;
};

const boundedObject = (maxBytes: number, checkOriginalRequest = false, originalMaxBytes = DESKTOP_ROOM_SESSION_LIMITS.originalRequestBodyBytes) => z.custom<unknown>(
  (input) => isBoundedJsonObject(input)
    && jsonUtf8ByteLength(input) <= maxBytes
    && (!checkOriginalRequest || jsonUtf8ByteLength(input.request) <= originalMaxBytes),
  { message: 'must be a bounded plain JSON object within the Desktop wire budget' },
);
const postRequest = <T extends z.ZodType>(request: T) => boundedObject(
  DESKTOP_ROOM_SESSION_LIMITS.requestBodyBytes, true,
).pipe(z.object({ desktopRoom: DesktopRoomSessionRequestMetadataSchema, request }).strict());

/** The raw original request is counted before its existing trim/default/projection behavior. */
export const DesktopRoomSessionCreateRequestSchema = boundedObject(
  DESKTOP_ROOM_SESSION_LIMITS.requestBodyBytes, true,
).pipe(z.object({
  desktopRoom: DesktopRoomSessionCreateMetadataSchema,
  request: ArenaRoomCreateRequestSchema,
}).strict());
export const DesktopRoomSessionJoinRequestSchema = postRequest(ArenaRoomJoinRequestSchema);
const rawRoomPresetConfigSchema = DesktopHostedPresetConfigSchema.extend({
  modelId: z.string().max(10 * 1_024),
});
/** Non-secret room selection; count the original UTF-8 JSON before model trim. */
export const DesktopRoomPresetConfigSchema = z.custom<z.input<typeof rawRoomPresetConfigSchema>>(
  input => rawRoomPresetConfigSchema.safeParse(input).success && jsonUtf8ByteLength(input) <= 10 * 1_024,
  { message: 'Desktop room provider selection exceeds its small input budget' },
).pipe(DesktopHostedPresetConfigSchema).refine(
  value => value.providerId !== 'system' && value.modelId !== '__custom_model_id__',
  { message: 'Select a catalog provider and an actual model ID' },
);
/** Only the trusted Native host can construct this outbound provider. Never use for IPC input. */
export const DesktopRoomInjectedProviderSchema = z.object({
  providerId: ProviderPresetIdSchema.refine(value => value !== 'system'),
  modelId: ProviderModelIdSchema.refine(value => value !== '__custom_model_id__'),
  apiKey: z.string().max(8 * 1_024).refine(value => value.trim().length > 0 && utf8ByteLength(value) <= 8 * 1_024),
  generationOverrides: DesktopHostedGenerationOverridesSchema.optional(),
}).strict();
const desktopRoomStartBusinessSchema = z.custom<z.input<typeof ArenaRoomGenerationStartRequestSchema>>(
  isDesktopRoomStartWithinNodeBudget, { message: 'Desktop room start material is too complex' },
).pipe(ArenaRoomGenerationStartRequestSchema.refine(
  value => value.generation.isDowngrade !== true && value.generation.arenaFreeRankingEnabled !== true,
  { message: 'Desktop room start cannot change ranking or downgrade policy' },
));
/** Renderer business input remains secret-free; funding selection is an IPC-only sibling. */
export const DesktopRoomGenerationStartRequestSchema = desktopRoomStartBusinessSchema.refine(
  value => !Object.hasOwn(value.generation, 'customProvider'),
  { message: 'Desktop room provider credentials must be injected by Native' },
);
/** API-only consumer; a strict provider still goes through normal service catalog and host checks. */
export const DesktopRoomGenerationStartWireRequestSchema = desktopRoomStartBusinessSchema.refine(
  value => !Object.hasOwn(value.generation, 'customProvider') || DesktopRoomInjectedProviderSchema.safeParse(value.generation.customProvider).success,
  { message: 'Desktop room injected provider is invalid' },
);
export const DesktopRoomSessionGenerationStartRequestSchema = boundedObject(
  DESKTOP_ROOM_SESSION_LIMITS.generationStartRequestBytes, true, DESKTOP_ROOM_SESSION_LIMITS.generationStartOriginalBytes,
).pipe(z.object({ desktopRoom: DesktopRoomSessionRequestMetadataSchema, request: DesktopRoomGenerationStartWireRequestSchema }).strict());
/** Immutable target only: state and timestamps are observations, never cancellation identity. */
export const DesktopRoomGenerationIdentitySchema = z.object({
  generationRequestId: GenerationMirrorSchema.shape.generationRequestId,
  generationId: GenerationMirrorSchema.shape.generationId,
  attempt: GenerationMirrorSchema.shape.attempt,
  configRevision: GenerationMirrorSchema.shape.configRevision,
  snapshotDigest: GenerationMirrorSchema.shape.snapshotDigest,
  collaborativeInfluence: GenerationMirrorSchema.shape.collaborativeInfluence,
  participantUserIds: GenerationMirrorSchema.shape.participantUserIds,
  hostAccountUserId: GenerationMirrorSchema.shape.hostAccountUserId,
}).strict().refine(value => value.hostAccountUserId === undefined || value.participantUserIds.includes(value.hostAccountUserId), {
  path: ['hostAccountUserId'], message: 'host must be a frozen participant',
});
export type DesktopRoomGenerationIdentity = z.infer<typeof DesktopRoomGenerationIdentitySchema>;
export const DesktopRoomStartingGenerationCancelRequestSchema = z.object({
  expectedRoomEpoch: OpaqueKeySchema,
  expectedGeneration: DesktopRoomGenerationIdentitySchema,
}).strict();
export const DesktopRoomSessionGenerationCancelRequestSchema = z.union([
  postRequest(ArenaRoomGenerationCancelRequestSchema),
  boundedObject(DESKTOP_ROOM_SESSION_LIMITS.requestBodyBytes, true).pipe(z.object({
    desktopRoom: z.object({ ...requestMetadata, cancelMode: z.literal('starting-v1') }).strict(),
    request: DesktopRoomStartingGenerationCancelRequestSchema,
  }).strict()),
]);
export const DesktopRoomSessionTicketRequestSchema = postRequest(ArenaRoomTicketRequestSchema);
export const DesktopRoomSessionLeaveRequestSchema = postRequest(ArenaRoomEpochMutationRequestSchema);
export const DesktopRoomSessionCloseRequestSchema = postRequest(ArenaRoomEpochMutationRequestSchema);
export const DesktopRoomSessionConfigRequestSchema = postRequest(ArenaRoomPublishConfigRequestSchema);
export const DesktopRoomSessionProposalSubmitRequestSchema = postRequest(ArenaRoomProposalSubmitRequestSchema.extend({ proposalId: DesktopRoomSessionProposalIdSchema }));
export const DesktopRoomSessionProposalWithdrawRequestSchema = postRequest(ArenaRoomProposalWithdrawRequestSchema);
export const DesktopRoomSessionProposalResolveRequestSchema = postRequest(ArenaRoomProposalResolveRequestSchema);
export const DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS = Object.freeze({
  create: DesktopRoomSessionCreateRequestSchema,
  join: DesktopRoomSessionJoinRequestSchema,
  generationStart: DesktopRoomSessionGenerationStartRequestSchema,
  generationCancel: DesktopRoomSessionGenerationCancelRequestSchema,
  ticket: DesktopRoomSessionTicketRequestSchema,
  leave: DesktopRoomSessionLeaveRequestSchema,
  close: DesktopRoomSessionCloseRequestSchema,
  config: DesktopRoomSessionConfigRequestSchema,
  proposalSubmit: DesktopRoomSessionProposalSubmitRequestSchema,
  proposalWithdraw: DesktopRoomSessionProposalWithdrawRequestSchema,
  proposalResolve: DesktopRoomSessionProposalResolveRequestSchema,
});
export type DesktopRoomSessionRequest<Operation extends DesktopRoomSessionPostOperation = DesktopRoomSessionPostOperation> =
  z.infer<(typeof DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS)[Operation]>;

const successResponse = <T extends z.ZodType>(result: T, maxBytes = DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes) => boundedObject(
  maxBytes,
).pipe(z.object({ desktopRoom: DesktopRoomSessionResponseMetadataSchema, result }).strict());
export const DesktopRoomSessionDiscoverSuccessSchema = successResponse(RoomDirectoryPageSchema);
export const DesktopRoomSessionCreateSuccessSchema = successResponse(ArenaRoomSessionResponseSchema);
export const DesktopRoomSessionJoinSuccessSchema = successResponse(ArenaRoomSessionResponseSchema);
export const DesktopRoomSessionSessionSuccessSchema = successResponse(ArenaRoomSessionResponseSchema);
export const DesktopRoomSessionGenerationReadSuccessSchema = successResponse(
  ArenaRoomGenerationViewResponseSchema, DESKTOP_ROOM_SESSION_LIMITS.generationResponseBodyBytes,
);
/** Bounded cancellation acknowledgement; full reports use the existing generation reader. */
export const DesktopRoomGenerationCancelReceiptSchema = z.object({
  protocolVersion: z.literal(1), roomId: DesktopRoomSessionRoomIdSchema, roomEpoch: OpaqueKeySchema,
  generation: GenerationMirrorSchema, status: ArenaRoomGenerationProjectionStatusSchema,
}).strict().superRefine((value, context) => {
  const states = { reserved: 'starting', running: 'running', finalizing: 'running',
    completed: 'completed', failed: 'failed', producer_lost: 'failed', cancelled: 'cancelled' } as const;
  if (value.generation.state !== states[value.status]) {
    context.addIssue({ code: 'custom', path: ['generation', 'state'], message: 'cancel receipt status must match mirror state' });
  }
});
export const DesktopRoomGenerationStartReceiptSchema = DesktopRoomGenerationCancelReceiptSchema;
export const DesktopRoomSessionGenerationStartSuccessSchema = successResponse(DesktopRoomGenerationStartReceiptSchema);
export const DesktopRoomSessionGenerationCancelSuccessSchema = successResponse(DesktopRoomGenerationCancelReceiptSchema);
// The legacy ticket schema counts UTF-16 units; Native additionally caps raw token bytes.
const desktopTicketResult = z.custom<z.input<typeof ArenaRoomTicketResponseSchema>>(
  (input) => isBoundedJsonObject(input) && typeof input.ticket === 'string'
    && utf8ByteLength(input.ticket) <= MAX_ARENA_ROOM_HTTP_TICKET_BYTES,
  { message: 'ticket must not exceed the original 4096-byte Native receive budget' },
).pipe(ArenaRoomTicketResponseSchema);
export const DesktopRoomSessionTicketSuccessSchema = successResponse(desktopTicketResult);
export const DesktopRoomSessionLeaveSuccessSchema = successResponse(ArenaRoomLeaveResponseSchema);
export const DesktopRoomSessionCloseSuccessSchema = successResponse(ArenaRoomLeaveResponseSchema);
export const DesktopRoomSessionConfigSuccessSchema = successResponse(ArenaRoomSessionResponseSchema);
// Summary receipts do not establish a complete replica cursor. Only resolve installs a snapshot.
export const DesktopRoomSessionProposalSubmitSuccessSchema = successResponse(
  ArenaRoomProposalMutationResponseSchema.refine((result) => result.status === 'submitted'),
);
export const DesktopRoomSessionProposalWithdrawSuccessSchema = successResponse(
  ArenaRoomProposalMutationResponseSchema.refine((result) => result.status === 'withdrawn' && result.result === 'applied'),
);
const equalJson = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>; const b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every((key) => Object.hasOwn(b, key) && equalJson(a[key], b[key]));
};
export const DesktopRoomSessionProposalResolveSuccessSchema = successResponse(
  ArenaRoomProposalMutationResponseSchema.superRefine((result, context) => {
    if (!['accepted', 'partially_accepted', 'rejected'].includes(result.status) || result.result !== 'applied') {
      context.addIssue({ code: 'custom', message: 'resolve requires an applied resolution' });
    }
    if (result.snapshot === undefined || result.sharedConfig === undefined
      || !equalJson(result.sharedConfig, result.snapshot.sharedConfig)) {
      context.addIssue({ code: 'custom', path: ['snapshot'], message: 'resolve requires a complete consistent snapshot' });
    }
  }),
);
export const DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS = Object.freeze({
  discover: DesktopRoomSessionDiscoverSuccessSchema,
  create: DesktopRoomSessionCreateSuccessSchema,
  join: DesktopRoomSessionJoinSuccessSchema,
  session: DesktopRoomSessionSessionSuccessSchema,
  generationRead: DesktopRoomSessionGenerationReadSuccessSchema,
  generationStart: DesktopRoomSessionGenerationStartSuccessSchema,
  generationCancel: DesktopRoomSessionGenerationCancelSuccessSchema,
  ticket: DesktopRoomSessionTicketSuccessSchema,
  leave: DesktopRoomSessionLeaveSuccessSchema,
  close: DesktopRoomSessionCloseSuccessSchema,
  config: DesktopRoomSessionConfigSuccessSchema,
  proposalSubmit: DesktopRoomSessionProposalSubmitSuccessSchema,
  proposalWithdraw: DesktopRoomSessionProposalWithdrawSuccessSchema,
  proposalResolve: DesktopRoomSessionProposalResolveSuccessSchema,
});
export type DesktopRoomSessionSuccess<Operation extends DesktopRoomSessionOperation = DesktopRoomSessionOperation> =
  z.infer<(typeof DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS)[Operation]>;

export const DESKTOP_ROOM_SESSION_ERROR_CODES = [
  ...ARENA_ROOM_HTTP_ERROR_CODES,
  'ROOM_DESKTOP_PROTOCOL_INVALID',
  'ROOM_DESKTOP_OWNER_MISMATCH',
  'ROOM_DESKTOP_OPERATION_UNSUPPORTED',
  'ROOM_DESKTOP_RESPONSE_TOO_LARGE',
  'ROOM_DESKTOP_RESPONSE_INVALID',
] as const;
export const DesktopRoomSessionErrorCodeSchema = z.enum(DESKTOP_ROOM_SESSION_ERROR_CODES);
export type DesktopRoomSessionErrorCode = z.infer<typeof DesktopRoomSessionErrorCodeSchema>;
export const DesktopRoomSessionErrorOutcomeSchema = z.enum(['not-applied', 'unknown', 'not-applicable']);
export type DesktopRoomSessionErrorOutcome = z.infer<typeof DesktopRoomSessionErrorOutcomeSchema>;

/** Unpaired failures contain no business data and cannot prove an applied operation. */
export const DESKTOP_ROOM_SESSION_UNPAIRED_ERROR_CODES = [
  'ROOM_AUTHENTICATION_REQUIRED',
  'ROOM_AUTHENTICATION_DENIED',
  'ROOM_DESKTOP_PROTOCOL_INVALID',
  'ROOM_DESKTOP_OWNER_MISMATCH',
  'ROOM_DESKTOP_OPERATION_UNSUPPORTED',
  'ROOM_FORBIDDEN',
  'ROOM_UNAVAILABLE',
  'ROOM_REQUEST_INVALID',
  'ROOM_PAYLOAD_TOO_LARGE',
  'ROOM_DESKTOP_RESPONSE_INVALID',
] as const;
const unpairedErrorCodes: ReadonlySet<DesktopRoomSessionErrorCode> = new Set(DESKTOP_ROOM_SESSION_UNPAIRED_ERROR_CODES);
const mustBeUnpaired: ReadonlySet<DesktopRoomSessionErrorCode> = new Set([
  'ROOM_AUTHENTICATION_REQUIRED', 'ROOM_AUTHENTICATION_DENIED', 'ROOM_DESKTOP_OWNER_MISMATCH',
]);
export const DesktopRoomSessionErrorResponseSchema = boundedObject(
  DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes,
).pipe(z.object({
  desktopRoom: z.object({
    version: z.literal(DESKTOP_ROOM_SESSION_PROTOCOL_VERSION),
    viewerUserId: DesktopRoomSessionUserIdSchema.nullable(),
  }).strict(),
  error: z.object({
    code: DesktopRoomSessionErrorCodeSchema,
    message: WireErrorMessageSchema,
    outcome: DesktopRoomSessionErrorOutcomeSchema,
    retryAfterSeconds: z.number().int().positive().max(DESKTOP_ROOM_SESSION_LIMITS.retryAfterSeconds).optional(),
  }).strict(),
}).strict()).superRefine((response, context) => {
  const isUnpaired = response.desktopRoom.viewerUserId === null;
  if ((isUnpaired && (!unpairedErrorCodes.has(response.error.code) || response.error.outcome === 'unknown'))
    || (!isUnpaired && mustBeUnpaired.has(response.error.code))) {
    context.addIssue({ code: 'custom', path: ['desktopRoom', 'viewerUserId'], message: 'error identity metadata is inconsistent' });
  }
});
export type DesktopRoomSessionErrorResponse = z.infer<typeof DesktopRoomSessionErrorResponseSchema>;

const getErrorResponse = DesktopRoomSessionErrorResponseSchema.refine(
  (response) => response.error.outcome === 'not-applicable',
  { path: ['error', 'outcome'], message: 'GET outcome must be not-applicable' },
);
const postErrorResponse = DesktopRoomSessionErrorResponseSchema.refine(
  (response) => response.error.outcome !== 'not-applicable',
  { path: ['error', 'outcome'], message: 'POST outcome must be not-applied or unknown' },
);
export const DESKTOP_ROOM_SESSION_RESPONSE_SCHEMAS = Object.freeze({
  discover: z.union([DesktopRoomSessionDiscoverSuccessSchema, getErrorResponse]),
  create: z.union([DesktopRoomSessionCreateSuccessSchema, postErrorResponse]),
  join: z.union([DesktopRoomSessionJoinSuccessSchema, postErrorResponse]),
  session: z.union([DesktopRoomSessionSessionSuccessSchema, getErrorResponse]),
  generationRead: z.union([DesktopRoomSessionGenerationReadSuccessSchema, getErrorResponse]),
  generationStart: z.union([DesktopRoomSessionGenerationStartSuccessSchema, postErrorResponse]),
  generationCancel: z.union([DesktopRoomSessionGenerationCancelSuccessSchema, postErrorResponse]),
  ticket: z.union([DesktopRoomSessionTicketSuccessSchema, postErrorResponse]),
  leave: z.union([DesktopRoomSessionLeaveSuccessSchema, postErrorResponse]),
  close: z.union([DesktopRoomSessionCloseSuccessSchema, postErrorResponse]),
  config: z.union([DesktopRoomSessionConfigSuccessSchema, postErrorResponse]),
  proposalSubmit: z.union([DesktopRoomSessionProposalSubmitSuccessSchema, postErrorResponse]),
  proposalWithdraw: z.union([DesktopRoomSessionProposalWithdrawSuccessSchema, postErrorResponse]),
  proposalResolve: z.union([DesktopRoomSessionProposalResolveSuccessSchema, postErrorResponse]),
});
export type DesktopRoomSessionResponse<Operation extends DesktopRoomSessionOperation = DesktopRoomSessionOperation> =
  z.infer<(typeof DESKTOP_ROOM_SESSION_RESPONSE_SCHEMAS)[Operation]>;

/** Only stable codes escape this parsing boundary, never raw data or Zod exceptions. */
export class DesktopRoomSessionContractError extends Error {
  readonly code: DesktopRoomSessionErrorCode;

  constructor(code: DesktopRoomSessionErrorCode) {
    super(code);
    this.name = 'DesktopRoomSessionContractError';
    this.code = code;
  }
}

/** The HTTP adapter separately enforces the operation's raw body budget before JSON decoding. */
export const parseDesktopRoomSessionRequest = <Operation extends DesktopRoomSessionPostOperation>(
  operation: Operation,
  raw: unknown,
  expectedUserId: number,
): DesktopRoomSessionRequest<Operation> => {
  if (!DesktopRoomSessionPostOperationSchema.safeParse(operation).success) {
    throw new DesktopRoomSessionContractError('ROOM_DESKTOP_OPERATION_UNSUPPORTED');
  }
  if (operation === 'generationStart' && !isDesktopRoomStartWithinNodeBudget((raw as { request?: unknown } | null)?.request)) {
    throw new DesktopRoomSessionContractError('ROOM_DESKTOP_PROTOCOL_INVALID');
  }
  if (!DesktopRoomSessionUserIdSchema.safeParse(expectedUserId).success || !isBoundedJsonObject(raw)
    || !isBoundedJsonObject(raw.request)) {
    throw new DesktopRoomSessionContractError('ROOM_DESKTOP_PROTOCOL_INVALID');
  }
  const start = operation === 'generationStart';
  if (jsonUtf8ByteLength(raw) > (start ? DESKTOP_ROOM_SESSION_LIMITS.generationStartRequestBytes : DESKTOP_ROOM_SESSION_LIMITS.requestBodyBytes)
    || jsonUtf8ByteLength(raw.request) > (start ? DESKTOP_ROOM_SESSION_LIMITS.generationStartOriginalBytes : DESKTOP_ROOM_SESSION_LIMITS.originalRequestBodyBytes)) {
    throw new DesktopRoomSessionContractError('ROOM_PAYLOAD_TOO_LARGE');
  }
  const parsed = DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS[operation].safeParse(raw);
  if (!parsed.success) throw new DesktopRoomSessionContractError('ROOM_DESKTOP_PROTOCOL_INVALID');
  if (parsed.data.desktopRoom.expectedUserId !== expectedUserId) {
    throw new DesktopRoomSessionContractError('ROOM_DESKTOP_OWNER_MISMATCH');
  }
  return parsed.data as DesktopRoomSessionRequest<Operation>;
};

/** Native must also bound the actual raw receive bytes before JSON decoding. */
export const parseDesktopRoomSessionResponse = <Operation extends DesktopRoomSessionOperation>(
  operation: Operation,
  raw: unknown,
  expectedUserId: number,
): DesktopRoomSessionResponse<Operation> => {
  if (!DesktopRoomSessionOperationSchema.safeParse(operation).success) {
    throw new DesktopRoomSessionContractError('ROOM_DESKTOP_OPERATION_UNSUPPORTED');
  }
  if (!DesktopRoomSessionUserIdSchema.safeParse(expectedUserId).success || !isBoundedJsonObject(raw)) {
    throw new DesktopRoomSessionContractError('ROOM_DESKTOP_RESPONSE_INVALID');
  }
  const maxBytes = operation === 'generationRead' && !Object.hasOwn(raw, 'error')
    ? DESKTOP_ROOM_SESSION_LIMITS.generationResponseBodyBytes : DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes;
  if (jsonUtf8ByteLength(raw) > maxBytes) {
    throw new DesktopRoomSessionContractError('ROOM_DESKTOP_RESPONSE_TOO_LARGE');
  }
  const parsed = DESKTOP_ROOM_SESSION_RESPONSE_SCHEMAS[operation].safeParse(raw);
  if (!parsed.success) throw new DesktopRoomSessionContractError('ROOM_DESKTOP_RESPONSE_INVALID');
  if (parsed.data.desktopRoom.viewerUserId !== null && parsed.data.desktopRoom.viewerUserId !== expectedUserId) {
    throw new DesktopRoomSessionContractError('ROOM_DESKTOP_OWNER_MISMATCH');
  }
  return parsed.data as DesktopRoomSessionResponse<Operation>;
};
