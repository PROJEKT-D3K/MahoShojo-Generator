import { describe, expect, it, vi } from 'vitest';
import { discoverLocalAi } from '../src/platform/local-ai-discovery-bridge';
import type { LocalAiDiscoveryRequest } from '@mahoshojo/contracts/local-ai-discovery';
const request: LocalAiDiscoveryRequest = { contractVersion: 1, requestId: 'r1', target: { kind: 'candidate', candidateId: 'ollama' } };
const response = { contractVersion: 1, requestId: 'r1', outcome: 'completed', service: { protocol: 'ollama-native', state: 'no-models', models: [] } };
describe('local discovery bridge', () => {
  it('invokes only strict discovery and returns validated response', async () => {
    const invoke = vi.fn(async () => response);
    expect(await discoverLocalAi(invoke, request, new AbortController().signal)).toEqual(response);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('discover_local_ai', { request });
  });
  it('pre-abort dispatches nothing', async () => {
    const invoke = vi.fn(); const c = new AbortController(); c.abort();
    await expect(discoverLocalAi(invoke, request, c.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('sends real cancel once and handles late rejected or resolved IPC', async () => {
    for (const rejectLate of [true, false]) {
      let resolve!: (value: unknown) => void; let reject!: (value: unknown) => void;
      const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
      const invoke = vi.fn((command: string) => command === 'discover_local_ai' ? pending : Promise.resolve(false));
      const c = new AbortController(); const result = discoverLocalAi(invoke, request, c.signal);
      const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
      c.abort(); c.abort(); await assertion;
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke).toHaveBeenLastCalledWith('cancel_local_ai_discovery', { request: { requestId: 'r1' } });
      if (rejectLate) reject(new Error('late secret-bearing failure')); else resolve(response);
      await Promise.resolve();
    }
  });
  it('rejects wrong identity/unknown fields and sanitizes native failures', async () => {
    for (const raw of [{ ...response, requestId: 'other' }, { ...response, secret: 'bad' }]) {
      await expect(discoverLocalAi(async () => raw, request, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-response' });
    }
    await expect(discoverLocalAi(async () => { throw { code: 'busy', message: 'sensitive' }; }, request, new AbortController().signal)).rejects.toMatchObject({ code: 'busy', message: '本机服务检查失败（busy）' });
    await expect(discoverLocalAi(async () => { throw 'sensitive'; }, request, new AbortController().signal)).rejects.toMatchObject({ code: 'failed' });
  });
});
