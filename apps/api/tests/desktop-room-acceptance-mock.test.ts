import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { ARENA_ROOM_PRESENCE_WEBSOCKET_PROTOCOL, type RoomServerTransportMessage } from '@mahoshojo/contracts/arena-room';
import { DESKTOP_ROOM_SESSION_OPERATIONS, DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, parseDesktopRoomSessionResponse, type DesktopRoomSessionOperation } from '@mahoshojo/contracts/desktop-room-session';
import { DesktopAuthExchangeResponseSchema } from '@mahoshojo/contracts/desktop-cloud';
import { MessageSummarySchema } from '@mahoshojo/contracts/messages';
import { ROOM_ACCEPTANCE_HOST, selfCheckRoomAcceptanceMock, startRoomAcceptanceMock, type RoomAcceptancePki, type RoomAcceptanceRuntime } from '../scripts/desktop-room-acceptance-mock';
import { createArenaRoomState } from './arena-room-fixtures';
import { monitorMock } from '../../../scripts/desktop-room-acceptance.mjs';

const pki = JSON.parse(await readFile(new URL('../../../scripts/fixtures/desktop-room-acceptance-pki.json', import.meta.url), 'utf8')) as RoomAcceptancePki;
const runtimes: RoomAcceptanceRuntime[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});
const start = async () => {
  const runtime = await startRoomAcceptanceMock({ pki, roomPort: 0, authPort: 0 }); runtimes.push(runtime); return runtime;
};
const request = (runtime: RoomAcceptanceRuntime, endpoint: string, options: {
  auth?: boolean; body?: unknown; headers?: Record<string, string>; method?: string; ca?: string | null; servername?: string;
} = {}): Promise<{ status: number; text: string; headers: IncomingHttpHeaders }> => new Promise((resolve, reject) => {
  const req = (options.auth ? httpRequest : httpsRequest)({
    host: '127.0.0.1', port: options.auth ? runtime.authAddress.port : runtime.roomAddress.port,
    ...(options.auth ? {} : { ca: options.ca === null ? undefined : options.ca ?? pki.ca, servername: options.servername ?? ROOM_ACCEPTANCE_HOST }),
    path: endpoint, method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: { ...options.headers, ...(options.body === undefined ? {} : { 'content-type': typeof options.body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json' }) }, timeout: 3000,
  }, (response) => {
    let text = ''; response.on('data', (data) => { text += data.toString(); });
    response.once('end', () => resolve({ status: response.statusCode!, text, headers: response.headers }));
  });
  req.once('error', reject); req.once('timeout', () => req.destroy(new Error('test timeout')));
  req.end(options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
});
const newGrant = async (runtime: RoomAcceptanceRuntime, userId: 101 | 202) => {
  const verifier = randomBytes(32).toString('base64url'); const state = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', redirect_uri: 'http://127.0.0.1:49152/callback' });
  const page = await request(runtime, `/auth/desktop?${query}`, { auth: true }); expect(page.status).toBe(200);
  expect(page.text).toContain('Synthetic 101'); expect(page.text).toContain('Synthetic 202');
  expect(page.headers['referrer-policy']).toBe('same-origin');
  expect(page.headers['content-security-policy']).toBe("default-src 'none'; form-action 'self'; frame-ancestors 'none'");
  const flow = /name="flow" value="([A-Za-z0-9_-]+)"/u.exec(page.text)![1]!;
  const form = new URLSearchParams({ flow, userId: String(userId) }).toString();
  const grant = await request(runtime, '/auth/desktop', { auth: true, body: form, headers: { origin: runtime.authOrigin } });
  expect(grant.status).toBe(303); const callback = new URL(grant.headers.location!);
  expect(callback.origin).toBe('http://127.0.0.1:49152'); expect(callback.searchParams.get('state')).toBe(state);
  return { body: { protocolVersion: 'desktop-auth-v1', code: callback.searchParams.get('code'), codeVerifier: verifier }, form };
};
const login = async (runtime: RoomAcceptanceRuntime, userId: 101 | 202) => {
  const grant = await newGrant(runtime, userId);
  const response = await request(runtime, '/api/auth/native/exchange', { auth: true, body: grant.body }); expect(response.status).toBe(200);
  expect(DesktopAuthExchangeResponseSchema.parse(JSON.parse(response.text)).account.userId).toBe(userId);
  return response.headers['set-cookie']![0]!.split(';')[0]!;
};
const headers = (userId: number, cookie: string) => ({
  cookie, 'x-mahoshojo-desktop-room-protocol': DESKTOP_ROOM_SESSION_PROTOCOL_VERSION,
  'x-mahoshojo-room-expected-user-id': `v1:${userId}`,
});
const sharedConfig = { ...createArenaRoomState().snapshot.sharedConfig, combatants: [] };
const creation = (id = 'acceptance-test-create') => ({ creationRequestId: id, displayName: 'Synthetic Host', directory: { title: 'Synthetic Room', visibility: 'public' }, sharedConfig });
const room = async (runtime: RoomAcceptanceRuntime, operation: DesktopRoomSessionOperation, cookie: string, userId: number, body?: unknown, roomId = '', mode: 'new' | 'resume-only' = 'new') => {
  const definition = DESKTOP_ROOM_SESSION_OPERATIONS[operation];
  const response = await request(runtime, definition.path.replace(':roomId', roomId), {
    method: definition.method, headers: { ...headers(userId, cookie), origin: runtime.roomOrigin },
    ...(definition.method === 'POST' ? { body: { desktopRoom: { version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, expectedUserId: userId, ...(operation === 'create' ? { createMode: mode } : {}) }, request: body } } : {}),
  });
  const parsed = parseDesktopRoomSessionResponse(operation, JSON.parse(response.text), userId);
  return { ...response, parsed };
};
const success = async (value: ReturnType<typeof room>) => {
  const response = await value; expect(response.status).toBeGreaterThanOrEqual(200); expect(response.status).toBeLessThan(300);
  const parsed = JSON.parse(response.text); expect(parsed).toHaveProperty('result'); return parsed.result;
};
const open = (runtime: RoomAcceptanceRuntime, ticket: string, origin = runtime.roomOrigin) => {
  const socket = new WebSocket(`wss://${ROOM_ACCEPTANCE_HOST}:${runtime.roomAddress.port}/api/arena/rooms/v1/ws?ticket=${encodeURIComponent(ticket)}`,
    [ARENA_ROOM_PRESENCE_WEBSOCKET_PROTOCOL],
    { ca: pki.ca, origin, lookup: (_hostname, options, callback) => options.all
            ? callback(null, [{ address: '127.0.0.1', family: 4 }])
            : callback(null, '127.0.0.1', 4), handshakeTimeout: 3000 });
  sockets.push(socket);
  const messages: RoomServerTransportMessage[] = [];
  socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as RoomServerTransportMessage));
  const connected = new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return { socket, messages, connected };
};
const closeSocket = (socket: WebSocket) => new Promise<void>((resolve) => {
  if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
  socket.once('close', () => resolve()); socket.close();
});
const latestPresence = (messages: RoomServerTransportMessage[]) => messages.filter((message) => message.type === 'room.presence').at(-1);

describe.sequential('Desktop Room acceptance real TLS producer', () => {
  it('real tsx child self-check matches the launcher monitor and exits naturally', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'room-acceptance-monitor-'));
    const api = fileURLToPath(new URL('../', import.meta.url));
    const require = createRequire(new URL('../package.json', import.meta.url));
    const child = spawn(process.execPath, ['--import', require.resolve('tsx'), path.join(api, 'scripts/desktop-room-acceptance-mock.ts'), '--self-check', '--state-root', stateRoot], {
      cwd: api, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      env: { ...process.env, NODE_OPTIONS: '', NODE_EXTRA_CA_CERTS: '', NODE_TLS_REJECT_UNAUTHORIZED: '1' },
    });
    const monitor = monitorMock(child, true, { readinessTimeoutMs: 10_000 });
    try {
      expect(await monitor.ready).toMatchObject({ event: 'self-check', roomOrigin: 'https://room.acceptance.invalid:34443', authOrigin: 'http://127.0.0.1:34080', selfCheck: { roomWss: true } });
      expect(await monitor.exit).toEqual({ code: 0, signal: null });
    } finally { await monitor.close(); await rm(stateRoot, { recursive: true, force: true }); }
  });
  it('same-listener self-check validates auth and TLS and clears only its synthetic state', async () => {
    const runtime = await start();
    expect(await selfCheckRoomAcceptanceMock(runtime, pki)).toEqual({ tlsTrusted: true, tlsNoRootRejected: true, tlsWrongSanRejected: true, authPkceOneUse: true, roomHttp: true, roomWss: true });
    expect(runtime.observations()).toMatchObject({ rooms: 0, receipts: 0, actors: 0, authSessions: 0, trace: [] });
    await expect(selfCheckRoomAcceptanceMock(runtime, pki)).rejects.toThrow('ACCEPTANCE_SELFCHECK_NOT_PRISTINE');
    const cookie = await login(runtime, 101); await success(room(runtime, 'create', cookie, 101, creation()));
  });

  it('trusts only the supplied fixture root and exact SAN over real HTTPS', async () => {
    const runtime = await start();
    await expect(request(runtime, '/api/arena/rooms/v1', { ca: null })).rejects.toMatchObject({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    await expect(request(runtime, '/api/arena/rooms/v1', { servername: 'wrong.acceptance.invalid' })).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    for (const [tls, code] of [
      [{}, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
      [{ ca: pki.ca, servername: 'wrong.acceptance.invalid' }, 'ERR_TLS_CERT_ALTNAME_INVALID'],
    ] as const) {
      const error = await new Promise<Error>((resolve, reject) => {
        const socket = new WebSocket(`wss://${ROOM_ACCEPTANCE_HOST}:${runtime.roomAddress.port}/api/arena/rooms/v1/ws`, ARENA_ROOM_PRESENCE_WEBSOCKET_PROTOCOL, {
          ...tls, origin: runtime.roomOrigin, lookup: (_hostname, options, callback) => options.all
            ? callback(null, [{ address: '127.0.0.1', family: 4 }])
            : callback(null, '127.0.0.1', 4), handshakeTimeout: 3000,
        });
        sockets.push(socket); socket.once('open', () => reject(new Error('untrusted WSS accepted')));
        socket.once('error', resolve);
      });
      expect(error).toMatchObject({ code });
    }
    expect((await request(runtime, '/health')).status).toBe(404);
    expect(runtime.observations().rooms).toBe(0);
  });

  it('rejects missing, opaque and foreign form Origins without consuming the flow', async () => {
    const runtime = await start();
    const query = new URLSearchParams({ state: 's'.repeat(43), code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256', redirect_uri: 'http://127.0.0.1:49152/callback' });
    const page = await request(runtime, `/auth/desktop?${query}`, { auth: true });
    expect(page.status).toBe(200);
    const flow = /name="flow" value="([A-Za-z0-9_-]+)"/u.exec(page.text)![1]!;
    const body = new URLSearchParams({ flow, userId: '101' }).toString();
    for (const origin of [undefined, 'null', 'http://localhost:34080', 'https://foreign.invalid']) {
      expect((await request(runtime, '/auth/desktop', { auth: true, body,
        headers: origin === undefined ? {} : { origin },
      })).status).toBe(403);
    }
    expect((await request(runtime, '/auth/desktop', { auth: true, body,
      headers: { origin: runtime.authOrigin },
    })).status).toBe(303);
  });

  it('preserves PKCE, state, one-use grant, session/profile/summary contracts and cookie identity', async () => {
    const runtime = await start();
    const grant = await newGrant(runtime, 101);
    const wrong = { ...grant.body, codeVerifier: 'x'.repeat(43) };
    expect((await request(runtime, '/api/auth/native/exchange', { auth: true, body: wrong })).status).toBe(401);
    expect((await request(runtime, '/api/auth/native/exchange', { auth: true, body: grant.body })).status).toBe(401);
    expect((await request(runtime, '/auth/desktop', { auth: true, body: grant.form, headers: { origin: runtime.authOrigin } })).status).toBe(400);
    const cookie101 = await login(runtime, 101); const cookie202 = await login(runtime, 202);
    const session = await request(runtime, '/api/auth/get-session', { auth: true, headers: { cookie: cookie101 } });
    expect(JSON.parse(session.text)).toMatchObject({ user: { userId: 101 } });
    expect(JSON.parse((await request(runtime, '/api/me/profile', { auth: true, headers: { cookie: cookie101 } })).text)).toEqual({ success: true, profile: { signature: '', avatarDataUrl: null } });
    expect(MessageSummarySchema.parse(JSON.parse((await request(runtime, '/api/messages/summary', { auth: true, headers: { cookie: cookie202 } })).text)).isAuthenticated).toBe(true);
    expect(JSON.parse((await request(runtime, '/announcements.json', { auth: true })).text)).toEqual([]);
    const mismatch = await room(runtime, 'create', cookie202, 101, creation());
    expect(mismatch.status).toBe(409); expect(mismatch.text).not.toContain('202');
    expect((await room(runtime, 'create', 'better-auth.session_token=101', 101, creation())).status).toBe(401);
    expect((await request(runtime, '/api/arena/rooms/v1', { body: {
      desktopRoom: { version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, expectedUserId: 101, createMode: 'new' }, request: creation(),
    }, headers: { ...headers(101, cookie101), origin: runtime.authOrigin } })).status).toBe(403);
    expect(runtime.observations().rooms).toBe(0);
    await request(runtime, '/api/auth/sign-out', { auth: true, body: {}, headers: { cookie: cookie101 } });
    expect((await room(runtime, 'discover', cookie101, 101)).status).toBe(401);
  });

  it('uses all seven HTTP operations, real WSS double presence, replay rejection and terminal readback', async () => {
    const runtime = await start(); const hostCookie = await login(runtime, 101); const memberCookie = await login(runtime, 202);
    const host = await success(room(runtime, 'create', hostCookie, 101, creation()));
    expect((await success(room(runtime, 'discover', hostCookie, 101))).items).toHaveLength(1);
    const member = await success(room(runtime, 'join', memberCookie, 202, { displayName: 'Synthetic Member' }, host.roomId));
    expect(member.self.userId).not.toBe(host.self.userId);
    const hostTicket = await success(room(runtime, 'ticket', hostCookie, 101, {}, host.roomId));
    const refusedStatus = await new Promise<number | undefined>((resolve, reject) => {
      const refused = open(runtime, hostTicket.ticket, runtime.authOrigin); void refused.connected.catch(reject);
      refused.socket.once('unexpected-response', (_request, response) => { response.resume(); refused.socket.terminate(); resolve(response.statusCode); });
      refused.socket.once('open', () => reject(new Error('wrong Origin accepted')));
    });
    expect(refusedStatus).toBe(403);
    const h = open(runtime, hostTicket.ticket); await h.connected;
    await expect.poll(() => h.messages.some((message) => message.type === 'room.snapshot')).toBe(true);
    const memberTicket = await success(room(runtime, 'ticket', memberCookie, 202, {}, host.roomId));
    const m = open(runtime, memberTicket.ticket); await m.connected;
    await expect.poll(() => latestPresence(h.messages)?.onlineUserIds).toEqual([host.self.userId, member.self.userId]);
    const secondTicket = await success(room(runtime, 'ticket', memberCookie, 202, {}, host.roomId));
    const m2 = open(runtime, secondTicket.ticket); await m2.connected;
    await closeSocket(m.socket);
    await expect.poll(() => runtime.observations().activeConnections).toBe(2);
    expect(latestPresence(h.messages)?.onlineUserIds).toEqual([host.self.userId, member.self.userId]);
    await closeSocket(m2.socket);
    await expect.poll(() => latestPresence(h.messages)?.onlineUserIds).toEqual([host.self.userId]);
    const reconnectTicket = await success(room(runtime, 'ticket', memberCookie, 202, {}, host.roomId));
    const reconnected = open(runtime, reconnectTicket.ticket); await reconnected.connected;
    await expect.poll(() => reconnected.messages.some((message) => message.type === 'room.snapshot')).toBe(true);
    await expect.poll(() => latestPresence(reconnected.messages)?.onlineUserIds).toEqual([host.self.userId, member.self.userId]);
    const replayStatus = await new Promise<number | undefined>((resolve, reject) => {
      const replay = open(runtime, memberTicket.ticket); void replay.connected.catch(reject);
      replay.socket.once('unexpected-response', (_request, response) => { response.resume(); replay.socket.terminate(); resolve(response.statusCode); });
      replay.socket.once('open', () => reject(new Error('ticket replay accepted')));
    });
    expect(replayStatus).toBe(401);
    expect((await success(room(runtime, 'session', memberCookie, 202, undefined, host.roomId))).self.userId).toBe(member.self.userId);
    expect(await success(room(runtime, 'leave', memberCookie, 202, { expectedRoomEpoch: host.roomEpoch }, host.roomId))).toMatchObject({ outcome: 'left' });
    expect((await room(runtime, 'session', memberCookie, 202, undefined, host.roomId)).status).toBe(404);
    expect(await success(room(runtime, 'close', hostCookie, 101, { expectedRoomEpoch: host.roomEpoch }, host.roomId))).toMatchObject({ outcome: 'closed' });
    expect((await room(runtime, 'session', hostCookie, 101, undefined, host.roomId)).status).toBe(404);
    expect((await success(room(runtime, 'discover', hostCookie, 101))).items).toEqual([]);
    expect(new Set(runtime.observations().trace.filter((entry) => entry.kind === 'room-http').map((entry) => entry.operation))).toEqual(new Set(Object.keys(DESKTOP_ROOM_SESSION_OPERATIONS)));
  });

  it('drops only successful committed create and resume-only recovers the original committed in-memory receipt', async () => {
    const runtime = await start(); const cookie = await login(runtime, 101);
    expect((await room(runtime, 'create', cookie, 101, creation('unknown-original'), '', 'resume-only')).status).toBe(409);
    expect(runtime.observations()).toMatchObject({ rooms: 0, receipts: 0 });
    runtime.armFault('create');
    await expect(room(runtime, 'create', cookie, 101, creation())).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(runtime.observations()).toMatchObject({ rooms: 1, receipts: 1 });
    const resumed = await success(room(runtime, 'create', cookie, 101, creation(), '', 'resume-only'));
    const retry = await success(room(runtime, 'create', cookie, 101, creation()));
    expect(retry.roomId).toBe(resumed.roomId); expect(retry.roomEpoch).toBe(resumed.roomEpoch);
    expect((await room(runtime, 'create', cookie, 101, { ...creation(), displayName: 'Changed intention' }, '', 'resume-only')).status).toBe(409);
    expect(runtime.observations()).toMatchObject({ rooms: 1, receipts: 1 });
    expect(runtime.observations().trace.filter((entry) => entry.kind === 'room-http' && entry.dropped)).toEqual([{ kind: 'room-http', operation: 'create', status: 201, dropped: true }]);
  });

  it('join/leave/close faults follow real mutations and safe readback; failed calls do not consume a fault', async () => {
    const runtime = await start(); const h = await login(runtime, 101); const m = await login(runtime, 202);
    const host = await success(room(runtime, 'create', h, 101, creation()));
    runtime.armFault('join');
    expect((await room(runtime, 'join', 'better-auth.session_token=forged', 202, { displayName: 'Member' }, host.roomId)).status).toBe(401);
    await expect(room(runtime, 'join', m, 202, { displayName: 'Member' }, host.roomId)).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect((await success(room(runtime, 'session', m, 202, undefined, host.roomId))).self.role).toBe('member');
    runtime.armFault('leave');
    await expect(room(runtime, 'leave', m, 202, { expectedRoomEpoch: host.roomEpoch }, host.roomId)).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect((await room(runtime, 'session', m, 202, undefined, host.roomId)).status).toBe(404);
    runtime.armFault('close');
    await expect(room(runtime, 'close', h, 101, { expectedRoomEpoch: host.roomEpoch }, host.roomId)).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect((await room(runtime, 'session', h, 101, undefined, host.roomId)).status).toBe(404);
    expect((await success(room(runtime, 'discover', h, 101))).items).toEqual([]);
    expect(runtime.observations().trace.flatMap((entry) => entry.kind === 'room-http' && entry.dropped ? [entry.operation] : [])).toEqual(['join', 'leave', 'close']);
  });

  it('refuses default/unnegotiated/generation/config/proposal paths and unknown controls with bounded safe trace', async () => {
    const runtime = await start(); const cookie = await login(runtime, 101);
    for (const path of ['/api/arena/generate-stream', '/api/arena/rooms/v1/room-1/generations', '/api/arena/rooms/v1/room-1/config', '/api/arena/rooms/v1/room-1/proposals', '/api/arena/rooms/v1/room-1/members/member-1/kick', '/api/arena/rooms/v1/room-1/unknown']) {
      expect((await request(runtime, path, { body: {}, headers: headers(101, cookie) })).status).toBe(404);
    }
    expect((await request(runtime, '/api/arena/rooms/v1', { headers: { cookie } })).status).toBe(404);
    expect((await request(runtime, '/api/arena/rooms/v1', { auth: true, headers: headers(101, cookie) })).status).toBe(404);
    expect(() => runtime.armFault('ticket' as never)).toThrow('ACCEPTANCE_FAULT_INVALID');
    runtime.armFault('create'); expect(() => runtime.armFault('join')).toThrow('ACCEPTANCE_FAULT_INVALID');
    for (let index = 0; index < 260; index++) await request(runtime, '/unknown');
    const observations = runtime.observations(); expect(observations.trace).toHaveLength(256); expect(observations.rooms).toBe(0);
    expect(JSON.stringify(observations)).not.toContain(cookie); expect(JSON.stringify(observations)).not.toContain('BEGIN');
  });

  it('releases the first listener when binding the second fails and closes live WSS plus both listeners', async () => {
    const bind = async (server: Server, port = 0) => {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      return (server.address() as AddressInfo).port;
    };
    const stop = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
    const blocker = createServer(); const reservation = createServer();
    const authPort = await bind(blocker); const roomPort = await bind(reservation); await stop(reservation);
    try {
      await expect(startRoomAcceptanceMock({ pki, roomPort, authPort })).rejects.toThrow('ACCEPTANCE_BIND_FAILED');
      const reusable = createServer(); await bind(reusable, roomPort); await stop(reusable);
    } finally { await stop(blocker); }
    const runtime = await start(); const cookie = await login(runtime, 101);
    const host = await success(room(runtime, 'create', cookie, 101, creation()));
    const ticket = await success(room(runtime, 'ticket', cookie, 101, {}, host.roomId));
    const connection = open(runtime, ticket.ticket); await connection.connected;
    await runtime.close(); await runtime.close();
    const roomAgain = createServer(); const authAgain = createServer();
    await bind(roomAgain, runtime.roomAddress.port); await bind(authAgain, runtime.authAddress.port);
    await stop(roomAgain); await stop(authAgain);
  });
});
