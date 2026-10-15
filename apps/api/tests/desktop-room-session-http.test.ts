import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import fixture from '@mahoshojo/contracts/fixtures/desktop-room-session.json';
import {
  DESKTOP_ROOM_SESSION_LIMITS,
  DESKTOP_ROOM_SESSION_OPERATIONS,
  DESKTOP_ROOM_SESSION_PROTOCOL_VERSION,
  DesktopRoomSessionErrorResponseSchema,
  parseDesktopRoomSessionResponse,
  type DesktopRoomSessionOperation,
} from '@mahoshojo/contracts/desktop-room-session';
import {
  ArenaRoomCreateRequestSchema,
  ArenaRoomPublishConfigRequestSchema,
  ArenaRoomSessionResponseSchema,
  RoomDirectoryPageSchema,
  RoomEventSchema,
} from '@mahoshojo/contracts/arena-room';
import { createHonoApp } from '#/app';
import type { HonoServerConfig } from '#/config';
import type { RedisService } from '#/redis/runtime';
import type { ArenaRoomHttpDependencies } from '#/arena-room/room-http';
import { ArenaRoomMembershipError } from '#/arena-room/room-membership-service';
import { ArenaRoomConfigError } from '#/arena-room/room-config-service';
import { createArenaRoomState } from './arena-room-fixtures';

