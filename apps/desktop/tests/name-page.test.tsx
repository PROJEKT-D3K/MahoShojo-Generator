// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNameGenerationResult } from '@mahoshojo/domain/name-generation';
import { NAME_DRAFT_KEY } from '../src/features/name/session';
import { resetDesktopAiConfigStoreForTests, getDesktopAiConfigStore } from '../src/features/ai-config/use-desktop-ai-config';
import { listDesktopPresetEntries } from '../src/features/ai-config/desktop-ai-config';
import { DESKTOP_AI_CONFIG_STORAGE_KEY } from '../src/features/ai-config/desktop-ai-config-store';
import { createDesktopRouter } from '../src/app/router';
import type { DesktopGenerationOutcome } from '../src/features/generation/executor';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), execute: vi.fn(), download: vi.fn(), downloadBlob: vi.fn(), capture: vi.fn(), listen: vi.fn(), profiles: vi.fn() }));
vi.mock('../src/platform/download-text-file', () => ({ downloadTextFile: mocks.download, downloadBlobFile: mocks.downloadBlob }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: mocks.listen }) }));
vi.mock('../src/features/name/generation', async original => ({ ...await original<object>(), executeNameGeneration: mocks.execute }));
vi.mock('@mahoshojo/ui-web/client', async original => ({ ...await original<object>(), capturePngBlob: mocks.capture }));
vi.mock('../src/platform/provider-profile-bridge', () => ({ listProviderProfileIds: async () => ['local'], getProviderProfile: mocks.profiles }));
vi.mock('../src/platform/local-card-bridge', () => ({ IpcLocalCardRepository: class {} }));
const generated = { flowerName: '铃兰', flowerDescription: '幸福归来', appearance: { height: '155cm', weight: '45kg', hairColor: '银白色', hairStyle: '长发', eyeColor: '绿色', skinTone: '白皙', wearing: '礼服', specialFeature: '微笑', mainColor: '绿色', firstPageColor: '#123456', secondPageColor: '#654321' }, spell: '花よ\n花啊' };
const card = buildNameGenerationResult('小满', generated);
const completed: DesktopGenerationOutcome<'name'> = { status: 'completed', mode: 'direct-local', card: { ...card }, cardKind: 'name', rawText: JSON.stringify(generated) };
let root: Root; let host: HTMLDivElement;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.includes(text))!;
const click = async (text: string) => { await act(async () => button(text).click()); await settle(); };
const draft = (inputName = '小满') => ({ version: 1, inputName, selectedLanguage: 'zh-CN' });
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); mocks.invoke.mockReset(); mocks.invoke.mockResolvedValue(true); localStorage.clear();
  localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 2, selection: { executionPreference: 'client', clientConnectionId: 'local' }, hiddenPresetIds: [] }));
  localStorage.setItem(NAME_DRAFT_KEY, JSON.stringify(draft()));
  resetDesktopAiConfigStoreForTests();
  mocks.profiles.mockResolvedValue({ id: 'local', name: '本地模型', adapter: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'model' });
  mocks.execute.mockResolvedValue(completed); mocks.listen.mockImplementation(async () => vi.fn()); mocks.capture.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [{ code: 'zh-CN', name: '简体中文' }, { code: 'ja', name: '日本語' }] })));
  vi.spyOn(window, 'confirm').mockReturnValue(false); vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  window.location.hash = '#/name'; host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const mount = async () => { const router = createDesktopRouter(); await router.load(); await act(async () => root.render(<StrictMode><RouterProvider router={router} /></StrictMode>)); await settle(); return router; };

