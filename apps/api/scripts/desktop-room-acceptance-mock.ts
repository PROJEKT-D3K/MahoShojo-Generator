import { ROOM_ACCEPTANCE_BYOK_KEY, createRoomAcceptanceStart, ROOM_ACCEPTANCE_START_SCENARIOS, type RoomAcceptanceStartScenario } from './desktop-room-acceptance-start';
/** Local acceptance only. Real Room authorities; synthetic accounts and bounded memory storage. */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpRequest, type Server } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import WebSocket from 'ws';
import { formatRoomMockDiagnostic, roomMockFailureCode } from '../../../scripts/desktop-room-acceptance-diagnostics.mjs';
import {
  ARENA_ROOM_PRESENCE_WEBSOCKET_PROTOCOL,
  ArenaRoomSharedConfigSchema,
  type RoomServerTransportMessage,
} from '@mahoshojo/contracts/arena-room';
import {
  DESKTOP_ROOM_SESSION_OPERATIONS, DESKTOP_ROOM_SESSION_PROTOCOL_VERSION,
  DesktopRoomSessionExpectedUserIdHeaderSchema, DesktopRoomSessionErrorResponseSchema, parseDesktopRoomSessionResponse,
  DesktopRoomSessionRoomIdSchema, DesktopRoomSessionProposalIdSchema, DesktopRoomSessionGenerationIdSchema,
  type DesktopRoomSessionOperation,
} from '@mahoshojo/contracts/desktop-room-session';
import {
  DESKTOP_AUTH_PROTOCOL_VERSION, DesktopAuthorizeQuerySchema, DesktopAuthExchangeRequestSchema,
  type DesktopAuthorizeQuery,
} from '@mahoshojo/contracts/desktop-cloud';
import { MessageSummarySchema } from '@mahoshojo/contracts/messages';
import {
  checkpointPredecessorOf, consumeArenaRoomCheckpointCommit, type ArenaRoomAuthorityState,
} from '@mahoshojo/multiplayer-core';
import { createRoomActorRegistry, type RoomActorCheckpointStore } from '../src/arena-room/room-actor-registry';
import { createArenaRoomMembershipService } from '../src/arena-room/room-membership-service';
import { createArenaRoomConfigService } from '../src/arena-room/room-config-service';
import { createArenaRoomProposalService } from '../src/arena-room/room-proposal-service';
import { createArenaDataCardRefVerifier, type ArenaDataCardRefVerifierD1Client } from '../src/arena-room/arena-data-card-ref-verifier';
import { createArenaRoomGenerationPresetResolver } from '../src/arena-room/room-generation-preset-registry';
import { createArenaRoomDirectoryService } from '../src/arena-room/room-directory-service';
import { createStoredRoomDirectoryRecord, serializeStoredRoomDirectoryRecord, type StoredRoomDirectoryRecord } from '../src/arena-room/room-directory-record';
import type { RedisRoomDirectoryCandidate, RedisRoomDirectoryStore } from '../src/arena-room/redis-room-directory-store';
import type { RedisRoomCreationReceipt, RedisRoomStore } from '../src/arena-room/redis-room-store';
import { registerArenaRoomHttpRoutes } from '../src/arena-room/room-http';
import { createArenaRoomTicketCodec, createArenaRoomTicketSignatureService } from '../src/arena-room/room-ticket';
import { createArenaRoomWebSocketAuthority } from '../src/arena-room/room-websocket-authority';
import { ARENA_ROOM_WEBSOCKET_PATH, RoomWebSocketGateway } from '../src/arena-room/room-websocket-gateway';
import { createRoomRequestDispatcher, createRoomWebSocketApp, createRoomWebSocketServer } from '../src/arena-room/room-websocket-transport';
import type { HonoAppVariables } from '../src/middleware/request-metadata';
import {
  createRoomAcceptanceGeneration, ROOM_ACCEPTANCE_GENERATION_LARGE_BYTES, ROOM_ACCEPTANCE_GENERATION_TAIL,
  type RoomAcceptanceGenerationObservation, type RoomAcceptanceGenerationScenario,
} from './desktop-room-acceptance-generation';

// This Native acceptance harness only exposes capabilities already implemented by its consumer.
export const ROOM_ACCEPTANCE_OPERATIONS = ['discover', 'create', 'join', 'session', 'ticket', 'leave', 'close', 'config', 'proposalSubmit', 'proposalWithdraw', 'proposalResolve', 'generationRead'] as const satisfies readonly DesktopRoomSessionOperation[];
export const ROOM_ACCEPTANCE_HOST = 'room.acceptance.invalid';
export const ROOM_ACCEPTANCE_PORT = 34443;
export const ROOM_ACCEPTANCE_AUTH_PORT = 34080;
export const ROOM_ACCEPTANCE_PUBLIC_CHARACTER = Object.freeze({
  id: 'acceptance-public-character-1', type: 'character', name: 'Synthetic public character',
  description: 'Local acceptance fixture only', author: 'Synthetic fixture', user_id: 101,
  is_public: 1, review_status: 'approved', deleted_at: null, updated_at: '2026-01-01T00:00:00.000Z',
  data: JSON.stringify({ name: 'Synthetic public character', content: 'A synthetic character for local Room acceptance.' }),
});
const CAPACITY = 64;
const TRACE_CAPACITY = 256;
const COOKIE = 'better-auth.session_token';
const account = (userId: 101 | 202) => ({ userId, username: `acceptance-${userId}`, displayName: `Synthetic ${userId}` });
const token = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const unavailable = (): never => { throw new Error('ACCEPTANCE_UNSUPPORTED'); };
export type RoomAcceptancePki = { ca: string; cert: string; key: string };
export type RoomAcceptanceFault = 'create' | 'join' | 'leave' | 'close' | 'config' | 'config-unsupported'
  | 'proposalSubmit' | 'proposalWithdraw' | 'proposalResolve' | 'proposal-unsupported' | 'generationCancel' | 'generationStart';
const faults: readonly string[] = ['create', 'join', 'leave', 'close', 'config', 'config-unsupported',
  'proposalSubmit', 'proposalWithdraw', 'proposalResolve', 'proposal-unsupported', 'generationCancel', 'generationStart'];
export type RoomAcceptanceObservation =
  | { kind: 'room-http'; operation: DesktopRoomSessionOperation; status: number; dropped: boolean }
  | { kind: 'public-card'; operation: 'random' | 'read'; status: number }
  | { kind: 'ws'; outcome: 'accepted' | 'rejected' }
  | { kind: 'refused' };
export type RoomAcceptanceRuntime = {
  roomOrigin: string;
  authOrigin: string;
  roomAddress: { host: '127.0.0.1'; port: number };
  authAddress: { host: '127.0.0.1'; port: number };
  close(): Promise<void>;
  armFault(operation: RoomAcceptanceFault): void;
  enableGenerationCancel(): void;
  enableGenerationStart(): void;
  generation(scenario: RoomAcceptanceGenerationScenario | RoomAcceptanceStartScenario): Promise<void>;
  observations(): { rooms: number; receipts: number; actors: number; activeConnections: number; authSessions: number; trace: RoomAcceptanceObservation[]; generation: RoomAcceptanceGenerationObservation & Partial<ReturnType<ReturnType<typeof createRoomAcceptanceStart>['observe']>> };
};

