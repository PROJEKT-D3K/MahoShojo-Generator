import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/desktop-room-ipc.json';
import service from '../fixtures/desktop-room-session.json';
import {
  DESKTOP_ROOM_ERROR_MESSAGE, DESKTOP_ROOM_IPC_COMMANDS, DESKTOP_ROOM_IPC_LIMITS,
  DesktopRoomAckResponseSchema, DesktopRoomAcceptedResponseSchema, DesktopRoomAttachRequestSchema,
  DesktopRoomAttachResponseSchema, DesktopRoomBatchSchema, DesktopRoomContractError, DesktopRoomConfigTrackingEndedSchema,
  DesktopRoomDetachRequestSchema, DesktopRoomDetachResponseSchema, DesktopRoomErrorSchema,
  DesktopRoomNotificationSchema, DesktopRoomRevokedNotificationSchema, DesktopRoomPullResponseSchema, DesktopRoomRequestSchema,
  DesktopRoomSubscribeRequestSchema, DesktopRoomSubscribeResponseSchema, parseDesktopRoomBatch,
} from '../src/desktop-room-ipc';
import { DESKTOP_ROOM_SESSION_RESPONSE_SCHEMAS } from '../src/desktop-room-session';
import { CustomStoryLengthSchema, HostLocalContentVersionSchema } from '../src/primitives';
import { ArenaRoomCreationRequestIdSchema } from '../src/room-http';
import { jsonUtf8ByteLength } from '../src/wire-size';

const patch = (root: unknown, path: string[], value: unknown): unknown => {
  const copy = structuredClone(root) as Record<string, unknown>;
  const target = path.slice(0, -1).reduce<Record<string, unknown>>((at, key) => at[key] as Record<string, unknown>, copy);
  target[path.at(-1)!] = value;
  return copy;
};
const directoryPull = (bytes: number) => {
  const pull = structuredClone(fixture.pulls[0]);
  const raw = pull as unknown as { batch: { event: { response: { result: { items: Array<{ createdAt: string }> } } } } };
  const entry = raw.batch.event.response.result.items[0];
  entry.createdAt = '2026-10-12T00:00:00.0Z';
  entry.createdAt = `2026-10-12T00:00:00.${'0'.repeat(bytes - jsonUtf8ByteLength(pull) + 1)}Z`;
  return pull;
};

const configRequest = () => {
  const session = service.operations.session.success.result;
  return {
    handle: fixture.attach.handle,
    request: {
      kind: 'config', roomId: session.roomId,
      request: {
        expectedRoomEpoch: session.roomEpoch,
        expectedRevision: session.snapshot.revision,
        expectedControlSeq: session.snapshot.controlSeq,
        sharedConfig: structuredClone(session.snapshot.sharedConfig),
      },
    },
  };
};

