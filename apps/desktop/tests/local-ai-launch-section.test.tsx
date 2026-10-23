// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectProviderProfileV1 } from '@mahoshojo/contracts/provider-profile';
import { LocalAiDiscoverySection } from '../src/features/ai-config/LocalAiDiscoverySection';
import { useDesktopAiConfig, getDesktopAiConfigStore, resetDesktopAiConfigStoreForTests } from '../src/features/ai-config/use-desktop-ai-config';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn(), documents: {} as Record<string, unknown> }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../src/platform/provider-profile-bridge', () => ({
  listProviderProfileIds: async () => Object.keys(mocks.documents),
  getProviderProfile: async (_invoke: unknown, id: string) => mocks.documents[id] ?? null,
  saveProviderProfile: async (_invoke: unknown, doc: DirectProviderProfileV1) => {
    mocks.save(doc); mocks.documents[doc.id] = doc; return doc;
  },
  deleteProviderProfile: async () => undefined,
  validateProviderExecutionProfile: async (_invoke: unknown, doc: unknown) => doc,
}));
const model = (id = 'new-model', remote = false) => ({ id, kind: 'unknown', loaded: 'unknown', execution: remote ? 'remote-indicated' : 'unknown' });
const complete = (requestId: string, models = [model()], state = 'reachable') => ({
  contractVersion: 1, requestId, outcome: 'completed', service: { protocol: 'ollama-native', state, models },
});
const cached = (command: string) => command === 'get_local_ai_launch_status' ? { contractVersion: 1, runtimeId: 'ollama', state: 'idle' } : false;
let root: Root; let container: HTMLDivElement;
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const button = (text: string) => [...container.querySelectorAll('button')].find(el => el.textContent === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); await settle(); };
const select = async (label: string, value: string) => {
  await act(async () => { const input = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle();
};
const Harness = () => <LocalAiDiscoverySection aiConfig={useDesktopAiConfig()} onManualConfigure={() => undefined} />;
const mount = async () => { await act(async () => root.render(<StrictMode><Harness /></StrictMode>)); await settle(); };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear(); resetDesktopAiConfigStoreForTests(); mocks.documents = {}; vi.clearAllMocks();
  mocks.invoke.mockImplementation(async (command: string, args?: { request?: { requestId: string } }) => {
    if (command === 'has_provider_secret') return false;
    if (command === 'discover_local_ai') return complete(args!.request!.requestId);
    return cached(command);
  });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const runtime = { contractVersion: 1, runtimeId: 'ollama' };
const operation = { ...runtime, operationId: 'op:1' };
const installation = { installationId: 'install:1', product: 'Ollama', source: 'default-location' };
const prepared = { ...operation, state: 'prepared', installation };
const ready = (models = [model()], state = 'reachable') => ({ ...operation, state: 'ready', installation, service: complete('unused', models, state).service });
let status: Record<string, unknown>;
beforeEach(() => {
  status = { ...runtime, state: 'idle' };
  mocks.invoke.mockImplementation(async (command: string, args?: { request?: { requestId: string } }) => {
    if (command === 'get_local_ai_launch_status') return status;
    if (command === 'discover_local_ai') return complete(args!.request!.requestId, [], 'unreachable');
    if (command === 'prepare_local_ai_launch') { status = prepared; return status; }
    if (command === 'start_local_ai') { status = ready(); return status; }
    if (command === 'cancel_local_ai_launch') { status = { ...operation, state: 'cancelled' }; return status; }
    if (command === 'stop_local_ai') { status = { ...operation, state: 'stopped' }; return status; }
    return false;
  });
});
const prepare = async () => { await mount(); await click('检查本机 AI 服务'); await click('检查所选服务'); };
const count = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command).length;
describe('managed Ollama actual discovery/save consumer', () => {
  it('only reads cached status on open and never prepares, discovers, or starts implicitly', async () => {
    await mount(); expect(count('get_local_ai_launch_status')).toBe(0);
    await click('检查本机 AI 服务');
    expect(count('get_local_ai_launch_status')).toBe(1);
    for (const command of ['discover_local_ai', 'prepare_local_ai_launch', 'start_local_ai']) expect(count(command)).toBe(0);
  });
  it('keeps a newer unreachable probe rather than reusing stale owned-ready models from cached status', async () => {
    status = ready(); const native = mocks.invoke.getMockImplementation()!; let discovered = 0;
    mocks.invoke.mockImplementation((cmd, args) => cmd === 'discover_local_ai' && discovered++ === 0
      ? Promise.resolve(complete(args!.request!.requestId)) : native(cmd, args));
    await mount(); await click('检查本机 AI 服务');
    expect(button('停止本次启动的服务')).toBeDefined();
    expect(button('保存所选模型并使用')).toBeUndefined();
    await click('检查所选服务'); expect(button('保存所选模型并使用')).toBeDefined();
    await click('检查所选服务');
    expect(container.textContent).toContain('未连接到该本机接口');
    expect(count('prepare_local_ai_launch')).toBe(0);
    expect(button('保存所选模型并使用')).toBeUndefined();
    expect(button('停止本次启动的服务')).toBeDefined();
    await click('查询本次启动状态');
    expect(container.textContent).toContain('未连接到该本机接口');
    expect(button('保存所选模型并使用')).toBeUndefined();
    expect(count('start_local_ai')).toBe(0);
  });
  it('does not turn prepare rejection recovery into a fresh service probe', async () => {
    const native = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) => {
      if (cmd === 'prepare_local_ai_launch') { status = ready(); return Promise.reject({ code: 'busy' }); }
      return native(cmd, args);
    });
    await prepare();
    expect(container.textContent).toContain('未连接到该本机接口');
    expect(button('停止本次启动的服务')).toBeDefined();
    expect(button('保存所选模型并使用')).toBeUndefined();
    expect(count('start_local_ai')).toBe(0);
  });
  it('single-flights explicit check/start and saves through the existing model/profile consumer without inference', async () => {
    await mount(); await click('检查本机 AI 服务');
    await act(async () => { button('检查所选服务').click(); button('检查所选服务').click(); }); await settle();
    expect(count('discover_local_ai')).toBe(1); expect(count('prepare_local_ai_launch')).toBe(1);
    expect(count('start_local_ai')).toBe(0);
    await act(async () => { button('为本次使用启动 Ollama').click(); button('为本次使用启动 Ollama').click(); }); await settle();
    expect(count('start_local_ai')).toBe(1);
    expect(mocks.invoke).toHaveBeenCalledWith('start_local_ai', { request: { ...operation, installationId: 'install:1' } });
    await click('保存所选模型并使用');
    const doc = mocks.save.mock.calls[0][0] as DirectProviderProfileV1;
    expect(doc).toMatchObject({ modelId: 'new-model', baseUrl: 'http://127.0.0.1:11434/v1' });
    expect(getDesktopAiConfigStore().getSnapshot().selection.clientConnectionId).toBe(doc.id);
    expect(mocks.invoke.mock.calls.some(([name]) => /stream_|generate|download|pull_model/.test(String(name)))).toBe(false);
  });
  it('never exposes stop for an external service discovered before the explicit start', async () => {
    const native = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) => cmd === 'start_local_ai' ? Promise.resolve({ ...operation, state: 'external', service: ready().service }) : native(cmd, args));
    await prepare(); await click('为本次使用启动 Ollama');
    expect(container.textContent).toContain('本应用不会停止它');
    expect(button('停止本次启动的服务')).toBeUndefined();
    expect(button('保存所选模型并使用')).toBeDefined();
  });
  it('explains GUI-only model paths for ready-but-empty services without downloading anything', async () => {
    const native = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) => cmd === 'start_local_ai' ? Promise.resolve(ready([], 'no-models')) : native(cmd, args));
    await prepare(); await click('为本次使用启动 Ollama');
    expect(container.textContent).toContain('改过模型位置');
    expect(container.textContent).toContain('不必重复下载');
    expect(button('保存所选模型并使用')).toBeUndefined();
    expect(button('停止本次启动的服务')).toBeDefined();
  });
  it('revokes a late prepare ticket after target change and cannot start stale work', async () => {
    let resolve!: (value: unknown) => void;
    const native = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) => cmd === 'prepare_local_ai_launch' ? new Promise(yes => { resolve = yes; }) : native(cmd, args));
    await prepare(); await select('本机服务检查目标', 'candidate:lm-studio');
    expect(count('cancel_local_ai_launch')).toBe(0);
    await act(async () => resolve(prepared)); await settle();
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_local_ai_launch', { request: operation });
    expect(count('start_local_ai')).toBe(0);
    expect(button('为本次使用启动 Ollama')).toBeUndefined();
    expect(container.textContent).toContain('LM Studio 请先在官方应用');
  });
  it('cancels prepare before the ticket arrives even when the same panel closes and reopens', async () => {
    let resolve!: (value: unknown) => void;
    const native = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) => cmd === 'prepare_local_ai_launch' ? new Promise(yes => { resolve = yes; }) : native(cmd, args));
    await prepare(); await click('收起本机服务检查'); await click('检查本机 AI 服务');
    await act(async () => resolve(prepared)); await settle();
    expect(count('cancel_local_ai_launch')).toBe(1); expect(count('start_local_ai')).toBe(0);
    expect(button('为本次使用启动 Ollama')).toBeUndefined();
    expect(container.textContent).toContain('本次启动已取消');
    expect(button('检查所选服务').disabled).toBe(false);
  });
  it('does not stop ready service on close/unmount and recovers it from cached Native state on reopen', async () => {
    await prepare(); await click('为本次使用启动 Ollama');
    await click('收起本机服务检查'); await click('检查本机 AI 服务');
    expect(count('stop_local_ai')).toBe(0); expect(count('cancel_local_ai_launch')).toBe(0);
    expect(button('停止本次启动的服务')).toBeDefined();
    await act(async () => root.unmount()); root = createRoot(container); await mount(); await click('检查本机 AI 服务');
    expect(button('停止本次启动的服务')).toBeDefined();
    expect(button('保存所选模型并使用')).toBeUndefined();
    expect(count('discover_local_ai')).toBe(1);
    expect(count('start_local_ai')).toBe(1); expect(count('stop_local_ai')).toBe(0);
  });
  it.each(['failed', 'stopped', 'cancelled'])('clears earlier ready models when cached status confirms %s', async terminal => {
    await prepare(); await click('为本次使用启动 Ollama');
    expect(button('保存所选模型并使用')).toBeDefined();
    status = { ...operation, state: terminal, ...(terminal === 'failed' ? { errorCode: 'process-exited' } : {}) };
    await click('查询本次启动状态');
    expect(button('保存所选模型并使用')).toBeUndefined();
    expect(button('停止本次启动的服务')).toBeUndefined();
    expect(count('discover_local_ai')).toBe(1); expect(count('start_local_ai')).toBe(1);
  });
  it('recovers a lost start reply by querying the original operation, never resending start', async () => {
    const native = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) => {
      if (cmd === 'start_local_ai') { status = ready(); return Promise.reject('lost native reply'); }
      return native(cmd, args);
    });
    await prepare(); await click('为本次使用启动 Ollama');
    expect(count('start_local_ai')).toBe(1); expect(count('get_local_ai_launch_status')).toBe(2);
    expect(button('停止本次启动的服务')).toBeDefined();
  });
  it('recovers an explicitly requested start that initially returned starting without sending another start', async () => {
    const native = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) => cmd === 'start_local_ai' ? Promise.resolve({ ...prepared, state: 'starting' }) : native(cmd, args));
    await prepare(); await click('为本次使用启动 Ollama');
    status = ready(); await click('查询本次启动状态');
    expect(button('保存所选模型并使用')).toBeDefined();
    expect(count('start_local_ai')).toBe(1); expect(count('discover_local_ai')).toBe(1);
  });
  it('recovers a still-pending start from status and ignores its stale error after an explicit stop', async () => {
    let reject!: (reason: unknown) => void;
    const native = mocks.invoke.getMockImplementation()!; let rejectStatus = false;
    mocks.invoke.mockImplementation((cmd, args) => {
      if (cmd === 'start_local_ai') return new Promise((_yes, no) => { reject = no; });
      if (cmd === 'get_local_ai_launch_status' && rejectStatus) return Promise.reject('late status unavailable');
      return native(cmd, args);
    });
    await prepare(); await click('为本次使用启动 Ollama');
    status = ready(); await click('查询本次启动状态'); await click('停止本次启动的服务');
    rejectStatus = true; await act(async () => reject('late start reply')); await settle();
    expect(container.textContent).toContain('本次服务已停止');
    expect(container.textContent).not.toContain('尚未确认原操作结果');
    expect(button('停止本次启动的服务')).toBeUndefined();
    expect(button('检查所选服务').disabled).toBe(false);
    expect(count('start_local_ai')).toBe(1);
  });
  it('retains original identity after an uncertain reply and refuses an unrelated recovered operation', async () => {
    const native = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) => {
      if (cmd === 'start_local_ai') { status = { ...ready(), operationId: 'other-op' }; return Promise.reject('lost'); }
      return native(cmd, args);
    });
    await prepare(); await click('为本次使用启动 Ollama');
    expect(container.textContent).toContain('尚未确认原操作结果');
    expect(button('检查所选服务').disabled).toBe(true);
    await click('查询本次启动状态'); expect(container.textContent).toContain('原操作仍未确认');
    expect(count('start_local_ai')).toBe(1); expect(button('停止本次启动的服务')).toBeUndefined();
  });
  it('reports cancellation cleanup as pending until Native confirms the terminal state', async () => {
    let resolve!: (value: unknown) => void;
    const native = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) => {
      if (cmd === 'start_local_ai') return new Promise(yes => { resolve = yes; });
      if (cmd === 'cancel_local_ai_launch') { status = { ...operation, state: 'stopping', installation }; return Promise.resolve(status); }
      return native(cmd, args);
    });
    await prepare(); await click('为本次使用启动 Ollama'); await click('取消本次启动');
    expect(container.textContent).toContain('正在停止…');
    expect(container.textContent).not.toContain('本次启动已取消');
    status = { ...operation, state: 'cancelled' };
    await click('查询本次启动状态');
    expect(container.textContent).toContain('本次启动已取消');
    await act(async () => resolve(status)); await settle();
    expect(count('start_local_ai')).toBe(1);
  });
  it('blocks stopping during generation and retries only the same owned operation after cleanup failure', async () => {
    await prepare(); await click('为本次使用启动 Ollama'); await click('保存所选模型并使用');
    let finish!: () => void;
    const store = getDesktopAiConfigStore(); let generating!: Promise<void>;
    await act(async () => { generating = store.withPreparedGeneration(async () => new Promise<void>(resolve => { finish = resolve; })); }); await settle();
    expect(button('停止本次启动的服务').disabled).toBe(true);
    expect(count('stop_local_ai')).toBe(0);
    await act(async () => { finish(); await generating; }); await settle();
    const native = mocks.invoke.getMockImplementation()!; let attempts = 0;
    mocks.invoke.mockImplementation((cmd, args) => {
      if (cmd === 'stop_local_ai' && attempts++ === 0) { status = { ...operation, state: 'stopping', installation }; return Promise.resolve(status); }
      return native(cmd, args);
    });
    await click('停止本次启动的服务');
    expect(container.textContent).toContain('正在停止…');
    expect(button('保存所选模型并使用')).toBeUndefined();
    await click('重试停止本次服务');
    expect(container.textContent).toContain('本次服务已停止');
    const stops = mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'stop_local_ai');
    expect(stops).toHaveLength(2); for (const call of stops) expect(call[1]).toEqual({ request: operation });
  });
});
