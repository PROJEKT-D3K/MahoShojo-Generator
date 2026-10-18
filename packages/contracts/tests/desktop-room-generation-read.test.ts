import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/desktop-room-generation-read.json';
import { ARENA_COMPANION_JSON_LIMITS } from '../src/arena-companion';
import {
  DESKTOP_ROOM_SESSION_LIMITS, DESKTOP_ROOM_SESSION_OPERATIONS,
  DesktopRoomSessionGenerationIdSchema, DesktopRoomSessionPostOperationSchema,
  parseDesktopRoomSessionResponse,
} from '../src/desktop-room-session';
import {
  DESKTOP_ROOM_ERROR_MESSAGE, DESKTOP_ROOM_IPC_LIMITS, DesktopRoomActionSchema, DesktopRoomAckResponseSchema,
  DesktopRoomBatchSchema, DesktopRoomGenerationDescriptorSchema, DesktopRoomGenerationFragmentSchema,
  DesktopRoomMutationOperationSchema, DesktopRoomNotificationSchema,
  DesktopRoomPullResponseSchema, getDesktopRoomHttpOperation, parseDesktopRoomBatch,
} from '../src/desktop-room-ipc';
import { ArenaRoomGenerationViewResponseSchema } from '../src/room-http';
import { jsonUtf8ByteLength, utf8ByteLength } from '../src/wire-size';

const batch = (event: unknown) => ({ handle: 'handle-1', subscriptionId: 'subscription-1',
  batchId: 'batch-1', sequence: 1, event });

