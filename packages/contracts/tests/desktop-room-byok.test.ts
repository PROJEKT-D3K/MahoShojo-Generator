import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/desktop-room-generation-start.json';
import { DesktopRoomActionSchema, DesktopRoomAttachResponseSchema, DesktopRoomGenerationStartTrackingEndedSchema, DESKTOP_ROOM_IPC_LIMITS, DesktopRoomPendingIntentSchema, DesktopRoomStartInvokeSchema } from '../src/desktop-room-ipc';
import { DesktopRoomGenerationStartRequestSchema, DesktopRoomGenerationStartWireRequestSchema, DesktopRoomInjectedProviderSchema, DESKTOP_ROOM_SESSION_LIMITS, DESKTOP_ROOM_START_MAX_NODES, parseDesktopRoomSessionRequest } from '../src/desktop-room-session';
import { jsonUtf8ByteLength } from '../src/wire-size';

const presetConfig = { providerId: 'deepseek', modelId: 'deepseek-v4-flash-0731', generationOverrides: { temperature: 0.5, maxOutputTokens: 4096, thinking: { mode: 'disabled' as const } } };
const provider = { ...presetConfig, apiKey: 'synthetic-room-byok-contract' };
const request = () => ({ ...structuredClone(fixture.action.request), generation: { customProvider: { ...provider } } });
const envelope = (request: unknown) => ({ desktopRoom: fixture.operation.request.desktopRoom, request });