const config: HonoServerConfig = {
  arenaMultiplayerEnabled: true, host: '127.0.0.1', port: 8787, nodeEnv: 'test',
  redisUrl: 'redis://127.0.0.1:6379', redisKeyPrefix: 'test', redisRequired: true,
  d1Required: false, corsOrigins: ['http://localhost:3000'],
  arenaRoomAllowedOrigins: ['http://localhost:3000'], authMode: 'hybrid',
};
const allow = () => ({ allowed: true, limit: 30, remaining: 29, retryAfterSeconds: 1 });
const redis = (): RedisService => ({
  connect: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  getStatus: vi.fn(() => ({ configured: true, connected: true, ready: true, lastError: null })),
  ping: vi.fn(async () => true), consumeFixedWindow: vi.fn(async () => allow()),
});
const snapshot = createArenaRoomState().snapshot;
const session = { roomId: snapshot.roomId, roomEpoch: snapshot.roomEpoch, member: snapshot.members[0]!, snapshot };
const createBody = {
  creationRequestId: 'desktop-create-original-1', displayName: 'Host',
  directory: { title: 'Room', visibility: 'unlisted' as const }, sharedConfig: snapshot.sharedConfig,
};
const configBody = {
  expectedRoomEpoch: snapshot.roomEpoch,
  expectedRevision: snapshot.revision,
  expectedControlSeq: snapshot.controlSeq,
  sharedConfig: snapshot.sharedConfig,
};
const fixtureSession = fixture.operations.session.success.result;
const operationFixtures = {
  ...fixture.operations,
  config: {
    method: 'POST',
    path: DESKTOP_ROOM_SESSION_OPERATIONS.config.path.replace(':roomId', fixtureSession.roomId),
    request: {
      desktopRoom: fixture.operations.join.request.desktopRoom,
      request: {
        expectedRoomEpoch: fixtureSession.roomEpoch,
        expectedRevision: fixtureSession.snapshot.revision,
        expectedControlSeq: fixtureSession.snapshot.controlSeq,
        sharedConfig: fixtureSession.snapshot.sharedConfig,
      },
    },
    success: fixture.operations.session.success,
    error: fixture.operations.join.error,
  },
};
const headers = {
  origin: 'http://localhost:3000', cookie: 'better-auth.session_token=synthetic-room-session',
  'content-type': 'application/json',
  'x-mahoshojo-desktop-room-protocol': DESKTOP_ROOM_SESSION_PROTOCOL_VERSION,
  'x-mahoshojo-room-expected-user-id': 'v1:101',
};
const wrap = (request: unknown, createMode?: 'new' | 'resume-only') => ({
  desktopRoom: {
    version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, expectedUserId: 101,
    ...(createMode === undefined ? {} : { createMode }),
  }, request,
});
const inputFor = (operation: DesktopRoomSessionOperation) => {
  if (operation === 'create') return wrap(createBody, 'new');
  if (operation === 'join') return wrap({ displayName: 'Member' });
  if (operation === 'ticket') return wrap({});
  if (operation === 'config') return wrap(configBody);
  if (operation === 'leave' || operation === 'close') return wrap({ expectedRoomEpoch: snapshot.roomEpoch });
  return undefined;
};
const pathFor = (operation: DesktopRoomSessionOperation) => (
  DESKTOP_ROOM_SESSION_OPERATIONS[operation].path.replace(':roomId', snapshot.roomId)
);
const depsFor = (): ArenaRoomHttpDependencies => ({
  resolveAuthentication: vi.fn(async () => ({ status: 'authenticated' as const, userId: 101 })),
  memberships: {
    hasCreationReceipt: vi.fn(async () => false),
    create: vi.fn(async () => session), join: vi.fn(async () => session),
    getSession: vi.fn(async () => session),
    leave: vi.fn(async () => ({ ...session, member: { ...session.member, role: 'member' as const } })),
    close: vi.fn(async () => session), kick: vi.fn(async () => session),
  },
  directory: { discoverPublic: vi.fn(async () => ({ items: [], nextCursor: null })) },
  websocketAuthority: { issue: vi.fn(async () => 'synthetic-room-ticket') },
  // Unsupported capabilities must never reach any service, even on a valid account.
  proposals: {
    submit: vi.fn(async () => { throw new Error('unexpected proposal'); }),
    resolve: vi.fn(async () => { throw new Error('unexpected proposal'); }),
    withdraw: vi.fn(async () => { throw new Error('unexpected proposal'); }),
  },
  generations: {
    start: vi.fn(async () => { throw new Error('unexpected generation'); }),
    read: vi.fn(async () => { throw new Error('unexpected generation'); }),
    list: vi.fn(async () => { throw new Error('unexpected generation'); }),
    readHistory: vi.fn(async () => { throw new Error('unexpected generation'); }),
    cancel: vi.fn(async () => { throw new Error('unexpected generation'); }),
  },
  configs: { publish: vi.fn(async () => session) },
  rateLimit: vi.fn(async () => allow()),
});
const appFor = (deps: ArenaRoomHttpDependencies) => createHonoApp(config, redis(), undefined, { arenaRoom: deps });
const assertNoBusiness = (deps: ArenaRoomHttpDependencies) => {
  for (const group of [deps.memberships, deps.directory, deps.websocketAuthority, deps.proposals, deps.generations, deps.configs]) {
    for (const port of Object.values(group)) expect(port).not.toHaveBeenCalled();
  }
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const operations = Object.keys(DESKTOP_ROOM_SESSION_OPERATIONS) as DesktopRoomSessionOperation[];
const requestFor = (operation: DesktopRoomSessionOperation) => ({
  method: DESKTOP_ROOM_SESSION_OPERATIONS[operation].method,
  headers,
  ...(inputFor(operation) === undefined ? {} : { body: JSON.stringify(inputFor(operation)) }),
});

describe('Desktop opt-in through the existing Room HTTP producer', () => {
  it.each(operations)('%s shared fixture equals actual handler JSON serialization', async (operation) => {
    const sample = operationFixtures[operation];
    const result = ArenaRoomSessionResponseSchema.parse(fixture.operations.session.success.result);
    const current = { roomId: result.roomId, roomEpoch: result.roomEpoch, member: result.self, snapshot: result.snapshot };
    const deps = depsFor();
    vi.mocked(deps.resolveAuthentication).mockResolvedValue({ status: 'authenticated', userId: fixture.expectedUserId });
    for (const port of [deps.memberships.create, deps.memberships.join, deps.memberships.getSession, deps.configs.publish]) {
      vi.mocked(port).mockResolvedValue(current);
    }
    vi.mocked(deps.memberships.close).mockResolvedValue(current);
    vi.mocked(deps.memberships.leave).mockResolvedValue({ ...current, member: { ...current.member, role: 'member' } });
    vi.mocked(deps.directory.discoverPublic).mockResolvedValue(RoomDirectoryPageSchema.parse(fixture.operations.discover.success.result));
    vi.mocked(deps.websocketAuthority.issue).mockResolvedValue(fixture.operations.ticket.success.result.ticket);
    const response = await appFor(deps).request(sample.path, {
      method: sample.method, headers: { ...headers, ...fixture.headers },
      ...(sample.request === null ? {} : { body: JSON.stringify(sample.request) }),
    });
    expect(response.status).toBe(operation === 'create' ? 201 : 200);
    const text = await response.text();
    expect(text).toBe(JSON.stringify(sample.success));
    expect(parseDesktopRoomSessionResponse(operation, JSON.parse(text), fixture.expectedUserId)).toEqual(sample.success);
    const output = process.env.DESKTOP_ROOM_SESSION_HTTP_WIRE_OUTPUT;
    if (output) {
      mkdirSync(output, { recursive: true });
      writeFileSync(path.join(output, `${operation}.response.json`), text);
      if (sample.request !== null) writeFileSync(path.join(output, `${operation}.request.json`), JSON.stringify(sample.request));
    }
  });

  it.each(operations)('%s shared error fixture equals the actual paired rate-limit serializer', async (operation) => {
    const sample = operationFixtures[operation];
    const deps = depsFor();
    vi.mocked(deps.resolveAuthentication).mockResolvedValue({ status: 'authenticated', userId: fixture.expectedUserId });
    vi.mocked(deps.rateLimit).mockResolvedValue({ ...allow(), allowed: false, remaining: 0, retryAfterSeconds: 3 });
    const response = await appFor(deps).request(sample.path, {
      method: sample.method, headers: { ...headers, ...fixture.headers },
      ...(sample.request === null ? {} : { body: JSON.stringify(sample.request) }),
    });
    expect(response.status).toBe(429);
    const text = await response.text();
    expect(text).toBe(JSON.stringify(sample.error));
    expect(parseDesktopRoomSessionResponse(operation, JSON.parse(text), fixture.expectedUserId)).toEqual(sample.error);
    assertNoBusiness(deps);
    const output = process.env.DESKTOP_ROOM_SESSION_HTTP_WIRE_OUTPUT;
    if (output) {
      mkdirSync(output, { recursive: true });
      writeFileSync(path.join(output, `${operation}.error.json`), text);
    }
  });

  it('unpaired owner mismatch fixture is an actual safe response without the other numeric account', async () => {
    const deps = depsFor();
    vi.mocked(deps.resolveAuthentication).mockResolvedValue({ status: 'authenticated', userId: 202 });
    const sample = fixture.operations.join;
    const response = await appFor(deps).request(sample.path, { method: sample.method, headers: { ...headers, ...fixture.headers }, body: JSON.stringify(sample.request) });
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).toBe(JSON.stringify(fixture.unpairedOwnerMismatch));
    assertNoBusiness(deps);
    const output = process.env.DESKTOP_ROOM_SESSION_HTTP_WIRE_OUTPUT;
    if (output) {
      mkdirSync(output, { recursive: true });
      writeFileSync(path.join(output, 'owner-mismatch.error.json'), text);
    }
  });

  it.each(operations)('%s uses paired numeric owner and the original operation response', async (operation) => {
    const deps = depsFor();
    const response = await appFor(deps).request(pathFor(operation), requestFor(operation));
    expect(response.status).toBe(operation === 'create' ? 201 : 200);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(text).toBe(JSON.stringify(body));
    expect(parseDesktopRoomSessionResponse(operation, body, 101)).toEqual(body);
    expect(body.desktopRoom).toEqual({ version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, viewerUserId: 101 });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(deps.resolveAuthentication).toHaveBeenCalledOnce();
    expect(deps.rateLimit).toHaveBeenCalledWith(expect.objectContaining({ operation: operation === 'config' ? 'configPublish' : operation, accountUserId: 101 }));
    if (operation === 'config') expect(deps.configs.publish).toHaveBeenCalledWith({ roomId: snapshot.roomId, accountUserId: 101, request: configBody });
    if (operation === 'create') {
      expect(deps.memberships.create).toHaveBeenCalledWith({ accountUserId: 101, requireExistingCreationReceipt: false, ...createBody });
    }
    if (operation === 'ticket') expect(body.result.ticket).toBe('synthetic-room-ticket');
    if (operation === 'leave') expect(body.result.outcome).toBe('left');
    if (operation === 'close') expect(body.result.outcome).toBe('closed');
  });

  it.each(operations)('%s wrong owner refuses before operation limit, receipt, recovery and all Room services', async (operation) => {
    const deps = depsFor();
    vi.mocked(deps.resolveAuthentication).mockResolvedValue({ status: 'authenticated', userId: 202 });
    const response = await appFor(deps).request(pathFor(operation), requestFor(operation));
    expect(response.status).toBe(409);
    const text = await response.text();
    const body = DesktopRoomSessionErrorResponseSchema.parse(JSON.parse(text));
    expect(body.desktopRoom.viewerUserId).toBeNull();
    expect(body.error.code).toBe('ROOM_DESKTOP_OWNER_MISMATCH');
    expect(body.error.outcome).toBe(operation === 'discover' || operation === 'session' ? 'not-applicable' : 'not-applied');
    expect(text).not.toContain('202');
    expect(deps.rateLimit).not.toHaveBeenCalled();
    assertNoBusiness(deps);
  });

  it.each([
    'proposals', 'proposals/proposal-1/resolve', 'proposals/proposal-1/withdraw',
    'members/member-1/kick', 'generations', 'generations/generation-1/cancel',
  ])('unsupported POST %s rejects any negotiation marker instead of legacy fallback', async (suffix) => {
    for (const markers of [headers, { ...headers, 'x-mahoshojo-desktop-room-protocol': '' }, { ...headers, 'x-mahoshojo-room-expected-user-id': '' }]) {
      const deps = depsFor();
      const response = await appFor(deps).request(`/api/arena/rooms/v1/room-1/${suffix}`, {
        method: 'POST', headers: markers, body: JSON.stringify(wrap({})),
      });
      expect(response.status).toBe(400);
      expect(deps.resolveAuthentication).not.toHaveBeenCalled();
      expect(deps.rateLimit).not.toHaveBeenCalled();
      assertNoBusiness(deps);
    }
  });

  it.each(['generations', 'generations/generation-1', 'generations/generation-1/history'])('unsupported GET %s refuses before service reads', async (suffix) => {
    const deps = depsFor();
    const response = await appFor(deps).request(`/api/arena/rooms/v1/room-1/${suffix}`, { headers });
    expect(response.status).toBe(400);
    assertNoBusiness(deps);
    expect(deps.resolveAuthentication).not.toHaveBeenCalled();
  });

  it.each([
    { ...headers, 'x-mahoshojo-desktop-room-protocol': 'future-version' },
    { ...headers, 'x-mahoshojo-desktop-room-protocol': '' },
    { ...headers, 'x-mahoshojo-room-expected-user-id': '' },
    { ...headers, 'x-mahoshojo-room-expected-user-id': 'v1:01' },
    { ...headers, 'x-mahoshojo-room-expected-user-id': 'v1:9007199254740992' },
  ])('invalid or half-present headers cannot reach authentication/business', async (invalidHeaders) => {
    const deps = depsFor();
    const response = await appFor(deps).request(pathFor('join'), { method: 'POST', headers: invalidHeaders, body: JSON.stringify(inputFor('join')) });
    expect(response.status).toBe(400);
    expect(DesktopRoomSessionErrorResponseSchema.parse(await response.json()).error.code).toBe('ROOM_DESKTOP_PROTOCOL_INVALID');
    expect(deps.resolveAuthentication).not.toHaveBeenCalled();
    assertNoBusiness(deps);
  });

  it.each([
    { displayName: 'Plain legacy body' },
    { ...wrap({ displayName: 'Member' }), unknown: true },
    { ...wrap({ displayName: 'Member' }), desktopRoom: { version: 'future', expectedUserId: 101 } },
    { ...wrap({ displayName: 'Member' }), desktopRoom: { version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, expectedUserId: 202 } },
    { ...wrap({ displayName: 'Member' }), desktopRoom: { version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, expectedUserId: 101, createMode: 'new' } },
    wrap({ displayName: 'Member', cookie: 'must-not-be-a-port' }),
    [], null,
  ])('invalid or mismatched POST envelope is explicitly not applied', async (body) => {
    const deps = depsFor();
    const response = await appFor(deps).request(pathFor('join'), { method: 'POST', headers, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(DesktopRoomSessionErrorResponseSchema.parse(await response.json()).error.outcome).toBe('not-applied');
    assertNoBusiness(deps);
    expect(deps.resolveAuthentication).not.toHaveBeenCalled();
  });

  it.each([
    { ...configBody, expectedRoomEpoch: '' },
    { ...configBody, expectedRevision: -1 },
    { ...configBody, expectedControlSeq: Number.MAX_SAFE_INTEGER + 1 },
    { ...configBody, sharedConfig: { ...configBody.sharedConfig, providerApiKey: 'secret-canary' } },
    { ...configBody, url: 'https://untrusted.invalid', headers: {} },
    { expectedRoomEpoch: snapshot.roomEpoch, sharedConfig: snapshot.sharedConfig },
  ])('invalid config DTO is not applied before authentication, rate limiting or publish', async (request) => {
    const deps = depsFor();
    const response = await appFor(deps).request(pathFor('config'), { method: 'POST', headers, body: JSON.stringify(wrap(request)) });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain('secret-canary');
    expect(DesktopRoomSessionErrorResponseSchema.parse(JSON.parse(text))).toMatchObject({
      desktopRoom: { viewerUserId: null }, error: { code: 'ROOM_DESKTOP_PROTOCOL_INVALID', outcome: 'not-applied' },
    });
    expect(deps.resolveAuthentication).not.toHaveBeenCalled();
    expect(deps.rateLimit).not.toHaveBeenCalled();
    assertNoBusiness(deps);
  });

  it.each([
    ['ROOM_EPOCH_STALE', 409], ['ROOM_REVISION_STALE', 409], ['ROOM_TRANSITION_DENIED', 409],
    ['ROOM_PERMISSION_DENIED', 403], ['ROOM_REFERENCE_DENIED', 409], ['ROOM_REFERENCE_STALE', 409],
    ['ROOM_CONFIG_FRAME_TOO_LARGE', 413], ['ROOM_OPERATION_UNKNOWN', 503], ['ROOM_REFERENCE_UNAVAILABLE', 503],
  ] as const)('config service %s remains conservatively unknown after publish entry', async (code, status) => {
    const deps = depsFor();
    vi.mocked(deps.configs.publish).mockRejectedValue(new ArenaRoomConfigError(code));
    const response = await appFor(deps).request(pathFor('config'), requestFor('config'));
    expect(response.status).toBe(status);
    expect(DesktopRoomSessionErrorResponseSchema.parse(await response.json())).toMatchObject({
      desktopRoom: { viewerUserId: 101 }, error: { outcome: 'unknown' },
    });
    expect(deps.configs.publish).toHaveBeenCalledOnce();
    expect(deps.memberships.getSession).not.toHaveBeenCalled();
  });

  it('a malformed config service response cannot prove a not-applied result or leak private failures', async () => {
    const deps = depsFor();
    vi.mocked(deps.configs.publish).mockResolvedValue({
      ...session, snapshot: { ...snapshot, controlSeq: Number.MAX_SAFE_INTEGER + 1 },
    });
    const response = await appFor(deps).request(pathFor('config'), requestFor('config'));
    // The original session serializer rejects the unsafe counter before the adapter sees a body.
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'ROOM_UNAVAILABLE', outcome: 'unknown' } });
    vi.mocked(deps.configs.publish).mockRejectedValue(new Error('SYNTHETIC_CONFIG_SECRET'));
    const failed = await appFor(deps).request(pathFor('config'), requestFor('config'));
    const text = await failed.text();
    expect(text).not.toContain('SYNTHETIC_CONFIG_SECRET');
    expect(failed.status).toBe(503);
    expect(DesktopRoomSessionErrorResponseSchema.parse(JSON.parse(text)).error.outcome).toBe('unknown');
    expect(deps.configs.publish).toHaveBeenCalledTimes(2);
  });

  it('resume-only goes straight to the existing receipt-required service without falling back to creation budget', async () => {
    const deps = depsFor();
    vi.mocked(deps.memberships.create).mockRejectedValue(new ArenaRoomMembershipError('ROOM_CREATION_REQUEST_CONFLICT'));
    const response = await appFor(deps).request(pathFor('create'), {
      method: 'POST', headers, body: JSON.stringify(wrap(createBody, 'resume-only')),
    });
    expect(response.status).toBe(409);
    expect(deps.memberships.hasCreationReceipt).not.toHaveBeenCalled();
    expect(deps.rateLimit).toHaveBeenCalledOnce();
    expect(deps.memberships.create).toHaveBeenCalledWith({ ...createBody, accountUserId: 101, requireExistingCreationReceipt: true });
    const body = DesktopRoomSessionErrorResponseSchema.parse(await response.json());
    expect(body.error).toMatchObject({ code: 'ROOM_CONFLICT', outcome: 'unknown' });
    expect(body.desktopRoom.viewerUserId).toBe(101);
  });

  it('host leave keeps the original server closed outcome', async () => {
    const deps = depsFor();
    vi.mocked(deps.memberships.leave).mockResolvedValue(session);
    const response = await appFor(deps).request(pathFor('leave'), requestFor('leave'));
    expect(await response.json()).toMatchObject({ result: { outcome: 'closed' } });
  });

  it.each(['anonymous', 'denied', 'throw'] as const)('original %s authentication is safe, paired and does not enter Room', async (status) => {
    const deps = depsFor();
    if (status === 'throw') vi.mocked(deps.resolveAuthentication).mockRejectedValue(new Error('SECRET_COOKIE_DO_NOT_RETURN'));
    else vi.mocked(deps.resolveAuthentication).mockResolvedValue({ status });
    const response = await appFor(deps).request(pathFor('join'), requestFor('join'));
    expect(response.status).toBe(status === 'anonymous' ? 401 : status === 'denied' ? 403 : 503);
    const text = await response.text();
    expect(text).not.toContain('SECRET_COOKIE');
    expect(DesktopRoomSessionErrorResponseSchema.parse(JSON.parse(text))).toMatchObject({ desktopRoom: { viewerUserId: null }, error: { outcome: 'not-applied' } });
    expect(deps.rateLimit).not.toHaveBeenCalled();
    assertNoBusiness(deps);
  });

  it.each(['missing', 'untrusted'] as const)('cookie mutation still enforces original %s Origin policy', async (kind) => {
    const deps = depsFor();
    const input = new Headers(headers);
    if (kind === 'missing') input.delete('origin'); else input.set('origin', 'https://untrusted.invalid');
    const response = await appFor(deps).request(pathFor('join'), { ...requestFor('join'), headers: input });
    expect(response.status).toBe(403);
    assertNoBusiness(deps);
    expect(deps.resolveAuthentication).not.toHaveBeenCalled();
  });

  it('a matched owner receiving a rate-limit failure is paired but not applied', async () => {
    const deps = depsFor();
    vi.mocked(deps.rateLimit).mockResolvedValue({ ...allow(), allowed: false, remaining: 0, retryAfterSeconds: 7 });
    const response = await appFor(deps).request(pathFor('join'), requestFor('join'));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(await response.json()).toMatchObject({ desktopRoom: { viewerUserId: 101 }, error: { code: 'ROOM_RATE_LIMITED', outcome: 'not-applied', retryAfterSeconds: 7 } });
    assertNoBusiness(deps);
  });

  it('unknown errors after a POST service cannot become a not-applied receipt or leak exception text', async () => {
    const deps = depsFor();
    vi.mocked(deps.memberships.join).mockRejectedValue(new Error('SYNTHETIC_SECRET_COOKIE'));
    const response = await appFor(deps).request(pathFor('join'), requestFor('join'));
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(text).not.toContain('SYNTHETIC_SECRET');
    expect(DesktopRoomSessionErrorResponseSchema.parse(JSON.parse(text))).toMatchObject({ desktopRoom: { viewerUserId: 101 }, error: { outcome: 'unknown' } });
    expect(deps.memberships.join).toHaveBeenCalledOnce();
  });

  it.each(operations)('%s unmarked Web request keeps the original unwrapped response', async (operation) => {
    const deps = depsFor(); const h = new Headers(headers);
    h.delete('x-mahoshojo-desktop-room-protocol'); h.delete('x-mahoshojo-room-expected-user-id');
    const wrapped = inputFor(operation);
    const response = await appFor(deps).request(pathFor(operation), {
      method: DESKTOP_ROOM_SESSION_OPERATIONS[operation].method, headers: h,
      ...(wrapped ? { body: JSON.stringify(wrapped.request) } : {}),
    });
    expect(response.status).toBe(operation === 'create' ? 201 : 200);
    const body = await response.json();
    expect(body).not.toHaveProperty('desktopRoom');
    if (operation === 'discover') expect(body).toEqual({ items: [], nextCursor: null });
    else expect(body).toHaveProperty('protocolVersion', 1);
  });

  it.each(['create', 'config'] as const)('unmarked %s with Native body does not silently unwrap on the Web path', async (operation) => {
    const deps = depsFor(); const h = new Headers(headers);
    h.delete('x-mahoshojo-desktop-room-protocol'); h.delete('x-mahoshojo-room-expected-user-id');
    const response = await appFor(deps).request(pathFor(operation), { ...requestFor(operation), headers: h });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'ROOM_REQUEST_INVALID' });
    assertNoBusiness(deps);
  });
});

