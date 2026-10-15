import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/desktop-room-session.json';
import proposalFixtures from '../fixtures/desktop-room-proposals.json';
import { ARENA_ROOM_HTTP_ERROR_CODES } from '../src/arena-error-taxonomy';
import {
  DESKTOP_ROOM_SESSION_ERROR_CODES,
  DESKTOP_ROOM_SESSION_EXPECTED_USER_ID_HEADER,
  DESKTOP_ROOM_SESSION_LIMITS,
  DESKTOP_ROOM_SESSION_OPERATIONS,
  DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS,
  DESKTOP_ROOM_SESSION_PROTOCOL_HEADER,
  DESKTOP_ROOM_SESSION_PROTOCOL_VERSION,
  DESKTOP_ROOM_SESSION_RESPONSE_SCHEMAS,
  DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS,
  DESKTOP_ROOM_SESSION_UNPAIRED_ERROR_CODES,
  DesktopRoomSessionContractError,
  DesktopRoomSessionErrorResponseSchema,
  DesktopRoomSessionExpectedUserIdHeaderSchema,
  DesktopRoomSessionOperationSchema,
  DesktopRoomSessionPostOperationSchema,
  parseDesktopRoomSessionRequest,
  parseDesktopRoomSessionResponse,
  type DesktopRoomSessionOperation,
} from '../src/desktop-room-session';
import { RoomDirectoryPageSchema } from '../src/room-directory';
import {
  ARENA_ROOM_HTTP_ROUTES,
  ArenaRoomCreateRequestSchema,
  ArenaRoomEpochMutationRequestSchema,
  ArenaRoomJoinRequestSchema,
  ArenaRoomPublishConfigRequestSchema,
  ArenaRoomProposalSubmitRequestSchema,
  ArenaRoomProposalWithdrawRequestSchema,
  ArenaRoomProposalResolveRequestSchema,
  ArenaRoomSessionResponseSchema,
  ArenaRoomTicketRequestSchema,
  ArenaRoomTicketResponseSchema,
} from '../src/room-http';
import { jsonUtf8ByteLength } from '../src/wire-size';

// Extend the old shared golden locally; existing Native consumers keep their seven-operation fixture.
const sessionFixture = fixture.operations.session.success.result;
const operationFixtures = {
  ...fixture.operations,
  ...proposalFixtures,
  config: {
    method: 'POST',
    path: ARENA_ROOM_HTTP_ROUTES.config.replace(':roomId', sessionFixture.roomId),
    request: {
      desktopRoom: fixture.operations.join.request.desktopRoom,
      request: {
        expectedRoomEpoch: sessionFixture.roomEpoch,
        expectedRevision: sessionFixture.snapshot.revision,
        expectedControlSeq: sessionFixture.snapshot.controlSeq,
        sharedConfig: sessionFixture.snapshot.sharedConfig,
      },
    },
    success: fixture.operations.session.success,
    error: fixture.operations.join.error,
  },
};
const owner = fixture.expectedUserId;
const operations = DesktopRoomSessionOperationSchema.options;
const postOperations = DesktopRoomSessionPostOperationSchema.options;
const originalRequestSchemas = {
  create: ArenaRoomCreateRequestSchema,
  join: ArenaRoomJoinRequestSchema,
  ticket: ArenaRoomTicketRequestSchema,
  leave: ArenaRoomEpochMutationRequestSchema,
  close: ArenaRoomEpochMutationRequestSchema,
  config: ArenaRoomPublishConfigRequestSchema,
  proposalSubmit: ArenaRoomProposalSubmitRequestSchema,
  proposalWithdraw: ArenaRoomProposalWithdrawRequestSchema,
  proposalResolve: ArenaRoomProposalResolveRequestSchema,
};
const objectAt = (root: unknown, path: string): Record<string, unknown> => path.split('/').filter(Boolean)
  .reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], root) as Record<string, unknown>;