/** Checkpoint, receipt and directory writes are one synchronous CAS transaction. */
class MemoryRoomStore implements RoomActorCheckpointStore, Pick<RedisRoomStore, 'loadCreationReceipt'> {
  readonly states = new Map<string, ArenaRoomAuthorityState>();
  readonly receipts = new Map<string, RedisRoomCreationReceipt>();
  readonly directory = new Map<string, StoredRoomDirectoryRecord>();
  async load(roomId: string) { return structuredClone(this.states.get(roomId) ?? null); }
  async loadCreationReceipt(input: { accountUserId: number; creationRequestId: string }) {
    return structuredClone(this.receipts.get(JSON.stringify([input.accountUserId, input.creationRequestId])) ?? null);
  }
  async save(input: Parameters<RoomActorCheckpointStore['save']>[0]) {
    const commit = consumeArenaRoomCheckpointCommit(input.commit);
    const next = commit.nextState;
    const roomId = next.snapshot.roomId;
    const current = this.states.get(roomId) ?? null;
    if (!same(current, commit.predecessorState)
      || (current !== null && !same(checkpointPredecessorOf(current), commit.predecessor))) {
      return { kind: 'conflict' as const };
    }
    if (current === null && this.states.size >= CAPACITY) throw new Error('ACCEPTANCE_CAPACITY');
    const receiptKey = input.creationReceipt === undefined ? null
      : JSON.stringify([input.creationReceipt.accountUserId, input.creationReceipt.creationRequestId]);
    if (receiptKey !== null && current !== null) throw new Error('REDIS_ROOM_CREATION_RECEIPT_INPUT_INVALID');
    if (receiptKey !== null && this.receipts.has(receiptKey)) throw new Error('REDIS_ROOM_CREATION_RECEIPT_CONFLICT');
    if (input.directory !== undefined && current !== null) throw new Error('ACCEPTANCE_DIRECTORY_INVALID');
    let directory = this.directory.get(roomId);
    if (input.directory !== undefined) directory = createStoredRoomDirectoryRecord(input.directory);
    else if (directory && input.directoryMutation !== 'preserve') {
      directory = next.lifecycle.status === 'closed' ? undefined : createStoredRoomDirectoryRecord({
        ...directory, roomEpoch: next.snapshot.roomEpoch, lastActivityAt: next.lifecycle.updatedAt,
      });
    }
    // Prepare every value before publishing any part of the transaction.
    const state = structuredClone(next);
    const receipt = input.creationReceipt && { roomId, requestDigest: input.creationReceipt.requestDigest };
    this.states.set(roomId, state);
    if (receiptKey && receipt) this.receipts.set(receiptKey, receipt);
    if (directory) this.directory.set(roomId, directory); else this.directory.delete(roomId);
    return { kind: 'saved' as const };
  }
  async refresh(input: Parameters<RoomActorCheckpointStore['refresh']>[0]) {
    const current = this.states.get(input.checkpoint.snapshot.roomId);
    return { kind: !current ? 'missing' as const : same(current, input.checkpoint) ? 'refreshed' as const : 'conflict' as const };
  }
  private candidate(record: StoredRoomDirectoryRecord): RedisRoomDirectoryCandidate {
    const roomHash = createHash('sha256').update(record.roomId).digest('hex');
    return { roomHash, recordKey: roomHash, raw: serializeStoredRoomDirectoryRecord(record), indexMember: record.publicIndexMember };
  }
  readonly directoryStore: RedisRoomDirectoryStore = {
    candidateFromRaw: async (input) => ({
      roomHash: createHash('sha256').update(input.roomId).digest('hex'),
      recordKey: createHash('sha256').update(input.roomId).digest('hex'),
      raw: input.raw, indexMember: input.indexMember ?? null,
    }),
    getCandidate: async (roomId) => {
      const record = this.directory.get(roomId); return record ? this.candidate(record) : null;
    },
    listPublicCandidates: async ({ afterIndexMember, limit }) => [...this.directory.values()]
      .filter((record) => record.publicIndexMember !== null && (!afterIndexMember || record.publicIndexMember > afterIndexMember))
      .sort((a, b) => a.publicIndexMember! < b.publicIndexMember! ? -1 : 1).slice(0, limit)
      .map((record) => this.candidate(record)),
    removeIfExact: async (candidate) => {
      for (const [roomId, record] of this.directory) {
        const current = this.candidate(record);
        if (current.recordKey === candidate.recordKey && current.raw === candidate.raw) {
          this.directory.delete(roomId); return { kind: 'removed' };
        }
      }
      return { kind: 'stale' };
    },
  };
}

// Only the production verifier sees this bounded metadata port. It cannot query a database or URL.
const syntheticCardMetadata: ArenaDataCardRefVerifierD1Client = {
  prepare: () => ({
    bind: (...params) => ({
      bind: () => unavailable(),
      all: async ({ retry }) => {
        if (retry !== 'safe-read' || params.length !== 1 || typeof params[0] !== 'string') return unavailable();
        return { success: true, results: params[0] === ROOM_ACCEPTANCE_PUBLIC_CHARACTER.id
          ? [{ id: ROOM_ACCEPTANCE_PUBLIC_CHARACTER.id, user_id: ROOM_ACCEPTANCE_PUBLIC_CHARACTER.user_id,
            type: ROOM_ACCEPTANCE_PUBLIC_CHARACTER.type, is_public: ROOM_ACCEPTANCE_PUBLIC_CHARACTER.is_public,
            review_status: ROOM_ACCEPTANCE_PUBLIC_CHARACTER.review_status, updated_at: ROOM_ACCEPTANCE_PUBLIC_CHARACTER.updated_at,
            deleted_at: ROOM_ACCEPTANCE_PUBLIC_CHARACTER.deleted_at }] : [] };
      },
    }),
    all: async () => unavailable(),
  }),
};

const roomServices = () => {
  const store = new MemoryRoomStore();
  const actors = createRoomActorRegistry({ store, maxActors: CAPACITY, maxFencedRooms: CAPACITY });
  actors.startIdleSweeper();
  // References use real authority checks; no generation/model service is constructed.
  const references = createArenaDataCardRefVerifier({ getClient: () => syntheticCardMetadata });
  const presets = createArenaRoomGenerationPresetResolver();
  const memberships = createArenaRoomMembershipService({ actors, creationReceipts: store, references, presets });
  const directory = createArenaRoomDirectoryService({ authority: store, store: store.directoryStore });
  const usedTickets = new Map<string, number>();
  const tickets = createArenaRoomTicketCodec({ signatures: createArenaRoomTicketSignatureService({
    env: { SIGNATURE_SECRET_KEY: token() }, logger: { warn: () => undefined, error: () => undefined },
  }) });
  const authority = createArenaRoomWebSocketAuthority({ actors, memberships, tickets, replay: {
    consume: async ({ jti, nowMs, expiresAtMs }) => {
      for (const [key, expiresAt] of usedTickets) if (expiresAt <= nowMs) usedTickets.delete(key);
      const key = digest(jti);
      if (usedTickets.has(key)) return { kind: 'replayed' };
      if (usedTickets.size >= 1024) throw new Error('ACCEPTANCE_CAPACITY');
      usedTickets.set(key, expiresAtMs); return { kind: 'consumed' };
    },
  } });
  const configs = createArenaRoomConfigService({ memberships, references, presets });
  const proposals = createArenaRoomProposalService({ memberships, references, presets });
  return { store, actors, memberships, directory, authority, configs, proposals };
};

const operationFor = (request: Request): DesktopRoomSessionOperation | null => {
  const url = new URL(request.url), segments = url.pathname.split('/');
  for (const operation of [...ROOM_ACCEPTANCE_OPERATIONS, 'generationCancel', 'generationStart'] as const) {
    if ((operation === 'generationRead' || operation === 'generationStart') && url.search !== '') continue;
    const definition = DESKTOP_ROOM_SESSION_OPERATIONS[operation];
    const expected = definition.path.split('/');
    if (request.method !== definition.method || expected.length !== segments.length) continue;
    const matches = expected.every((part, index) => {
      const encoded = segments[index]!;
      if (part !== ':roomId' && part !== ':proposalId' && part !== ':generationId') return part === encoded;
      try {
        const value = decodeURIComponent(encoded);
        const schema = part === ':roomId' ? DesktopRoomSessionRoomIdSchema
          : part === ':generationId' ? DesktopRoomSessionGenerationIdSchema : DesktopRoomSessionProposalIdSchema;
        return schema.safeParse(value).success && encodeURIComponent(value) === encoded;
      } catch { return false; }
    });
    if (matches) return operation;
  }
  return null;
};
const bind = async (server: Server, port: number) => {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError); server.once('listening', onListening); server.listen(port, '127.0.0.1');
  });
  return (server.address() as AddressInfo).port;
};
const resetForSelfCheck = new WeakMap<RoomAcceptanceRuntime, () => Promise<void>>();