describe('Desktop classic route with the existing owner and AI configuration', () => {
  it('auto-restores input, generates through frozen Direct settings and exports the shared JSON/PNG', async () => {
    await mount(); expect(mocks.execute).not.toHaveBeenCalled(); expect(host.querySelector<HTMLInputElement>('#name')?.value).toBe('小满');
    await click('へんしん');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute.mock.calls[0]!.slice(0, 3)).toEqual([
      expect.objectContaining({ profileId: 'local', providerTarget: { kind: 'custom', profileId: 'local' } }),
      { realName: '小满', language: 'zh-CN' },
      expect.objectContaining({ mode: 'direct-local', generationMode: 'non-stream', modelId: 'model' }),
    ]);
    expect(host.querySelector('.result-card')?.textContent).toContain('铃兰');
    await click('下载设定文件'); expect(mocks.download).toHaveBeenCalledWith('魔法少女_铃兰.json', JSON.stringify(card, null, 2));
    await click('保存为图片'); expect(mocks.capture).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ mediaAdapter: expect.objectContaining({ snapdomProxyUrl: '' }) }));
    expect(mocks.downloadBlob).toHaveBeenCalledWith('铃兰.png', expect.any(Blob));
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it('blocks a second request and model changes, cancels, keeps raw output and rejects a late card', async () => {
    let finish!: (result: DesktopGenerationOutcome<'name'>) => void; let signal!: AbortSignal;
    mocks.execute.mockImplementation((_options, _input, _intent, abortSignal, partial) => { signal = abortSignal; partial('half raw'); return new Promise(resolve => { finish = resolve; }); });
    await mount(); await click('へんしん');
    await act(async () => button('少女创造中').click()); expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLInputElement>('#name')?.disabled).toBe(true); expect(host.textContent).toContain('half raw');
    await click('取消生成'); expect(signal.aborted).toBe(true);
    await act(async () => finish({ ...completed, rawText: 'half raw' })); await settle();
    expect(host.querySelector('.result-card')).toBeNull(); expect(host.textContent).toContain('half raw');
    expect(JSON.parse(localStorage.getItem(NAME_DRAFT_KEY)!).output.phase).toBe('cancelled');
  });
  it('reopens a completed draft without model calls or result navigation', async () => {
    localStorage.setItem(NAME_DRAFT_KEY, JSON.stringify({ ...draft(), output: { mode: 'direct-local', cardKind: 'name', card, rawText: 'saved original', phase: 'completed' } }));
    await mount(); expect(host.querySelector('.result-card')?.textContent).toContain('铃兰'); expect(mocks.execute).not.toHaveBeenCalled();
    await click('下载设定文件'); expect(mocks.download).toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('protects failed-draft content on navigation and preserves it on export failure', async () => {
    const router = await mount(); await click('へんしん');
    mocks.capture.mockRejectedValue(new Error('snapshot failed')); await click('保存为图片');
    expect(host.textContent).toContain('当前结果已保留'); expect(host.querySelector('.result-card')).toBeTruthy();
    const original = localStorage.getItem(NAME_DRAFT_KEY);
    expect(original).toContain('铃兰');
    await act(async () => router.navigate({ to: '/' })); await settle();
    expect(router.state.location.pathname).toBe('/');
    expect(localStorage.getItem(NAME_DRAFT_KEY)).toBe(original);
  });
  it('shows server unsupported rather than dispatching a fake hosted route', async () => {
    localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 2, selection: { executionPreference: 'server', clientConnectionId: 'local' }, hiddenPresetIds: [] }));
    resetDesktopAiConfigStoreForTests(); await mount();
    expect(host.textContent).toContain('服务器模式不支持此页面'); expect(button('へんしん').disabled).toBe(true); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('keeps the old successful registration card while a new failed raw attempt is visible', async () => {
    await mount(); await click('へんしん');
    mocks.execute.mockResolvedValue({ status: 'invalid-output', mode: 'direct-local', rawText: 'new malformed JSON', message: 'invalid output' });
    await click('へんしん');
    expect(window.confirm).not.toHaveBeenCalled();
    expect(host.querySelector('.result-card')?.textContent).toContain('铃兰');
    expect(host.textContent).toContain('上次成功结果'); expect(host.textContent).toContain('new malformed JSON');
    await click('下载设定文件'); expect(mocks.download).toHaveBeenCalledWith('魔法少女_铃兰.json', JSON.stringify(card, null, 2));
  });
  it('pagehide cancels preparation before a late credential probe can dispatch', async () => {
    await mount(); const store = getDesktopAiConfigStore();
    const preset = listDesktopPresetEntries(new Set()).find(entry => entry.directCapableModels.length > 0)!;
    await act(async () => { store.selectProviderTarget({ kind: 'preset', providerId: preset.preset.id }); store.selectPresetModel(preset.preset.id, preset.directCapableModels[0]!.value); });
    await settle();
    let release!: (value: boolean) => void;
    mocks.invoke.mockImplementation(async (command: string) => command === 'has_provider_secret' ? new Promise<boolean>(resolve => { release = resolve; }) : true);
    expect(button('へんしん').disabled).toBe(false);
    await click('へんしん'); expect(store.isPreparingGeneration()).toBe(true);
    expect(() => store.selectProviderTarget({ kind: 'custom', profileId: 'local' })).toThrow('生成期间');
    expect(() => store.setPresetKeyDraft(preset.preset.id, 'synthetic-new-key')).toThrow('生成期间');
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(store.isPreparingGeneration()).toBe(false);
    await act(async () => release(true)); await settle();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('preserves corrupt storage until confirmed and retains usable input when clearing fails', async () => {
    localStorage.setItem(NAME_DRAFT_KEY, '{broken'); await mount();
    await click('清除损坏草稿'); expect(localStorage.getItem(NAME_DRAFT_KEY)).toBe('{broken');
    const input = host.querySelector<HTMLInputElement>('#name')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '仍可填写');
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
    vi.mocked(window.confirm).mockReturnValue(true);
    const originalRemove = Storage.prototype.removeItem;
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) { if (key === NAME_DRAFT_KEY) throw new Error('read-only'); return originalRemove.call(this, key); });
    await click('清除损坏草稿');
    expect(localStorage.getItem(NAME_DRAFT_KEY)).toBe('{broken'); expect(input.value).toBe('仍可填写'); expect(host.textContent).toContain('原数据已保留');
    remove.mockRestore(); await click('清除损坏草稿');
    expect(localStorage.getItem(NAME_DRAFT_KEY)).toBeNull(); expect(input.value).toBe(''); expect(host.textContent).not.toContain('清除损坏草稿并重置本页');
  });

});
