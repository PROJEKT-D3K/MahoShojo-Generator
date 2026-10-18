import type { Context } from 'hono';
import {
  DESKTOP_ROOM_SESSION_EXPECTED_USER_ID_HEADER,
  DESKTOP_ROOM_SESSION_LIMITS,
  DESKTOP_ROOM_SESSION_OPERATIONS,
  DESKTOP_ROOM_SESSION_PROTOCOL_HEADER,
  DESKTOP_ROOM_SESSION_PROTOCOL_VERSION,
  DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS,
  DesktopRoomSessionErrorResponseSchema,
  DesktopRoomSessionExpectedUserIdHeaderSchema,
  DesktopRoomSessionProposalIdSchema,
  DesktopRoomSessionGenerationIdSchema,
  DesktopRoomSessionRoomIdSchema,
  parseDesktopRoomSessionRequest,
  type DesktopRoomSessionErrorCode,
  type DesktopRoomSessionErrorOutcome,
  type DesktopRoomSessionOperation,
  type DesktopRoomSessionPostOperation,
} from '@mahoshojo/contracts/desktop-room-session';
import { ArenaRoomHttpErrorResponseSchema } from '@mahoshojo/contracts/arena-room';

import type { HonoAppVariables } from '#/middleware/request-metadata';

type RoomContext = Context<{ Variables: HonoAppVariables }>;
type Scope = {
  readonly operation: DesktopRoomSessionOperation;
  readonly expectedUserId: number;
  readonly request?: unknown;
  readonly createMode?: 'new' | 'resume-only';
  viewerUserId: number | null;
  businessEntered: boolean;
};

const encodedBytes = (value: unknown): number => (
  new TextEncoder().encode(JSON.stringify(value)).byteLength
);

const resolveOperation = (method: string, path: string): DesktopRoomSessionOperation | null => {
  for (const [name, route] of Object.entries(DESKTOP_ROOM_SESSION_OPERATIONS)) {
    if (method !== route.method) continue;
    const template = route.path.split('/');
    const segments = path.split('/');
    if (template.length !== segments.length) continue;
    const matches = template.every((segment, index) => {
      const raw = segments[index]!;
      if (segment !== ':roomId' && segment !== ':proposalId' && segment !== ':generationId') return raw === segment;
      try {
        const decoded = decodeURIComponent(raw);
        const schema = segment === ':proposalId' ? DesktopRoomSessionProposalIdSchema
          : segment === ':generationId' ? DesktopRoomSessionGenerationIdSchema : DesktopRoomSessionRoomIdSchema;
        const parsed = schema.safeParse(decoded);
        // A single canonical segment only: no slash, backslash, or second decoding layer.
        return parsed.success && encodeURIComponent(parsed.data) === raw;
      } catch { return false; }
    });
    if (matches) return name as DesktopRoomSessionOperation;
  }
  return null;
};

const outcomeFor = (context: RoomContext, scope?: Scope): DesktopRoomSessionErrorOutcome => (
  context.req.method === 'GET' ? 'not-applicable' : scope?.businessEntered ? 'unknown' : 'not-applied'
);