export const startRoomAcceptanceMock = async (options: {
  pki: RoomAcceptancePki; roomPort?: number; authPort?: number;
}): Promise<RoomAcceptanceRuntime> => {
  for (const port of [options.roomPort ?? ROOM_ACCEPTANCE_PORT, options.authPort ?? ROOM_ACCEPTANCE_AUTH_PORT]) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ACCEPTANCE_PORT_INVALID');
  }
  let services = roomServices();
  let cancelEnabled = false;
  let starter: ReturnType<typeof createRoomAcceptanceStart> | null = null;
  const newStarter = () => createRoomAcceptanceStart({ memberships: services.memberships, publicCharacter: ROOM_ACCEPTANCE_PUBLIC_CHARACTER });
  const newGeneration = () => createRoomAcceptanceGeneration({ states: () => [...services.store.states.values()], memberships: () => services.memberships, cancelEnabled: () => cancelEnabled });
  let generation = newGeneration();
  const trace: RoomAcceptanceObservation[] = [];
  const observe = (entry: RoomAcceptanceObservation) => { trace.push(entry); if (trace.length > TRACE_CAPACITY) trace.shift(); };
  let armed: RoomAcceptanceFault | null = null;
  let roomOrigin = ''; let authOrigin = '';
  const sessions = new Map<string, { userId: 101 | 202; expiresAt: number }>();
  const flows = new Map<string, { query: DesktopAuthorizeQuery; expiresAt: number }>();
  const grants = new Map<string, { userId: 101 | 202; challenge: string; expiresAt: number }>();
  const prune = <T extends { expiresAt: number }>(map: Map<string, T>) => {
    for (const [key, value] of map) if (value.expiresAt <= Date.now()) map.delete(key);
  };
  const identity = (request: Request) => {
    prune(sessions);
    const pairs = (request.headers.get('cookie') ?? '').split(';').map((value) => value.trim())
      .filter((value) => value.startsWith(`${COOKIE}=`));
    if (pairs.length !== 1) return null;
    return sessions.get(digest(pairs[0]!.slice(COOKIE.length + 1))) ?? null;
  };
  const http = new Hono<{ Variables: HonoAppVariables }>();
  http.onError(() => Response.json({ error: 'Acceptance request failed' }, { status: 503 }));
  http.use('*', async (context, next) => { generation.recordRequest(context.req.raw); await next(); });
  http.use('*', (context, next) => bodyLimit({ maxSize: starter && operationFor(context.req.raw) === 'generationStart' ? 12 * 1024 * 1024 + 1024 : 65 * 1024 })(context, next));
  http.use('*', async (context, next) => {
    context.header('cache-control', 'no-store');
    if (operationFor(context.req.raw) === null || (operationFor(context.req.raw) === 'generationCancel' && !cancelEnabled) || (operationFor(context.req.raw) === 'generationStart' && !starter)
      || context.req.header('x-mahoshojo-desktop-room-protocol') !== DESKTOP_ROOM_SESSION_PROTOCOL_VERSION) {
      observe({ kind: 'refused' }); return context.json({ code: 'ACCEPTANCE_ROUTE_REFUSED' }, 404);
    }
    // Test service only: mirror the older adapter's pre-auth operation rejection.
    // Invalid owner headers retain the real adapter's protocol error and do not consume this fault.
    const operation = operationFor(context.req.raw);
    if (((armed === 'config-unsupported' && operation === 'config')
      || (armed === 'proposal-unsupported'
        && (operation === 'proposalSubmit' || operation === 'proposalWithdraw' || operation === 'proposalResolve')))
      && DesktopRoomSessionExpectedUserIdHeaderSchema.safeParse(context.req.header('x-mahoshojo-room-expected-user-id')).success) {
      armed = null;
      return context.json(DesktopRoomSessionErrorResponseSchema.parse({
        desktopRoom: { version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, viewerUserId: null },
        error: { code: 'ROOM_DESKTOP_OPERATION_UNSUPPORTED', message: '当前桌面房间版本不支持此操作', outcome: 'not-applied' },
      }), 400);
    }
    await next();
  });
  registerArenaRoomHttpRoutes(http, {
    resolveAuthentication: async (request) => {
      const session = identity(request);
      return session ? { status: 'authenticated', userId: session.userId } : { status: 'anonymous' };
    },
    memberships: {
      create: (input) => services.memberships.create(input), join: (input) => services.memberships.join(input),
      getSession: (input) => services.memberships.getSession(input), hasCreationReceipt: (input) => services.memberships.hasCreationReceipt(input),
      leave: (input) => services.memberships.leave(input), close: (input) => services.memberships.close(input), kick: async () => unavailable(),
    },
    directory: { discoverPublic: (input) => services.directory.discoverPublic(input) },
    websocketAuthority: { issue: (input) => services.authority.issue(input) },
    proposals: { submit: (input) => services.proposals.submit(input), resolve: (input) => services.proposals.resolve(input), withdraw: (input) => services.proposals.withdraw(input) },
    generations: { start: input => starter ? starter.service.start(input) : Promise.resolve(generation.refusedDispatch('start')), read: input => starter ? starter.service.read(input) : generation.read(input),
      list: async () => unavailable(), readHistory: async () => unavailable(), cancel: input => starter ? starter.service.cancel(input) : generation.cancel(input) },
    configs: { publish: (input) => services.configs.publish(input) },
    rateLimit: async () => ({ allowed: true, limit: 100, remaining: 99, retryAfterSeconds: 1 }),
  }, { isAllowedOrigin: (origin) => origin === roomOrigin });
  let gateway: RoomWebSocketGateway | undefined;
  let websocketApp: ReturnType<typeof createRoomWebSocketApp> | undefined;
  const websocketServer = createRoomWebSocketServer();
  const dispatch = createRoomRequestDispatcher(http, {
    fetch: (request, env) => websocketApp?.fetch(request, env)
      ?? Response.json({ code: 'ACCEPTANCE_NOT_READY' }, { status: 503 }),
  });
  const tls = createAdaptorServer({
    createServer: createHttpsServer, serverOptions: { key: options.pki.key, cert: options.pki.cert, minVersion: 'TLSv1.2' },
    websocket: { server: websocketServer },
    fetch: async (request, env) => {
      const operation = operationFor(request);
      const result = await dispatch(request, env);
      if (operation !== null && (operation !== 'generationCancel' || cancelEnabled) && (operation !== 'generationStart' || starter) && result instanceof Response) {
        const dropped = result.ok && armed === operation;
        observe({ kind: 'room-http', operation, status: result.status, dropped });
        if (dropped) { armed = null; env.outgoing.destroy(); }
      }
      return result;
    },
  }) as Server;
  const auth = new Hono();
  auth.onError(() => Response.json({ error: 'Acceptance request failed' }, { status: 503 }));
  auth.use('*', async (context, next) => { generation.recordRequest(context.req.raw); await next(); });
  auth.use('*', bodyLimit({ maxSize: 4096 }));
  auth.use('*', async (context, next) => {
    // Keep the browser's same-origin form POST Origin; suppress referrers to the callback.
    context.header('cache-control', 'no-store'); context.header('referrer-policy', 'same-origin');
    context.header('content-security-policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'");
    await next();
  });
  auth.get('/auth/desktop', (context) => {
    const query = new URL(context.req.url).searchParams;
    const parsed = DesktopAuthorizeQuerySchema.safeParse(Object.fromEntries(query));
    if (!parsed.success || [...query.keys()].length !== 4) return context.json({ code: 'invalid-request', error: 'Invalid authorization' }, 400);
    prune(flows); if (flows.size >= CAPACITY) return context.json({ error: 'Local capacity' }, 429);
    const flow = token(); flows.set(flow, { query: parsed.data, expiresAt: Date.now() + 120_000 });
    return context.html(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic Room acceptance</title><h1>Synthetic Room acceptance</h1><p>Local fixture accounts only. No real sign-in.</p><form method="post" action="/auth/desktop"><input type="hidden" name="flow" value="${flow}"><button name="userId" value="101">Synthetic 101</button><button name="userId" value="202">Synthetic 202</button></form></html>`);
  });
  auth.post('/auth/desktop', async (context) => {
    if (context.req.header('origin') !== authOrigin) return context.json({ error: 'Origin refused' }, 403);
    const data = await context.req.parseBody();
    if (Object.keys(data).sort().join('|') !== 'flow|userId' || typeof data.flow !== 'string' || !['101', '202'].includes(String(data.userId))) {
      return context.json({ error: 'Invalid selection' }, 400);
    }
    prune(flows); prune(grants);
    const flow = flows.get(data.flow); flows.delete(data.flow);
    if (!flow) return context.json({ error: 'Invalid authorization' }, 400);
    if (grants.size >= CAPACITY) return context.json({ error: 'Local capacity' }, 429);
    const code = token(); const userId = Number(data.userId) as 101 | 202;
    grants.set(digest(code), { userId, challenge: flow.query.code_challenge, expiresAt: Date.now() + 120_000 });
    const redirect = new URL(flow.query.redirect_uri);
    redirect.searchParams.set('state', flow.query.state); redirect.searchParams.set('code', code);
    return context.redirect(redirect.href, 303);
  });
  auth.post('/api/auth/native/exchange', async (context) => {
    const parsed = DesktopAuthExchangeRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: 'Invalid exchange', code: 'invalid-request' }, 400);
    prune(grants); prune(sessions);
    const key = digest(parsed.data.code); const grant = grants.get(key); grants.delete(key);
    if (!grant || digest(parsed.data.codeVerifier) !== grant.challenge) return context.json({ error: 'Invalid grant', code: 'invalid-grant' }, 401);
    if (sessions.size >= CAPACITY) return context.json({ error: 'Local capacity', code: 'rate-limited' }, 429);
    const value = token(); const expiresAt = Date.now() + 60 * 60 * 1000;
    sessions.set(digest(value), { userId: grant.userId, expiresAt });
    context.header('set-cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`);
    return context.json({ protocolVersion: DESKTOP_AUTH_PROTOCOL_VERSION, account: account(grant.userId), sessionExpiresAt: new Date(expiresAt).toISOString() });
  });
  auth.get('/api/auth/get-session', (context) => {
    const current = identity(context.req.raw);
    return context.json(current ? { session: { expiresAt: new Date(current.expiresAt).toISOString() }, user: account(current.userId) } : { session: null, user: null });
  });
  auth.post('/api/auth/sign-out', (context) => {
    const pairs = (context.req.header('cookie') ?? '').split(';').map((value) => value.trim());
    for (const pair of pairs) if (pair.startsWith(`${COOKIE}=`)) sessions.delete(digest(pair.slice(COOKIE.length + 1)));
    context.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    return context.json({ success: true });
  });
  auth.get('/api/me/profile', (context) => identity(context.req.raw)
    ? context.json({ success: true, profile: { signature: '', avatarDataUrl: null } })
    : context.json({ error: 'Unauthorized' }, 401));
  for (const [endpoint, operation, key, expected] of [
    ['/api/random-public-card', 'random', 'type', 'character'],
    ['/api/public-data-cards', 'read', 'id', ROOM_ACCEPTANCE_PUBLIC_CHARACTER.id],
  ] as const) {
    auth.get(endpoint, (context) => {
      const query = new URL(context.req.url).searchParams;
      const allowed = context.req.method === 'GET' && [...query.keys()].length === 1 && query.get(key) === expected;
      observe({ kind: 'public-card', operation, status: allowed ? 200 : 404 });
      return allowed ? context.json({ success: true, card: ROOM_ACCEPTANCE_PUBLIC_CHARACTER })
        : context.json({ code: 'ACCEPTANCE_ROUTE_REFUSED' }, 404);
    });
  }
  auth.get('/announcements.json', (context) => context.json([]));
  auth.get('/api/messages/summary', (context) => context.json(MessageSummarySchema.parse({
    unreadTotal: 0, siteUnread: 0, directUnread: 0, latest: null, fetchedAt: new Date().toISOString(),
    isAuthenticated: identity(context.req.raw) !== null, hasCrowdReviewPending: false, crowdReviewPrompt: null,
  })));
  auth.notFound((context) => context.json({ code: 'ACCEPTANCE_ROUTE_REFUSED' }, 404));
  const authServer = createAdaptorServer({ fetch: auth.fetch }) as Server;
  const sockets = new Set<Socket>();
  for (const server of [tls, authServer]) {
    server.maxConnections = 32; server.requestTimeout = 5000; server.headersTimeout = 5000;
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  }
  let closing: Promise<void> | null = null;
  const close = () => closing ??= (async () => {
    generation.dispose(); starter?.dispose();
    gateway?.forceClose();
    for (const socket of websocketServer.clients) socket.terminate();
    for (const socket of sockets) socket.destroy();
    await Promise.all([tls, authServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    await services.actors.shutdown(); services.store.states.clear(); services.store.receipts.clear(); services.store.directory.clear();
    sessions.clear(); flows.clear(); grants.clear();
  })();
  try {
    const roomPort = await bind(tls, options.roomPort ?? ROOM_ACCEPTANCE_PORT);
    roomOrigin = `https://${ROOM_ACCEPTANCE_HOST}:${roomPort}`;
    gateway = new RoomWebSocketGateway({
      allowedBrowserOrigins: [roomOrigin], authorize: async (request) => {
        const decision = await services.authority.authorize(request);
        observe({ kind: 'ws', outcome: decision.accepted ? 'accepted' : 'rejected' }); return generation.wrapAuthorization(decision);
      }, closeGraceMs: 50, shutdownGraceMs: 100,
    });
    websocketApp = createRoomWebSocketApp(gateway);
    const authPort = await bind(authServer, options.authPort ?? ROOM_ACCEPTANCE_AUTH_PORT);
    authOrigin = `http://127.0.0.1:${authPort}`;
    const runtime: RoomAcceptanceRuntime = {
      roomOrigin, authOrigin, roomAddress: { host: '127.0.0.1', port: roomPort }, authAddress: { host: '127.0.0.1', port: authPort }, close,
      armFault(operation) {
        if (!faults.includes(operation) || (operation === 'generationCancel' && !cancelEnabled) || (operation === 'generationStart' && !starter) || armed !== null || closing) throw new Error('ACCEPTANCE_FAULT_INVALID');
        armed = operation;
      },
      enableGenerationCancel: () => { cancelEnabled = true; },
      enableGenerationStart: () => { if (starter) throw new Error('ACCEPTANCE_ALREADY_ENABLED'); cancelEnabled = true; starter = newStarter(); },
      generation: async scenario => {
        if (ROOM_ACCEPTANCE_START_SCENARIOS.includes(scenario as RoomAcceptanceStartScenario)) { if (!starter) throw new Error('ACCEPTANCE_START_DISABLED'); starter.control(scenario as RoomAcceptanceStartScenario); return; }
        if (starter) throw new Error('ACCEPTANCE_USE_START_SCENARIOS');
        await generation.control(scenario as RoomAcceptanceGenerationScenario);
      },
      observations: () => ({ rooms: services.store.states.size, receipts: services.store.receipts.size,
        actors: services.actors.size, activeConnections: websocketServer.clients.size, authSessions: sessions.size, trace: structuredClone(trace), generation: { ...generation.observe(), ...(starter ? starter.observe() : {}) } }),
    };
    resetForSelfCheck.set(runtime, async () => {
      generation.dispose(); starter?.dispose();
      await services.actors.shutdown(); services = roomServices(); sessions.clear(); flows.clear(); grants.clear(); trace.length = 0; armed = null;
      generation = newGeneration(); if (starter) starter = newStarter();
    });
    return runtime;
  } catch (error) {
    await close();
    throw Object.assign(new Error('ACCEPTANCE_BIND_FAILED'), { code: roomMockFailureCode(error) });
  }
};

/** Fixed-destination request helper. Used only by local self-checks, never exposed over stdin. */
const probe = (runtime: RoomAcceptanceRuntime, pki: RoomAcceptancePki, endpoint: string, options: {
  auth?: boolean; body?: unknown; headers?: Record<string, string>; trusted?: boolean; hostname?: string;
} = {}): Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }> => new Promise((resolve, reject) => {
  const request = (options.auth ? httpRequest : httpsRequest)({
    host: '127.0.0.1', port: options.auth ? runtime.authAddress.port : runtime.roomAddress.port,
    ...(options.auth ? {} : { ca: options.trusted === false ? undefined : pki.ca, servername: options.hostname ?? ROOM_ACCEPTANCE_HOST }),
    path: endpoint, method: options.body === undefined ? 'GET' : 'POST',
    headers: { ...options.headers, ...(options.body === undefined ? {} : { 'content-type': typeof options.body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json' }) },
    timeout: 5000,
  }, (response) => {
    let body = ''; response.setEncoding('utf8');
    response.on('data', (chunk: string) => { body += chunk; if (Buffer.byteLength(body) > 2 * 1024 * 1024) request.destroy(new Error('ACCEPTANCE_PROBE_BOUND')); });
    response.once('end', () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
  });
  request.once('error', (error) => {
    const code = roomMockFailureCode(error);
    reject(new Error(code === 'UNKNOWN' ? 'ACCEPTANCE_PROBE_FAILED' : code));
  });
  request.once('timeout', () => request.destroy(new Error('ACCEPTANCE_PROBE_TIMEOUT')));
  request.end(options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
});

export const selfCheckRoomAcceptanceMock = async (runtime: RoomAcceptanceRuntime, pki: RoomAcceptancePki, cancelMode = false, startMode = false) => {
  const reset = resetForSelfCheck.get(runtime);
  if (!reset || runtime.observations().trace.length || runtime.observations().authSessions) throw new Error('ACCEPTANCE_SELFCHECK_NOT_PRISTINE');
  resetForSelfCheck.delete(runtime);
  const assert = (value: unknown) => { if (!value) throw new Error('ACCEPTANCE_SELFCHECK_FAILED'); };
  const openSockets: WebSocket[] = [];
  const generationMessages = new Map<WebSocket, RoomServerTransportMessage[]>();
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('ACCEPTANCE_SELFCHECK_FAILED');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    for (const negative of [{ trusted: false }, { hostname: 'wrong.acceptance.invalid' }]) {
      let rejected = false; try { await probe(runtime, pki, '/api/arena/rooms/v1', negative); } catch { rejected = true; } assert(rejected);
    }
    const login = async (userId: 101 | 202) => {
      const verifier = token(); const state = token();
      const query = new URLSearchParams({ state, code_challenge: digest(verifier), code_challenge_method: 'S256', redirect_uri: 'http://127.0.0.1:49152/callback' });
      const page = await probe(runtime, pki, `/auth/desktop?${query}`, { auth: true });
      const flow = /name="flow" value="([A-Za-z0-9_-]+)"/u.exec(page.body)?.[1]; assert(flow);
      const grant = await probe(runtime, pki, '/auth/desktop', { auth: true, body: new URLSearchParams({ flow: flow!, userId: String(userId) }).toString(), headers: { origin: runtime.authOrigin } });
      assert(grant.status === 303); const redirect = new URL(grant.headers.location!); assert(redirect.searchParams.get('state') === state);
      const exchangeBody = { protocolVersion: DESKTOP_AUTH_PROTOCOL_VERSION, code: redirect.searchParams.get('code'), codeVerifier: verifier };
      const exchange = await probe(runtime, pki, '/api/auth/native/exchange', { auth: true, body: exchangeBody });
      assert(exchange.status === 200 && JSON.parse(exchange.body).account.userId === userId);
      assert((await probe(runtime, pki, '/api/auth/native/exchange', { auth: true, body: exchangeBody })).status === 401);
      return exchange.headers['set-cookie']![0]!.split(';')[0]!;
    };
    const hostCookie = await login(101); const memberCookie = await login(202);
    const roomRequest = async (operation: DesktopRoomSessionOperation, userId: number, cookie: string, request?: unknown, roomId = '', proposalId = '', generationId = '', startingCancel = false) => {
      const definition = DESKTOP_ROOM_SESSION_OPERATIONS[operation];
      const response = await probe(runtime, pki, definition.path.replace(':roomId', encodeURIComponent(roomId)).replace(':proposalId', encodeURIComponent(proposalId)).replace(':generationId', encodeURIComponent(generationId)), {
        headers: { cookie, origin: runtime.roomOrigin, 'x-mahoshojo-desktop-room-protocol': DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, 'x-mahoshojo-room-expected-user-id': `v1:${userId}` },
        ...(definition.method === 'POST' ? { body: { desktopRoom: { version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, expectedUserId: userId, ...(operation === 'create' ? { createMode: 'new' } : {}), ...(startingCancel ? { cancelMode: 'starting-v1' } : {}) }, request } } : {}),
      });
      const parsed = parseDesktopRoomSessionResponse(operation, JSON.parse(response.body), userId);
      assert(response.status === (operation === 'create' ? 201 : operation === 'generationStart' ? 202 : 200) && 'result' in parsed); return JSON.parse(response.body).result;
    };
    const config = ArenaRoomSharedConfigSchema.parse({ battleMode: 'classic', combatants: [], teams: [], scenario: null, auxScenarios: [], materials: [], userGuidance: '', storyLength: 'standard', customStoryLength: null, selectedLanguage: 'zh-CN', historySettings: { readArenaHistory: true, readArenaHistoryLimit: 3, isArenaHistoryUnlimited: false, writeArenaHistory: true, readCurrentState: true, writeCurrentState: true, readNarrativeHistory: false, readNarrativeHistoryLimit: 10, isNarrativeHistoryUnlimited: false, writeNarrativeHistory: false } });
    const created = await roomRequest('create', 101, hostCookie, { creationRequestId: 'acceptance-self-check', displayName: 'Synthetic 101', directory: { title: 'Self check', visibility: 'public' }, sharedConfig: config });
    const configPath = DESKTOP_ROOM_SESSION_OPERATIONS.config.path.replace(':roomId', created.roomId);
    const configHeaders = { cookie: hostCookie, origin: runtime.roomOrigin, 'x-mahoshojo-desktop-room-protocol': DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, 'x-mahoshojo-room-expected-user-id': 'v1:101' };
    const target = { ...created.snapshot.sharedConfig, userGuidance: 'Synthetic config acceptance' };
    const configRequest = { expectedRoomEpoch: created.roomEpoch, expectedRevision: created.snapshot.revision,
      expectedControlSeq: created.snapshot.controlSeq, sharedConfig: target };
    runtime.armFault('config-unsupported');
    const unsupported = await probe(runtime, pki, configPath, { headers: configHeaders,
      body: { desktopRoom: { version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, expectedUserId: 101 }, request: configRequest } });
    const rejection = parseDesktopRoomSessionResponse('config', JSON.parse(unsupported.body), 101);
    assert(unsupported.status === 400 && 'error' in rejection && rejection.error.code === 'ROOM_DESKTOP_OPERATION_UNSUPPORTED'
      && rejection.error.outcome === 'not-applied' && rejection.desktopRoom.viewerUserId === null);
    assert(same((await roomRequest('session', 101, hostCookie, undefined, created.roomId)).snapshot, created.snapshot));
    runtime.armFault('config');
    let dropped = false;
    try { await roomRequest('config', 101, hostCookie, configRequest, created.roomId); }
    catch { dropped = true; }
    const observed = await roomRequest('session', 101, hostCookie, undefined, created.roomId);
    assert(dropped && observed.snapshot.revision === created.snapshot.revision + 1
      && observed.snapshot.controlSeq === created.snapshot.controlSeq + 1 && same(observed.snapshot.sharedConfig, target));
    assert(same(runtime.observations().trace.filter(entry => entry.kind === 'room-http' && entry.operation === 'config'), [
      { kind: 'room-http', operation: 'config', status: 400, dropped: false },
      { kind: 'room-http', operation: 'config', status: 200, dropped: true },
    ]));
    await roomRequest('discover', 101, hostCookie);
    await roomRequest('join', 202, memberCookie, { displayName: 'Synthetic 202' }, created.roomId);
    await roomRequest('session', 202, memberCookie, undefined, created.roomId);
    const connect = async (userId: number, cookie: string) => {
      const issued = await roomRequest('ticket', userId, cookie, {}, created.roomId);
      const current = await roomRequest('session', userId, cookie, undefined, created.roomId);
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`wss://${ROOM_ACCEPTANCE_HOST}:${runtime.roomAddress.port}${ARENA_ROOM_WEBSOCKET_PATH}?ticket=${encodeURIComponent(issued.ticket)}`,
          [ARENA_ROOM_PRESENCE_WEBSOCKET_PROTOCOL],
          { ca: pki.ca, origin: runtime.roomOrigin, lookup: (_hostname, options, callback) => options.all
            ? callback(null, [{ address: '127.0.0.1', family: 4 }])
            : callback(null, '127.0.0.1', 4), handshakeTimeout: 5000 });
        openSockets.push(socket);
        const messages: RoomServerTransportMessage[] = []; generationMessages.set(socket, messages);
        const timeout = setTimeout(() => reject(new Error('ACCEPTANCE_SELFCHECK_WS')), 5000);
        socket.once('error', () => { clearTimeout(timeout); reject(new Error('ACCEPTANCE_SELFCHECK_WS')); });
        let snapshot = false; let presence = false;
        socket.on('message', (data) => {
          const message = JSON.parse(data.toString());
          messages.push(message as RoomServerTransportMessage);
          if (message.type === 'room.snapshot') snapshot = message.payload.members.some((member: { userId: string }) => member.userId === current.self.userId);
          if (message.type === 'room.presence') presence = message.onlineUserIds.includes(current.self.userId);
          if (snapshot && presence) { clearTimeout(timeout); resolve(); }
        });
      });
      return openSockets.at(-1)!;
    };
    await connect(101, hostCookie); await connect(202, memberCookie);
    const random = await probe(runtime, pki, '/api/random-public-card?type=character', { auth: true });
    const fresh = await probe(runtime, pki, `/api/public-data-cards?id=${ROOM_ACCEPTANCE_PUBLIC_CHARACTER.id}`, { auth: true });
    assert(random.status === 200 && fresh.status === 200 && same(JSON.parse(random.body), JSON.parse(fresh.body))
      && same(JSON.parse(fresh.body), { success: true, card: ROOM_ACCEPTANCE_PUBLIC_CHARACTER }));
    const beforeProposal = await roomRequest('session', 202, memberCookie, undefined, created.roomId);
    const proposal = {
      proposalId: 'self-check-提案', expectedRoomEpoch: created.roomEpoch, baseRevision: beforeProposal.snapshot.revision,
      changes: [{ type: 'addCombatant', changeId: 'add-character',
        ref: { id: ROOM_ACCEPTANCE_PUBLIC_CHARACTER.id, kind: 'character', versionToken: 'older-observation-not-a-CAS-fence' },
        expectedBase: { kind: 'absent' } }],
    };
    runtime.armFault('proposal-unsupported');
    const unsupportedProposal = await probe(runtime, pki, DESKTOP_ROOM_SESSION_OPERATIONS.proposalSubmit.path.replace(':roomId', created.roomId), {
      headers: { ...configHeaders, cookie: memberCookie, 'x-mahoshojo-room-expected-user-id': 'v1:202' },
      body: { desktopRoom: { version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, expectedUserId: 202 }, request: proposal },
    });
    const unsupportedProposalBody = parseDesktopRoomSessionResponse('proposalSubmit', JSON.parse(unsupportedProposal.body), 202);
    assert(unsupportedProposal.status === 400 && 'error' in unsupportedProposalBody
      && unsupportedProposalBody.error.code === 'ROOM_DESKTOP_OPERATION_UNSUPPORTED'
      && unsupportedProposalBody.error.outcome === 'not-applied'
      && same((await roomRequest('session', 202, memberCookie, undefined, created.roomId)).snapshot, beforeProposal.snapshot));
    runtime.armFault('proposalSubmit');
    let proposalDropped = false;
    try { await roomRequest('proposalSubmit', 202, memberCookie, proposal, created.roomId); }
    catch { proposalDropped = true; }
    const submitted = await roomRequest('session', 202, memberCookie, undefined, created.roomId);
    assert(proposalDropped && submitted.snapshot.proposals.length === 1
      && submitted.snapshot.proposals[0].proposalId === proposal.proposalId
      && submitted.snapshot.revision === beforeProposal.snapshot.revision);
    const withdrawn = await roomRequest('proposalWithdraw', 202, memberCookie,
      { expectedRoomEpoch: created.roomEpoch }, created.roomId, proposal.proposalId);
    assert(withdrawn.status === 'withdrawn' && !('snapshot' in withdrawn) && !('sharedConfig' in withdrawn));
    const nextProposal = { ...proposal, proposalId: 'self-check-resolve' };
    const submission = await roomRequest('proposalSubmit', 202, memberCookie, nextProposal, created.roomId);
    assert(submission.status === 'submitted' && !('snapshot' in submission) && !('sharedConfig' in submission));
    const resolved = await roomRequest('proposalResolve', 101, hostCookie,
      { expectedRoomEpoch: created.roomEpoch, resolution: 'accept-selected', selectedChangeIds: ['add-character'] }, created.roomId, nextProposal.proposalId);
    const afterResolve = await roomRequest('session', 101, hostCookie, undefined, created.roomId);
    assert(resolved.status === 'accepted' && same(resolved.snapshot, afterResolve.snapshot)
      && same(resolved.sharedConfig, afterResolve.snapshot.sharedConfig)
      && resolved.snapshot.sharedConfig.combatants[0].ref.id === ROOM_ACCEPTANCE_PUBLIC_CHARACTER.id);
    assert(same(runtime.observations().trace.filter(entry => entry.kind === 'room-http' && entry.operation === 'proposalSubmit'), [
      { kind: 'room-http', operation: 'proposalSubmit', status: 400, dropped: false },
      { kind: 'room-http', operation: 'proposalSubmit', status: 200, dropped: true },
      { kind: 'room-http', operation: 'proposalSubmit', status: 200, dropped: false },
    ]));
    await runtime.generation('seed-large');
    const seeded = await roomRequest('session', 101, hostCookie, undefined, created.roomId);
    const generationId = seeded.snapshot.activeGeneration.generationId;
    const read = () => roomRequest('generationRead', 101, hostCookie, undefined, created.roomId, '', generationId);
    const baseline = await read();
    assert(baseline.status === 'running' && !baseline.finalAuthoritative
      && Buffer.byteLength(baseline.markdown) === ROOM_ACCEPTANCE_GENERATION_LARGE_BYTES
      && baseline.markdown.endsWith(ROOM_ACCEPTANCE_GENERATION_TAIL));
    const generationPath = DESKTOP_ROOM_SESSION_OPERATIONS.generationRead.path.replace(':roomId', created.roomId).replace(':generationId', generationId);
    const beforeOwner = runtime.observations().generation.readDispatches;
    assert((await probe(runtime, pki, generationPath, { headers: { ...configHeaders, 'x-mahoshojo-room-expected-user-id': 'v1:202' } })).status === 409);
    assert(runtime.observations().generation.readDispatches === beforeOwner);
    await runtime.generation('delta'); await runtime.generation('gap');
    await until(() => [...generationMessages.values()].every(messages => messages.some(message => message.type === 'story.delta' && message.chunkSeq === 2)));
    for (const messages of generationMessages.values()) {
      assert(same(messages.flatMap(message => message.type === 'story.delta' ? [message.chunkSeq] : []), [0, 2]));
    }
    const repaired = await read();
    assert(repaired.nextChunkSeq === 3 && repaired.markdown.includes('受控缺口（仅传输丢帧）') && !repaired.finalAuthoritative);
    await runtime.generation('disconnect');
    await until(() => openSockets.every(socket => socket.readyState === WebSocket.CLOSED));
    const reconnected = await connect(101, hostCookie);
    assert((await read()).markdown === repaired.markdown);
    await runtime.generation('hold-read');
    const pendingRead = read();
    await until(() => runtime.observations().generation.readHeld);
    await runtime.generation('complete');
    await until(() => generationMessages.get(reconnected)!.some(message => message.type === 'generation.completed'));
    await runtime.generation('release-read');
    const late = await pendingRead;
    assert(late.status === 'running' && !late.finalAuthoritative && late.generation.generationId === generationId);
    const final = await read();
    assert(final.finalAuthoritative && final.status === 'completed' && final.result.format === 'stream-markdown'
      && final.markdown === repaired.markdown && final.generationRecordId);
    for (const endpoint of [`/api/arena/rooms/v1/${created.roomId}/generations`, `${generationPath}/cancel`, '/api/arena/generate-stream']) {
      assert((await probe(runtime, pki, endpoint, { headers: configHeaders, body: {} })).status === 404);
    }
    for (const endpoint of [`/api/arena/rooms/v1/${created.roomId}/generations`, `${generationPath}/history`, `${generationPath}?view=history`, `${generationPath}?view=current`]) {
      assert((await probe(runtime, pki, endpoint, { headers: configHeaders })).status === 404);
    }
    const generation = runtime.observations().generation;
    assert(generation.fixture === 'completed' && !generation.readHeld && generation.readDispatches >= 5
      && generation.deltaFrames === 3 && generation.droppedFrames === 2 && generation.disconnections === 2
      && generation.startRequests === 1 && generation.cancelRequests === 1 && generation.modelRequests === 1
      && generation.startDispatches === 0 && generation.cancelDispatches === 0 && generation.modelDispatches === 0);
    if (cancelMode && !startMode) {
      runtime.enableGenerationCancel();
      await runtime.generation('seed-large');
      const current = await roomRequest('session', 101, hostCookie, undefined, created.roomId);
      const target = current.snapshot.activeGeneration.generationId;
      await runtime.generation('cancel-wait');
      const receipt = await roomRequest('generationCancel', 101, hostCookie, { expectedRoomEpoch: created.roomEpoch }, created.roomId, '', target);
      assert(receipt.status === 'running' && !('markdown' in receipt) && !('result' in receipt));
      assert(Buffer.byteLength(JSON.stringify(receipt)) < 256 * 1024);
      assert((await roomRequest('generationRead', 101, hostCookie, undefined, created.roomId, '', target)).status === 'running');
      await runtime.generation('cancel-complete');
      assert((await roomRequest('generationRead', 101, hostCookie, undefined, created.roomId, '', target)).status === 'cancelled');
      await runtime.generation('seed');
      const next = await roomRequest('session', 101, hostCookie, undefined, created.roomId);
      runtime.armFault('generationCancel');
      const cancelPath = DESKTOP_ROOM_SESSION_OPERATIONS.generationCancel.path.replace(':roomId', created.roomId).replace(':generationId', next.snapshot.activeGeneration.generationId);
      let lost = false;
      try { await probe(runtime, pki, cancelPath, { headers: configHeaders, body: { desktopRoom: { version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, expectedUserId: 101 }, request: { expectedRoomEpoch: created.roomEpoch } } }); } catch { lost = true; }
      assert(lost);
      assert((await roomRequest('generationRead', 101, hostCookie, undefined, created.roomId, '', next.snapshot.activeGeneration.generationId)).status === 'cancelled');
      const observed = runtime.observations().generation;
      assert(observed.cancelEnabled && observed.cancelDispatches === 2 && observed.startDispatches === 0 && observed.modelDispatches === 0);
    }
    if (startMode) {
      runtime.enableGenerationStart();
      const before = await roomRequest('session', 101, hostCookie, undefined, created.roomId);
      // A genuine host-local payload crosses the Desktop envelope and real materializer.
      // This body is larger than the old 64 KiB request lane, but contains no account/model data.
      const payload = { content: '完整合成本机正文🌙'.repeat(6000), name: 'Synthetic local character', templateId: '通用角色' };
      const contentVersion = `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
      const localKey = 'host-local:character:acceptance-start';
      await roomRequest('config', 101, hostCookie, { expectedRoomEpoch: created.roomEpoch, expectedRevision: before.snapshot.revision,
        expectedControlSeq: before.snapshot.controlSeq, sharedConfig: { ...before.snapshot.sharedConfig, battleMode: 'daily', teams: [],
          combatants: [{ key: localKey, source: 'host-local', type: 'general-character', displayName: payload.name, contentVersion }] } }, created.roomId);
      const ready = await roomRequest('session', 101, hostCookie, undefined, created.roomId);
      const original = { expectedRoomEpoch: created.roomEpoch, expectedRevision: ready.snapshot.revision, expectedControlSeq: ready.snapshot.controlSeq,
        generationRequestId: 'synthetic-start-reservation-1', sharedConfig: ready.snapshot.sharedConfig,
        hostLocalPayloads: [{ key: localKey, kind: 'character', payload }], generation: {} };
      const invalidPayloads = [[], [{ ...original.hostLocalPayloads[0]!, key: 'host-local:wrong' }],
        [...original.hostLocalPayloads, { ...original.hostLocalPayloads[0]!, key: 'host-local:extra' }],
        [{ ...original.hostLocalPayloads[0]!, kind: 'scenario' }],
        [{ ...original.hostLocalPayloads[0]!, payload: { ...payload, content: 'changed after freeze' } }]];
      for (let index = 0; index < invalidPayloads.length; index += 1) {
        let refused = false;
        try { await roomRequest('generationStart', 101, hostCookie, { ...original, generationRequestId: `invalid-local-${index}`, hostLocalPayloads: invalidPayloads[index] }, created.roomId); } catch { refused = true; }
        assert(refused && runtime.observations().generation.startReservations === 0 && runtime.observations().generation.syntheticProducers === 0);
      }
      await runtime.generation('start-reserve-only');
      let reservationOnly = false;
      try { await roomRequest('generationStart', 101, hostCookie, original, created.roomId); } catch { reservationOnly = true; }
      const reserved = await roomRequest('session', 101, hostCookie, undefined, created.roomId);
      assert(reservationOnly && reserved.snapshot.activeGeneration.state === 'starting'
        && reserved.snapshot.activeGeneration.generationRequestId === original.generationRequestId
        && runtime.observations().generation.syntheticProducers === 0);
      const target = reserved.snapshot.activeGeneration.generationId;
      const missingPath = DESKTOP_ROOM_SESSION_OPERATIONS.generationRead.path.replace(':roomId', created.roomId).replace(':generationId', target);
      const missing = await probe(runtime, pki, missingPath, { headers: configHeaders });
      assert(missing.status === 404 && JSON.parse(missing.body).error.code === 'ROOM_NOT_FOUND');
      await runtime.generation('start-unavailable');
      let unavailable = false;
      try { await roomRequest('generationStart', 101, hostCookie, original, created.roomId); } catch { unavailable = true; }
      assert(unavailable && runtime.observations().generation.syntheticProducers === 0);
      await runtime.generation('start-available'); await runtime.generation('start-large');
      runtime.armFault('generationStart');
      let lost = false;
      try { await roomRequest('generationStart', 101, hostCookie, original, created.roomId); } catch { lost = true; }
      assert(lost);
      const retry = await roomRequest('generationStart', 101, hostCookie, original, created.roomId);
      assert(retry.generation.generationId === target && !('markdown' in retry) && !('result' in retry));
      assert(runtime.observations().generation.syntheticProducers === 1 && runtime.observations().generation.startPortCalls === 2);
      await runtime.generation('start-delta');
      await until(() => [...generationMessages.values()].some(messages => messages.some(message => message.type === 'story.delta' && message.generationId === target)));
      await runtime.generation('start-complete');
      await until(() => [...generationMessages.values()].some(messages => messages.some(message => message.type === 'generation.completed' && message.payload.generationId === target)));
      const finalStart = await roomRequest('generationRead', 101, hostCookie, undefined, created.roomId, '', target);
      assert(finalStart.finalAuthoritative && Buffer.byteLength(finalStart.markdown) > ROOM_ACCEPTANCE_GENERATION_LARGE_BYTES);
      const repeat = await roomRequest('generationStart', 101, hostCookie, original, created.roomId);
      assert(repeat.status === 'completed' && !('markdown' in repeat) && runtime.observations().generation.syntheticProducers === 1);
      const next = await roomRequest('session', 101, hostCookie, undefined, created.roomId);
      const second = { ...original, generationRequestId: 'synthetic-start-cancel-2', expectedControlSeq: next.snapshot.controlSeq };
      const started = await roomRequest('generationStart', 101, hostCookie, second, created.roomId);
      await roomRequest('generationCancel', 101, hostCookie, { expectedRoomEpoch: created.roomEpoch }, created.roomId, '', started.generation.generationId);
      const stopped = await roomRequest('generationRead', 101, hostCookie, undefined, created.roomId, '', started.generation.generationId);
      assert(stopped.status === 'cancelled' && runtime.observations().generation.modelDispatches === 0);
      const afterCancel = await roomRequest('session', 101, hostCookie, undefined, created.roomId);
      const byok = { ...original, generationRequestId: 'synthetic-catalog-byok', expectedRevision: afterCancel.snapshot.revision,
        expectedControlSeq: afterCancel.snapshot.controlSeq, generation: { customProvider: { providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: ROOM_ACCEPTANCE_BYOK_KEY, generationOverrides: { temperature: 0.5 } } } };
      runtime.armFault('generationStart');
      let byokLost = false; try { await roomRequest('generationStart', 101, hostCookie, byok, created.roomId); } catch { byokLost = true; }
      assert(byokLost);
      const byokReceipt = await roomRequest('generationStart', 101, hostCookie, byok, created.roomId);
      assert(byokReceipt.generation.generationRequestId === byok.generationRequestId && runtime.observations().generation.byokStartPortCalls === 1
        && runtime.observations().generation.syntheticProducers === 3);
      const byokSession = await roomRequest('session', 101, hostCookie, undefined, created.roomId);
      assert(!JSON.stringify([byokReceipt, byokSession, runtime.observations()]).includes(ROOM_ACCEPTANCE_BYOK_KEY));
      await runtime.generation('start-complete');
      const byokReport = await roomRequest('generationRead', 101, hostCookie, undefined, created.roomId, '', byokReceipt.generation.generationId);
      assert(byokReport.status === 'completed' && !JSON.stringify(byokReport).includes(ROOM_ACCEPTANCE_BYOK_KEY));
      // Only the explicit start acceptance mode enables this synthetic reservation scenario.
      // No start re-POST follows cancellation; a GET completes the held cancellation projection.
      for (const lostReceipt of [false, true]) {
        const previous = await roomRequest('session', 101, hostCookie, undefined, created.roomId);
        const request = { ...original, generationRequestId: `synthetic-starting-cancel-${lostReceipt ? 'lost' : 'pending'}`,
          expectedRevision: previous.snapshot.revision, expectedControlSeq: previous.snapshot.controlSeq };
        const counts = runtime.observations().generation;
        await runtime.generation('start-reserve-only-gated');
        let reservedOnly = false;
        try { await roomRequest('generationStart', 101, hostCookie, request, created.roomId); } catch { reservedOnly = true; }
        const current = await roomRequest('session', 101, hostCookie, undefined, created.roomId);
        const mirror = current.snapshot.activeGeneration;
        assert(reservedOnly && mirror.state === 'starting' && mirror.generationRequestId === request.generationRequestId);
        const expectedGeneration = Object.fromEntries(Object.entries(mirror).filter(([key]) => !['state', 'startedAt', 'finishedAt'].includes(key)));
        await runtime.generation('start-disable-starting-cancel');
        if (lostReceipt) runtime.armFault('generationCancel'); else await runtime.generation('start-cancel-wait');
        let unknown = false;
        try { await roomRequest('generationCancel', 101, hostCookie, { expectedRoomEpoch: created.roomEpoch, expectedGeneration }, created.roomId, '', mirror.generationId, true); } catch { unknown = true; }
        assert(unknown);
        if (!lostReceipt) await runtime.generation('start-cancel-complete');
        const cancelled = await roomRequest('generationRead', 101, hostCookie, undefined, created.roomId, '', mirror.generationId);
        const observed = runtime.observations().generation;
        assert(cancelled.status === 'cancelled' && cancelled.generation.state === 'cancelled'
          && observed.startDispatches === counts.startDispatches! + 1 && observed.cancelDispatches === counts.cancelDispatches! + 1
          && observed.syntheticProducers === counts.syntheticProducers && observed.modelDispatches === 0);
      }
    }
    await roomRequest('leave', 202, memberCookie, { expectedRoomEpoch: created.roomEpoch }, created.roomId);
    await roomRequest('close', 101, hostCookie, { expectedRoomEpoch: created.roomEpoch }, created.roomId);
    assert((await roomRequest('discover', 101, hostCookie)).items.length === 0);
    return { tlsTrusted: true, tlsNoRootRejected: true, tlsWrongSanRejected: true, authPkceOneUse: true,
      roomHttp: true, roomWss: true, roomProposals: true, proposalReceiptLoss: true, fixedPublicRefs: true,
      roomGenerationRead: true, roomGenerationRecovery: true, generationReadOnly: !cancelMode && !startMode, ...((cancelMode || startMode) ? { generationCancel: true } : {}), ...(startMode ? { generationStart: true, generationStartingCancel: true, syntheticProducer: true } : {}) } as const;
  } finally {
    await Promise.all(openSockets.map((socket) => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
      socket.once('close', () => resolve()); socket.terminate();
    })));
    await reset();
  }
};

let startupStage = 'validate-args';
const main = async () => {
  const args = process.argv.slice(2);
  const selfCheck = args[0] === '--self-check'; if (selfCheck) args.shift();
  const startMode = args[0] === '--synthetic-start'; if (startMode) args.shift();
  const cancelMode = args[0] === '--synthetic-cancel'; if (cancelMode) args.shift();
  if (args.length !== 2 || args[0] !== '--state-root' || !path.isAbsolute(args[1]!)) throw new Error('ACCEPTANCE_ARGUMENT_INVALID');
  // State root identifies the enclosing isolated run. Credentials never persist here.
  startupStage = 'load-fixture';
  const pki = JSON.parse(await readFile(new URL('../../../scripts/fixtures/desktop-room-acceptance-pki.json', import.meta.url), 'utf8')) as RoomAcceptancePki;
  startupStage = 'listen';
  const runtime = await startRoomAcceptanceMock({ pki });
  const emit = (value: unknown) => {
    if (process.stdout.writableLength > 128 * 1024) throw new Error('ACCEPTANCE_OUTPUT_BOUND');
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  const stop = async () => { await runtime.close(); process.stdin.pause(); };
  try {
    startupStage = 'self-check';
    const summary = await selfCheckRoomAcceptanceMock(runtime, pki, cancelMode, startMode);
    startupStage = 'ready-output';
    if (selfCheck) { emit({ event: 'self-check', roomOrigin: runtime.roomOrigin, authOrigin: runtime.authOrigin, selfCheck: summary }); startupStage = 'cleanup'; await stop(); return; }
    emit({ event: 'ready', roomOrigin: runtime.roomOrigin, authOrigin: runtime.authOrigin, roomAddress: runtime.roomAddress, selfCheck: summary });
    startupStage = 'control';
    let pending = ''; let chain = Promise.resolve(); let stopped = false; let queued = 0;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      pending += chunk;
      if (pending.length > 4096) { stopped = true; void stop(); return; }
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (++queued > 16) { stopped = true; void stop(); return; }
        chain = chain.then(async () => {
          if (stopped) return;
          let id: number | null = null;
          try {
            const value = JSON.parse(line) as Record<string, unknown>;
            if (!Number.isSafeInteger(value.id) || Number(value.id) < 1) throw new Error('invalid'); id = Number(value.id);
            const keys = Object.keys(value).sort().join('|');
            if (value.command === 'arm-fault' && keys === 'command|id|operation') {
              runtime.armFault(value.operation as RoomAcceptanceFault); emit({ id, event: 'armed', operation: value.operation });
            } else if (value.command === 'generation' && keys === 'command|id|scenario') {
              await runtime.generation(value.scenario as RoomAcceptanceGenerationScenario | RoomAcceptanceStartScenario); emit({ id, event: 'generation', scenario: value.scenario });
            } else if (value.command === 'observe' && keys === 'command|id') emit({ id, event: 'observations', ...runtime.observations() });
            else if (value.command === 'stop' && keys === 'command|id') { stopped = true; await stop(); emit({ id, event: 'stopped' }); }
            else throw new Error('invalid');
          } catch { emit({ id, event: 'error', code: 'ACCEPTANCE_CONTROL_REFUSED' }); }
        }).catch(async (error) => {
          process.stderr.write(formatRoomMockDiagnostic('control', error));
          stopped = true; process.exitCode = 1; await stop();
        })
          .finally(() => { queued -= 1; });
      }
    });
    process.stdin.once('end', () => { void chain.then(stop); });
    process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
  } catch (error) { await stop(); throw error; }
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => { process.stderr.write(formatRoomMockDiagnostic(startupStage, error)); process.exitCode = 1; });
}