describe('Desktop current-generation read transport contract', () => {
  it('grants a strict completion fence only on a newly accepted exact receipt', () => {
    const receipt = { kind: 'acknowledged', handle: 'handle-1', subscriptionId: 'subscription-1', batchId: 'batch-1', sequence: 1, accepted: true };
    expect(DesktopRoomAckResponseSchema.safeParse(receipt).success).toBe(true);
    for (const current of [true, false]) {
      const value = { ...receipt, generationRead: { requestId: fixture.descriptor.requestId, current } };
      expect(DesktopRoomAckResponseSchema.parse(value)).toEqual(value);
      expect(DesktopRoomAckResponseSchema.safeParse({ ...value, accepted: false }).success).toBe(false);
    }
    for (const generationRead of [{ requestId: 'read-1' }, { requestId: 'read-1', current: true, extra: true }, { requestId: '../bad', current: true }]) {
      expect(DesktopRoomAckResponseSchema.safeParse({ ...receipt, generationRead }).success).toBe(false);
    }
  });
  it('has exactly one fixed read and no generation mutation', () => {
    expect(DESKTOP_ROOM_SESSION_OPERATIONS.generationRead).toEqual({ method: 'GET',
      path: '/api/arena/rooms/v1/:roomId/generations/:generationId' });
    expect(DESKTOP_ROOM_SESSION_LIMITS.generationResponseBodyBytes).toBe(ARENA_COMPANION_JSON_LIMITS.wireBytes);
    expect(DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes).toBe(262_144);
    expect(DesktopRoomSessionPostOperationSchema.safeParse('generationRead').success).toBe(false);
    expect(DesktopRoomMutationOperationSchema.safeParse('generationRead').success).toBe(false);
    const action = DesktopRoomActionSchema.parse(fixture.action);
    if (action.kind !== 'generation-read') throw new Error('expected generation action');
    expect(getDesktopRoomHttpOperation(action)).toBe('generationRead');
    for (const key of ['roomId', 'url', 'headers', 'method', 'cookie', 'view', 'request', 'start', 'cancel']) {
      expect(DesktopRoomActionSchema.safeParse({ ...fixture.action, [key]: 'injected' }).success).toBe(false);
    }
    for (const generationId of ['', ' x ', '.', '..', 'a/b', 'a\\b', 'a%2fb', '\ud800', 'x'.repeat(257)]) {
      expect(DesktopRoomSessionGenerationIdSchema.safeParse(generationId).success).toBe(false);
      expect(DesktopRoomActionSchema.safeParse({ ...fixture.action, generationId }).success).toBe(false);
    }
    for (const expectedAttempt of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      expect(DesktopRoomActionSchema.safeParse({ ...fixture.action, expectedAttempt }).success).toBe(false);
    }
  });

  it('preserves the entire checked envelope bytes and escaped lone surrogates across scalar fragments', () => {
    const expected = structuredClone(fixture.operation.success);
    expected.result.markdown += '：\ud800';
    expect(JSON.stringify(expected)).toBe(fixture.rawEnvelope);
    expect(fixture.rawEnvelope).toContain('\\ud800');
    expect(DesktopRoomGenerationDescriptorSchema.parse(fixture.descriptor)).toEqual(fixture.descriptor);
    let offset = 0;
    for (const fragment of fixture.fragments) {
      expect(DesktopRoomGenerationFragmentSchema.parse(fragment)).toEqual(fragment);
      expect(fragment.offset).toBe(offset);
      offset += utf8ByteLength(fragment.text);
      expect(parseDesktopRoomBatch(batch(fragment), fixture.expectedUserId)).toEqual(batch(fragment));
      expect(DesktopRoomPullResponseSchema.safeParse({ kind: 'batch', batch: batch(fragment) }).success).toBe(true);
    }
    const raw = fixture.fragments.map((fragment) => fragment.text).join('');
    expect(raw).toBe(fixture.rawEnvelope);
    expect(offset).toBe(fixture.descriptor.byteLength);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(fixture.descriptor.digest);
    expect(parseDesktopRoomSessionResponse('generationRead', JSON.parse(raw), fixture.expectedUserId)).toEqual(expected);
    expect(ArenaRoomGenerationViewResponseSchema.parse(JSON.parse(raw).result)).toEqual(expected.result);
    expect(DesktopRoomBatchSchema.safeParse(batch({ kind: 'http-result', requestId: fixture.descriptor.requestId,
      operation: 'generationRead', response: fixture.operation.success })).success).toBe(false);
  });

  it('strictly bounds descriptor and raw fragment bytes while keeping the existing full-batch budget', () => {
    for (const invalid of [{ byteLength: 0 }, { byteLength: DESKTOP_ROOM_SESSION_LIMITS.generationResponseBodyBytes + 1 },
      { byteLength: 0.5 }, { attempt: 0 }, { attempt: Number.MAX_SAFE_INTEGER + 1 },
      { digest: 'A'.repeat(64) }, { digest: 'a'.repeat(63) }, { digest: `${'a'.repeat(64)}\n` }, { extra: true }]) {
      expect(DesktopRoomGenerationDescriptorSchema.safeParse({ ...fixture.descriptor, ...invalid }).success).toBe(false);
    }
    for (const text of ['a'.repeat(16_384), '\0'.repeat(16_384), '😀'.repeat(4_096), '界'.repeat(5_461)]) {
      const fragment = { ...fixture.fragments[0], text };
      expect(DesktopRoomGenerationFragmentSchema.parse(fragment)).toEqual(fragment);
      expect(utf8ByteLength(text)).toBeLessThanOrEqual(DESKTOP_ROOM_IPC_LIMITS.generationFragmentBytes);
      const pull = { kind: 'batch', batch: batch(fragment) };
      expect(jsonUtf8ByteLength(pull)).toBeLessThanOrEqual(DESKTOP_ROOM_IPC_LIMITS.batchBytes);
      expect(DesktopRoomPullResponseSchema.parse(pull)).toEqual(pull);
    }
    for (const text of ['', 'a'.repeat(16_385), '😀'.repeat(4_097), '\ud800', '\udc00']) {
      expect(DesktopRoomGenerationFragmentSchema.safeParse({ ...fixture.fragments[0], text }).success).toBe(false);
    }
    for (const invalid of [{ offset: -1 }, { offset: 0.5 }, { offset: DESKTOP_ROOM_SESSION_LIMITS.generationResponseBodyBytes + 1 },
      { final: undefined }, { final: 'true' }, { extra: true }]) {
      expect(DesktopRoomGenerationFragmentSchema.safeParse({ ...fixture.fragments[0], ...invalid }).success).toBe(false);
    }
  });

  it('accepts a strict view above the old ceiling but refuses unnegotiated, wrong-owner or malformed views', () => {
    const success = structuredClone(fixture.operation.success);
    success.result.markdown = '界😀\n'.repeat(50_000) + '\ud800';
    expect(jsonUtf8ByteLength(success)).toBeGreaterThan(DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes);
    expect(parseDesktopRoomSessionResponse('generationRead', success, fixture.expectedUserId)).toEqual(success);
    expect(() => parseDesktopRoomSessionResponse('session', success, fixture.expectedUserId)).toThrow('ROOM_DESKTOP_RESPONSE_TOO_LARGE');
    expect(() => parseDesktopRoomSessionResponse('generationRead', success.result, fixture.expectedUserId)).toThrow('ROOM_DESKTOP_RESPONSE_INVALID');
    expect(() => parseDesktopRoomSessionResponse('generationRead', success, fixture.expectedUserId + 1)).toThrow('ROOM_DESKTOP_OWNER_MISMATCH');
    for (const invalid of [{ desktopRoom: { ...success.desktopRoom, version: 'future' } },
      { result: { ...success.result, extra: true } }, { result: { ...success.result, finalAuthoritative: false } }]) {
      expect(() => parseDesktopRoomSessionResponse('generationRead', { ...success, ...invalid }, fixture.expectedUserId)).toThrow('ROOM_DESKTOP_RESPONSE_INVALID');
    }
    const largeError = { ...fixture.operation.error, padding: 'x'.repeat(DESKTOP_ROOM_SESSION_LIMITS.responseBodyBytes) };
    expect(() => parseDesktopRoomSessionResponse('generationRead', largeError, fixture.expectedUserId)).toThrow('ROOM_DESKTOP_RESPONSE_TOO_LARGE');
  });

  it('requires read-only outcomes for request errors and revocation, without mutation intents', () => {
    const error = { code: 'response-too-large', message: DESKTOP_ROOM_ERROR_MESSAGE, outcome: 'not-applicable' };
    const requestError = { kind: 'request-error', requestId: fixture.descriptor.requestId, operation: 'generationRead', error };
    const revoked = { type: 'revoked', ...batch(undefined), requestId: fixture.descriptor.requestId, operation: 'generationRead', error };
    delete (revoked as { event?: unknown }).event;
    expect(DesktopRoomBatchSchema.safeParse(batch(requestError)).success).toBe(true);
    expect(DesktopRoomNotificationSchema.safeParse(revoked).success).toBe(true);
    for (const outcome of ['not-applied', 'unknown']) {
      expect(DesktopRoomBatchSchema.safeParse(batch({ ...requestError, error: { ...error, outcome } })).success).toBe(false);
      expect(DesktopRoomNotificationSchema.safeParse({ ...revoked, error: { ...error, outcome } }).success).toBe(false);
    }
    expect(DesktopRoomBatchSchema.safeParse(batch({ kind: 'mutation-unknown', intentId: 'intent-1',
      operation: 'generationRead', roomId: fixture.descriptor.roomId })).success).toBe(false);
  });
});
