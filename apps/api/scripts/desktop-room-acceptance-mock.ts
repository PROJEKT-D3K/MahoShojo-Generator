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
import {
  ARENA_ROOM_PRESENCE_WEBSOCKET_PROTOCOL,
  ArenaRoomSharedConfigSchema,
} from '@mahoshojo/contracts/arena-room';
import {
  DESKTOP_ROOM_SESSION_OPERATIONS, DESKTOP_ROOM_SESSION_PROTOCOL_VERSION,
  DesktopRoomSessionExpectedUserIdHeaderSchema, DesktopRoomSessionErrorResponseSchema, parseDesktopRoomSessionResponse,
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

// This Native acceptance harness only exposes capabilities already implemented by its consumer.
export const ROOM_ACCEPTANCE_OPERATIONS = ['discover', 'create', 'join', 'session', 'ticket', 'leave', 'close', 'config'] as const satisfies readonly DesktopRoomSessionOperation[];
export const ROOM_ACCEPTANCE_HOST = 'room.acceptance.invalid';
export const ROOM_ACCEPTANCE_PORT = 34443;
export const ROOM_ACCEPTANCE_AUTH_PORT = 34080;
const CAPACITY = 64;
const TRACE_CAPACITY = 256;
const COOKIE = 'better-auth.session_token';
const account = (userId: 101 | 202) => ({ userId, username: `acceptance-${userId}`, displayName: `Synthetic ${userId}` });
const token = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const unavailable = (): never => { throw new Error('ACCEPTANCE_UNSUPPORTED'); };
export type RoomAcceptancePki = { ca: string; cert: string; key: string };
export type RoomAcceptanceFault = 'create' | 'join' | 'leave' | 'close' | 'config' | 'config-unsupported';
const faults: readonly string[] = ['create', 'join', 'leave', 'close', 'config', 'config-unsupported'];
export type RoomAcceptanceObservation =
  | { kind: 'room-http'; operation: DesktopRoomSessionOperation; status: number; dropped: boolean }
  | { kind: 'ws'; outcome: 'accepted' | 'rejected' }
  | { kind: 'refused' };
export type RoomAcceptanceRuntime = {
  roomOrigin: string;
  authOrigin: string;
  roomAddress: { host: '127.0.0.1'; port: number };
  authAddress: { host: '127.0.0.1'; port: number };
  close(): Promise<void>;
  armFault(operation: RoomAcceptanceFault): void;
  observations(): { rooms: number; receipts: number; actors: number; activeConnections: number; authSessions: number; trace: RoomAcceptanceObservation[] };
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

const roomServices = () => {
  const store = new MemoryRoomStore();
  const actors = createRoomActorRegistry({ store, maxActors: CAPACITY, maxFencedRooms: CAPACITY });
  actors.startIdleSweeper();
  // No content resolver or generation capability is installed in this local scope.
  const memberships = createArenaRoomMembershipService({ actors, creationReceipts: store });
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
  const configs = createArenaRoomConfigService({ memberships });
  return { store, actors, memberships, directory, authority, configs };
};

const operationFor = (request: Request): DesktopRoomSessionOperation | null => {
  const pathname = new URL(request.url).pathname;
  for (const operation of ROOM_ACCEPTANCE_OPERATIONS) {
    const definition = DESKTOP_ROOM_SESSION_OPERATIONS[operation];
    const pattern = new RegExp(`^${definition.path.replace(':roomId', '[A-Za-z0-9._:-]{1,256}')}$`, 'u');
    if (request.method === definition.method && pattern.test(pathname)) return operation as DesktopRoomSessionOperation;
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
  http.use('*', bodyLimit({ maxSize: 65 * 1024 }));
  http.use('*', async (context, next) => {
    context.header('cache-control', 'no-store');
    if (operationFor(context.req.raw) === null
      || context.req.header('x-mahoshojo-desktop-room-protocol') !== DESKTOP_ROOM_SESSION_PROTOCOL_VERSION) {
      observe({ kind: 'refused' }); return context.json({ code: 'ACCEPTANCE_ROUTE_REFUSED' }, 404);
    }
    // Test service only: mirror the older adapter's pre-auth operation rejection.
    // Invalid owner headers retain the real adapter's protocol error and do not consume this fault.
    if (armed === 'config-unsupported' && operationFor(context.req.raw) === 'config'
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
    proposals: { submit: async () => unavailable(), resolve: async () => unavailable(), withdraw: async () => unavailable() },
    generations: { start: async () => unavailable(), read: async () => unavailable(), list: async () => unavailable(), readHistory: async () => unavailable(), cancel: async () => unavailable() },
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
      if (operation !== null && result instanceof Response) {
        const dropped = result.ok && armed === operation;
        observe({ kind: 'room-http', operation, status: result.status, dropped });
        if (dropped) { armed = null; env.outgoing.destroy(); }
      }
      return result;
    },
  }) as Server;
  const auth = new Hono();
  auth.onError(() => Response.json({ error: 'Acceptance request failed' }, { status: 503 }));
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
        observe({ kind: 'ws', outcome: decision.accepted ? 'accepted' : 'rejected' }); return decision;
      }, closeGraceMs: 50, shutdownGraceMs: 100,
    });
    websocketApp = createRoomWebSocketApp(gateway);
    const authPort = await bind(authServer, options.authPort ?? ROOM_ACCEPTANCE_AUTH_PORT);
    authOrigin = `http://127.0.0.1:${authPort}`;
    const runtime: RoomAcceptanceRuntime = {
      roomOrigin, authOrigin, roomAddress: { host: '127.0.0.1', port: roomPort }, authAddress: { host: '127.0.0.1', port: authPort }, close,
      armFault(operation) {
        if (!faults.includes(operation) || armed !== null || closing) throw new Error('ACCEPTANCE_FAULT_INVALID');
        armed = operation;
      },
      observations: () => ({ rooms: services.store.states.size, receipts: services.store.receipts.size,
        actors: services.actors.size, activeConnections: websocketServer.clients.size, authSessions: sessions.size, trace: structuredClone(trace) }),
    };
    resetForSelfCheck.set(runtime, async () => {
      await services.actors.shutdown(); services = roomServices(); sessions.clear(); flows.clear(); grants.clear(); trace.length = 0; armed = null;
    });
    return runtime;
  } catch { await close(); throw new Error('ACCEPTANCE_BIND_FAILED'); }
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
    let body = '';
    response.on('data', (chunk: Buffer) => { body += chunk.toString(); if (body.length > 300_000) request.destroy(new Error('ACCEPTANCE_PROBE_BOUND')); });
    response.once('end', () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
  });
  request.once('error', () => reject(new Error('ACCEPTANCE_PROBE_FAILED')));
  request.once('timeout', () => request.destroy(new Error('ACCEPTANCE_PROBE_TIMEOUT')));
  request.end(options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
});