/** Only this opt-in adapter wraps responses; unmarked Web requests never enter it. */
export const createDesktopRoomSessionAdapter = (options: {
  readonly readBody: (request: Request, maxBytes: number) => Promise<unknown>;
  readonly isBodyTooLarge: (error: unknown) => boolean;
}) => {
  const scopes = new WeakMap<RoomContext, Scope>();

  const errorResponse = (
    context: RoomContext,
    code: DesktopRoomSessionErrorCode,
    message: string,
    status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503,
    retryAfterSeconds?: number,
  ): Response => {
    const scope = scopes.get(context);
    const error = DesktopRoomSessionErrorResponseSchema.parse({
      desktopRoom: {
        version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION,
        viewerUserId: scope?.viewerUserId ?? null,
      },
      error: {
        code,
        message,
        outcome: outcomeFor(context, scope),
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      },
    });
    return context.json(error, status);
  };

  const readResponse = async (response: Response, maxBytes: number): Promise<unknown> => {
    if (!response.body) throw new Error('invalid-response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error('response-too-large');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  };

  const middleware = async (context: RoomContext, next: () => Promise<void>) => {
    const protocol = context.req.header(DESKTOP_ROOM_SESSION_PROTOCOL_HEADER);
    const owner = context.req.header(DESKTOP_ROOM_SESSION_EXPECTED_USER_ID_HEADER);
    if (protocol === undefined && owner === undefined) {
      await next();
      return;
    }
    const parsedOwner = DesktopRoomSessionExpectedUserIdHeaderSchema.safeParse(owner);
    if (protocol !== DESKTOP_ROOM_SESSION_PROTOCOL_VERSION || !parsedOwner.success) {
      return errorResponse(context, 'ROOM_DESKTOP_PROTOCOL_INVALID', '桌面房间协议协商无效', 400);
    }
    const url = new URL(context.req.url);
    const operation = resolveOperation(context.req.method, url.pathname);
    // Desktop reads only the current projection. History/query variants remain Web-only.
    if (operation === null || (operation === 'generationRead' && url.search !== '')) {
      return errorResponse(context, 'ROOM_DESKTOP_OPERATION_UNSUPPORTED', '当前桌面房间版本不支持此操作', 400);
    }
    // Header parser is canonical and safe-integer checked; the account remains unverified here.
    const expectedUserId = parsedOwner.data;
    let request: unknown;
    let createMode: 'new' | 'resume-only' | undefined;
    if (context.req.method === 'POST') {
      try {
        const body = await options.readBody(context.req.raw, DESKTOP_ROOM_SESSION_LIMITS.requestBodyBytes);
        const envelope = parseDesktopRoomSessionRequest(
          operation as DesktopRoomSessionPostOperation, body, expectedUserId,
        );
        request = envelope.request;
        if ('createMode' in envelope.desktopRoom) createMode = envelope.desktopRoom.createMode;
      } catch (error) {
        const tooLarge = options.isBodyTooLarge(error)
          || (error instanceof Error && 'code' in error && error.code === 'ROOM_PAYLOAD_TOO_LARGE');
        return errorResponse(
          context,
          tooLarge ? 'ROOM_PAYLOAD_TOO_LARGE' : 'ROOM_DESKTOP_PROTOCOL_INVALID',
          tooLarge ? '桌面房间请求超过大小限制' : '桌面房间请求封套无效',
          tooLarge ? 413 : 400,
        );
      }
    }
    const scope: Scope = { operation, expectedUserId, request, createMode, viewerUserId: null, businessEntered: false };
    scopes.set(context, scope);
    await next();

    const largeGenerationSuccess = operation === 'generationRead' && context.res.status === 200;
    const successLimit = largeGenerationSuccess
      ? DESKTOP_ROOM_SESSION_LIMITS.generationResponseBodyBytes : DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes;
    if (operation === 'generationRead' && context.res.ok && !largeGenerationSuccess) {
      // Native accepts a current-generation body only with HTTP 200. Do not read
      // or enlarge an unexpected success status, even if its DTO would be valid.
      await context.res.body?.cancel().catch(() => undefined);
      context.res = errorResponse(context, 'ROOM_DESKTOP_RESPONSE_INVALID', '房间响应不符合桌面协议，请先核对操作结果', 502);
      return;
    }
    let body: unknown;
    try {
      body = await readResponse(context.res, successLimit);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'response-too-large';
      context.res = errorResponse(
        context,
        tooLarge ? 'ROOM_DESKTOP_RESPONSE_TOO_LARGE' : 'ROOM_DESKTOP_RESPONSE_INVALID',
        tooLarge ? '房间响应超过桌面传输限制，请先核对操作结果' : '房间响应不符合桌面协议，请先核对操作结果',
        502,
      );
      return;
    }
    // Authentication/owner failures produced by this adapter are already closed and paired.
    const ownError = DesktopRoomSessionErrorResponseSchema.safeParse(body);
    if (ownError.success) {
      context.res = context.json(ownError.data, context.res.status as 400);
      return;
    }
    if (!context.res.ok) {
      const legacyError = ArenaRoomHttpErrorResponseSchema.safeParse(body);
      if (!legacyError.success) {
        context.res = errorResponse(context, 'ROOM_DESKTOP_RESPONSE_INVALID', '房间错误回执不符合桌面协议', 502);
        return;
      }
      const retry = legacyError.data.retryAfterSeconds;
      if (retry !== undefined && (!Number.isSafeInteger(retry) || retry > 86_400)) {
        context.res = errorResponse(context, 'ROOM_DESKTOP_RESPONSE_INVALID', '房间错误回执不符合桌面协议', 502);
        return;
      }
      context.res = errorResponse(
        context, legacyError.data.code, legacyError.data.error,
        context.res.status as 400, retry,
      );
      return;
    }
    const envelope = {
      desktopRoom: { version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, viewerUserId: scope.viewerUserId },
      result: body,
    };
    if (encodedBytes(envelope) > successLimit) {
      context.res = errorResponse(context, 'ROOM_DESKTOP_RESPONSE_TOO_LARGE', '房间响应超过桌面传输限制，请先核对操作结果', 502);
      return;
    }
    const parsed = DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS[operation].safeParse(envelope);
    if (!parsed.success) {
      context.res = errorResponse(context, 'ROOM_DESKTOP_RESPONSE_INVALID', '房间响应不符合桌面协议，请先核对操作结果', 502);
      return;
    }
    context.res = context.json(parsed.data, context.res.status as 200);
  };

  return {
    middleware,
    authenticate(context: RoomContext, accountUserId: number): Response | null {
      const scope = scopes.get(context);
      if (!scope) return null;
      if (!Number.isSafeInteger(accountUserId) || accountUserId <= 0 || accountUserId !== scope.expectedUserId) {
        return errorResponse(context, 'ROOM_DESKTOP_OWNER_MISMATCH', '登录身份已变化，请重新进入房间', 409);
      }
      scope.viewerUserId = accountUserId;
      return null;
    },
    requestBody(context: RoomContext): { readonly value: unknown } | null {
      const scope = scopes.get(context);
      return scope ? { value: scope.request } : null;
    },
    generationCancelReceipt(context: RoomContext): boolean {
      return scopes.get(context)?.operation === 'generationCancel';
    },
    resumeOnly(context: RoomContext): boolean {
      return scopes.get(context)?.createMode === 'resume-only';
    },
    enterBusiness(context: RoomContext): void {
      const scope = scopes.get(context);
      if (scope) scope.businessEntered = true;
    },
  };
};