const patch = (root: unknown, path: string, value: unknown): unknown => {
  const copy: unknown = structuredClone(root);
  const keys = path.split('/').filter(Boolean);
  objectAt(copy, keys.slice(0, -1).join('/'))[keys.at(-1)!] = value;
  return copy;
};
const without = (root: unknown, path: string, key: string): unknown => {
  const copy: unknown = structuredClone(root);
  delete objectAt(copy, path)[key];
  return copy;
};
const oversizedDirectory = (bytes: number) => {
  const response = structuredClone(fixture.operations.discover.success);
  const entry = response.result.items[0];
  entry.createdAt = '2026-10-12T00:00:00.0Z';
  const padding = bytes - jsonUtf8ByteLength(response);
  entry.createdAt = `2026-10-12T00:00:00.${'0'.repeat(padding + 1)}Z`;
  return response;
};
const paddedJoin = (bytes: number) => {
  const request = structuredClone(fixture.operations.join.request);
  request.request.displayName = '成员😀 "引号" \\ 换行\n末尾';
  request.request.displayName += ' '.repeat(bytes - jsonUtf8ByteLength(request.request));
  return request;
};

const expectCode = (run: () => unknown, code: string) => {
  try {
    run();
    expect.fail('expected a closed contract failure');
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopRoomSessionContractError);
    expect(error).toMatchObject({ code, message: code });
    expect(error).not.toHaveProperty('cause');
  }
};

