import { describe, expect, it, vi } from 'vitest';
import {
  cancelLocalAiLaunch, getLocalAiLaunchStatus, prepareLocalAiLaunch, startLocalAi, stopLocalAi,
} from '../src/platform/local-ai-launch-bridge';
const runtime = { contractVersion: 1 as const, runtimeId: 'ollama' as const };
const operation = { ...runtime, operationId: 'op:1' };
const request = { ...operation, installationId: 'install:1' };
const installation = { installationId: 'install:1', product: 'Ollama', source: 'default-location' };
const prepared = { ...operation, state: 'prepared', installation };
describe('local launch narrow bridge', () => {
  it('uses validated requests for each command without additional authority', async () => {
    const invoke = vi.fn(async () => prepared);
    expect(await prepareLocalAiLaunch(invoke)).toEqual(prepared);
    expect(invoke).toHaveBeenLastCalledWith('prepare_local_ai_launch', { request: runtime });
    await getLocalAiLaunchStatus(invoke);
    expect(invoke).toHaveBeenLastCalledWith('get_local_ai_launch_status', { request: runtime });
    await startLocalAi(invoke, request);
    expect(invoke).toHaveBeenLastCalledWith('start_local_ai', { request });
    await cancelLocalAiLaunch(invoke, operation);
    expect(invoke).toHaveBeenLastCalledWith('cancel_local_ai_launch', { request: operation });
    await stopLocalAi(invoke, operation);
    expect(invoke).toHaveBeenLastCalledWith('stop_local_ai', { request: operation });
  });
  it('never dispatches unknown/path/argv/environment authority', () => {
    const invoke = vi.fn();
    expect(() => prepareLocalAiLaunch(invoke, { ...runtime, path: 'C:/bad.exe' } as typeof runtime)).toThrow();
    expect(() => startLocalAi(invoke, { ...request, env: { OLLAMA_HOST: '0.0.0.0' } } as typeof request)).toThrow();
    expect(() => stopLocalAi(invoke, { ...operation, pid: 42 } as typeof operation)).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('rejects mismatched operation identity, malformed states, and injected response fields', async () => {
    for (const value of [{ ...prepared, operationId: 'other' }, { ...prepared, path: 'bad' }, { ...prepared, installation: { ...installation, installationId: 'different' } }, { ...operation, state: 'ready' }]) {
      await expect(startLocalAi(async () => value, request)).rejects.toMatchObject({ code: 'invalid-response', operationId: 'op:1' });
    }
  });
  it('preserves operation identity on failure and never retries a side effect', async () => {
    const invoke = vi.fn(async () => { throw { code: 'installation-changed', message: 'secret local path' }; });
    await expect(startLocalAi(invoke, request)).rejects.toMatchObject({ code: 'installation-changed', operationId: 'op:1', message: '本次启动操作未确认（installation-changed）' });
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(getLocalAiLaunchStatus(async () => { throw 'secret raw failure'; })).rejects.toMatchObject({ code: 'failed' });
  });
  it('retains a late prepare ticket rather than silently aborting the native operation', async () => {
    let resolve!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise(yes => { resolve = yes; }));
    const pending = prepareLocalAiLaunch(invoke); resolve(prepared);
    expect(await pending).toEqual(prepared);
  });
});
