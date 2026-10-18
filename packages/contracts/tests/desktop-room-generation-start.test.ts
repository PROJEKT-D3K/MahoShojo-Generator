import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/desktop-room-generation-start.json';
import { DESKTOP_ROOM_SESSION_LIMITS, DESKTOP_ROOM_START_MAX_NODES, isDesktopRoomStartWithinNodeBudget, DesktopRoomGenerationStartRequestSchema, DesktopRoomGenerationStartReceiptSchema, parseDesktopRoomSessionRequest } from '../src/desktop-room-session';
import { DesktopRoomActionSchema, DesktopRoomPendingIntentSchema, DesktopRoomStartInvokeSchema } from '../src/desktop-room-ipc';
import { jsonUtf8ByteLength } from '../src/wire-size';

describe('Desktop fixed-default generation start', () => {
  it('counts exact aggregate nodes across individually valid payloads without tightening Web JSON', () => {
    const request = { ...fixture.action.request, hostLocalPayloads: Array.from({ length: 10 }, (_, index) => ({
      key: `host-local:${index}`, kind: 'character', payload: { values: Array(9000).fill(null) },
    })), generation: { narrativeHistory: [] as null[] } };
    const count = (value: unknown): number => 1 + (value && typeof value === 'object' ? Object.values(value).reduce<number>((total, child) => total + count(child), 0) : 0);
    request.generation.narrativeHistory = Array(DESKTOP_ROOM_START_MAX_NODES - count(request)).fill(null);
    expect(count(request)).toBe(100_000); expect(isDesktopRoomStartWithinNodeBudget(request)).toBe(true);
    const parsed = DesktopRoomGenerationStartRequestSchema.safeParse(request); expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    request.generation.narrativeHistory.push(null);
    expect(isDesktopRoomStartWithinNodeBudget(request)).toBe(false); expect(DesktopRoomGenerationStartRequestSchema.safeParse(request).success).toBe(false);
    const sameNodesWithUnicodeKeys = { '中文🌙': [null, { '另一键': 1 }] };
    expect(isDesktopRoomStartWithinNodeBudget(sameNodesWithUnicodeKeys)).toBe(true);
    let deep: unknown = null; for (let index = 0; index < 66; index += 1) deep = [deep];
    expect(isDesktopRoomStartWithinNodeBudget(deep)).toBe(false);
  });
  it('keeps a closed original request and intent-only retry', () => {
    expect(DesktopRoomActionSchema.parse(fixture.action)).toEqual(fixture.action);
    expect(DesktopRoomActionSchema.parse({ kind: 'retry-generation-start', intentId: 'original' })).toEqual({ kind: 'retry-generation-start', intentId: 'original' });
    for (const extra of [{ request: fixture.action.request }, { roomEpoch: 'new' }, { systemConfig: {} }, { customProvider: { apiKey: 'forbidden' } }]) {
      expect(DesktopRoomActionSchema.safeParse({ kind: 'retry-generation-start', intentId: 'original', ...extra }).success).toBe(false);
      expect(DesktopRoomActionSchema.safeParse({ ...fixture.action, ...extra, request: { ...fixture.action.request, ...extra } }).success).toBe(false);
    }
    for (const flag of ['isDowngrade', 'arenaFreeRankingEnabled']) {
      const value = structuredClone(fixture.action);
      (value.request.generation as Record<string, unknown>)[flag] = true;
      expect(DesktopRoomActionSchema.safeParse(value).success).toBe(false);
    }
    const provider = structuredClone(fixture.operation.request) as unknown as { request: { generation: Record<string, unknown> } };
    provider.request.generation.customProvider = { apiKey: 'forbidden' };
    expect(() => parseDesktopRoomSessionRequest('generationStart', provider, fixture.operation.request.desktopRoom.expectedUserId)).toThrow();
  });
  it.each(['a', '中', '🌙', '\\', '\n'])('counts the original DTO including escaped UTF-8 %s before projection', (unit) => {
    const value = structuredClone(fixture.operation.request);
    const padding = DESKTOP_ROOM_SESSION_LIMITS.generationStartOriginalBytes - jsonUtf8ByteLength(value.request);
    // displayName-like trim is deliberately not involved: full arbitrary runtime JSON is counted.
    (value.request.generation as Record<string, unknown>).narrativeHistory = '';
    const overhead = jsonUtf8ByteLength(value.request) - (DESKTOP_ROOM_SESSION_LIMITS.generationStartOriginalBytes - padding);
    const size = jsonUtf8ByteLength(unit) - 2;
    (value.request.generation as Record<string, unknown>).narrativeHistory = unit.repeat(Math.floor((padding - overhead) / size)) + 'x'.repeat((padding - overhead) % size);
    expect(jsonUtf8ByteLength(value.request)).toBe(DESKTOP_ROOM_SESSION_LIMITS.generationStartOriginalBytes);
    expect(parseDesktopRoomSessionRequest('generationStart', value, value.desktopRoom.expectedUserId)).toBeTruthy();
    expect(DesktopRoomStartInvokeSchema.safeParse({ request: { handle: 'host', request: { ...fixture.action, request: value.request } } }).success).toBe(true);
    (value.request.generation as Record<string, string>).narrativeHistory += 'x';
    expect(() => parseDesktopRoomSessionRequest('generationStart', value, value.desktopRoom.expectedUserId)).toThrow('ROOM_PAYLOAD_TOO_LARGE');
  });
  it('binds metadata and keeps the receipt small', () => {
    const pending = { intentId: 'start', operation: 'generationStart', roomId: fixture.action.roomId,
      generationStart: { roomEpoch: fixture.action.request.expectedRoomEpoch, generationRequestId: fixture.action.request.generationRequestId, retryable: true } };
    expect(DesktopRoomPendingIntentSchema.parse(pending)).toEqual(pending);
    expect(DesktopRoomPendingIntentSchema.safeParse({ ...pending, generationStart: undefined }).success).toBe(false);
    expect(DesktopRoomGenerationStartReceiptSchema.parse(fixture.operation.success.result)).toEqual(fixture.operation.success.result);
    for (const extra of [{ markdown: 'body' }, { result: {} }, { finalAuthoritative: true }]) expect(DesktopRoomGenerationStartReceiptSchema.safeParse({ ...fixture.operation.success.result, ...extra }).success).toBe(false);
    expect(DesktopRoomStartInvokeSchema.safeParse({ request: { handle: 'host', request: { ...fixture.action, roomId: '../other' } } }).success).toBe(false);
  });
});