describe('Desktop Native Room session opt-in contract', () => {
  it('adds only fixed config to the original routes with unchanged version and transport budgets', () => {
    expect(DESKTOP_ROOM_SESSION_PROTOCOL_VERSION).toBe(fixture.protocolVersion);
    expect(DESKTOP_ROOM_SESSION_PROTOCOL_HEADER).toBe('x-mahoshojo-desktop-room-protocol');
    expect(DESKTOP_ROOM_SESSION_EXPECTED_USER_ID_HEADER).toBe('x-mahoshojo-room-expected-user-id');
    expect(DESKTOP_ROOM_SESSION_LIMITS).toEqual(fixture.limits);
    expect(Object.keys(DESKTOP_ROOM_SESSION_OPERATIONS)).toEqual(operations);
    expect(DESKTOP_ROOM_SESSION_OPERATIONS.discover).toEqual({ method: 'GET', path: ARENA_ROOM_HTTP_ROUTES.collection });
    expect(DESKTOP_ROOM_SESSION_OPERATIONS.create).toEqual({ method: 'POST', path: ARENA_ROOM_HTTP_ROUTES.collection });
    for (const operation of ['join', 'session', 'ticket', 'leave', 'close', 'config'] as const) {
      expect(DESKTOP_ROOM_SESSION_OPERATIONS[operation].path).toBe(ARENA_ROOM_HTTP_ROUTES[operation]);
    }
    for (const operation of ['proposals', 'generations', 'kick', 'ws', 'constructor']) {
      expect(DesktopRoomSessionOperationSchema.safeParse(operation).success).toBe(false);
    }
  });

  it.each(operations)('round-trips the shared %s serializer fixture through real schemas', (operation) => {
    const sample = operationFixtures[operation];
    expect(DESKTOP_ROOM_SESSION_OPERATIONS[operation].method).toBe(sample.method);
    expect(sample.path).toBe(DESKTOP_ROOM_SESSION_OPERATIONS[operation].path.replace(':roomId', fixture.operations.session.success.result.roomId).replace(':proposalId', proposalFixtures.proposalSubmit.request.request.proposalId));
    for (const response of [sample.success, sample.error]) {
      expect(DESKTOP_ROOM_SESSION_RESPONSE_SCHEMAS[operation].parse(response)).toEqual(response);
      expect(parseDesktopRoomSessionResponse(operation, JSON.parse(JSON.stringify(response)), owner)).toEqual(response);
    }
    expect(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS[operation].parse(sample.success)).toEqual(sample.success);
    expect(JSON.stringify(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS[operation].parse(sample.success)))
      .toBe(JSON.stringify(sample.success));
  });

  it.each(postOperations)('keeps the original %s schema and rejects the new wire on every legacy POST', (operation) => {
    const sample = operationFixtures[operation].request;
    expect(DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS[operation].parse(sample)).toEqual(sample);
    expect(parseDesktopRoomSessionRequest(operation, JSON.parse(JSON.stringify(sample)), owner)).toEqual(sample);
    expect(originalRequestSchemas[operation].parse(sample.request)).toEqual(sample.request);
    // Every old write entry is strict: a new envelope cannot become a legacy write.
    for (const originalSchema of Object.values(originalRequestSchemas)) {
      expect(originalSchema.safeParse(sample).success).toBe(false);
    }
  });

  it('requires createMode on create only and leaves its existing DTO unchanged', () => {
    expect(parseDesktopRoomSessionRequest('create', fixture.createResumeOnlyRequest, owner)).toEqual(fixture.createResumeOnlyRequest);
    expect(ArenaRoomCreateRequestSchema.safeParse(fixture.createResumeOnlyRequest).success).toBe(false);
    for (const value of ['resume', '', null, 1, ['new']]) {
      expect(DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS.create.safeParse(patch(fixture.operations.create.request, 'desktopRoom/createMode', value)).success).toBe(false);
    }
    expect(DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS.create.safeParse(without(fixture.operations.create.request, 'desktopRoom', 'createMode')).success).toBe(false);
    for (const operation of ['join', 'ticket', 'leave', 'close', 'config'] as const) {
      expect(DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS[operation].safeParse(patch(operationFixtures[operation].request, 'desktopRoom/createMode', 'new')).success).toBe(false);
    }
  });

  it('parses exact owner assertion headers without lossy or permissive coercion', () => {
    expect(DesktopRoomSessionExpectedUserIdHeaderSchema.parse(fixture.headers[DESKTOP_ROOM_SESSION_EXPECTED_USER_ID_HEADER])).toBe(owner);
    expect(DesktopRoomSessionExpectedUserIdHeaderSchema.parse(`v1:${Number.MAX_SAFE_INTEGER}`)).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of ['v2:42', '42', 'v1:0', 'v1:-1', 'v1:+42', 'v1:042', 'v1:4.2', 'v1:42.0', 'v1:4e2', ' v1:42', 'v1:42 ', 'v1:9007199254740992', 'v1:999999999999999999999', null, 42, ['v1:42']]) {
      expect(DesktopRoomSessionExpectedUserIdHeaderSchema.safeParse(value).success).toBe(false);
    }
  });

  it('requires versioned, object-only, closed metadata and original DTOs', () => {
    for (const operation of postOperations) {
      const sample = operationFixtures[operation].request;
      const schema = DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS[operation];
      for (const path of ['', 'desktopRoom', 'request']) {
        expect(schema.safeParse(patch(sample, `${path}/extra`, 'secret-canary')).success).toBe(false);
        if (path) expect(schema.safeParse(patch(sample, path, Object.values(objectAt(sample, path)))).success).toBe(false);
      }
      for (const path of ['desktopRoom/version', 'desktopRoom/expectedUserId']) {
        const fields = path.split('/');
        expect(schema.safeParse(without(sample, fields[0], fields[1])).success).toBe(false);
      }
      expect(schema.safeParse(patch(sample, 'desktopRoom/version', 'desktop-room-session-v2')).success).toBe(false);
      expect(schema.safeParse(patch(sample, 'request', null)).success).toBe(false);
      for (const raw of [Object.values(sample), null, true, 42, 'body']) expect(schema.safeParse(raw).success).toBe(false);
    }
    for (const operation of operations) {
      const sample = operationFixtures[operation].success;
      const schema = DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS[operation];
      for (const path of ['', 'desktopRoom', 'result']) {
        expect(schema.safeParse(patch(sample, `${path}/extra`, 'secret-canary')).success).toBe(false);
      }
      for (const raw of [Object.values(sample), null, true, 42, 'body']) expect(schema.safeParse(raw).success).toBe(false);
      expect(schema.safeParse(patch(sample, 'desktopRoom/version', 'desktop-room-session-v2')).success).toBe(false);
      expect(schema.safeParse(patch(sample, 'desktopRoom/viewerUserId', null)).success).toBe(false);
      expect(schema.safeParse(without(sample, 'desktopRoom', 'viewerUserId')).success).toBe(false);
      expect(schema.safeParse(sample.result).success).toBe(false);
    }
  });

  it('rejects unsafe integers in metadata and original nested snapshots', () => {
    for (const value of [0, -1, 42.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '42', null]) {
      expect(DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS.join.safeParse(patch(fixture.operations.join.request, 'desktopRoom/expectedUserId', value)).success).toBe(false);
      expect(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS.session.safeParse(patch(fixture.operations.session.success, 'desktopRoom/viewerUserId', value)).success).toBe(false);
    }
    expect(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS.session.safeParse(patch(fixture.operations.session.success, 'result/snapshot/controlSeq', Number.MAX_SAFE_INTEGER + 1)).success).toBe(false);
    expect(DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS.join.safeParse(patch(fixture.operations.join.request, 'desktopRoom/expectedUserId', Number.MAX_SAFE_INTEGER)).success).toBe(true);
    expect(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS.session.safeParse(patch(fixture.operations.session.success, 'desktopRoom/viewerUserId', Number.MAX_SAFE_INTEGER)).success).toBe(true);
    expectCode(() => parseDesktopRoomSessionRequest('join', fixture.operations.join.request, owner + 1), 'ROOM_DESKTOP_OWNER_MISMATCH');
    expectCode(() => parseDesktopRoomSessionResponse('session', fixture.operations.session.success, owner + 1), 'ROOM_DESKTOP_OWNER_MISMATCH');
  });

  it('closes every error field, preserves the original code whitelist and bounds retry/message', () => {
    expect(DESKTOP_ROOM_SESSION_ERROR_CODES).toEqual([...ARENA_ROOM_HTTP_ERROR_CODES,
      'ROOM_DESKTOP_PROTOCOL_INVALID', 'ROOM_DESKTOP_OWNER_MISMATCH', 'ROOM_DESKTOP_OPERATION_UNSUPPORTED',
      'ROOM_DESKTOP_RESPONSE_TOO_LARGE', 'ROOM_DESKTOP_RESPONSE_INVALID']);
    const sample = fixture.operations.join.error;
    for (const path of ['', 'desktopRoom', 'error']) {
      expect(DesktopRoomSessionErrorResponseSchema.safeParse(patch(sample, `${path}/details`, 'private-account-canary')).success).toBe(false);
      if (path) expect(DesktopRoomSessionErrorResponseSchema.safeParse(patch(sample, path, Object.values(objectAt(sample, path)))).success).toBe(false);
    }
    for (const [path, value] of [
      ['error/code', 'INTERNAL_EXCEPTION'], ['error/outcome', 'applied'], ['error/message', ''],
      ['error/message', '😀'.repeat(101)], ['error/retryAfterSeconds', 0], ['error/retryAfterSeconds', 86_401],
      ['error/retryAfterSeconds', Number.MAX_SAFE_INTEGER + 1], ['error/retryAfterSeconds', 1.5],
    ] as const) expect(DesktopRoomSessionErrorResponseSchema.safeParse(patch(sample, path, value)).success).toBe(false);
    expect(DesktopRoomSessionErrorResponseSchema.safeParse(patch(sample, 'error/retryAfterSeconds', 86_400)).success).toBe(true);
    expect(DesktopRoomSessionErrorResponseSchema.safeParse(patch(sample, 'error/message', '😀'.repeat(100))).success).toBe(true);
    for (const operation of operations) {
      expect(DESKTOP_ROOM_SESSION_RESPONSE_SCHEMAS[operation].safeParse({ ...operationFixtures[operation].success, error: sample.error }).success).toBe(false);
      const isGet = DESKTOP_ROOM_SESSION_OPERATIONS[operation].method === 'GET';
      for (const outcome of ['not-applied', 'unknown', 'not-applicable']) {
        expect(DESKTOP_ROOM_SESSION_RESPONSE_SCHEMAS[operation].safeParse(patch(sample, 'error/outcome', outcome)).success).toBe(isGet ? outcome === 'not-applicable' : outcome !== 'not-applicable');
      }
    }
  });

  it('accepts only whitelisted unpaired failures without exposing an identity or result', () => {
    const sample = fixture.unpairedOwnerMismatch;
    expect(parseDesktopRoomSessionResponse('join', sample, owner)).toEqual(sample);
    for (const code of DESKTOP_ROOM_SESSION_UNPAIRED_ERROR_CODES) {
      expect(DesktopRoomSessionErrorResponseSchema.safeParse(patch(sample, 'error/code', code)).success).toBe(true);
    }
    for (const code of ['ROOM_RATE_LIMITED', 'ROOM_CONFLICT', 'ROOM_NOT_FOUND']) {
      expect(DesktopRoomSessionErrorResponseSchema.safeParse(patch(sample, 'error/code', code)).success).toBe(false);
    }
    expect(DesktopRoomSessionErrorResponseSchema.safeParse(patch(sample, 'error/outcome', 'unknown')).success).toBe(false);
    expect(DesktopRoomSessionErrorResponseSchema.safeParse(patch(sample, 'desktopRoom/viewerUserId', owner)).success).toBe(false);
    expect(DesktopRoomSessionErrorResponseSchema.safeParse({ ...sample, result: fixture.operations.session.success.result }).success).toBe(false);
  });

  it('counts raw inner UTF-8 JSON before trim/default and accepts exactly 64 KiB', () => {
    const atLimit = paddedJoin(DESKTOP_ROOM_SESSION_LIMITS.originalRequestBodyBytes);
    expect(jsonUtf8ByteLength(atLimit.request)).toBe(65_536);
    expect(JSON.stringify(atLimit.request).length).toBeLessThan(65_536);
    const parsed = parseDesktopRoomSessionRequest('join', atLimit, owner);
    expect(parsed.request).toEqual(ArenaRoomJoinRequestSchema.parse(atLimit.request));
    expect(parsed.request.displayName.endsWith('末尾')).toBe(true);
    const overLimit = paddedJoin(DESKTOP_ROOM_SESSION_LIMITS.originalRequestBodyBytes + 1);
    expect(ArenaRoomJoinRequestSchema.safeParse(overLimit.request).success).toBe(true);
    expect(DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS.join.safeParse(overLimit).success).toBe(false);
    expectCode(() => parseDesktopRoomSessionRequest('join', overLimit, owner), 'ROOM_PAYLOAD_TOO_LARGE');
    const create = without(fixture.operations.create.request, 'request/sharedConfig', 'reportFormat');
    const original = ArenaRoomCreateRequestSchema.parse(objectAt(create, 'request'));
    expect(parseDesktopRoomSessionRequest('create', create, owner).request).toEqual(original);
  });

  it('keeps config intent closed, requires every CAS token and rejects unsafe counters', () => {
    const sample = operationFixtures.config.request;
    for (const key of ['expectedRoomEpoch', 'expectedRevision', 'expectedControlSeq', 'sharedConfig']) {
      expect(DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS.config.safeParse(without(sample, 'request', key)).success).toBe(false);
    }
    for (const key of ['expectedRevision', 'expectedControlSeq']) {
      for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
        expectCode(() => parseDesktopRoomSessionRequest('config', patch(sample, `request/${key}`, value), owner), 'ROOM_DESKTOP_PROTOCOL_INVALID');
      }
    }
    for (const key of ['url', 'headers', 'cookie', 'role', 'operationId']) {
      expectCode(() => parseDesktopRoomSessionRequest('config', patch(sample, `request/${key}`, 'secret-canary'), owner), 'ROOM_DESKTOP_PROTOCOL_INVALID');
    }
    expectCode(() => parseDesktopRoomSessionRequest('config', sample, owner + 1), 'ROOM_DESKTOP_OWNER_MISMATCH');
    expectCode(() => parseDesktopRoomSessionResponse('config', operationFixtures.config.success, owner + 1), 'ROOM_DESKTOP_OWNER_MISMATCH');
  });

  it('applies the unchanged 64 KiB inner and 256 KiB response bounds to config', () => {
    const request = ArenaRoomPublishConfigRequestSchema.parse(operationFixtures.config.request.request);
    request.sharedConfig.materials = [];
    for (let index = 0; index < 256; index += 1) {
      request.sharedConfig.materials.push({ key: `host-local:config-${index}`, displayName: '\0'.repeat(200), source: 'host-local', type: 'material' });
      if (jsonUtf8ByteLength(request) > DESKTOP_ROOM_SESSION_LIMITS.originalRequestBodyBytes) {
        request.sharedConfig.materials.pop(); break;
      }
    }
    const padding = { key: 'host-local:config-padding', displayName: 'x', source: 'host-local' as const, type: 'material' as const };
    request.sharedConfig.materials.push(padding);
    while (jsonUtf8ByteLength(request) + 6 <= 65_536 && padding.displayName.length < 200) padding.displayName += '\0';
    while (jsonUtf8ByteLength(request) < 65_536 && padding.key.length < 256) padding.key += 'x';
    const envelope = { ...operationFixtures.config.request, request };
    expect(jsonUtf8ByteLength(request)).toBe(65_536);
    expect(parseDesktopRoomSessionRequest('config', envelope, owner).request).toEqual(request);
    padding.key += 'x';
    expect(ArenaRoomPublishConfigRequestSchema.safeParse(request).success).toBe(true);
    expectCode(() => parseDesktopRoomSessionRequest('config', envelope, owner), 'ROOM_PAYLOAD_TOO_LARGE');

    const response = DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS.config.parse(operationFixtures.config.success);
    const member = response.result.snapshot.members[1]!;
    member.joinedAt = '2026-10-12T00:00:00.0Z';
    member.joinedAt = `2026-10-12T00:00:00.${'0'.repeat(262_144 - jsonUtf8ByteLength(response) + 1)}Z`;
    expect(jsonUtf8ByteLength(response)).toBe(262_144);
    expect(parseDesktopRoomSessionResponse('config', response, owner)).toEqual(response);
    member.joinedAt = member.joinedAt.replace(/Z$/u, '0Z');
    expect(ArenaRoomSessionResponseSchema.safeParse(response.result).success).toBe(true);
    expectCode(() => parseDesktopRoomSessionResponse('config', response, owner), 'ROOM_DESKTOP_RESPONSE_TOO_LARGE');
  });

  it('counts the entire compact outer envelope, not only the original DTO', () => {
    const sample = { ...fixture.operations.join.request, padding: '' };
    sample.padding = 'x'.repeat(DESKTOP_ROOM_SESSION_LIMITS.requestBodyBytes - jsonUtf8ByteLength(sample));
    expect(jsonUtf8ByteLength(sample)).toBe(66_560);
    expectCode(() => parseDesktopRoomSessionRequest('join', sample, owner), 'ROOM_DESKTOP_PROTOCOL_INVALID');
    sample.padding += 'x';
    expectCode(() => parseDesktopRoomSessionRequest('join', sample, owner), 'ROOM_PAYLOAD_TOO_LARGE');
  });

  it('separates legal original ISO precision from the 256 KiB Desktop receive boundary', () => {
    const atLimit = oversizedDirectory(DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes);
    expect(jsonUtf8ByteLength(atLimit)).toBe(262_144);
    expect(parseDesktopRoomSessionResponse('discover', atLimit, owner)).toEqual(atLimit);
    const overLimit = oversizedDirectory(DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes + 1);
    expect(jsonUtf8ByteLength(overLimit)).toBe(262_145);
    expect(RoomDirectoryPageSchema.safeParse(overLimit.result).success).toBe(true);
    expect(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS.discover.safeParse(overLimit).success).toBe(false);
    expectCode(() => parseDesktopRoomSessionResponse('discover', overLimit, owner), 'ROOM_DESKTOP_RESPONSE_TOO_LARGE');
  });

  it('caps raw ticket UTF-8 bytes before the unchanged legacy token normalization', () => {
    const sample = fixture.operations.ticket.success;
    const atLimit = patch(sample, 'result/ticket', '😀'.repeat(1_024));
    expect(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS.ticket.safeParse(atLimit).success).toBe(true);
    const overLimit = patch(sample, 'result/ticket', `${'😀'.repeat(1_024)}x`);
    expect(ArenaRoomTicketResponseSchema.safeParse(objectAt(overLimit, 'result')).success).toBe(true);
    expect(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS.ticket.safeParse(overLimit).success).toBe(false);
    const padded = patch(sample, 'result/ticket', `x${' '.repeat(4_096)}`);
    expect(ArenaRoomTicketResponseSchema.safeParse(objectAt(padded, 'result')).success).toBe(true);
    expect(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS.ticket.safeParse(padded).success).toBe(false);
  });

  it('shares real 32-member and 50-entry boundary fixtures, including duplicate self and Unicode escapes', () => {
    const { sessionWith32Members: session, directoryWith50Items: directory } = fixture.boundaryExamples;
    expect(session.result.snapshot.members).toHaveLength(32);
    expect(session.result.self).toEqual(session.result.snapshot.members[0]);
    expect(ArenaRoomSessionResponseSchema.parse(session.result)).toEqual(session.result);
    expect(parseDesktopRoomSessionResponse('session', session, owner)).toEqual(session);
    expect(directory.result.items).toHaveLength(50);
    expect(parseDesktopRoomSessionResponse('discover', directory, owner)).toEqual(directory);
    expect(JSON.stringify(session)).toContain('\\n');
    expect(JSON.stringify(session)).toContain('😀');
    expect(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS.session.safeParse(patch(session, 'result/snapshot/members', [...session.result.snapshot.members, { ...session.result.snapshot.members[1], userId: 'extra' }])).success).toBe(false);
    expect(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS.discover.safeParse(patch(directory, 'result/items', [...directory.result.items, directory.result.items[0]])).success).toBe(false);
  });

  it('rejects deep/cyclic/non-JSON objects and malformed branches without leaking raw failures', () => {
    let deep: unknown = {};
    for (let index = 0; index < 1_000; index += 1) deep = { nested: deep };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalid = [deep, cyclic, new Date(), { value: BigInt(1) }, JSON.parse('{"__proto__":{"polluted":true}}')];
    for (const value of invalid) {
      expect(DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS.join.safeParse(value).success).toBe(false);
      expectCode(() => parseDesktopRoomSessionRequest('join', value, owner), 'ROOM_DESKTOP_PROTOCOL_INVALID');
      expectCode(() => parseDesktopRoomSessionResponse('session', value, owner), 'ROOM_DESKTOP_RESPONSE_INVALID');
    }
    expectCode(() => parseDesktopRoomSessionRequest('join', {}, owner), 'ROOM_DESKTOP_PROTOCOL_INVALID');
    expectCode(() => parseDesktopRoomSessionResponse('ticket', fixture.operations.session.success, owner), 'ROOM_DESKTOP_RESPONSE_INVALID');
    expectCode(() => parseDesktopRoomSessionResponse('kick' as DesktopRoomSessionOperation, {}, owner), 'ROOM_DESKTOP_OPERATION_UNSUPPORTED');
  });
});