export const selfCheckRoomAcceptanceMock = async (runtime: RoomAcceptanceRuntime, pki: RoomAcceptancePki) => {
  const reset = resetForSelfCheck.get(runtime);
  if (!reset || runtime.observations().trace.length || runtime.observations().authSessions) throw new Error('ACCEPTANCE_SELFCHECK_NOT_PRISTINE');
  resetForSelfCheck.delete(runtime);
  const assert = (value: unknown) => { if (!value) throw new Error('ACCEPTANCE_SELFCHECK_FAILED'); };
  const openSockets: WebSocket[] = [];
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
    const roomRequest = async (operation: DesktopRoomSessionOperation, userId: number, cookie: string, request?: unknown, roomId = '') => {
      const definition = DESKTOP_ROOM_SESSION_OPERATIONS[operation];
      const response = await probe(runtime, pki, definition.path.replace(':roomId', roomId), {
        headers: { cookie, origin: runtime.roomOrigin, 'x-mahoshojo-desktop-room-protocol': DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, 'x-mahoshojo-room-expected-user-id': `v1:${userId}` },
        ...(definition.method === 'POST' ? { body: { desktopRoom: { version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, expectedUserId: userId, ...(operation === 'create' ? { createMode: 'new' } : {}) }, request } } : {}),
      });
      const parsed = parseDesktopRoomSessionResponse(operation, JSON.parse(response.body), userId);
      assert(response.status === (operation === 'create' ? 201 : 200) && 'result' in parsed); return JSON.parse(response.body).result;
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
    for (const [userId, cookie] of [[101, hostCookie], [202, memberCookie]] as const) {
      const issued = await roomRequest('ticket', userId, cookie, {}, created.roomId);
      const current = await roomRequest('session', userId, cookie, undefined, created.roomId);
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`wss://${ROOM_ACCEPTANCE_HOST}:${runtime.roomAddress.port}${ARENA_ROOM_WEBSOCKET_PATH}?ticket=${encodeURIComponent(issued.ticket)}`,
          [ARENA_ROOM_PRESENCE_WEBSOCKET_PROTOCOL],
          { ca: pki.ca, origin: runtime.roomOrigin, lookup: (_hostname, options, callback) => options.all
            ? callback(null, [{ address: '127.0.0.1', family: 4 }])
            : callback(null, '127.0.0.1', 4), handshakeTimeout: 5000 });
        openSockets.push(socket);
        const timeout = setTimeout(() => reject(new Error('ACCEPTANCE_SELFCHECK_WS')), 5000);
        socket.once('error', () => { clearTimeout(timeout); reject(new Error('ACCEPTANCE_SELFCHECK_WS')); });
        let snapshot = false; let presence = false;
        socket.on('message', (data) => {
          const message = JSON.parse(data.toString());
          if (message.type === 'room.snapshot') snapshot = message.payload.members.some((member: { userId: string }) => member.userId === current.self.userId);
          if (message.type === 'room.presence') presence = message.onlineUserIds.includes(current.self.userId);
          if (snapshot && presence) { clearTimeout(timeout); resolve(); }
        });
      });
    }
    await roomRequest('leave', 202, memberCookie, { expectedRoomEpoch: created.roomEpoch }, created.roomId);
    await roomRequest('close', 101, hostCookie, { expectedRoomEpoch: created.roomEpoch }, created.roomId);
    assert((await roomRequest('discover', 101, hostCookie)).items.length === 0);
    return { tlsTrusted: true, tlsNoRootRejected: true, tlsWrongSanRejected: true, authPkceOneUse: true, roomHttp: true, roomWss: true } as const;
  } finally {
    await Promise.all(openSockets.map((socket) => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
      socket.once('close', () => resolve()); socket.terminate();
    })));
    await reset();
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  const selfCheck = args[0] === '--self-check'; if (selfCheck) args.shift();
  if (args.length !== 2 || args[0] !== '--state-root' || !path.isAbsolute(args[1]!)) throw new Error('ACCEPTANCE_ARGUMENT_INVALID');
  // State root identifies the enclosing isolated run. Credentials never persist here.
  const pki = JSON.parse(await readFile(new URL('../../../scripts/fixtures/desktop-room-acceptance-pki.json', import.meta.url), 'utf8')) as RoomAcceptancePki;
  const runtime = await startRoomAcceptanceMock({ pki });
  const emit = (value: unknown) => {
    if (process.stdout.writableLength > 128 * 1024) throw new Error('ACCEPTANCE_OUTPUT_BOUND');
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  const stop = async () => { await runtime.close(); process.stdin.pause(); };
  try {
    const summary = await selfCheckRoomAcceptanceMock(runtime, pki);
    if (selfCheck) { emit({ event: 'self-check', roomOrigin: runtime.roomOrigin, authOrigin: runtime.authOrigin, selfCheck: summary }); await stop(); return; }
    emit({ event: 'ready', roomOrigin: runtime.roomOrigin, authOrigin: runtime.authOrigin, roomAddress: runtime.roomAddress, selfCheck: summary });
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
            } else if (value.command === 'observe' && keys === 'command|id') emit({ id, event: 'observations', ...runtime.observations() });
            else if (value.command === 'stop' && keys === 'command|id') { stopped = true; await stop(); emit({ id, event: 'stopped' }); }
            else throw new Error('invalid');
          } catch { emit({ id, event: 'error', code: 'ACCEPTANCE_CONTROL_REFUSED' }); }
        }).catch(async () => { stopped = true; process.exitCode = 1; await stop(); })
          .finally(() => { queued -= 1; });
      }
    });
    process.stdin.once('end', () => { void chain.then(stop); });
    process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
  } catch { await stop(); throw new Error('ACCEPTANCE_START_FAILED'); }
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { process.stderr.write('Room acceptance mock failed\n'); process.exitCode = 1; });
}
