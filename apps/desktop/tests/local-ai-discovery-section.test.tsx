// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectProviderProfileV1 } from '@mahoshojo/contracts/provider-profile';
import { AiConnectionsPanel } from '../src/features/ai-config/AiConnectionsPanel';
import { getDesktopAiConfigStore, resetDesktopAiConfigStoreForTests } from '../src/features/ai-config/use-desktop-ai-config';
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
const profile = (id = 'p1'): DirectProviderProfileV1 => ({
  version: 1, id, name: '已安装服务', adapter: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1',
  modelId: 'old-model', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
});
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
const mount = async () => { await act(async () => root.render(<StrictMode><AiConnectionsPanel /></StrictMode>)); await settle(); };
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
describe('settings local discovery actual consumer', () => {
  it('never probes on mount/open; explicit discovery saves chosen model and activates the shared store', async () => {
    await mount(); await click('检查本机 AI 服务');
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === 'discover_local_ai')).toBe(false);
    await click('检查所选服务'); await click('保存所选模型并使用');
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const doc = mocks.save.mock.calls[0][0] as DirectProviderProfileV1;
    expect(doc).toMatchObject({ modelId: 'new-model', baseUrl: 'http://127.0.0.1:11434/v1' });
    const snapshot = getDesktopAiConfigStore().getSnapshot();
    expect(snapshot.selection).toMatchObject({ executionPreference: 'client', clientConnectionId: doc.id });
    expect(snapshot.modelsByProfileId[doc.id].selectedModelId).toBe('new-model');
    expect(mocks.invoke.mock.calls.every(([cmd]) => !String(cmd).startsWith('stream_'))).toBe(true);
  });
  it('does not revive a completed model list after closing and reopening', async () => {
    await mount(); await click('检查本机 AI 服务'); await click('检查所选服务');
    expect(button('保存所选模型并使用')).toBeDefined();
    await click('收起本机服务检查'); await click('检查本机 AI 服务');
    expect(button('保存所选模型并使用')).toBeUndefined();
  });

  it('keeps existing address/name and replaces the active model rather than stale inline selection', async () => {
    mocks.documents.p1 = profile(); await mount();
    const store = getDesktopAiConfigStore();
    act(() => { store.activateConnection('p1'); store.useInlineModel('old-inline'); });
    await click('检查本机 AI 服务'); await select('本机服务检查目标', 'profile:p1');
    await click('检查所选服务'); await click('保存所选模型并使用');
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ id: 'p1', name: '已安装服务', baseUrl: profile().baseUrl, modelId: 'new-model' });
    expect(store.getSnapshot().modelsByProfileId.p1.selectedModelId).toBe('new-model');
    expect(store.getSnapshot().modelsByProfileId.p1.inlineModelId).toBeUndefined();
  });
  it('sends cancel and ignores late results after target switch and close', async () => {
    let finish!: (value: unknown) => void; let requestId = '';
    mocks.invoke.mockImplementation((cmd: string, args: { request: { requestId: string } }) => {
      if (cmd === 'discover_local_ai') { requestId = args.request.requestId; return new Promise(resolve => { finish = resolve; }); }
      return Promise.resolve(cached(cmd));
    });
    await mount(); await click('检查本机 AI 服务'); await click('检查所选服务');
    await select('本机服务检查目标', 'candidate:lm-studio');
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_local_ai_discovery', { request: { requestId } });
    await act(async () => finish(complete(requestId))); await settle();
    expect(button('保存所选模型并使用')).toBeUndefined();
    await click('检查所选服务'); await click('收起本机服务检查');
    await act(async () => finish(complete(requestId))); await settle();
    await click('检查本机 AI 服务');
    expect(button('保存所选模型并使用')).toBeUndefined();
  });
  it('isolates late response when the saved Profile changes under the same id', async () => {
    mocks.documents.p1 = profile(); let finish!: (value: unknown) => void; let requestId = '';
    mocks.invoke.mockImplementation((cmd: string, args: { request: { requestId: string } }) => {
      if (cmd === 'discover_local_ai') { requestId = args.request.requestId; return new Promise(resolve => { finish = resolve; }); }
      return Promise.resolve(cached(cmd));
    });
    await mount(); await click('检查本机 AI 服务'); await select('本机服务检查目标', 'profile:p1'); await click('检查所选服务');
    await act(async () => { await getDesktopAiConfigStore().saveConnection({ id: 'p1', name: '已修改', baseUrl: profile().baseUrl, modelId: 'changed' }); });
    await act(async () => finish(complete(requestId))); await settle();
    expect(button('保存所选模型并使用')).toBeUndefined();
  });
  it('permanently invalidates completed results across Profile A to B to A restoration', async () => {
    const original = profile(); mocks.documents.p1 = original;
    await mount(); await click('检查本机 AI 服务'); await select('本机服务检查目标', 'profile:p1'); await click('检查所选服务');
    expect(button('保存所选模型并使用')).toBeDefined();
    mocks.documents.p1 = { ...original, modelId: 'changed' };
    await act(async () => getDesktopAiConfigStore().refreshProfiles()); await settle();
    mocks.documents.p1 = original;
    await act(async () => getDesktopAiConfigStore().refreshProfiles()); await settle();
    expect(button('保存所选模型并使用')).toBeUndefined();
  });

  it('does not offer remote-only/empty models or pretend auth onboarding is automatic', async () => {
    let next = complete('unused', [model('cloud:cloud', true)], 'no-compatible-models');
    mocks.invoke.mockImplementation(async (cmd: string, args: { request: { requestId: string } }) => cmd === 'discover_local_ai' ? { ...next, requestId: args.request.requestId } : cached(cmd));
    await mount(); await click('检查本机 AI 服务'); await click('检查所选服务');
    expect(button('保存所选模型并使用')).toBeUndefined();
    expect(container.querySelector<HTMLOptionElement>('option[value="cloud:cloud"]')!.disabled).toBe(true);
    next = complete('unused', [], 'auth-required'); await click('检查所选服务');
    expect(container.textContent).toContain('复制模型标识');
    expect(mocks.save).not.toHaveBeenCalled();
    await click('手动配置此服务');
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
  });
  it('does not activate failed persistence and retries with the same new Profile id', async () => {
    await mount(); const store = getDesktopAiConfigStore(); const original = store.saveConnection;
    const saved = vi.spyOn(store, 'saveConnection').mockRejectedValueOnce(new Error('保存失败'));
    await click('检查本机 AI 服务'); await click('检查所选服务'); await click('保存所选模型并使用');
    expect(store.getSnapshot().selection.clientConnectionId).toBeNull();
    const firstId = saved.mock.calls[0][0].id; saved.mockImplementation(original);
    await click('保存所选模型并使用'); expect(saved.mock.calls[1][0].id).toBe(firstId);
  });
});