// This fixture is a shared contract corpus, not a claim of Native producer execution.
describe('closed Native Room IPC', () => {
  it('pins four commands and complete serialized output budgets', () => {
    expect(Object.values(DESKTOP_ROOM_IPC_COMMANDS)).toEqual(['arena_room_attach', 'arena_room_request', 'arena_room_subscribe', 'arena_room_detach']);
    expect(DESKTOP_ROOM_IPC_LIMITS).toEqual({ ...fixture.limits, generationFragmentBytes: 16_384 });
    expect(DesktopRoomAttachRequestSchema.parse(fixture.attachRequest)).toEqual(fixture.attachRequest);
    expect(DesktopRoomAttachResponseSchema.parse(fixture.attach)).toEqual(fixture.attach);
    expect(DesktopRoomSubscribeRequestSchema.parse(fixture.subscribeRequest)).toEqual(fixture.subscribeRequest);
    expect(DesktopRoomSubscribeResponseSchema.parse(fixture.subscribe)).toEqual(fixture.subscribe);
    expect(DesktopRoomDetachRequestSchema.parse(fixture.detachRequest)).toEqual(fixture.detachRequest);
    expect(DesktopRoomDetachResponseSchema.parse(fixture.detach)).toEqual(fixture.detach);
    expect(DesktopRoomAcceptedResponseSchema.parse(fixture.accepted)).toEqual(fixture.accepted);
    expect(DesktopRoomPullResponseSchema.parse(fixture.empty)).toEqual(fixture.empty);
    expect(DesktopRoomErrorSchema.parse(fixture.error)).toEqual(fixture.error);
    for (const request of fixture.requests) expect(DesktopRoomRequestSchema.parse(request)).toEqual(request);
    for (const notification of fixture.notifications) expect(DesktopRoomNotificationSchema.parse(notification)).toEqual(notification);
    for (const ack of fixture.acks) expect(DesktopRoomAckResponseSchema.parse(ack)).toEqual(ack);
  });
  it('validates a separate closed one-KiB revoked notification without any body or new command', () => {
    for (const notification of fixture.revokedNotifications) {
      expect(DesktopRoomRevokedNotificationSchema.parse(notification)).toEqual(notification);
      expect(DesktopRoomNotificationSchema.parse(notification)).toEqual(notification);
      expect(jsonUtf8ByteLength(notification)).toBeLessThanOrEqual(DESKTOP_ROOM_IPC_LIMITS.notificationBytes);
    }
    const notification = fixture.revokedNotifications[0];
    for (const [path, value] of [
      [['body'], 'not-delivery-data'], [['error', 'raw'], 'secret-canary'],
      [['error', 'message'], 'secret-canary'], [['error', 'serverCode'], 'UNRECOGNIZED'],
      [['operation'], 'ticket'], [['operation'], 'session'], [['batchId'], undefined],
      [['requestId'], undefined], [['sequence'], Number.MAX_SAFE_INTEGER + 1],
      [['handle'], 'x'.repeat(DESKTOP_ROOM_IPC_LIMITS.notificationBytes)],
    ] as Array<[string[], unknown]>) expect(DesktopRoomNotificationSchema.safeParse(patch(notification, path, value)).success).toBe(false);
    const subscription = fixture.revokedNotifications[3];
    expect(DesktopRoomRevokedNotificationSchema.parse(subscription)).toEqual(subscription);
    for (const [path, value] of [
      [['requestId'], 'not-null'], [['requestId'], undefined], [['operation'], 'session'],
      [['error', 'outcome'], 'not-applied'], [['error', 'outcome'], 'unknown'],
    ] as Array<[string[], unknown]>) expect(DesktopRoomNotificationSchema.safeParse(patch(subscription, path, value)).success).toBe(false);
    expect(DesktopRoomNotificationSchema.safeParse({ ...notification, requestId: null }).success).toBe(false);
    expect(DesktopRoomNotificationSchema.safeParse({ ...fixture.notifications[0], error: notification.error }).success).toBe(false);
  });
  it('reuses unchanged actual service DTO schemas under local wrappers, including all nested session state', () => {
    for (const raw of fixture.pulls) {
      const response = DesktopRoomPullResponseSchema.parse(raw);
      expect(response).toEqual(raw);
      if (response.kind !== 'batch') throw new Error('fixture must contain batch');
      const batch = parseDesktopRoomBatch(response.batch, fixture.expectedUserId);
      expect(batch).toEqual(response.batch);
      if (batch.event.kind !== 'http-result') continue;
      const operation = batch.event.operation;
      if (operation === 'config' || operation === 'proposalSubmit' || operation === 'proposalWithdraw' || operation === 'proposalResolve') throw new Error('legacy fixture has no expanded operation');
      expect(DESKTOP_ROOM_SESSION_RESPONSE_SCHEMAS[operation].parse(batch.event.response)).toEqual(batch.event.response);
      expect(batch.event.response).toEqual('result' in batch.event.response ? service.operations[operation].success : service.operations[operation].error);
    }
  });
  it.each([
    { name: 'creationRequestId', schema: ArenaRoomCreationRequestIdSchema, valid: 'creation-request-0001' },
    { name: 'hostLocalContentVersion', schema: HostLocalContentVersionSchema, valid: `sha256:${'a'.repeat(64)}` },
    { name: 'customStoryLength', schema: CustomStoryLengthSchema, valid: '1200' },
  ])('uses the actual $name schema to reject a trailing newline without a new Native restriction', ({ schema, valid }) => {
    expect(schema.parse(valid)).toBe(valid);
    expect(schema.safeParse(`${valid}\n`).success).toBe(false);
  });
  it('accepts config only with the complete CAS DTO and closed nested shared config', () => {
    const config = configRequest();
    expect(DesktopRoomRequestSchema.parse(config)).toEqual(config);
    for (const field of ['expectedRoomEpoch', 'expectedRevision', 'expectedControlSeq', 'sharedConfig']) {
      const missing = structuredClone(config) as unknown as { request: { request: Record<string, unknown> } };
      delete missing.request.request[field];
      expect(DesktopRoomRequestSchema.safeParse(missing).success).toBe(false);
    }
    for (const field of ['expectedRevision', 'expectedControlSeq']) {
      for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7', null]) {
        expect(DesktopRoomRequestSchema.safeParse(patch(config, ['request', 'request', field], value)).success).toBe(false);
      }
    }
    for (const path of [[], ['request'], ['request', 'request'], ['request', 'request', 'sharedConfig'],
      ['request', 'request', 'sharedConfig', 'historySettings'], ['request', 'request', 'sharedConfig', 'combatants', '0'],
      ['request', 'request', 'sharedConfig', 'combatants', '0', 'ref']]) {
      expect(DesktopRoomRequestSchema.safeParse(patch(config, [...path, 'injected'], true)).success).toBe(false);
    }
    for (const field of ['roomId', 'expectedRoomEpoch']) {
      const path = field === 'roomId' ? ['request', field] : ['request', 'request', field];
      expect(DesktopRoomRequestSchema.safeParse(patch(config, path, '')).success).toBe(false);
    }
  });
  it('caps the original config body at 64 KiB before trimming nested display names', () => {
    const config = configRequest();
    const body = config.request.request;
    body.sharedConfig.teams[0].displayName += ' '.repeat(65_536 - jsonUtf8ByteLength(body));
    expect(jsonUtf8ByteLength(body)).toBe(65_536);
    expect(DesktopRoomRequestSchema.safeParse(config).success).toBe(true);
    body.sharedConfig.teams[0].displayName += ' ';
    expect(jsonUtf8ByteLength(body)).toBe(65_537);
    expect(DesktopRoomRequestSchema.safeParse(config).success).toBe(false);
    for (const character of ['\u2000', '\t']) {
      const encoded = configRequest();
      const displayName = encoded.request.request.sharedConfig.teams[0].displayName;
      const remaining = 65_536 - jsonUtf8ByteLength(encoded.request.request);
      const cost = jsonUtf8ByteLength(character) - 2;
      encoded.request.request.sharedConfig.teams[0].displayName = displayName
        + character.repeat(Math.floor(remaining / cost)) + ' '.repeat(remaining % cost);
      expect(jsonUtf8ByteLength(encoded.request.request)).toBe(65_536);
      expect(DesktopRoomRequestSchema.safeParse(encoded).success).toBe(true);
      encoded.request.request.sharedConfig.teams[0].displayName += character;
      expect(DesktopRoomRequestSchema.safeParse(encoded).success).toBe(false);
    }
  });
  it('delivers config as a full owner-checked session response rather than a partial write receipt', () => {
    const pull = patch(fixture.pulls[6], ['batch', 'event', 'operation'], 'config') as typeof fixture.pulls[6];
    expect(DesktopRoomPullResponseSchema.parse(pull)).toEqual(pull);
    expect(parseDesktopRoomBatch(pull.batch, fixture.expectedUserId)).toEqual(pull.batch);
    expect(() => parseDesktopRoomBatch(pull.batch, fixture.expectedUserId + 1)).toThrow(DesktopRoomContractError);
    for (const result of [{ applied: true }, { snapshot: service.operations.session.success.result.snapshot }]) {
      expect(DesktopRoomPullResponseSchema.safeParse(patch(pull, ['batch', 'event', 'response', 'result'], result)).success).toBe(false);
    }
    for (const path of [['batch', 'event', 'response'], ['batch', 'event', 'response', 'result'],
      ['batch', 'event', 'response', 'result', 'self'], ['batch', 'event', 'response', 'result', 'snapshot'],
      ['batch', 'event', 'response', 'result', 'snapshot', 'sharedConfig']]) {
      expect(DesktopRoomPullResponseSchema.safeParse(patch(pull, [...path, 'injected'], true)).success).toBe(false);
    }
    const failure = patch(fixture.pulls[3], ['batch', 'event', 'operation'], 'config');
    expect(DesktopRoomPullResponseSchema.safeParse(failure).success).toBe(true);
  });
  it('correlates unknown config mutations and revocation with their scoped intent and closed outcomes', () => {
    const event = { kind: 'mutation-unknown', intentId: 'config-intent-1', operation: 'config', roomId: fixture.subscribeRequest.roomId };
    const batch = { ...fixture.pulls[17].batch, event };
    expect(DesktopRoomBatchSchema.parse(batch)).toEqual(batch);
    const attach = { ...fixture.attach, pendingIntent: { intentId: event.intentId, operation: event.operation, roomId: event.roomId } };
    expect(DesktopRoomAttachResponseSchema.parse(attach)).toEqual(attach);
    for (const invalid of [{ roomId: null }, { operation: 'end-config-tracking' }, { operation: 'ticket' }, { injected: true }]) {
      expect(DesktopRoomBatchSchema.safeParse({ ...batch, event: { ...event, ...invalid } }).success).toBe(false);
      expect(DesktopRoomAttachResponseSchema.safeParse({ ...attach, pendingIntent: { ...attach.pendingIntent, ...invalid } }).success).toBe(false);
    }
    const failure = patch(fixture.pulls[18], ['batch', 'event', 'operation'], 'config');
    expect(DesktopRoomPullResponseSchema.safeParse(failure).success).toBe(true);
    expect(DesktopRoomPullResponseSchema.safeParse(patch(failure, ['batch', 'event', 'error', 'outcome'], 'not-applicable')).success).toBe(false);
    const revoked = { ...fixture.revokedNotifications[0], operation: 'config' };
    expect(DesktopRoomNotificationSchema.safeParse(revoked).success).toBe(true);
    expect(DesktopRoomNotificationSchema.safeParse(patch(revoked, ['error', 'outcome'], 'not-applicable')).success).toBe(false);
  });
  it('ends only local config tracking using a closed token request and small affirmative response', () => {
    const request = { handle: fixture.attach.handle, request: { kind: 'end-config-tracking', intentId: 'config-intent-1' } };
    const ended = { kind: 'config-tracking-ended', intentId: request.request.intentId, ended: true };
    expect(DesktopRoomRequestSchema.parse(request)).toEqual(request);
    expect(DesktopRoomConfigTrackingEndedSchema.parse(ended)).toEqual(ended);
    expect(jsonUtf8ByteLength(ended)).toBeLessThanOrEqual(DESKTOP_ROOM_IPC_LIMITS.smallResponseBytes);
    for (const intentId of [undefined, null, '', 'invalid token', 'x'.repeat(129), 'x'.repeat(DESKTOP_ROOM_IPC_LIMITS.smallResponseBytes)]) {
      expect(DesktopRoomRequestSchema.safeParse(patch(request, ['request', 'intentId'], intentId)).success).toBe(false);
      expect(DesktopRoomConfigTrackingEndedSchema.safeParse({ ...ended, intentId }).success).toBe(false);
    }
    for (const key of ['roomId', 'request', 'expectedRoomEpoch', 'cancel', 'applied', 'response']) {
      expect(DesktopRoomRequestSchema.safeParse(patch(request, ['request', key], true)).success).toBe(false);
      expect(DesktopRoomConfigTrackingEndedSchema.safeParse({ ...ended, [key]: true }).success).toBe(false);
    }
    for (const value of [false, undefined, 'true', 1]) {
      expect(DesktopRoomConfigTrackingEndedSchema.safeParse({ ...ended, ended: value }).success).toBe(false);
    }
    expect(DesktopRoomAcceptedResponseSchema.safeParse(ended).success).toBe(false);
    expect(DesktopRoomConfigTrackingEndedSchema.safeParse(fixture.accepted).success).toBe(false);
  });
  it('requires closed object-only messages and rejects caller-selected transport or credentials', () => {
    const schemas = [DesktopRoomAttachRequestSchema, DesktopRoomRequestSchema, DesktopRoomSubscribeRequestSchema,
      DesktopRoomDetachRequestSchema, DesktopRoomBatchSchema, DesktopRoomNotificationSchema, DesktopRoomPullResponseSchema];
    for (const schema of schemas) for (const raw of [null, true, 42, [], '"{}"', '{}', new Date(), new Map()]) {
      expect(schema.safeParse(raw).success).toBe(false);
    }
    for (const key of ['url', 'origin', 'cookie', 'ticket', 'secretRef', 'headers', 'method', 'onEvent', 'role']) {
      expect(DesktopRoomAttachRequestSchema.safeParse({ ...fixture.attachRequest, [key]: 'secret-canary' }).success).toBe(false);
      expect(DesktopRoomRequestSchema.safeParse({ ...fixture.requests[0], [key]: 'secret-canary' }).success).toBe(false);
      expect(DesktopRoomRequestSchema.safeParse(patch(fixture.requests[0], ['request', key], 'secret-canary')).success).toBe(false);
    }
    for (const kind of ['ticket', 'proposals', 'generations', 'kick', 'fetch']) {
      expect(DesktopRoomRequestSchema.safeParse({ handle: fixture.attach.handle, request: { kind } }).success).toBe(false);
    }
  });
  it('rejects unknown fields at every nested DTO layer without projecting them away', () => {
    const create = fixture.requests.find((value) => value.request.kind === 'create')!;
    for (const path of [[], ['request'], ['request', 'request'], ['request', 'request', 'directory'],
      ['request', 'request', 'sharedConfig'], ['request', 'request', 'sharedConfig', 'historySettings'],
      ['request', 'request', 'sharedConfig', 'combatants', '0'], ['request', 'request', 'sharedConfig', 'combatants', '0', 'ref']]) {
      expect(DesktopRoomRequestSchema.safeParse(patch(create, [...path, 'injected'], 'secret-canary')).success).toBe(false);
    }
    const session = fixture.pulls[2];
    for (const path of [[], ['batch'], ['batch', 'event'], ['batch', 'event', 'response'], ['batch', 'event', 'response', 'desktopRoom'],
      ['batch', 'event', 'response', 'result'], ['batch', 'event', 'response', 'result', 'self'],
      ['batch', 'event', 'response', 'result', 'snapshot'], ['batch', 'event', 'response', 'result', 'snapshot', 'members', '0']]) {
      expect(DesktopRoomPullResponseSchema.safeParse(patch(session, [...path, 'injected'], true)).success).toBe(false);
    }
    expect(DesktopRoomNotificationSchema.safeParse({ ...fixture.notifications[0], body: 'not-a-notification' }).success).toBe(false);
    expect(DesktopRoomErrorSchema.safeParse({ ...fixture.error, cause: 'secret-canary' }).success).toBe(false);
    expect(DesktopRoomErrorSchema.safeParse({ ...fixture.error, message: 'secret-canary' }).success).toBe(false);
  });
  it('caps original create bytes before trim/defaults and counts UTF-8 JSON escapes', () => {
    const create = fixture.requests.find((value) => value.request.kind === 'create')!;
    const raw = structuredClone(create) as unknown as { request: { request: { displayName: string } } };
    const body = raw.request.request;
    const base = jsonUtf8ByteLength(body);
    body.displayName += ' '.repeat(65_536 - base);
    expect(DesktopRoomRequestSchema.safeParse(raw).success).toBe(true);
    body.displayName += ' ';
    expect(DesktopRoomRequestSchema.safeParse(raw).success).toBe(false);
    for (const text of ['界'.repeat(23_000), '\u0001'.repeat(12_000), '😀'.repeat(18_000)]) {
      expect(DesktopRoomRequestSchema.safeParse(patch(create, ['request', 'request', 'displayName'], text)).success).toBe(false);
    }
    const atLimit = directoryPull(DESKTOP_ROOM_IPC_LIMITS.batchBytes);
    expect(jsonUtf8ByteLength(atLimit)).toBe(DESKTOP_ROOM_IPC_LIMITS.batchBytes);
    expect(DesktopRoomPullResponseSchema.safeParse(atLimit).success).toBe(true);
    const oneOver = directoryPull(DESKTOP_ROOM_IPC_LIMITS.batchBytes + 1);
    expect(DesktopRoomBatchSchema.safeParse(oneOver.batch).success).toBe(true);
    expect(DesktopRoomPullResponseSchema.safeParse(oneOver).success).toBe(false);
  });
  it('rejects unsafe integers, excessive depth, cyclic objects, hidden properties and accessors before serialization', () => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, '1']) {
      expect(DesktopRoomAttachRequestSchema.safeParse({ ...fixture.attachRequest, attachIntent: value }).success).toBe(false);
    }
    expect(DesktopRoomAttachRequestSchema.safeParse({ ...fixture.attachRequest, attachIntent: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    expect(DesktopRoomAttachRequestSchema.safeParse({ ...fixture.attachRequest, documentNonce: 'not-document-nonce' }).success).toBe(false);
    expect(DesktopRoomPullResponseSchema.safeParse(patch(fixture.pulls[2], ['batch', 'event', 'response', 'result', 'snapshot', 'controlSeq'], Number.MAX_SAFE_INTEGER + 1)).success).toBe(false);
    let deep: unknown = {};
    for (let index = 0; index < 66; index += 1) deep = { nested: deep };
    expect(DesktopRoomRequestSchema.safeParse({ ...fixture.requests[0], deep }).success).toBe(false);
    const cyclic: Record<string, unknown> = { ...fixture.attachRequest }; cyclic.cycle = cyclic;
    const accessor = Object.defineProperty({ ...fixture.attachRequest }, 'secret', { enumerable: true, get() { throw new Error('must not execute'); } });
    const hidden = Object.defineProperty({ ...fixture.attachRequest }, 'secret', { value: 'hidden', enumerable: false });
    for (const raw of [cyclic, accessor, hidden, JSON.parse('{"__proto__":{}}')]) expect(DesktopRoomAttachRequestSchema.safeParse(raw).success).toBe(false);
  });
  it('rejects unpaired UTF-16 in every Native string value or key without repairing valid emoji', () => {
    for (const text of fixture.unicodeBoundary.invalidJsonTexts) expect(DesktopRoomRequestSchema.safeParse(JSON.parse(text)).success).toBe(false);
    const paired = JSON.parse(fixture.unicodeBoundary.validJsonText);
    expect(DesktopRoomRequestSchema.parse(paired)).toEqual(paired);
    for (const text of ['\ud800', '\udc00', 'before\ud800after', '\ud800\ud800', '\udc00\ud800']) {
      expect(DesktopRoomPullResponseSchema.safeParse(patch(fixture.pulls[0], ['batch', 'event', 'response', 'result', 'items', '0', 'title'], text)).success).toBe(false);
    }
    expect(DesktopRoomPullResponseSchema.safeParse(patch(fixture.pulls[0], ['batch', 'event', 'response', 'result', 'items', '0', 'title'], 'paired 😀')).success).toBe(true);
  });
  it('correlates accepted HTTP failures with request and operation using closed outcomes', () => {
    const failure = fixture.pulls.find((pull) => pull.batch.event.kind === 'request-error')!;
    expect(DesktopRoomPullResponseSchema.safeParse(failure).success).toBe(true);
    for (const [path, value] of [
      [['batch', 'event', 'operation'], 'ticket'],
      [['batch', 'event', 'operation'], 'discover'],
      [['batch', 'event', 'requestId'], undefined],
      [['batch', 'event', 'error', 'message'], 'secret-canary'],
      [['batch', 'event', 'error', 'raw'], 'secret-canary'],
      [['batch', 'event', 'error', 'outcome'], 'not-applicable'],
    ] as Array<[string[], unknown]>) expect(DesktopRoomPullResponseSchema.safeParse(patch(failure, path, value)).success).toBe(false);
  });
  it('checks negotiated owner and emits only a stable error, never parser data', () => {
    const session = fixture.pulls[2].batch;
    expect(() => parseDesktopRoomBatch(session, fixture.expectedUserId + 1)).toThrow(DesktopRoomContractError);
    try { parseDesktopRoomBatch({ ...session, injected: 'secret-canary' }, fixture.expectedUserId); }
    catch (error) {
      expect(error).toMatchObject({ code: 'invalid-response', message: DESKTOP_ROOM_ERROR_MESSAGE });
      expect(error).not.toHaveProperty('cause');
      expect(String(error)).not.toContain('secret-canary');
    }
  });
});

const nativeOutput = process.env.MAHO_ROOM_NATIVE_IPC_FIXTURE;
it.skipIf(!nativeOutput)('consumes unchanged Native-produced pull bytes through the actual IPC schemas', () => {
  const native = JSON.parse(readFileSync(nativeOutput!, 'utf8')) as { expectedUserId: number; attach: unknown; notifications: unknown[]; pulls: unknown[] };
  DesktopRoomAttachResponseSchema.parse(native.attach);
  expect(native.notifications.length).toBeGreaterThan(0);
  for (const raw of native.notifications) DesktopRoomNotificationSchema.parse(raw);
  for (const raw of native.pulls) {
    const parsed = DesktopRoomPullResponseSchema.parse(raw);
    expect(parsed).toEqual(raw);
    if (parsed.kind === 'batch') expect(parseDesktopRoomBatch(parsed.batch, native.expectedUserId)).toEqual(parsed.batch);
  }
});
