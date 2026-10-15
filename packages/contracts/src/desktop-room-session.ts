import { z } from './zod';

import { ARENA_ROOM_HTTP_ERROR_CODES } from './arena-error-taxonomy';
import { JsonValueSchema, SAFE_JSON_VALUE_MAX_DEPTH, type JsonValue } from './json-value';
import { MAX_CONTROL_FRAME_BYTES } from './limits';
import { WireErrorMessageSchema } from './primitives';
import { RoomDirectoryPageSchema } from './room-directory';
import {
  ARENA_ROOM_HTTP_ROUTES,
  MAX_ARENA_ROOM_HTTP_TICKET_BYTES,
  ArenaRoomCreateRequestSchema,
  ArenaRoomEpochMutationRequestSchema,
  ArenaRoomJoinRequestSchema,
  ArenaRoomLeaveResponseSchema,
  ArenaRoomPublishConfigRequestSchema,
  ArenaRoomSessionResponseSchema,
  ArenaRoomTicketRequestSchema,
  ArenaRoomTicketResponseSchema,
} from './room-http';
import { jsonUtf8ByteLength, utf8ByteLength } from './wire-size';

/** Same-path, fail-closed Native opt-in; unnegotiated Web contracts stay unchanged. */
export const DESKTOP_ROOM_SESSION_PROTOCOL_VERSION = 'desktop-room-session-v1' as const;
export const DESKTOP_ROOM_SESSION_PROTOCOL_HEADER = 'x-mahoshojo-desktop-room-protocol' as const;
export const DESKTOP_ROOM_SESSION_EXPECTED_USER_ID_HEADER = 'x-mahoshojo-room-expected-user-id' as const;
export const DESKTOP_ROOM_SESSION_LIMITS = Object.freeze({
  originalRequestBodyBytes: 64 * 1_024,
  requestBodyBytes: 65 * 1_024,
  responseBodyBytes: 256 * 1_024,
  websocketMessageBytes: MAX_CONTROL_FRAME_BYTES,
  maxJsonDepth: SAFE_JSON_VALUE_MAX_DEPTH,
  retryAfterSeconds: 86_400,
});

export const DESKTOP_ROOM_SESSION_OPERATIONS = Object.freeze({
  discover: { method: 'GET', path: ARENA_ROOM_HTTP_ROUTES.collection },
  create: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.collection },
  join: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.join },
  session: { method: 'GET', path: ARENA_ROOM_HTTP_ROUTES.session },
  ticket: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.ticket },
  leave: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.leave },
  close: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.close },
  config: { method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.config },
} as const);
export const DesktopRoomSessionOperationSchema = z.enum([
  'discover', 'create', 'join', 'session', 'ticket', 'leave', 'close', 'config',
]);
export const DesktopRoomSessionPostOperationSchema = z.enum(['create', 'join', 'ticket', 'leave', 'close', 'config']);
export type DesktopRoomSessionOperation = z.infer<typeof DesktopRoomSessionOperationSchema>;
export type DesktopRoomSessionPostOperation = z.infer<typeof DesktopRoomSessionPostOperationSchema>;

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