describe('Desktop room catalog BYOK boundaries', () => {
  it('keeps non-secret selection only on the action and never changes system wire', () => {
    const action = { ...fixture.action, presetConfig };
    expect(DesktopRoomActionSchema.parse(action)).toEqual(action);
    expect(DesktopRoomStartInvokeSchema.parse({ request: { handle: 'host', request: action } })).toBeTruthy();
    expect(DesktopRoomActionSchema.parse(fixture.action)).toEqual(fixture.action);
    expect(parseDesktopRoomSessionRequest('generationStart', fixture.operation.request, fixture.operation.request.desktopRoom.expectedUserId)).toBeTruthy();
    for (const selection of [null, { ...presetConfig, secretRef: 'forbidden' }, { ...presetConfig, apiKey: 'forbidden' }, { ...presetConfig, baseUrl: 'https://invalid.example' }, { ...presetConfig, providerId: 'system' }, { ...presetConfig, modelId: '__custom_model_id__' }, { ...presetConfig, generationOverrides: { temperature: -1 } }]) {
      expect(DesktopRoomActionSchema.safeParse({ ...action, presetConfig: selection }).success).toBe(false);
    }
    for (const extra of [{ apiKey: 'forbidden' }, { secretRef: 'forbidden' }, { presetConfig }, { customProvider: provider }]) {
      expect(DesktopRoomActionSchema.safeParse({ ...action, request: { ...action.request, ...extra } }).success).toBe(false);
      expect(DesktopRoomActionSchema.safeParse({ kind: 'retry-generation-start', intentId: 'original', ...extra }).success).toBe(false);
    }
    expect(DesktopRoomActionSchema.safeParse({ ...action, request: request() }).success).toBe(false);
    expect(DesktopRoomGenerationStartRequestSchema.safeParse(request()).success).toBe(false);
  });
  it('bounds the original public selection before multibyte whitespace is trimmed', () => {
    const selection = { providerId: 'deepseek', modelId: '\ufeff'.repeat(3300) + 'deepseek-v4-flash' };
    expect(jsonUtf8ByteLength(selection)).toBeLessThan(10 * 1024);
    expect(DesktopRoomActionSchema.parse({ ...fixture.action, presetConfig: selection })).toMatchObject({ presetConfig: { modelId: 'deepseek-v4-flash' } });
    selection.modelId = '\ufeff'.repeat(3500) + 'deepseek-v4-flash';
    expect(jsonUtf8ByteLength(selection)).toBeGreaterThan(10 * 1024);
    expect(DesktopRoomActionSchema.safeParse({ ...fixture.action, presetConfig: selection }).success).toBe(false);
  });
  it('accepts only the strict Native injected provider through the API wire consumer', () => {
    const value = request();
    expect(DesktopRoomGenerationStartWireRequestSchema.parse(value)).toEqual(value);
    expect(parseDesktopRoomSessionRequest('generationStart', envelope(value), fixture.operation.request.desktopRoom.expectedUserId)).toBeTruthy();
    for (const customProvider of [null, {}, { ...provider, providerId: 'system' }, { ...provider, modelId: '__custom_model_id__' }, { ...provider, maxOutputTokens: 2 }, { ...provider, headers: {} }, { ...provider, secretRef: 'forbidden' }, { ...provider, baseUrl: 'https://invalid.example' }, { ...provider, generationOverrides: { thinking: { mode: 'disabled', effort: 'max' } } }]) {
      expect(DesktopRoomGenerationStartWireRequestSchema.safeParse({ ...value, generation: { customProvider } }).success).toBe(false);
    }
    expect(() => parseDesktopRoomSessionRequest('generationStart', { ...envelope(value), presetConfig }, fixture.operation.request.desktopRoom.expectedUserId)).toThrow();
  });
  it('bounds raw UTF-8 Key bytes independently of trim and escaping', () => {
    for (const apiKey of ['x'.repeat(8192), '🌙'.repeat(2048), '\u0001'.repeat(8192)]) expect(DesktopRoomInjectedProviderSchema.safeParse({ ...provider, apiKey }).success).toBe(true);
    for (const apiKey of ['', '   ', 'x'.repeat(8193), ' '.repeat(8192) + 'x', '🌙'.repeat(2048) + 'x']) expect(DesktopRoomInjectedProviderSchema.safeParse({ ...provider, apiKey }).success).toBe(false);
  });
  it('counts the injected provider inside the original 12 MiB and emits an actual TS golden', () => {
    const value = { ...request(), generation: { customProvider: { ...provider, modelId: 'deepseek-v4-flash', apiKey: '\u0001'.repeat(8192) }, narrativeHistory: '' } };
    value.generation.narrativeHistory = 'x'.repeat(DESKTOP_ROOM_SESSION_LIMITS.generationStartOriginalBytes - jsonUtf8ByteLength(value));
    expect(jsonUtf8ByteLength(value)).toBe(12 * 1024 * 1024);
    expect(parseDesktopRoomSessionRequest('generationStart', envelope(value), fixture.operation.request.desktopRoom.expectedUserId)).toBeTruthy();
    const dir = process.env.MAHO_ROOM_BYOK_FIXTURE_DIR;
    if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'injected-exact.json'), JSON.stringify(value)); writeFileSync(join(dir, 'action.json'), JSON.stringify(DesktopRoomActionSchema.parse({ ...fixture.action, presetConfig }))); }
    value.generation.narrativeHistory += 'x';
    expect(() => parseDesktopRoomSessionRequest('generationStart', envelope(value), fixture.operation.request.desktopRoom.expectedUserId)).toThrow('ROOM_PAYLOAD_TOO_LARGE');
  });
  it('counts injected provider nodes in the same aggregate ceiling', () => {
    const value = { ...request(), hostLocalPayloads: Array.from({ length: 10 }, (_, i) => ({ key: `host-local:${i}`, kind: 'character', payload: { values: Array(9000).fill(null) } })), generation: { customProvider: provider, narrativeHistory: [] as null[] } };
    const count = (input: unknown): number => 1 + (input && typeof input === 'object' ? Object.values(input).reduce<number>((n, item) => n + count(item), 0) : 0);
    value.generation.narrativeHistory = Array(DESKTOP_ROOM_START_MAX_NODES - count(value)).fill(null);
    expect(DesktopRoomGenerationStartWireRequestSchema.safeParse(value).success).toBe(true);
    value.generation.narrativeHistory.push(null);
    expect(DesktopRoomGenerationStartWireRequestSchema.safeParse(value).success).toBe(false);
  });
  it('recovers bounded long pending selections without enlarging ordinary small responses', () => {
    const opaque = 'a' + '\u0001'.repeat(255);
    const pending = { intentId: 'i'.repeat(128), operation: 'generationStart', roomId: opaque,
      generationTarget: { roomEpoch: opaque, generationId: opaque, attempt: Number.MAX_SAFE_INTEGER },
      generationStart: { roomEpoch: opaque, generationRequestId: 'r'.repeat(128), retryable: true,
        presetConfig: { ...presetConfig, providerId: 'p'.repeat(100), modelId: '中'.repeat(200), generationOverrides: { maxOutputTokens: 1_000_000, temperature: 1e-300, thinking: { mode: 'enabled', effort: 'minimal' } } } } };
    const value = { handle: 'h'.repeat(128), subscriptionId: 's'.repeat(128), pendingIntent: pending, generationStartBlocked: false, generationStartFence: null };
    expect(jsonUtf8ByteLength(value)).toBeGreaterThan(1024);
    expect(jsonUtf8ByteLength(value)).toBeLessThanOrEqual(DESKTOP_ROOM_IPC_LIMITS.generationStartRecoveryBytes);
    expect(DesktopRoomAttachResponseSchema.safeParse(value).success).toBe(true);
    const system = structuredClone(value); Reflect.deleteProperty(system.pendingIntent.generationStart, 'presetConfig');
    expect(DesktopRoomAttachResponseSchema.safeParse(system).success).toBe(true);
    const fence = { roomId: opaque, generationRequestId: 'r'.repeat(128) };
    const ended = { kind: 'generation-start-tracking-ended', intentId: 'i'.repeat(128), ended: true, generationStartBlocked: true, generationStartFence: fence };
    expect(jsonUtf8ByteLength(ended)).toBeGreaterThan(1024);
    expect(DesktopRoomGenerationStartTrackingEndedSchema.safeParse(ended).success).toBe(true);
    expect(DesktopRoomAttachResponseSchema.safeParse({ ...value, pendingIntent: null, generationStartBlocked: true, generationStartFence: fence }).success).toBe(true);
    expect(DesktopRoomAttachResponseSchema.safeParse({ ...value, pendingIntent: { intentId: 'i'.repeat(128), operation: 'close', roomId: opaque } }).success).toBe(false);
  });
  it('exposes only the original non-secret choice in pending and keeps retry intent-only', () => {
    const pending = { intentId: 'start', operation: 'generationStart', roomId: fixture.action.roomId, generationStart: { roomEpoch: fixture.action.request.expectedRoomEpoch, generationRequestId: fixture.action.request.generationRequestId, retryable: true, presetConfig } };
    expect(DesktopRoomPendingIntentSchema.parse(pending)).toEqual(pending);
    expect(DesktopRoomPendingIntentSchema.safeParse({ ...pending, generationStart: { ...pending.generationStart, presetConfig: provider } }).success).toBe(false);
  });
});