const maximumRequest = (operation: 'create' | 'config') => {
  const body = structuredClone(operation === 'create' ? createBody : configBody); body.sharedConfig.materials = [];
  for (let index = 0; index < 256; index += 1) {
    body.sharedConfig.materials.push({ key: `host-local:request-${index}`, displayName: '\0'.repeat(200), source: 'host-local', type: 'material' });
    if (bytes(body) > 65_536) { body.sharedConfig.materials.pop(); break; }
  }
  const padding = { key: 'host-local:request-padding', displayName: 'x', source: 'host-local' as const, type: 'material' as const };
  body.sharedConfig.materials.push(padding);
  while (bytes(body) + 6 <= 65_536 && padding.displayName.length < 200) padding.displayName += '\0';
  while (bytes(body) < 65_536 && padding.key.length < 256) padding.key += 'x';
  expect(bytes(body)).toBe(65_536);
  expect((operation === 'create' ? ArenaRoomCreateRequestSchema : ArenaRoomPublishConfigRequestSchema).safeParse(body).success).toBe(true);
  return body;
};

describe('Desktop raw budgets on the actual producer', () => {
  it.each(['create', 'config'] as const)('%s accepts exactly64KiB inner/exactly65KiB raw outer and rejects each one-byte overflow before business', async (operation) => {
    const request = maximumRequest(operation);
    const envelope = wrap(request, operation === 'create' ? 'new' : undefined); const compact = JSON.stringify(envelope);
    const raw = compact + ' '.repeat(DESKTOP_ROOM_SESSION_LIMITS.requestBodyBytes - Buffer.byteLength(compact));
    expect(Buffer.byteLength(raw)).toBe(DESKTOP_ROOM_SESSION_LIMITS.requestBodyBytes);
    const accepted = depsFor();
    expect((await appFor(accepted).request(pathFor(operation), { method: 'POST', headers, body: raw })).status).toBe(operation === 'create' ? 201 : 200);
    expect(operation === 'create' ? accepted.memberships.create : accepted.configs.publish).toHaveBeenCalledOnce();
    const oversizedOuter = depsFor();
    const outer = await appFor(oversizedOuter).request(pathFor(operation), { method: 'POST', headers, body: raw + ' ' });
    expect(outer.status).toBe(413); assertNoBusiness(oversizedOuter);
    const last = request.sharedConfig.materials.at(-1)!;
    last.key += 'x';
    expect(bytes(request)).toBe(65_537);
    expect((operation === 'create' ? ArenaRoomCreateRequestSchema : ArenaRoomPublishConfigRequestSchema).safeParse(request).success).toBe(true);
    const oversizedInner = depsFor();
    const inner = await appFor(oversizedInner).request(pathFor(operation), { method: 'POST', headers, body: JSON.stringify(envelope) });
    expect(inner.status).toBe(413); assertNoBusiness(oversizedInner);
  });

  it.each(['create', 'config'] as const)('unmarked Web %s still rejects raw64KiB +1 rather than inheriting the envelope allowance', async (operation) => {
    const h = new Headers(headers); h.delete('x-mahoshojo-desktop-room-protocol'); h.delete('x-mahoshojo-room-expected-user-id');
    const deps = depsFor();
    const response = await appFor(deps).request(pathFor(operation), { method: 'POST', headers: h, body: JSON.stringify(maximumRequest(operation)) + ' ' });
    expect(response.status).toBe(413); assertNoBusiness(deps);
  });

  it('schema-valid oversized ISO directory is an explicit transport error, while Web shape remains legal', async () => {
    const page = {
      items: [{ roomId: 'room-1', title: 'Room', visibility: 'public' as const, status: 'open' as const,
        createdAt: `2026-08-28T00:00:00.${'1'.repeat(270_000)}Z`, lastActivityAt: '2026-08-28T00:00:00.000Z',
        hostDisplayName: 'Host', memberCount: 1, memberLimit: 32 }], nextCursor: null,
    };
    expect(RoomDirectoryPageSchema.safeParse(page).success).toBe(true);
    const deps = depsFor(); vi.mocked(deps.directory.discoverPublic).mockResolvedValue(page);
    const response = await appFor(deps).request(pathFor('discover'), { headers });
    expect(response.status).toBe(502);
    expect(DesktopRoomSessionErrorResponseSchema.parse(await response.json())).toMatchObject({
      desktopRoom: { viewerUserId: 101 }, error: { code: 'ROOM_DESKTOP_RESPONSE_TOO_LARGE', outcome: 'not-applicable' },
    });
    expect(deps.directory.discoverPublic).toHaveBeenCalledOnce();
    const h = new Headers(headers); h.delete('x-mahoshojo-desktop-room-protocol'); h.delete('x-mahoshojo-room-expected-user-id');
    const original = await appFor(deps).request(pathFor('discover'), { headers: h });
    expect(original.status).toBe(200); expect(await original.json()).toEqual(page);
  });

  it('includes owner metadata in the exact256KiB response cap and preserves unknown POST outcomes', async () => {
    const page = {
      items: [{ roomId: 'room-1', title: 'Room', visibility: 'public' as const, status: 'open' as const,
        createdAt: '2026-08-28T00:00:00.0Z', lastActivityAt: '2026-08-28T00:00:00.000Z',
        hostDisplayName: 'Host', memberCount: 1, memberLimit: 32 }], nextCursor: null,
    };
    const envelope = { desktopRoom: { version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, viewerUserId: 101 }, result: page };
    const padding = DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes - bytes(envelope);
    page.items[0]!.createdAt = `2026-08-28T00:00:00.${'0'.repeat(padding + 1)}Z`;
    expect(bytes(envelope)).toBe(DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes);
    expect(RoomDirectoryPageSchema.safeParse(page).success).toBe(true);
    const deps = depsFor(); vi.mocked(deps.directory.discoverPublic).mockResolvedValue(page);
    const accepted = await appFor(deps).request(pathFor('discover'), { headers });
    expect(accepted.status).toBe(200);
    expect(Buffer.byteLength(await accepted.text())).toBe(DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes);
    page.items[0]!.createdAt = page.items[0]!.createdAt.replace(/Z$/u, '0Z');
    expect(bytes(envelope)).toBe(DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes + 1);
    const refused = await appFor(deps).request(pathFor('discover'), { headers });
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({ error: { code: 'ROOM_DESKTOP_RESPONSE_TOO_LARGE', outcome: 'not-applicable' } });

    const largeSnapshot = structuredClone(snapshot);
    largeSnapshot.members[0]!.joinedAt = `2026-08-28T00:00:00.${'1'.repeat(270_000)}Z`;
    const largeSession = { ...session, member: largeSnapshot.members[0]!, snapshot: largeSnapshot };
    // Actual legacy DTO serializer accepts this synthetic oversized service view.
    expect(ArenaRoomSessionResponseSchema.safeParse({ protocolVersion: 1, roomId: largeSession.roomId, roomEpoch: largeSession.roomEpoch, self: largeSession.member, snapshot: largeSnapshot }).success).toBe(true);
    const mutated = depsFor(); vi.mocked(mutated.memberships.join).mockResolvedValue(largeSession);
    const unknown = await appFor(mutated).request(pathFor('join'), requestFor('join'));
    expect(unknown.status).toBe(502);
    expect(mutated.memberships.join).toHaveBeenCalledOnce();
    expect(await unknown.json()).toMatchObject({ desktopRoom: { viewerUserId: 101 }, error: { code: 'ROOM_DESKTOP_RESPONSE_TOO_LARGE', outcome: 'unknown' } });
  });

  it('config accepts an exact256KiB complete response and marks one-byte overflow unknown after one publish', async () => {
    const result = ArenaRoomSessionResponseSchema.parse(fixture.operations.session.success.result);
    const member = result.snapshot.members[1]!;
    member.joinedAt = '2026-08-28T00:00:00.0Z';
    const envelope = { desktopRoom: { version: DESKTOP_ROOM_SESSION_PROTOCOL_VERSION, viewerUserId: 101 }, result };
    member.joinedAt = `2026-08-28T00:00:00.${'0'.repeat(DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes - bytes(envelope) + 1)}Z`;
    expect(bytes(envelope)).toBe(262_144);
    const deps = depsFor();
    vi.mocked(deps.configs.publish).mockResolvedValue({ roomId: result.roomId, roomEpoch: result.roomEpoch, member: result.self, snapshot: result.snapshot });
    const accepted = await appFor(deps).request(pathFor('config'), requestFor('config'));
    expect(accepted.status).toBe(200);
    const text = await accepted.text();
    expect(Buffer.byteLength(text)).toBe(262_144);
    expect(parseDesktopRoomSessionResponse('config', JSON.parse(text), 101)).toEqual(envelope);
    expect(deps.configs.publish).toHaveBeenCalledOnce();

    member.joinedAt = member.joinedAt.replace(/Z$/u, '0Z');
    expect(bytes(envelope)).toBe(262_145);
    expect(ArenaRoomSessionResponseSchema.safeParse(result).success).toBe(true);
    const refused = await appFor(deps).request(pathFor('config'), requestFor('config'));
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({ error: { code: 'ROOM_DESKTOP_RESPONSE_TOO_LARGE', outcome: 'unknown' } });
    expect(deps.configs.publish).toHaveBeenCalledTimes(2);
  });

  it('complete control frame remains bounded independently of duplicated self and response wrapper', async () => {
    const state = structuredClone(snapshot);
    state.members = Array.from({ length: 32 }, (_, index) => ({ userId: `member-${index}`, role: index === 0 ? 'host' : 'member', displayName: '\0'.repeat(200), membershipState: 'active', joinedAt: '2026-08-28T00:00:00.000Z' }));
    const frame = () => ({ protocolVersion: 1, roomId: state.roomId, roomEpoch: state.roomEpoch, controlSeq: state.controlSeq, timestamp: '2026-08-28T00:00:00.000Z', type: 'room.snapshot', payload: state });
    for (let index = 0; index < 256; index += 1) {
      state.sharedConfig.materials.push({ key: `host-local:material-${index}`, displayName: '\0'.repeat(200), source: 'host-local', type: 'material' });
      if (!RoomEventSchema.safeParse(frame()).success) { state.sharedConfig.materials.pop(); break; }
    }
    const padding = { key: 'host-local:padding', displayName: 'x', source: 'host-local' as const, type: 'material' as const };
    state.sharedConfig.materials.push(padding);
    while (bytes(frame()) + 6 <= 65_536 && padding.displayName.length < 200) padding.displayName += '\0';
    while (bytes(frame()) < 65_536 && padding.key.length < 256) padding.key += 'x';
    expect(bytes(frame())).toBe(65_536); expect(RoomEventSchema.safeParse(frame()).success).toBe(true);
    const deps = depsFor();
    vi.mocked(deps.memberships.getSession).mockResolvedValue({ roomId: state.roomId, roomEpoch: state.roomEpoch, member: state.members[0]!, snapshot: state });
    const response = await appFor(deps).request(pathFor('session'), { headers });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(text)).toBeGreaterThan(65_536);
    expect(parseDesktopRoomSessionResponse('session', JSON.parse(text), 101)).toEqual(JSON.parse(text));
    padding.key += 'x'; expect(RoomEventSchema.safeParse(frame()).success).toBe(false);
  });
});