const boundedObject = (maxBytes: number, checkOriginalRequest = false) => z.custom<unknown>(
  (input) => isBoundedJsonObject(input)
    && jsonUtf8ByteLength(input) <= maxBytes
    && (!checkOriginalRequest || jsonUtf8ByteLength(input.request) <= DESKTOP_ROOM_SESSION_LIMITS.originalRequestBodyBytes),
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
export const DesktopRoomSessionTicketRequestSchema = postRequest(ArenaRoomTicketRequestSchema);
export const DesktopRoomSessionLeaveRequestSchema = postRequest(ArenaRoomEpochMutationRequestSchema);
export const DesktopRoomSessionCloseRequestSchema = postRequest(ArenaRoomEpochMutationRequestSchema);
export const DesktopRoomSessionConfigRequestSchema = postRequest(ArenaRoomPublishConfigRequestSchema);
export const DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS = Object.freeze({
  create: DesktopRoomSessionCreateRequestSchema,
  join: DesktopRoomSessionJoinRequestSchema,
  ticket: DesktopRoomSessionTicketRequestSchema,
  leave: DesktopRoomSessionLeaveRequestSchema,
  close: DesktopRoomSessionCloseRequestSchema,
  config: DesktopRoomSessionConfigRequestSchema,
});
export type DesktopRoomSessionRequest<Operation extends DesktopRoomSessionPostOperation = DesktopRoomSessionPostOperation> =
  z.infer<(typeof DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS)[Operation]>;

const successResponse = <T extends z.ZodType>(result: T) => boundedObject(
  DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes,
).pipe(z.object({ desktopRoom: DesktopRoomSessionResponseMetadataSchema, result }).strict());
export const DesktopRoomSessionDiscoverSuccessSchema = successResponse(RoomDirectoryPageSchema);
export const DesktopRoomSessionCreateSuccessSchema = successResponse(ArenaRoomSessionResponseSchema);
export const DesktopRoomSessionJoinSuccessSchema = successResponse(ArenaRoomSessionResponseSchema);
export const DesktopRoomSessionSessionSuccessSchema = successResponse(ArenaRoomSessionResponseSchema);
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
export const DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS = Object.freeze({
  discover: DesktopRoomSessionDiscoverSuccessSchema,
  create: DesktopRoomSessionCreateSuccessSchema,
  join: DesktopRoomSessionJoinSuccessSchema,
  session: DesktopRoomSessionSessionSuccessSchema,
  ticket: DesktopRoomSessionTicketSuccessSchema,
  leave: DesktopRoomSessionLeaveSuccessSchema,
  close: DesktopRoomSessionCloseSuccessSchema,
  config: DesktopRoomSessionConfigSuccessSchema,
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
  ticket: z.union([DesktopRoomSessionTicketSuccessSchema, postErrorResponse]),
  leave: z.union([DesktopRoomSessionLeaveSuccessSchema, postErrorResponse]),
  close: z.union([DesktopRoomSessionCloseSuccessSchema, postErrorResponse]),
  config: z.union([DesktopRoomSessionConfigSuccessSchema, postErrorResponse]),
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

/** The HTTP adapter must separately enforce the actual raw 65 KiB body before JSON decoding. */
export const parseDesktopRoomSessionRequest = <Operation extends DesktopRoomSessionPostOperation>(
  operation: Operation,
  raw: unknown,
  expectedUserId: number,
): DesktopRoomSessionRequest<Operation> => {
  if (!DesktopRoomSessionPostOperationSchema.safeParse(operation).success) {
    throw new DesktopRoomSessionContractError('ROOM_DESKTOP_OPERATION_UNSUPPORTED');
  }
  if (!DesktopRoomSessionUserIdSchema.safeParse(expectedUserId).success || !isBoundedJsonObject(raw)
    || !isBoundedJsonObject(raw.request)) {
    throw new DesktopRoomSessionContractError('ROOM_DESKTOP_PROTOCOL_INVALID');
  }
  if (jsonUtf8ByteLength(raw) > DESKTOP_ROOM_SESSION_LIMITS.requestBodyBytes
    || jsonUtf8ByteLength(raw.request) > DESKTOP_ROOM_SESSION_LIMITS.originalRequestBodyBytes) {
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
  if (jsonUtf8ByteLength(raw) > DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes) {
    throw new DesktopRoomSessionContractError('ROOM_DESKTOP_RESPONSE_TOO_LARGE');
  }
  const parsed = DESKTOP_ROOM_SESSION_RESPONSE_SCHEMAS[operation].safeParse(raw);
  if (!parsed.success) throw new DesktopRoomSessionContractError('ROOM_DESKTOP_RESPONSE_INVALID');
  if (parsed.data.desktopRoom.viewerUserId !== null && parsed.data.desktopRoom.viewerUserId !== expectedUserId) {
    throw new DesktopRoomSessionContractError('ROOM_DESKTOP_OWNER_MISMATCH');
  }
  return parsed.data as DesktopRoomSessionResponse<Operation>;
};