describe('Desktop proposal wire semantics', () => {
  it('keeps ordinary merge and explicit override revision semantics', () => {
    const base = { ...proposalFixtures.proposalResolve.request, request: {
      expectedRoomEpoch: sessionFixture.roomEpoch, resolution: 'accept-selected', selectedChangeIds: ['guidance-1'],
    } };
    expect(parseDesktopRoomSessionRequest('proposalResolve', base, owner).request).not.toHaveProperty('expectedRevision');
    expect(parseDesktopRoomSessionRequest('proposalResolve', { ...base, request: { ...base.request, expectedRevision: 0 } }, owner).request).toHaveProperty('expectedRevision', 0);
    expect(DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS.proposalResolve.safeParse({ ...base, request: { ...base.request, overrideChangeIds: ['guidance-1'] } }).success).toBe(false);
    expect(DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS.proposalResolve.safeParse({ ...base, request: { ...base.request, expectedRevision: 0, overrideChangeIds: ['guidance-1'] } }).success).toBe(true);
  });

  it('requires directly addressable Desktop submit IDs without changing legacy DTOs', () => {
    for (const proposalId of ['提案 甲', 'proposal-1', 'a.b']) {
      const request = { ...proposalFixtures.proposalSubmit.request, request: { ...proposalFixtures.proposalSubmit.request.request, proposalId } };
      expect(parseDesktopRoomSessionRequest('proposalSubmit', request, owner).request.proposalId).toBe(proposalId);
    }
    for (const proposalId of [' leading', 'trailing ', '/', 'a/b', 'a\\b', 'a%2Fb', 'a%252Fb', '.', '..']) {
      const request = { ...proposalFixtures.proposalSubmit.request, request: { ...proposalFixtures.proposalSubmit.request.request, proposalId } };
      expect(DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS.proposalSubmit.safeParse(request).success).toBe(false);
      if (proposalId !== '.' && proposalId !== '..') expect(ArenaRoomProposalSubmitRequestSchema.safeParse(request.request).success).toBe(true);
    }
  });

  it('rejects submit authority injection while retaining old baseline and ordered typed intent', () => {
    const base = proposalFixtures.proposalSubmit.request;
    expect(parseDesktopRoomSessionRequest('proposalSubmit', { ...base, request: { ...base.request, baseRevision: 0 } }, owner).request.baseRevision).toBe(0);
    for (const key of ['authorUserId', 'createdAt', 'status', 'expectedRevision', 'expectedControlSeq']) {
      expect(DESKTOP_ROOM_SESSION_POST_REQUEST_SCHEMAS.proposalSubmit.safeParse({ ...base, request: { ...base.request, [key]: 'injected' } }).success).toBe(false);
    }
  });

  it('requires complete resolve state and equal duplicate sharedConfig independently of object key order', () => {
    const response = structuredClone(proposalFixtures.proposalResolve.success);
    response.result.sharedConfig = Object.fromEntries(Object.entries(response.result.sharedConfig).reverse()) as typeof response.result.sharedConfig;
    expect(parseDesktopRoomSessionResponse('proposalResolve', response, owner)).toEqual(response);
    for (const key of ['snapshot', 'sharedConfig']) expect(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS.proposalResolve.safeParse(without(response, 'result', key)).success).toBe(false);
    response.result.sharedConfig.userGuidance = 'mismatch';
    expect(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS.proposalResolve.safeParse(response).success).toBe(false);
  });

  it('keeps summary statuses operation-specific and cannot invent terminal replay receipts', () => {
    expect(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS.proposalSubmit.safeParse(patch(proposalFixtures.proposalSubmit.success, 'result/result', 'idempotent')).success).toBe(true);
    for (const operation of ['proposalWithdraw', 'proposalResolve'] as const) {
      expect(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS[operation].safeParse(patch(proposalFixtures[operation].success, 'result/result', 'idempotent')).success).toBe(false);
      expect(DESKTOP_ROOM_SESSION_SUCCESS_RESPONSE_SCHEMAS[operation].safeParse(patch(proposalFixtures[operation].success, 'result/status', 'submitted')).success).toBe(false);
    }
  });
});
