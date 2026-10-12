import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/arena-strict-preflight.json';
import { DesktopStrictPreflightRequestSchema, STRICT_PREFLIGHT_MAX_BYTES, type DesktopStrictPreflightRequest } from '@mahoshojo/contracts/arena-strict-preflight';
import { readStrictPreflight } from '../src/platform/strict-preflight-bridge';

const request = () => DesktopStrictPreflightRequestSchema.parse(fixture.request);
const command = 'cloud_arena_strict_preflight';

describe('Desktop fixed Strict preflight bridge', () => {
  it('uses only the narrow command and validates shared result fields', async () => {
    const invoke = vi.fn().mockResolvedValue(fixture.response);
    await expect(readStrictPreflight(invoke, request())).resolves.toEqual(fixture.response);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(command, { request: fixture.request });
  });
  it.each(['url', 'headers', 'apiKey', 'secretRef', 'credentials', 'endpoint'])('rejects %s before IPC', async (field) => {
    const invoke = vi.fn();
    const invalid = { ...request(), [field]: 'escape' } as DesktopStrictPreflightRequest;
    await expect(readStrictPreflight(invoke, invalid)).rejects.toMatchObject({ command, code: 'invalid-request' });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('enforces serialized UTF-8 bytes, including the exact request limit', async () => {
    const invoke = vi.fn().mockResolvedValue(fixture.response);
    const exact = request();
    exact.body.combatants = Array.from({ length: 32 }, () => ({ ...exact.body.combatants[0], characterGuidance: 'x'.repeat(2000) }));
    exact.body.combatants[0].characterGuidance = '';
    const padding = STRICT_PREFLIGHT_MAX_BYTES - new TextEncoder().encode(JSON.stringify(exact)).byteLength;
    expect(padding).toBeGreaterThan(0); expect(padding).toBeLessThan(2000);
    exact.body.combatants[0].characterGuidance = 'x'.repeat(padding);
    expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(STRICT_PREFLIGHT_MAX_BYTES);
    await expect(readStrictPreflight(invoke, exact)).resolves.toEqual(fixture.response);
    invoke.mockClear(); exact.body.combatants[0].characterGuidance += 'x';
    await expect(readStrictPreflight(invoke, exact)).rejects.toMatchObject({ code: 'invalid-request' });
    expect(invoke).not.toHaveBeenCalled();
    const multibyte = request();
    multibyte.body.combatants = Array.from({ length: 32 }, () => ({ ...multibyte.body.combatants[0], characterGuidance: '中'.repeat(2000) }));
    expect(DesktopStrictPreflightRequestSchema.safeParse(multibyte).success).toBe(true);
    await expect(readStrictPreflight(invoke, multibyte)).rejects.toMatchObject({ code: 'invalid-request' });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('fails closed on old deployment, wrong viewer, decision mismatch and private fields', async () => {
    const legacy: Partial<typeof fixture.response> = { ...fixture.response }; delete legacy.preflightVersion;
    const noViewer: Partial<typeof fixture.response> = { ...fixture.response }; delete noViewer.viewerUserId;
    for (const response of [legacy, noViewer, { ...fixture.response, viewerUserId: 43 }, { ...fixture.response, willCount: false }, { ...fixture.response, reasons: ['blocked'] }, { ...fixture.response, cookie: 'secret' }, { ...fixture.response, daily: { ...fixture.response.daily, privateMetadata: 'secret' } }]) {
      await expect(readStrictPreflight(vi.fn().mockResolvedValue(response), request())).rejects.toMatchObject({ command, code: 'invalid-response' });
    }
  });
  it.each(['not-authenticated', 'state-mismatch', 'network-error', 'protocol-mismatch', 'response-too-large', 'forbidden', 'server-unavailable'])('preserves Native %s errors without disguising them as a negative preflight', async (code) => {
    const invoke = vi.fn().mockRejectedValue({ code, message: 'synthetic error' });
    await expect(readStrictPreflight(invoke, request())).rejects.toMatchObject({ command, code, message: 'synthetic error' });
  });
  it('binds validation to the parsed request snapshot rather than a mutable caller object', async () => {
    const input = request();
    let resolve!: (value: unknown) => void;
    const invoke = vi.fn().mockImplementation(() => new Promise<unknown>((done) => { resolve = done; }));
    const pending = readStrictPreflight(invoke, input);
    input.expectedUserId = 43;
    resolve(fixture.response);
    await expect(pending).resolves.toMatchObject({ viewerUserId: 42 });
    expect(invoke.mock.calls[0][1].request.expectedUserId).toBe(42);
  });
  it.skipIf(!process.env.STRICT_PREFLIGHT_NATIVE_WIRE_INPUT)('consumes the real Native loopback typed projection through the renderer schema', async () => {
    const native: unknown = JSON.parse(readFileSync(join(process.env.STRICT_PREFLIGHT_NATIVE_WIRE_INPUT!, 'strict-preflight.json'), 'utf8'));
    await expect(readStrictPreflight(vi.fn().mockResolvedValue(native), request())).resolves.toEqual(fixture.response);
  });
});
