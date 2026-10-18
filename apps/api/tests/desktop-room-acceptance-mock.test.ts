import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARENA_ROOM_PRESENCE_WEBSOCKET_PROTOCOL, type RoomServerTransportMessage } from '@mahoshojo/contracts/arena-room';
import { DESKTOP_ROOM_SESSION_OPERATIONS, DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, parseDesktopRoomSessionResponse, type DesktopRoomSessionOperation } from '@mahoshojo/contracts/desktop-room-session';
import { DesktopAuthExchangeResponseSchema } from '@mahoshojo/contracts/desktop-cloud';
import { MessageSummarySchema } from '@mahoshojo/contracts/messages';
import { ROOM_ACCEPTANCE_HOST, ROOM_ACCEPTANCE_OPERATIONS, ROOM_ACCEPTANCE_PUBLIC_CHARACTER, selfCheckRoomAcceptanceMock, startRoomAcceptanceMock, type RoomAcceptancePki, type RoomAcceptanceRuntime } from '../scripts/desktop-room-acceptance-mock';
import type { RoomActor, RoomActorExecuteInput } from '../src/arena-room/room-actor-registry';
import type { ResolvedArenaRoomMembership } from '../src/arena-room/room-membership-service';
import { ARENA_ROOM_GENERATION_PRESET_REFS } from '../src/arena-room/room-generation-preset-registry';
import { createArenaRoomState } from './arena-room-fixtures';
import { monitorMock, ROOM_GENERATION_SCENARIOS } from '../../../scripts/desktop-room-acceptance.mjs';
import { createRoomAcceptanceGeneration, ROOM_ACCEPTANCE_GENERATION_SCENARIOS, ROOM_ACCEPTANCE_GENERATION_LARGE_BYTES, ROOM_ACCEPTANCE_GENERATION_TAIL } from '../scripts/desktop-room-acceptance-generation';

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
    let text = ''; response.setEncoding('utf8'); response.on('data', (data: string) => { text += data; });
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
const room = async (runtime: RoomAcceptanceRuntime, operation: DesktopRoomSessionOperation, cookie: string, userId: number, body?: unknown, roomId = '', mode: 'new' | 'resume-only' = 'new', proposalId = '', generationId = '') => {
  const definition = DESKTOP_ROOM_SESSION_OPERATIONS[operation];
  const response = await request(runtime, definition.path.replace(':roomId', encodeURIComponent(roomId)).replace(':proposalId', encodeURIComponent(proposalId)).replace(':generationId', encodeURIComponent(generationId)), {
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
const joinedRoom = async () => {
  const runtime = await start(); const h = await login(runtime, 101); const m = await login(runtime, 202);
  const host = await success(room(runtime, 'create', h, 101, creation()));
  const member = await success(room(runtime, 'join', m, 202, { displayName: 'Synthetic Member' }, host.roomId));
  const snapshot = (await success(room(runtime, 'session', h, 101, undefined, host.roomId))).snapshot;
  const proposal = { proposalId: 'member-proposal', expectedRoomEpoch: host.roomEpoch, baseRevision: snapshot.revision,
    changes: [{ type: 'setUserGuidance', changeId: 'guidance', value: 'PROPOSAL-PRIVATE-CANARY', expectedBase: { kind: 'value', value: '' } }] };
  return { runtime, h, m, host, member, snapshot, proposal };
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

const checkFailedChild = async (stage: string, code: string, options: { args?: string[]; bootstrap?: string } = {}) => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'room-acceptance-failure-'));
  const api = fileURLToPath(new URL('../', import.meta.url));
  const require = createRequire(new URL('../package.json', import.meta.url));
  const child = spawn(process.execPath, [
    '--import', require.resolve('tsx'),
    ...(options.bootstrap ? ['--import', `data:text/javascript,${encodeURIComponent(options.bootstrap)}`] : []),
    path.join(api, 'scripts/desktop-room-acceptance-mock.ts'),
    ...(options.args ?? ['--self-check', '--state-root', stateRoot]),
  ], {
    cwd: api, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    env: { ...process.env, NODE_OPTIONS: '', NODE_EXTRA_CA_CERTS: '', NODE_TLS_REJECT_UNAUTHORIZED: '1' },
  });
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  const monitor = monitorMock(child, true, { readinessTimeoutMs: 10_000 });
  try {
    const failure = await monitor.ready.catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain(`mock stopped before ready (code=1, signal=null); stage=${stage}, reason=${code}`);
    expect(failure.stack).not.toContain('PRIVATE-DIAGNOSTIC-CANARY');
    expect(failure.cause).toBeUndefined();
    expect(await monitor.exit).toEqual({ code: 1, signal: null });
    expect(stderr).toContain(`ROOM_ACCEPTANCE_FAILURE stage=${stage} code=${code}\n`);
    expect(stderr).not.toContain('PRIVATE-DIAGNOSTIC-CANARY'); expect(stdout).toBe('');
  } finally { await monitor.close(); await rm(stateRoot, { recursive: true, force: true }); }
};

describe.sequential('Desktop Room acceptance real TLS producer', () => {
  it('collects a real child final diagnostic from inherited stderr after exit', async () => {
    const diagnostic = 'ROOM_ACCEPTANCE_FAILURE stage=listen code=EADDRINUSE\n';
    const writer = `process.stdin.once('data', () => { process.stderr.write(${JSON.stringify(diagnostic)}); process.stdin.destroy(); });`;
    const child = spawn(process.execPath, ['-e', `
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], {
        stdio: [3, 'ignore', 2],
      }).unref();
      process.exitCode = 1;
    `], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], shell: false });
    let exited = false, diagnosticAfterExit = false;
    child.once('exit', () => { exited = true; (child.stdio[3] as Writable).end('go'); });
    child.stderr.on('data', chunk => { if (chunk.toString().includes('ROOM_ACCEPTANCE_FAILURE')) diagnosticAfterExit = exited; });
    const monitor = monitorMock(child, true, { readinessTimeoutMs: 10_000 });
    try {
      await expect(monitor.ready).rejects.toThrow('mock stopped before ready (code=1, signal=null); stage=listen, reason=EADDRINUSE');
      expect(await monitor.exit).toEqual({ code: 1, signal: null }); expect(diagnosticAfterExit).toBe(true);
    } finally { await monitor.close(); }
  });

  it('reports invalid child arguments without echoing their private values', async () => {
    await checkFailedChild('validate-args', 'ACCEPTANCE_ARGUMENT_INVALID', { args: ['PRIVATE-DIAGNOSTIC-CANARY'] });
  });

  it.each(['missing', 'invalid-json'])('reports a real child %s fixture failure without the original error', async fault => {
    const bootstrap = `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const readFile = fs.readFile;
      fs.readFile = (file, ...args) => {
        if (file instanceof URL && file.pathname.endsWith('/scripts/fixtures/desktop-room-acceptance-pki.json')) {
          return ${fault === 'missing'
            ? "Promise.reject(Object.assign(new Error('PRIVATE-DIAGNOSTIC-CANARY'), { code: 'ENOENT', path: 'PRIVATE-DIAGNOSTIC-CANARY' }))"
            : "Promise.resolve('PRIVATE-DIAGNOSTIC-CANARY')"};
        }
        return readFile(file, ...args);
      };
      syncBuiltinESMExports();
    `;
    await checkFailedChild('load-fixture', fault === 'missing' ? 'ENOENT' : 'INVALID_JSON', { bootstrap });
  });

  it('reports an occupied listener from the real child and keeps the owner listener alive', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => { blocker.once('error', reject); blocker.listen(34443, '127.0.0.1', resolve); });
    try {
      await checkFailedChild('listen', 'EADDRINUSE'); expect(blocker.listening).toBe(true);
    } finally { await new Promise<void>((resolve) => blocker.close(() => resolve())); }
  });

  it('preserves a safe self-check reason from a real child and discards the private error payload', async () => {
    await checkFailedChild('self-check', 'ECONNREFUSED', { bootstrap: `
      import http from 'node:http';
      import { syncBuiltinESMExports } from 'node:module';
      http.request = () => { throw Object.assign(new Error('PRIVATE-DIAGNOSTIC-CANARY'), {
        code: 'ECONNREFUSED', headers: { authorization: 'PRIVATE-DIAGNOSTIC-CANARY' }, body: 'PRIVATE-DIAGNOSTIC-CANARY',
      }); };
      syncBuiltinESMExports();
    ` });
  });

  it('preserves the probe timeout code through the request error event in a real child', async () => {
    await checkFailedChild('self-check', 'ACCEPTANCE_PROBE_TIMEOUT', { bootstrap: `
      import http from 'node:http';
      import { EventEmitter } from 'node:events';
      import { syncBuiltinESMExports } from 'node:module';
      http.request = () => {
        const request = new EventEmitter();
        request.end = () => queueMicrotask(() => request.emit('timeout'));
        request.destroy = error => request.emit('error', Object.assign(error, {
          headers: { authorization: 'PRIVATE-DIAGNOSTIC-CANARY' }, body: 'PRIVATE-DIAGNOSTIC-CANARY',
        }));
        return request;
      };
      syncBuiltinESMExports();
    ` });
  });

  it.each([false, true])('real tsx child self-check matches launcher monitor (synthetic start=%s)', async syntheticStart => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'room-acceptance-monitor-'));
    const api = fileURLToPath(new URL('../', import.meta.url));
    const require = createRequire(new URL('../package.json', import.meta.url));
    const child = spawn(process.execPath, ['--import', require.resolve('tsx'), path.join(api, 'scripts/desktop-room-acceptance-mock.ts'), '--self-check', ...(syntheticStart ? ['--synthetic-start'] : []), '--state-root', stateRoot], {
      cwd: api, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      env: { ...process.env, NODE_OPTIONS: '', NODE_EXTRA_CA_CERTS: '', NODE_TLS_REJECT_UNAUTHORIZED: '1' },
    });
    const monitor = monitorMock(child, true, { readinessTimeoutMs: 10_000, syntheticStart });
    try {
      expect(await monitor.ready).toMatchObject({ event: 'self-check', roomOrigin: 'https://room.acceptance.invalid:34443', authOrigin: 'http://127.0.0.1:34080',
        selfCheck: { roomWss: true, roomProposals: true, proposalReceiptLoss: true, fixedPublicRefs: true } });
      expect(await monitor.exit).toEqual({ code: 0, signal: null });
    } finally { await monitor.close(); await rm(stateRoot, { recursive: true, force: true }); }
  });
  it('same-listener self-check validates auth and TLS and clears only its synthetic state', async () => {
    const runtime = await start();
    expect(await selfCheckRoomAcceptanceMock(runtime, pki)).toEqual({ tlsTrusted: true, tlsNoRootRejected: true, tlsWrongSanRejected: true, authPkceOneUse: true, roomHttp: true, roomWss: true, roomProposals: true, proposalReceiptLoss: true, fixedPublicRefs: true, roomGenerationRead: true, roomGenerationRecovery: true, generationReadOnly: true });
    expect(runtime.observations()).toMatchObject({ rooms: 0, receipts: 0, actors: 0, authSessions: 0, trace: [] });
    await expect(selfCheckRoomAcceptanceMock(runtime, pki)).rejects.toThrow('ACCEPTANCE_SELFCHECK_NOT_PRISTINE');
    const cookie = await login(runtime, 101); await success(room(runtime, 'create', cookie, 101, creation()));
  });

  it('runs the real generation service with reservation-only, explicit original retry and synthetic producer', async () => {
    const runtime = await start();
    expect(await selfCheckRoomAcceptanceMock(runtime, pki, false, true)).toMatchObject({ generationStart: true, syntheticProducer: true, generationCancel: true, generationReadOnly: false });
    expect(runtime.observations()).toMatchObject({ rooms: 0, receipts: 0, actors: 0, authSessions: 0, generation: { modelDispatches: 0 } });
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

  it.each(['replay', 'current'] as const)('requires a fresh snapshot for a new Native socket instead of the old %s cursor', async mode => {
    const runtime = await start(); const cookie = await login(runtime, 101);
    const created = await success(room(runtime, 'create', cookie, 101, creation()));
    if (mode === 'current') {
      const anchorTicket = await success(room(runtime, 'ticket', cookie, 101, {}, created.roomId));
      const anchor = open(runtime, anchorTicket.ticket); await anchor.connected;
      await expect.poll(() => latestPresence(anchor.messages)?.onlineUserIds).toContain(created.self.userId);
    }
    const current = await success(room(runtime, 'session', cookie, 101, undefined, created.roomId));
    const replayTicket = await success(room(runtime, 'ticket', cookie, 101, {
      reconnect: { control: { roomEpoch: current.roomEpoch, controlSeq: current.snapshot.controlSeq } },
    }, created.roomId));
    const replay = open(runtime, replayTicket.ticket); await replay.connected;
    await expect.poll(() => latestPresence(replay.messages)?.onlineUserIds).toContain(created.self.userId);
    // These are real admission frames. Native clears snapshot_seen on every new
    // connection, so the old cursor reaches presence without a bound snapshot.
    expect(replay.messages.map(message => message.type)).toEqual(mode === 'replay'
      ? ['room.host.online', 'room.presence'] : ['room.presence']);
    replay.socket.send(JSON.stringify({ protocolVersion: 1, type: 'room.resync.request' }));
    await expect.poll(() => replay.messages.filter(message => message.type === 'room.presence').length).toBe(2);
    expect(replay.messages.slice(-2).map(message => message.type)).toEqual(['room.snapshot', 'room.presence']);

    const freshTicket = await success(room(runtime, 'ticket', cookie, 101, {}, created.roomId));
    const fresh = open(runtime, freshTicket.ticket); await fresh.connected;
    await expect.poll(() => latestPresence(fresh.messages)?.onlineUserIds).toContain(created.self.userId);
    expect(fresh.messages.map(message => message.type)).toEqual(['room.snapshot', 'room.presence']);
    // The existing fixed resync remains valid after the initial full snapshot.
    fresh.socket.send(JSON.stringify({ protocolVersion: 1, type: 'room.resync.request' }));
    await expect.poll(() => fresh.messages.filter(message => message.type === 'room.presence').length).toBe(2);
    expect(fresh.messages.map(message => message.type)).toEqual([
      'room.snapshot', 'room.presence', 'room.snapshot', 'room.presence',
    ]);
  });

  it('uses all implemented Native HTTP operations, real WSS double presence, replay rejection and terminal readback', async () => {
    const runtime = await start(); const hostCookie = await login(runtime, 101); const memberCookie = await login(runtime, 202);
    const host = await success(room(runtime, 'create', hostCookie, 101, creation()));
    expect((await success(room(runtime, 'discover', hostCookie, 101))).items).toHaveLength(1);
    const member = await success(room(runtime, 'join', memberCookie, 202, { displayName: 'Synthetic Member' }, host.roomId));
    expect(member.self.userId).not.toBe(host.self.userId);
    const current = await success(room(runtime, 'session', hostCookie, 101, undefined, host.roomId));
    const target = { ...current.snapshot.sharedConfig, userGuidance: '显式发布配置' };
    const published = await success(room(runtime, 'config', hostCookie, 101, {
      expectedRoomEpoch: current.roomEpoch, expectedRevision: current.snapshot.revision,
      expectedControlSeq: current.snapshot.controlSeq, sharedConfig: target,
    }, host.roomId));
    expect(published).toMatchObject({ roomId: host.roomId, roomEpoch: host.roomEpoch, self: host.self,
      snapshot: { revision: current.snapshot.revision + 1, controlSeq: current.snapshot.controlSeq + 1, sharedConfig: target },
    });
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
    const proposal = { proposalId: 'all-operations-withdraw', expectedRoomEpoch: host.roomEpoch, baseRevision: published.snapshot.revision,
      changes: [{ type: 'setUserGuidance', changeId: 'guidance', value: '提案建议', expectedBase: { kind: 'value', value: target.userGuidance } }] };
    await success(room(runtime, 'proposalSubmit', memberCookie, 202, proposal, host.roomId));
    await expect.poll(() => h.messages.some(message => message.type === 'proposal.submitted' && message.payload.proposal.proposalId === proposal.proposalId)).toBe(true);
    await expect.poll(() => reconnected.messages.some(message => message.type === 'proposal.submitted' && message.payload.proposal.proposalId === proposal.proposalId)).toBe(true);
    await success(room(runtime, 'proposalWithdraw', memberCookie, 202, { expectedRoomEpoch: host.roomEpoch }, host.roomId, 'new', proposal.proposalId));
    await expect.poll(() => h.messages.some(message => message.type === 'proposal.resolved' && message.payload.proposalId === proposal.proposalId && message.payload.status === 'withdrawn')).toBe(true);
    await success(room(runtime, 'proposalSubmit', memberCookie, 202, { ...proposal, proposalId: 'all-operations-resolve' }, host.roomId));
    await success(room(runtime, 'proposalResolve', hostCookie, 101, { expectedRoomEpoch: host.roomEpoch, resolution: 'reject' }, host.roomId, 'new', 'all-operations-resolve'));
    await runtime.generation('seed');
    const generation = (await success(room(runtime, 'session', hostCookie, 101, undefined, host.roomId))).snapshot.activeGeneration;
    expect(await success(room(runtime, 'generationRead', hostCookie, 101, undefined, host.roomId, 'new', '', generation.generationId))).toMatchObject({ status: 'running', finalAuthoritative: false });
    await runtime.generation('complete');
    expect(await success(room(runtime, 'leave', memberCookie, 202, { expectedRoomEpoch: host.roomEpoch }, host.roomId))).toMatchObject({ outcome: 'left' });
    expect((await room(runtime, 'session', memberCookie, 202, undefined, host.roomId)).status).toBe(404);
    expect(await success(room(runtime, 'close', hostCookie, 101, { expectedRoomEpoch: host.roomEpoch }, host.roomId))).toMatchObject({ outcome: 'closed' });
    expect((await room(runtime, 'session', hostCookie, 101, undefined, host.roomId)).status).toBe(404);
    expect((await success(room(runtime, 'discover', hostCookie, 101))).items).toEqual([]);
    expect(new Set(runtime.observations().trace.filter((entry) => entry.kind === 'room-http').map((entry) => entry.operation))).toEqual(new Set(ROOM_ACCEPTANCE_OPERATIONS));
  });

  it('config keeps actual host, epoch, revision and controlSeq authority ahead of mutation', async () => {
    const runtime = await start(); const hostCookie = await login(runtime, 101); const memberCookie = await login(runtime, 202);
    const host = await success(room(runtime, 'create', hostCookie, 101, creation()));
    await success(room(runtime, 'join', memberCookie, 202, { displayName: 'Synthetic Member' }, host.roomId));
    const current = await success(room(runtime, 'session', hostCookie, 101, undefined, host.roomId));
    const intent = { expectedRoomEpoch: current.roomEpoch, expectedRevision: current.snapshot.revision,
      expectedControlSeq: current.snapshot.controlSeq, sharedConfig: { ...current.snapshot.sharedConfig, userGuidance: '不得越权写入' } };
    for (const request of [
      { ...intent, expectedRoomEpoch: 'stale-epoch' },
      { ...intent, expectedRevision: current.snapshot.revision + 1 },
      { ...intent, expectedControlSeq: current.snapshot.controlSeq + 1 },
    ]) {
      const refused = await room(runtime, 'config', hostCookie, 101, request, host.roomId);
      expect(refused.status).toBe(409);
      expect(refused.parsed).toMatchObject({ error: { code: 'ROOM_CONFLICT', outcome: 'unknown' } });
    }
    const nonHost = await room(runtime, 'config', memberCookie, 202, intent, host.roomId);
    expect(nonHost.status).toBe(403);
    expect(nonHost.parsed).toMatchObject({ error: { code: 'ROOM_FORBIDDEN', outcome: 'unknown' } });
    const wrongOwner = await room(runtime, 'config', memberCookie, 101, intent, host.roomId);
    expect(wrongOwner.status).toBe(409);
    expect(wrongOwner.parsed).toMatchObject({ desktopRoom: { viewerUserId: null }, error: { code: 'ROOM_DESKTOP_OWNER_MISMATCH', outcome: 'not-applied' } });
    const observed = await success(room(runtime, 'session', hostCookie, 101, undefined, host.roomId));
    expect(observed.snapshot).toEqual(current.snapshot);
  });

  it('one-shot old producer rejection is unpaired and pre-business, with no configuration change or secret trace', async () => {
    const runtime = await start(); const cookie = await login(runtime, 101);
    const host = await success(room(runtime, 'create', cookie, 101, creation()));
    const target = { ...host.snapshot.sharedConfig, userGuidance: 'CONFIG-PRIVATE-CANARY' };
    const intent = { expectedRoomEpoch: host.roomEpoch, expectedRevision: host.snapshot.revision,
      expectedControlSeq: host.snapshot.controlSeq, sharedConfig: target };
    runtime.armFault('config-unsupported');
    expect(() => runtime.armFault('config')).toThrow('ACCEPTANCE_FAULT_INVALID');
    await success(room(runtime, 'session', cookie, 101, undefined, host.roomId));
    const malformed = await request(runtime, DESKTOP_ROOM_SESSION_OPERATIONS.config.path.replace(':roomId', host.roomId), {
      headers: { ...headers(101, cookie), 'x-mahoshojo-room-expected-user-id': 'invalid' }, body: {},
    });
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.text).error.code).toBe('ROOM_DESKTOP_PROTOCOL_INVALID');
    const rejected = await room(runtime, 'config', cookie, 101, intent, host.roomId);
    expect(rejected.status).toBe(400);
    expect(rejected.parsed).toEqual({ desktopRoom: { version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, viewerUserId: null },
      error: { code: 'ROOM_DESKTOP_OPERATION_UNSUPPORTED', message: '当前桌面房间版本不支持此操作', outcome: 'not-applied' } });
    const current = await success(room(runtime, 'session', cookie, 101, undefined, host.roomId));
    expect(current.snapshot).toEqual(host.snapshot); expect(runtime.observations()).toMatchObject({ rooms: 1, receipts: 1 });
    const published = await success(room(runtime, 'config', cookie, 101, intent, host.roomId));
    expect(published.snapshot).toMatchObject({ revision: host.snapshot.revision + 1, controlSeq: host.snapshot.controlSeq + 1, sharedConfig: target });
    expect(runtime.observations().trace.filter(entry => entry.kind === 'room-http' && entry.operation === 'config')).toEqual([
      { kind: 'room-http', operation: 'config', status: 400, dropped: false },
      { kind: 'room-http', operation: 'config', status: 400, dropped: false },
      { kind: 'room-http', operation: 'config', status: 200, dropped: false },
    ]);
    expect(JSON.stringify(runtime.observations())).not.toContain('CONFIG-PRIVATE-CANARY');
    expect(JSON.stringify(runtime.observations())).not.toContain(cookie);
  });

  it('a lost config HTTP receipt leaves a committed state that later GET only observes without another POST', async () => {
    const runtime = await start(); const cookie = await login(runtime, 101);
    const host = await success(room(runtime, 'create', cookie, 101, creation()));
    const target = { ...host.snapshot.sharedConfig, userGuidance: '已提交但原回执丢失' };
    runtime.armFault('config');
    await expect(room(runtime, 'config', cookie, 101, { expectedRoomEpoch: host.roomEpoch,
      expectedRevision: host.snapshot.revision, expectedControlSeq: host.snapshot.controlSeq, sharedConfig: target,
    }, host.roomId)).rejects.toMatchObject({ code: 'ECONNRESET' });
    const observed = await success(room(runtime, 'session', cookie, 101, undefined, host.roomId));
    expect(observed.snapshot).toMatchObject({ revision: host.snapshot.revision + 1, sharedConfig: target });
    expect(observed).not.toHaveProperty('operationId');
    expect(observed).not.toHaveProperty('receipt');
    expect(runtime.observations().trace.filter((entry) => entry.kind === 'room-http' && entry.operation === 'config'))
      .toEqual([{ kind: 'room-http', operation: 'config', status: 200, dropped: true }]);
  });

  it('uses real proposal role/epoch/idempotency authority, summary mutations and full resolve snapshots', async () => {
    const { runtime, h, m, host, member, snapshot, proposal } = await joinedRoom();
    expect((await room(runtime, 'proposalSubmit', h, 101, proposal, host.roomId)).status).toBe(403);
    expect((await room(runtime, 'proposalSubmit', m, 202, { ...proposal, expectedRoomEpoch: 'stale-epoch' }, host.roomId)).status).toBe(409);
    const wrongOwner = await room(runtime, 'proposalSubmit', m, 101, proposal, host.roomId);
    expect(wrongOwner.parsed).toMatchObject({ desktopRoom: { viewerUserId: null }, error: { code: 'ROOM_DESKTOP_OWNER_MISMATCH', outcome: 'not-applied' } });
    expect((await success(room(runtime, 'session', h, 101, undefined, host.roomId))).snapshot).toEqual(snapshot);
    const submitted = await success(room(runtime, 'proposalSubmit', m, 202, proposal, host.roomId));
    expect(submitted).toMatchObject({ proposalId: proposal.proposalId, status: 'submitted', result: 'applied', revision: snapshot.revision, controlSeq: snapshot.controlSeq + 1 });
    expect(submitted).not.toHaveProperty('snapshot'); expect(submitted).not.toHaveProperty('sharedConfig');
    const replay = await success(room(runtime, 'proposalSubmit', m, 202, proposal, host.roomId));
    expect(replay).toEqual({ ...submitted, result: 'idempotent' });
    expect((await room(runtime, 'proposalSubmit', m, 202, { ...proposal, changes: [{ ...proposal.changes[0], value: 'Different intent' }] }, host.roomId)).status).toBe(409);
    const memberView = await success(room(runtime, 'session', m, 202, undefined, host.roomId));
    expect(memberView.snapshot.proposals).toHaveLength(1);
    expect(memberView.snapshot.proposals[0]).toMatchObject({ proposalId: proposal.proposalId, authorUserId: member.self.userId, changes: proposal.changes });
    const resolve = { expectedRoomEpoch: host.roomEpoch, resolution: 'accept-selected', selectedChangeIds: ['guidance'] };
    expect((await room(runtime, 'proposalResolve', m, 202, resolve, host.roomId, 'new', proposal.proposalId)).status).toBe(403);
    expect((await room(runtime, 'proposalWithdraw', h, 101, { expectedRoomEpoch: host.roomEpoch }, host.roomId, 'new', proposal.proposalId)).status).toBe(403);
    expect((await room(runtime, 'proposalWithdraw', m, 202, { expectedRoomEpoch: 'stale-epoch' }, host.roomId, 'new', proposal.proposalId)).status).toBe(409);
    expect((await room(runtime, 'proposalResolve', h, 101, { ...resolve, expectedRoomEpoch: 'stale-epoch' }, host.roomId, 'new', proposal.proposalId)).status).toBe(409);
    const resolved = await success(room(runtime, 'proposalResolve', h, 101, resolve, host.roomId, 'new', proposal.proposalId));
    const observed = await success(room(runtime, 'session', h, 101, undefined, host.roomId));
    expect(resolved).toMatchObject({ status: 'accepted', revision: snapshot.revision + 1, snapshot: observed.snapshot, sharedConfig: observed.snapshot.sharedConfig });
    expect(resolved.snapshot.proposals).toEqual([]);
    expect(resolved.snapshot.members).toHaveLength(2);
    expect(resolved.snapshot.sharedConfig.userGuidance).toBe('PROPOSAL-PRIVATE-CANARY');
    expect((await room(runtime, 'proposalSubmit', m, 202, proposal, host.roomId)).status).toBe(409);
    expect(JSON.stringify(runtime.observations())).not.toContain('PROPOSAL-PRIVATE-CANARY');
    expect(JSON.stringify(runtime.observations())).not.toContain(m);
  });

  it('drops each successful proposal receipt after real commit and readback never replays a POST', async () => {
    const { runtime, h, m, host, snapshot, proposal } = await joinedRoom();
    runtime.armFault('proposalSubmit');
    expect((await room(runtime, 'proposalSubmit', h, 101, proposal, host.roomId)).status).toBe(403);
    await expect(room(runtime, 'proposalSubmit', m, 202, proposal, host.roomId)).rejects.toMatchObject({ code: 'ECONNRESET' });
    const submitted = await success(room(runtime, 'session', m, 202, undefined, host.roomId));
    expect(submitted.snapshot).toMatchObject({ revision: snapshot.revision, controlSeq: snapshot.controlSeq + 1, proposals: [{ proposalId: proposal.proposalId }] });
    expect(submitted).not.toHaveProperty('receipt'); expect(submitted).not.toHaveProperty('operationId');
    runtime.armFault('proposalWithdraw');
    expect((await room(runtime, 'proposalWithdraw', h, 101, { expectedRoomEpoch: host.roomEpoch }, host.roomId, 'new', proposal.proposalId)).status).toBe(403);
    await expect(room(runtime, 'proposalWithdraw', m, 202, { expectedRoomEpoch: host.roomEpoch }, host.roomId, 'new', proposal.proposalId)).rejects.toMatchObject({ code: 'ECONNRESET' });
    const withdrawn = await success(room(runtime, 'session', m, 202, undefined, host.roomId));
    expect(withdrawn.snapshot.proposals).toEqual([]);
    expect(withdrawn.snapshot.revision).toBe(snapshot.revision);
    expect(withdrawn.snapshot.controlSeq).toBe(submitted.snapshot.controlSeq + 1);
    const next = { ...proposal, proposalId: 'resolve-receipt-loss' };
    await success(room(runtime, 'proposalSubmit', m, 202, next, host.roomId));
    const intent = { expectedRoomEpoch: host.roomEpoch, resolution: 'accept-selected', selectedChangeIds: ['guidance'] };
    runtime.armFault('proposalResolve');
    expect((await room(runtime, 'proposalResolve', m, 202, intent, host.roomId, 'new', next.proposalId)).status).toBe(403);
    await expect(room(runtime, 'proposalResolve', h, 101, intent, host.roomId, 'new', next.proposalId)).rejects.toMatchObject({ code: 'ECONNRESET' });
    const resolved = await success(room(runtime, 'session', h, 101, undefined, host.roomId));
    expect(resolved.snapshot).toMatchObject({ revision: snapshot.revision + 1, proposals: [], sharedConfig: { userGuidance: proposal.changes[0]!.value } });
    await success(room(runtime, 'session', m, 202, undefined, host.roomId));
    expect(runtime.observations().trace.filter(entry => entry.kind === 'room-http' && entry.operation.startsWith('proposal'))).toEqual([
      { kind: 'room-http', operation: 'proposalSubmit', status: 403, dropped: false },
      { kind: 'room-http', operation: 'proposalSubmit', status: 200, dropped: true },
      { kind: 'room-http', operation: 'proposalWithdraw', status: 403, dropped: false },
      { kind: 'room-http', operation: 'proposalWithdraw', status: 200, dropped: true },
      { kind: 'room-http', operation: 'proposalSubmit', status: 200, dropped: false },
      { kind: 'room-http', operation: 'proposalResolve', status: 403, dropped: false },
      { kind: 'room-http', operation: 'proposalResolve', status: 200, dropped: true },
    ]);
  });

  it.each(['proposalSubmit', 'proposalWithdraw', 'proposalResolve'] as const)('rejects one %s before business and does not consume unsupported fault for invalid protocol or owner', async (operation) => {
    const { runtime, h, m, host, proposal } = await joinedRoom();
    if (operation !== 'proposalSubmit') await success(room(runtime, 'proposalSubmit', m, 202, proposal, host.roomId));
    const before = await success(room(runtime, 'session', h, 101, undefined, host.roomId));
    const userId = operation === 'proposalResolve' ? 101 : 202; const cookie = userId === 101 ? h : m;
    const body = operation === 'proposalSubmit' ? proposal : operation === 'proposalWithdraw'
      ? { expectedRoomEpoch: host.roomEpoch } : { expectedRoomEpoch: host.roomEpoch, resolution: 'reject' };
    const endpoint = DESKTOP_ROOM_SESSION_OPERATIONS[operation].path.replace(':roomId', host.roomId).replace(':proposalId', proposal.proposalId);
    runtime.armFault('proposal-unsupported');
    expect((await request(runtime, endpoint, { body: {}, headers: { ...headers(userId, cookie), 'x-mahoshojo-desktop-room-protocol': 'invalid' } })).status).toBe(404);
    for (const owner of ['invalid', 'v1:0202', 'v1:9007199254740992']) {
      const malformed = await request(runtime, endpoint, { body: {}, headers: { ...headers(userId, cookie), 'x-mahoshojo-room-expected-user-id': owner } });
      expect(malformed.status).toBe(400);
      expect(JSON.parse(malformed.text).error.code).toBe('ROOM_DESKTOP_PROTOCOL_INVALID');
    }
    const rejected = await room(runtime, operation, cookie, userId, body, host.roomId, 'new', proposal.proposalId);
    expect(rejected.status).toBe(400);
    expect(rejected.parsed).toMatchObject({ desktopRoom: { viewerUserId: null }, error: { code: 'ROOM_DESKTOP_OPERATION_UNSUPPORTED', outcome: 'not-applied' } });
    expect((await success(room(runtime, 'session', h, 101, undefined, host.roomId))).snapshot).toEqual(before.snapshot);
    const applied = await success(room(runtime, operation, cookie, userId, body, host.roomId, 'new', proposal.proposalId));
    expect(applied.status).toBe(operation === 'proposalSubmit' ? 'submitted' : operation === 'proposalWithdraw' ? 'withdrawn' : 'rejected');
  });

  it('accepts canonical encoded Unicode proposal IDs and refuses encoded path injection without mutations', async () => {
    const { runtime, h, m, host, proposal } = await joinedRoom();
    const unicode = { ...proposal, proposalId: '提案 ?#:+&=!' };
    await success(room(runtime, 'proposalSubmit', m, 202, unicode, host.roomId));
    const before = await success(room(runtime, 'session', h, 101, undefined, host.roomId));
    for (const encoded of ['%2Fother', '%5Cother', '%252Fother', '%252e%252e', '%20trimmed%20', '%ED%A0%80', '%E0%A4%A', 'one/two']) {
      const endpoint = `/api/arena/rooms/v1/${host.roomId}/proposals/${encoded}/withdraw`;
      expect((await request(runtime, endpoint, { headers: headers(202, m), body: {} })).status).toBe(404);
    }
    for (const unsafe of ['../resolve', 'a/b', 'a\\b', '%2Fhidden', '..', '.']) {
      expect((await room(runtime, 'proposalSubmit', m, 202, { ...proposal, proposalId: unsafe }, host.roomId)).status).toBe(400);
    }
    expect((await success(room(runtime, 'session', h, 101, undefined, host.roomId))).snapshot).toEqual(before.snapshot);
    const withdrawn = await success(room(runtime, 'proposalWithdraw', m, 202, { expectedRoomEpoch: host.roomEpoch }, host.roomId, 'new', unicode.proposalId));
    expect(withdrawn.status).toBe('withdrawn'); expect(withdrawn).not.toHaveProperty('snapshot');
  });

  it('serves only fixed random/fresh public character reads and verifies real references without token CAS', async () => {
    const { runtime, h, m, host, proposal } = await joinedRoom();
    const random = await request(runtime, '/api/random-public-card?type=character', { auth: true });
    const fresh = await request(runtime, `/api/public-data-cards?id=${ROOM_ACCEPTANCE_PUBLIC_CHARACTER.id}`, { auth: true });
    expect(random.status).toBe(200); expect(fresh.status).toBe(200);
    expect(JSON.parse(random.text)).toEqual(JSON.parse(fresh.text));
    expect(JSON.parse(fresh.text)).toEqual({ success: true, card: ROOM_ACCEPTANCE_PUBLIC_CHARACTER });
    expect(ROOM_ACCEPTANCE_PUBLIC_CHARACTER).toMatchObject({ type: 'character', is_public: 1, review_status: 'approved', deleted_at: null });
    expect(runtime.observations().trace.filter(entry => entry.kind === 'public-card')).toEqual([
      { kind: 'public-card', operation: 'random', status: 200 }, { kind: 'public-card', operation: 'read', status: 200 },
    ]);
    for (const endpoint of ['/api/random-public-card', '/api/random-public-card?type=scenario', '/api/random-public-card?type=character&type=character',
      '/api/random-public-card?type=character&url=https://example.com', '/api/public-data-cards', '/api/public-data-cards?id=unknown',
      `/api/public-data-cards?id=${ROOM_ACCEPTANCE_PUBLIC_CHARACTER.id}&id=${ROOM_ACCEPTANCE_PUBLIC_CHARACTER.id}`, '/api/public-data-cards?url=https://example.com']) {
      expect((await request(runtime, endpoint, { auth: true })).status).toBe(404);
    }
    for (const endpoint of ['/api/random-public-card?type=character', `/api/public-data-cards?id=${ROOM_ACCEPTANCE_PUBLIC_CHARACTER.id}`]) {
      expect((await request(runtime, endpoint, { auth: true, body: {} })).status).toBe(404);
      expect((await request(runtime, endpoint, { auth: true, method: 'HEAD' })).status).toBe(404);
      expect((await request(runtime, endpoint)).status).toBe(404);
    }
    const change = { changeId: 'character', type: 'addCombatant', ref: { id: ROOM_ACCEPTANCE_PUBLIC_CHARACTER.id, kind: 'character', versionToken: 'earlier-observation' }, expectedBase: { kind: 'absent' } };
    const before = await success(room(runtime, 'session', h, 101, undefined, host.roomId));
    for (const changes of [[{ ...change, ref: { ...change.ref, id: 'unknown-card' } }],
      [{ type: 'setScenario', changeId: 'scenario', ref: { ...change.ref, kind: 'scenario' }, expectedBase: { kind: 'ref', ref: null } }]]) {
      const rejected = await room(runtime, 'proposalSubmit', m, 202, { ...proposal, changes }, host.roomId);
      expect(rejected.status).toBe(409);
      expect(rejected.parsed).toMatchObject({ error: { code: 'ROOM_CONFLICT', message: expect.stringContaining('数据卡不可用于当前房间') } });
    }
    expect((await success(room(runtime, 'session', h, 101, undefined, host.roomId))).snapshot).toEqual(before.snapshot);
    await success(room(runtime, 'proposalSubmit', m, 202, { ...proposal, changes: [change] }, host.roomId));
    const resolved = await success(room(runtime, 'proposalResolve', h, 101, { expectedRoomEpoch: host.roomEpoch,
      resolution: 'accept-selected', selectedChangeIds: ['character'] }, host.roomId, 'new', proposal.proposalId));
    expect(resolved.sharedConfig.combatants).toEqual([{ key: `data-card:${change.ref.id}`, ref: change.ref }]);
    expect(JSON.stringify(runtime.observations())).not.toContain('earlier-observation');
    expect(JSON.stringify(runtime.observations())).not.toContain(ROOM_ACCEPTANCE_PUBLIC_CHARACTER.data);
  });

  it('uses the released preset resolver and exact content digest for submit and host resolve', async () => {
    const { runtime, h, m, host, proposal } = await joinedRoom();
    const ref = ARENA_ROOM_GENERATION_PRESET_REFS.find(entry => entry.kind === 'character')!;
    const change = { changeId: 'preset', type: 'addCombatant', key: `preset:${ref.id}`, ref, expectedBase: { kind: 'absent' } };
    const stale = await room(runtime, 'proposalSubmit', m, 202, { ...proposal, changes: [{ ...change, ref: { ...ref, versionToken: 'sha256:wrong' } }] }, host.roomId);
    expect(stale.status).toBe(409);
    expect(stale.parsed).toMatchObject({ error: { code: 'ROOM_CONFLICT', message: expect.stringContaining('数据卡已更新') } });
    await success(room(runtime, 'proposalSubmit', m, 202, { ...proposal, changes: [change] }, host.roomId));
    const resolved = await success(room(runtime, 'proposalResolve', h, 101, { expectedRoomEpoch: host.roomEpoch,
      resolution: 'accept-selected', selectedChangeIds: ['preset'] }, host.roomId, 'new', proposal.proposalId));
    expect(resolved.sharedConfig.combatants).toEqual([{ key: change.key, ref }]);
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

  it('refuses default/unnegotiated/generation/kick paths and unknown controls with bounded safe trace', async () => {
    const runtime = await start(); const cookie = await login(runtime, 101);
    expect(ROOM_ACCEPTANCE_OPERATIONS).toEqual(['discover', 'create', 'join', 'session', 'ticket', 'leave', 'close', 'config', 'proposalSubmit', 'proposalWithdraw', 'proposalResolve', 'generationRead']);
    for (const path of ['/api/arena/generate-stream', '/api/arena/rooms/v1/room-1/generations', '/api/arena/rooms/v1/room-1/generations/generation-1/cancel', '/api/arena/rooms/v1/room-1/members/member-1/kick', '/api/arena/rooms/v1/room-1/unknown']) {
      expect((await request(runtime, path, { body: {}, headers: headers(101, cookie) })).status).toBe(404);
    }
    expect((await request(runtime, '/api/arena/rooms/v1/room-1/config', { headers: headers(101, cookie) })).status).toBe(404);
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

describe.sequential('Desktop current generation acceptance fixture', () => {
  it('runs a separately opted-in cancellation self-check with no generation start or model dispatch', async () => {
    const runtime = await start();
    expect(await selfCheckRoomAcceptanceMock(runtime, pki, true)).toMatchObject({ generationCancel: true, generationReadOnly: false, roomGenerationRead: true });
    expect(runtime.observations().generation).toMatchObject({ cancelEnabled: true, cancelDispatches: 0, startDispatches: 0, modelDispatches: 0 });
  });
  it('defaults to read-only and separately proves host cancellation, bounded receipt, waiting and terminal GET', async () => {
    const context = await joinedRoom(), { runtime, host, h, m } = context;
    await runtime.generation('seed-large');
    const current = await success(room(runtime, 'session', h, 101, undefined, host.roomId));
    const generationId = current.snapshot.activeGeneration.generationId;
    const cancel = (cookie: string, userId: number) => room(runtime, 'generationCancel', cookie, userId, { expectedRoomEpoch: host.roomEpoch }, host.roomId, 'new', '', generationId);
    await expect(cancel(h, 101)).rejects.toThrow('ROOM_DESKTOP_RESPONSE_INVALID');
    expect(runtime.observations().generation.cancelDispatches).toBe(0);
    await expect(runtime.generation('cancel-wait')).rejects.toThrow();
    runtime.enableGenerationCancel();
    expect((await cancel(m, 202)).status).toBe(403);
    expect(runtime.observations().generation.cancelDispatches).toBe(0);
    await runtime.generation('cancel-wait');
    const receipt = await success(cancel(h, 101));
    expect(receipt.status).toBe('running'); expect(receipt).not.toHaveProperty('markdown');
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(256 * 1024);
    expect((await success(room(runtime, 'generationRead', h, 101, undefined, host.roomId, 'new', '', generationId))).status).toBe('running');
    await runtime.generation('cancel-complete');
    expect(await success(room(runtime, 'generationRead', h, 101, undefined, host.roomId, 'new', '', generationId))).toMatchObject({ status: 'cancelled', finalAuthoritative: false });
    expect(runtime.observations().generation).toMatchObject({ fixture: 'cancelled', cancelDispatches: 1, startDispatches: 0, modelDispatches: 0 });
  });

  const read = (runtime: RoomAcceptanceRuntime, cookie: string, userId: number, roomId: string, generationId: string) =>
    room(runtime, 'generationRead', cookie, userId, undefined, roomId, 'new', '', generationId);
  const seed = async (context: Awaited<ReturnType<typeof joinedRoom>>, large = false) => {
    await context.runtime.generation(large ? 'seed-large' : 'seed');
    return (await success(room(context.runtime, 'session', context.h, 101, undefined, context.host.roomId))).snapshot.activeGeneration.generationId as string;
  };
  it('shares the frozen scenarios and refuses absent, ambiguous, active or cross-room fixture replacement', async () => {
    expect(ROOM_ACCEPTANCE_GENERATION_SCENARIOS).toEqual([...ROOM_GENERATION_SCENARIOS, 'cancel-wait', 'cancel-complete']);
    const runtime = await start();
    expect(runtime.observations().generation).toEqual({ fixture: 'none', readHeld: false, cancelEnabled: false, readRequests: 0, readDispatches: 0,
      startRequests: 0, cancelRequests: 0, modelRequests: 0, startDispatches: 0, cancelDispatches: 0, modelDispatches: 0,
      deltaFrames: 0, droppedFrames: 0, disconnections: 0 });
    for (const scenario of [...ROOM_ACCEPTANCE_GENERATION_SCENARIOS, 'arbitrary-url']) await expect(runtime.generation(scenario as never)).rejects.toThrow('ACCEPTANCE_CONTROL_REFUSED');
    const h = await login(runtime, 101), m = await login(runtime, 202);
    const host = await success(room(runtime, 'create', h, 101, creation()));
    await expect(runtime.generation('seed')).rejects.toThrow('ACCEPTANCE_CONTROL_REFUSED');
    await success(room(runtime, 'join', m, 202, { displayName: 'Synthetic 202' }, host.roomId));
    const second = await success(room(runtime, 'create', h, 101, creation('second-active')));
    await expect(runtime.generation('seed')).rejects.toThrow('ACCEPTANCE_CONTROL_REFUSED');
    await success(room(runtime, 'close', h, 101, { expectedRoomEpoch: second.roomEpoch }, second.roomId));
    await runtime.generation('seed');
    const before = await success(room(runtime, 'session', h, 101, undefined, host.roomId));
    await expect(runtime.generation('seed-large')).rejects.toThrow('ACCEPTANCE_CONTROL_REFUSED');
    expect((await success(room(runtime, 'session', h, 101, undefined, host.roomId))).snapshot).toEqual(before.snapshot);
    await runtime.generation('complete');
    await success(room(runtime, 'close', h, 101, { expectedRoomEpoch: host.roomEpoch }, host.roomId));
    const next = await success(room(runtime, 'create', h, 101, creation('third-active')));
    await success(room(runtime, 'join', m, 202, { displayName: 'Synthetic 202' }, next.roomId));
    await expect(runtime.generation('seed')).rejects.toThrow('ACCEPTANCE_CONTROL_REFUSED');
  });
  it('serves exact 1 MiB UTF-8 only after owner, active member and canonical current-generation checks', async () => {
    const context = await joinedRoom(), { runtime, h, m, host } = context;
    const generationId = await seed(context, true);
    const response = await read(runtime, m, 202, host.roomId, generationId), view = JSON.parse(response.text).result;
    expect(response.status).toBe(200); expect(Buffer.byteLength(response.text)).toBeGreaterThan(256 * 1024);
    expect(Buffer.byteLength(view.markdown)).toBe(ROOM_ACCEPTANCE_GENERATION_LARGE_BYTES);
    expect(view.markdown.endsWith(ROOM_ACCEPTANCE_GENERATION_TAIL)).toBe(true);
    expect(view).toMatchObject({ status: 'running', finalAuthoritative: false, nextChunkSeq: 0, generation: { participantUserIds: [101, 202], generationId } });
    const path = `/api/arena/rooms/v1/${host.roomId}/generations/${generationId}`, before = runtime.observations().generation.readDispatches;
    expect((await request(runtime, path, { headers: headers(202, h) })).status).toBe(409);
    for (const suffix of ['?view=history', '?view=current', '?x=1', '/history']) expect((await request(runtime, path + suffix, { headers: headers(101, h) })).status).toBe(404);
    for (const encoded of ['%61cceptance-generation-1', 'a%2Fb', 'a%5Cb', 'a%252Fb', '%20trimmed', '%ED%A0%80']) {
      expect((await request(runtime, `/api/arena/rooms/v1/${host.roomId}/generations/${encoded}`, { headers: headers(101, h) })).status).toBe(404);
    }
    expect(runtime.observations().generation.readDispatches).toBe(before);
    expect((await read(runtime, h, 101, host.roomId, 'unknown-generation')).status).toBe(404);
    await success(room(runtime, 'leave', m, 202, { expectedRoomEpoch: host.roomEpoch }, host.roomId));
    expect((await read(runtime, m, 202, host.roomId, generationId)).status).toBe(403);
    const observed = runtime.observations();
    expect(observed.generation).toMatchObject({ startDispatches: 0, cancelDispatches: 0, modelDispatches: 0 });
    for (const value of [h, m, ROOM_ACCEPTANCE_GENERATION_TAIL, generationId]) expect(JSON.stringify(observed)).not.toContain(value);
  });
  it('keeps actor frames contiguous, drops a transport frame per fixture peer, and recovers WSS and final GET', async () => {
    const context = await joinedRoom(), { runtime, h, m, host } = context;
    const connections: ReturnType<typeof open>[] = [];
    for (const [cookie, userId] of [[h, 101], [m, 202]] as const) {
      const ticket = await success(room(runtime, 'ticket', cookie, userId, {}, host.roomId));
      const connection = open(runtime, ticket.ticket); await connection.connected; connections.push(connection);
    }
    await vi.waitFor(() => { for (const connection of connections) expect(latestPresence(connection.messages)?.onlineUserIds).toHaveLength(2); });
    const generationId = await seed(context);
    await runtime.generation('delta'); await runtime.generation('gap');
    await vi.waitFor(() => { for (const connection of connections) expect(connection.messages.filter(message => message.type === 'story.delta')).toHaveLength(2); });
    for (const connection of connections) expect(connection.messages.flatMap(message => message.type === 'story.delta' ? [message.chunkSeq] : [])).toEqual([0, 2]);
    const recovered = await success(read(runtime, h, 101, host.roomId, generationId));
    expect(recovered).toMatchObject({ nextChunkSeq: 3, finalAuthoritative: false });
    expect(recovered.markdown).toContain('受控缺口（仅传输丢帧）');
    expect(runtime.observations().generation).toMatchObject({ deltaFrames: 3, droppedFrames: 2 });
    await runtime.generation('disconnect');
    await expect(runtime.generation('disconnect')).rejects.toThrow('ACCEPTANCE_CONTROL_REFUSED');
    await expect(runtime.generation('gap')).rejects.toThrow('ACCEPTANCE_CONTROL_REFUSED');
    expect(runtime.observations().generation).toMatchObject({ disconnections: 2, deltaFrames: 3, droppedFrames: 2 });
    await vi.waitFor(() => { for (const connection of connections) expect(connection.socket.readyState).toBe(WebSocket.CLOSED); });
    const ticket = await success(room(runtime, 'ticket', m, 202, {}, host.roomId)), reconnected = open(runtime, ticket.ticket); await reconnected.connected;
    await vi.waitFor(() => expect(reconnected.messages.some(message => message.type === 'room.snapshot')).toBe(true));
    expect((await success(read(runtime, m, 202, host.roomId, generationId))).markdown).toBe(recovered.markdown);
    await runtime.generation('complete');
    await vi.waitFor(() => expect(reconnected.messages.some(message => message.type === 'generation.completed')).toBe(true));
    expect(await success(read(runtime, m, 202, host.roomId, generationId))).toMatchObject({ status: 'completed', finalAuthoritative: true,
      markdown: recovered.markdown, result: { version: 1, format: 'stream-markdown', mode: 'classic' } });
    expect(runtime.observations().generation).toMatchObject({ fixture: 'completed', startDispatches: 0, cancelDispatches: 0, modelDispatches: 0 });
    await expect(runtime.generation('delta')).rejects.toThrow('ACCEPTANCE_CONTROL_REFUSED');
  });
  it('holds one authorized old response without rebinding it to a new generation, account membership or room', async () => {
    const context = await joinedRoom(), { runtime, h, m, host } = context, generationId = await seed(context);
    await runtime.generation('hold-read');
    const pending = read(runtime, m, 202, host.roomId, generationId);
    await vi.waitFor(() => expect(runtime.observations().generation.readHeld).toBe(true));
    await expect(runtime.generation('hold-read')).rejects.toThrow('ACCEPTANCE_CONTROL_REFUSED');
    expect((await read(runtime, h, 101, host.roomId, generationId)).status).toBe(503);
    await runtime.generation('complete'); await runtime.generation('seed-large');
    const next = await success(room(runtime, 'session', h, 101, undefined, host.roomId));
    const other = await success(room(runtime, 'create', h, 101, creation('late-other-room')));
    await success(room(runtime, 'leave', m, 202, { expectedRoomEpoch: host.roomEpoch }, host.roomId));
    await success(room(runtime, 'join', m, 202, { displayName: 'Synthetic 202' }, other.roomId));
    await runtime.generation('release-read');
    const old = await success(pending);
    expect(old).toMatchObject({ roomId: host.roomId, roomEpoch: host.roomEpoch, generation: { generationId, attempt: 1 }, status: 'running', finalAuthoritative: false });
    expect(Buffer.byteLength(old.markdown)).toBeLessThan(1024); expect(runtime.observations().generation.readHeld).toBe(false);
    await expect(runtime.generation('release-read')).rejects.toThrow('ACCEPTANCE_CONTROL_REFUSED');
    expect((await read(runtime, h, 101, host.roomId, generationId)).status).toBe(404);
    const fresh = await success(read(runtime, h, 101, host.roomId, next.snapshot.activeGeneration.generationId));
    expect(fresh.generation.attempt).toBe(2); expect(Buffer.byteLength(fresh.markdown)).toBe(ROOM_ACCEPTANCE_GENERATION_LARGE_BYTES);
    expect((await read(runtime, m, 202, other.roomId, fresh.generation.generationId)).status).toBe(404);
  });
  it('cancels a held read and its timer on close without retaining listeners', async () => {
    const context = await joinedRoom(), { runtime, h, host } = context, generationId = await seed(context);
    await runtime.generation('hold-read');
    const pending = read(runtime, h, 101, host.roomId, generationId).catch(() => null);
    await vi.waitFor(() => expect(runtime.observations().generation.readHeld).toBe(true));
    await runtime.close(); await pending;
    expect(runtime.observations().generation).toMatchObject({ fixture: 'none', readHeld: false });
    await expect(runtime.generation('seed')).rejects.toThrow('ACCEPTANCE_CONTROL_REFUSED');
  });
  it.each(['resolve', 'reserve-success', 'reserve-failure'] as const)('cannot resurrect a fixture when dispose crosses %s', async boundary => {
    const state = createArenaRoomState();
    const member = { ...state.snapshot.members[0]!, userId: 'member-2', role: 'member' as const };
    state.snapshot.members.push(member); state.memberAuthority.push({ ...state.memberAuthority[0]!, accountUserId: 202, member });
    let delayed = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const execute = vi.fn(async (input: RoomActorExecuteInput) => {
      if (delayed) { await gate; return { ok: boundary === 'reserve-success' }; }
      const command = input.command as { type: string; generationRequestId: string; generationId: string; attempt: number; timestamp: string; state: 'running' | 'completed' };
      if (command.type === 'reserve-generation') state.snapshot.activeGeneration = {
        generationRequestId: command.generationRequestId, generationId: command.generationId, attempt: command.attempt,
        state: 'starting', configRevision: state.snapshot.revision, snapshotDigest: `sha256:${'a'.repeat(64)}`,
        collaborativeInfluence: false, participantUserIds: [101, 202], startedAt: command.timestamp,
      };
      else state.snapshot.activeGeneration = { ...state.snapshot.activeGeneration!, state: command.state };
      return { ok: true };
    });
    const actor = { getSnapshot: () => state, execute } as unknown as RoomActor;
    const resolveActiveByAccount = vi.fn(async () => {
      if (delayed && boundary === 'resolve') await gate;
      return { roomId: state.snapshot.roomId, roomEpoch: state.snapshot.roomEpoch, accountUserId: 101,
        member: state.snapshot.members[0]!, actor, state } satisfies ResolvedArenaRoomMembership;
    });
    const helper = createRoomAcceptanceGeneration({ states: () => [state], memberships: () => ({ resolveActiveByAccount }) });
    await helper.control('seed'); await helper.control('complete');
    expect(helper.observe().fixture).toBe('completed');
    delayed = true; execute.mockClear(); resolveActiveByAccount.mockClear();
    const pending = helper.control('seed');
    await vi.waitFor(() => expect(boundary === 'resolve' ? resolveActiveByAccount : execute).toHaveBeenCalledOnce());
    helper.dispose(); release();
    await expect(pending).rejects.toThrow('ACCEPTANCE_CONTROL_REFUSED');
    expect(helper.observe()).toMatchObject({ fixture: 'none', readHeld: false });
    expect(execute).toHaveBeenCalledTimes(boundary === 'resolve' ? 0 : 1);
    await expect(helper.control('seed')).rejects.toThrow('ACCEPTANCE_CONTROL_REFUSED');
  });

  it('counts refused write/model attempts on both listeners beyond trace eviction and explicitly refuses counter overflow', async () => {
    const runtime = await start(), cookie = await login(runtime, 101);
    for (const auth of [false, true]) for (const endpoint of ['/api/arena/rooms/v1/room-1/generations', '/api/arena/rooms/v1/room-1/generations/generation-1/cancel',
      '/api/arena/generate-stream?format=sse', '/api/arena/session/generate-next', '/api/creator/generate', '/api/creator/generate-stream']) {
      expect((await request(runtime, endpoint, { auth, body: {}, headers: headers(101, cookie) })).status).toBe(404);
    }
    for (let index = 0; index < 260; index++) await request(runtime, '/unknown');
    expect(runtime.observations().generation).toMatchObject({ startRequests: 2, cancelRequests: 2, modelRequests: 8, startDispatches: 0, cancelDispatches: 0, modelDispatches: 0 });
    const helper = createRoomAcceptanceGeneration({ states: () => [], memberships: () => ({ resolveActiveByAccount: vi.fn() }) });
    const attempt = new Request('https://room.acceptance.invalid/api/arena/generate-stream', { method: 'POST' });
    for (let index = 0; index < 65_536; index++) helper.recordRequest(attempt);
    expect(() => helper.recordRequest(attempt)).toThrow('ACCEPTANCE_CONTROL_REFUSED');
    expect(helper.observe().modelRequests).toBe(65_536); expect(helper.observe().modelDispatches).toBe(0); helper.dispose();
  });
});
