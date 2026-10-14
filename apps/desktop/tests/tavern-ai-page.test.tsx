// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopTavern } from '../src/app/tavern-page';
import { getDesktopAiConfigStore, resetDesktopAiConfigStoreForTests } from '../src/features/ai-config/use-desktop-ai-config';
import { DESKTOP_AI_CONFIG_STORAGE_KEY } from '../src/features/ai-config/desktop-ai-config-store';
import { listDesktopPresetEntries } from '../src/features/ai-config/desktop-ai-config';
import { TAVERN_AI_DRAFT_KEY } from '../src/features/tavern/session';
import type { TavernGenerationInput } from '../src/features/tavern/generation';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), execute: vi.fn(), export: vi.fn(), save: vi.fn(), guard: vi.fn(), account: { userId: null as number | null, epoch: 0 } }));
vi.mock('../src/features/account/use-desktop-cloud-session', () => {
  const authFlow = { kind: 'idle' };
  const getSnapshot = () => ({ bootstrapped: true, account: mocks.account.userId === null ? null : { userId: mocks.account.userId }, verification: mocks.account.userId === null ? 'signed-out' : 'verified', authFlow });
  return { useDesktopCloudSession: () => ({ state: getSnapshot(), store: { getSnapshot, getCredentialEpoch: () => mocks.account.epoch } }) };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({}), Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('../src/app/useLeaveGuard', () => ({ useLeaveGuard: (...args: unknown[]) => { mocks.guard(...args); return { ready: true }; } }));
vi.mock('../src/features/external-links/external-links-provider', () => ({ useExternalLinks: () => ({ openFixed: vi.fn() }) }));
vi.mock('../src/features/tavern/generation', async original => ({ ...await original<object>(), executeTavernGeneration: mocks.execute }));
vi.mock('../src/platform/provider-profile-bridge', () => ({ listProviderProfileIds: async () => ['local'], getProviderProfile: async () => ({ id: 'local', name: '本地模型', adapter: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'model' }) }));
vi.mock('../src/platform/local-card-bridge', () => ({ IpcLocalCardRepository: class {} }));
vi.mock('../src/features/tavern/host', () => ({ saveDesktopTavernCard: mocks.save, exportTavernFile: mocks.export, getDesktopTavernBase: vi.fn() }));
vi.mock('@mahoshojo/ui-web/shell', () => ({ ProductFooter: () => null }));
vi.mock('@mahoshojo/ui-web/character-card', () => ({ CanshouCard: () => null, GeneralCharacterCard: ({ general }: { general: { content: string } }) => <pre data-result="character">{general.content}</pre> }));
vi.mock('@mahoshojo/ui-web/scenario', () => ({ GeneralScenarioCard: ({ scenario }: { scenario: { content: string } }) => <pre data-result="scenario">{scenario.content}</pre> }));
let root: Root; let host: HTMLDivElement;
const raw = { name: 'Alice', description: '{{user}} 对 {{char}} 说话', unknown: { keep: true } };
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.includes(text))!;
const click = async (text: string) => { await act(async () => button(text).click()); await settle(); };
async function upload(value = raw) {
  const bytes = new TextEncoder().encode(JSON.stringify(value)); const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'card.json', size: bytes.length, arrayBuffer: async () => bytes.buffer }] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}
async function chooseAi() { const input = host.querySelector<HTMLInputElement>('input[name="tavern-convert-mode"]:not(:checked)')!; await act(async () => input.click()); await settle(); }
async function template(value: string) { const select = host.querySelector<HTMLSelectElement>('select')!; await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }); }
const scenario = { title: '整理情景', scenario_type: '互动', description: '简介', elements: { scene: { place: '庭院' }, events: 'AI 整理正文', atmosphere: '轻松', development: ['探访'] } };
const complete = (input: TavernGenerationInput) => ({ status: 'completed', mode: 'direct-local', cardKind: input.template, rawText: '模型输出', card: input.template === 'scenario' ? { ...scenario, _tavern: { raw: input.raw } } : { templateId: input.template === 'general' ? '通用角色' : '通用情景', ...(input.template === 'general' ? { name: '整理角色' } : { title: '整理情景' }), content: 'AI 整理正文', _tavern: { raw: input.raw } } });
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.account = { userId: null, epoch: 0 };
  vi.clearAllMocks(); mocks.invoke.mockReset(); mocks.invoke.mockResolvedValue(true); mocks.execute.mockReset(); mocks.execute.mockImplementation(async (_options, input) => complete(input));
  localStorage.clear(); localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 2, selection: { executionPreference: 'client', clientConnectionId: 'local' }, hiddenPresetIds: [] })); resetDesktopAiConfigStoreForTests();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [{ code: 'zh-CN', name: '简体中文' }] })));
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const mount = async () => { await act(async () => root.render(<StrictMode><DesktopTavern /></StrictMode>)); await settle(); };

describe('Desktop Tavern actual Direct journey', () => {
  it.each(['general', 'general-scenario', 'scenario'])('generates %s with frozen source and restores without replay', async kind => {
    await mount(); await upload(); await template(kind); if (kind !== 'scenario') await chooseAi(); await click('开始转换');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute.mock.calls[0]!.slice(0, 3)).toEqual([
      expect.objectContaining({ profileId: 'local', providerTarget: { kind: 'custom', profileId: 'local' } }),
      expect.objectContaining({ raw, template: kind, language: 'zh-CN' }),
      expect.objectContaining({ mode: 'direct-local', generationMode: 'non-stream', modelId: 'model' }),
    ]);
    expect(host.querySelector('[data-result]')?.textContent).toContain('AI 整理正文');
    await click(kind === 'scenario' ? '下载情景卡 JSON' : '下载通用卡 JSON'); const exported = JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[0]![0].bytes));
    expect(exported).toMatchObject({ ...(kind === 'scenario' ? scenario : { content: 'AI 整理正文' }), _tavern: { raw } });
    if (kind === 'scenario') { expect(exported).not.toHaveProperty('content'); expect(exported).not.toHaveProperty('templateId'); }
    await act(async () => root.unmount()); root = createRoot(host); await mount();
    expect(mocks.execute).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('已恢复 AI 结果');
    await click('导出原件 JSON'); expect(JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[1]![0].bytes))).toEqual(raw);
  });
  it('selects structured AI locally, disables unsupported rules, and preserves execution preference', async () => {
    await mount(); await upload(); const before = localStorage.getItem(DESKTOP_AI_CONFIG_STORAGE_KEY);
    await template('scenario');
    const rules = host.querySelector<HTMLInputElement>('input[name="tavern-convert-mode"]')!;
    expect(rules.disabled).toBe(true); expect(rules.checked).toBe(false);
    expect(host.textContent).toContain('尚未提供规则映射'); expect(host.querySelector('[data-result]')).toBeNull();
    expect(localStorage.getItem(DESKTOP_AI_CONFIG_STORAGE_KEY)).toBe(before);
    await act(async () => rules.click()); await click('开始转换');
    expect(mocks.execute.mock.calls[0]![1].template).toBe('scenario');
    expect(host.querySelector('[data-result="scenario"]')?.textContent).toContain('庭院');
  });
  it('requires confirmation for source/template changes and never restores a result under the replacement source', async () => {
    await mount(); await upload(); await chooseAi(); await click('开始转换');
    await template('general-scenario'); expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe('general');
    await upload({ ...raw, name: 'Bob' }); expect(host.querySelector('[data-result]')?.textContent).toContain('AI 整理正文');
    vi.mocked(window.confirm).mockReturnValue(true); await template('general-scenario');
    expect(host.querySelector('[data-result]')).toBeNull(); expect(JSON.parse(localStorage.getItem(TAVERN_AI_DRAFT_KEY)!).output.card).toBeNull();
    await click('开始转换'); await upload({ ...raw, name: 'Bob' });
    expect(host.querySelector('[data-result]')).toBeNull(); expect(JSON.parse(localStorage.getItem(TAVERN_AI_DRAFT_KEY)!).input).toBeNull();
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });
  it('single-flights, disables source changes, cancels the original request and rejects its late card', async () => {
    let finish!: (result: unknown) => void; let signal!: AbortSignal; let frozen!: TavernGenerationInput;
    mocks.execute.mockImplementation((_options, input, _intent, abort) => { signal = abort; frozen = input; return new Promise(resolve => { finish = resolve; }); });
    await mount(); await upload(); await chooseAi();
    await act(async () => { button('开始转换').click(); button('开始转换').click(); });
    expect(mocks.execute).toHaveBeenCalledTimes(1); expect(host.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLSelectElement>('select')?.disabled).toBe(true);
    await click('取消转换'); expect(signal.aborted).toBe(true); await act(async () => finish(complete(frozen)));
    expect(host.querySelector('[data-result]')).toBeNull(); expect(host.textContent).toContain('模型输出'); expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it.each(['general', 'scenario'])('uses Hosted %s without rewriting the selected server preference', async kind => {
    localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 2, selection: { executionPreference: 'server', clientConnectionId: 'local' }, hiddenPresetIds: [] })); resetDesktopAiConfigStoreForTests();
    await mount(); await upload(); const before = localStorage.getItem(DESKTOP_AI_CONFIG_STORAGE_KEY); await template(kind); if (kind !== 'scenario') await chooseAi();
    expect(button('开始转换').disabled).toBe(false); await click('开始转换');
    expect(mocks.execute.mock.calls[0]![2]).toMatchObject({ mode: 'hosted-json', generationMode: 'non-stream' });
    expect(mocks.execute.mock.calls[0]![0]).toMatchObject({ providerTarget: { kind: 'system' }, onHostedDispatchSettled: expect.any(Function) });
    expect(localStorage.getItem(DESKTOP_AI_CONFIG_STORAGE_KEY)).toBe(before);
  });
  it.each(['system', 'preset'] as const)('stores Hosted cooldown under the %s key only', async kind => {
    localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 2, selection: { executionPreference: 'server', clientConnectionId: 'local' }, hiddenPresetIds: [] })); resetDesktopAiConfigStoreForTests();
    await mount(); await upload(); await chooseAi();
    if (kind === 'preset') {
      const store = getDesktopAiConfigStore();
      await act(async () => { store.selectProviderTarget({ kind: 'preset', providerId: 'deepseek' }); store.selectPresetModel('deepseek', 'deepseek-chat'); }); await settle();
    }
    await click('开始转换');
    expect(mocks.execute).toHaveBeenCalledOnce();
    const start = Date.now();
    await act(async () => mocks.execute.mock.calls[0]![0].onHostedDispatchSettled());
    const mode = kind === 'system' ? 'system' : 'custom';
    expect(Number(localStorage.getItem(`tavernConvertCooldown:${mode}`))).toBeGreaterThanOrEqual(start + (kind === 'system' ? 120_000 : 3_000));
    expect(localStorage.getItem(`tavernConvertCooldown:${kind === 'system' ? 'custom' : 'system'}`)).toBeNull();
  });
  it('rejects oversized Hosted source metadata before preset credential preparation', async () => {
    localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 2, selection: { executionPreference: 'server', clientConnectionId: 'local' }, hiddenPresetIds: [] })); resetDesktopAiConfigStoreForTests();
    await mount(); await upload({ ...raw, name: 'x'.repeat(4097) }); await chooseAi();
    const store = getDesktopAiConfigStore();
    await act(async () => { store.selectProviderTarget({ kind: 'preset', providerId: 'deepseek' }); store.selectPresetModel('deepseek', 'deepseek-chat'); }); await settle();
    mocks.invoke.mockClear(); expect(button('开始转换').disabled).toBe(true);
    expect(host.textContent).toContain('4096'); expect(store.isPreparingGeneration()).toBe(false); expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it.each(['login', 'same-account-credential'] as const)('blocks an account change during preset preparation: %s', async change => {
    localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 2, selection: { executionPreference: 'server', clientConnectionId: 'local' }, hiddenPresetIds: [] })); resetDesktopAiConfigStoreForTests();
    if (change === 'same-account-credential') mocks.account.userId = 7;
    await mount(); await upload(); await chooseAi();
    const store = getDesktopAiConfigStore();
    const entry = listDesktopPresetEntries(new Set()).find(item => item.preset.id === 'deepseek')!;
    await act(async () => { store.selectProviderTarget({ kind: 'preset', providerId: entry.preset.id }); store.selectPresetModel(entry.preset.id, 'deepseek-chat'); }); await settle();
    let finish!: (value: boolean) => void;
    mocks.invoke.mockImplementation(async (command: string) => command === 'has_provider_secret' ? new Promise<boolean>(resolve => { finish = resolve; }) : true);
    await click('开始转换'); expect(store.isPreparingGeneration()).toBe(true);
    mocks.account = { userId: 7, epoch: 1 };
    await act(async () => finish(true)); await settle();
    expect(mocks.execute).not.toHaveBeenCalled(); expect(host.textContent).toContain('准备期间账号状态已变化');
    expect(JSON.parse(localStorage.getItem(TAVERN_AI_DRAFT_KEY)!).input.raw).toEqual(raw);
  });
  it('does not dispatch after preset Key preparation fails or a cancelled preparation returns late', async () => {
    await mount(); await upload(); await chooseAi(); const store = getDesktopAiConfigStore();
    const entry = listDesktopPresetEntries(new Set()).find(item => item.directCapableModels.length)!;
    await act(async () => { store.selectProviderTarget({ kind: 'preset', providerId: entry.preset.id }); store.selectPresetModel(entry.preset.id, entry.directCapableModels[0]!.value); }); await settle();
    await act(async () => store.setPresetKeyDraft(entry.preset.id, 'synthetic-key'));
    mocks.invoke.mockRejectedValue(new Error('secure storage unavailable')); await click('开始转换');
    expect(mocks.execute).not.toHaveBeenCalled(); expect(JSON.stringify(localStorage)).not.toContain('synthetic-key');
    let finish!: (value: boolean) => void;
    mocks.invoke.mockImplementation(async (command: string) => command === 'has_provider_secret' ? new Promise<boolean>(resolve => { finish = resolve; }) : true);
    await click('开始转换'); expect(store.isPreparingGeneration()).toBe(true); await click('取消转换');
    await act(async () => finish(true)); await settle(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it.each(['rules', 'canshou'])('protects unsaved connection edits when switching to %s', async destination => {
    await mount(); await upload(); await chooseAi(); await click('更新凭据');
    const name = [...host.querySelectorAll('label')].find(label => label.textContent?.includes('显示名'))!.querySelector('input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '未保存连接'); name.dispatchEvent(new Event('input', { bubbles: true })); });
    const change = async () => destination === 'canshou' ? template('canshou') : act(async () => host.querySelector<HTMLInputElement>('input[name="tavern-convert-mode"]')!.click());
    await change(); expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('尚未保存'));
    expect(name.isConnected).toBe(true); expect(name.value).toBe('未保存连接');
    expect(host.querySelector<HTMLInputElement>('input[name="tavern-convert-mode"]:checked')?.parentElement?.textContent).toContain('AI 深度转换');
    vi.mocked(window.confirm).mockReturnValue(true); await change();
    expect(name.isConnected).toBe(false); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('retains the completed result and original if a replacement file cannot be parsed', async () => {
    await mount(); await upload(); await chooseAi(); await click('开始转换'); vi.mocked(window.confirm).mockReturnValue(true);
    const before = localStorage.getItem(TAVERN_AI_DRAFT_KEY);
    await upload({ invalid: true } as unknown as typeof raw);
    expect(host.querySelector('[data-result]')?.textContent).toBe('AI 整理正文');
    expect(localStorage.getItem(TAVERN_AI_DRAFT_KEY)).toBe(before);
    await click('导出原件 JSON'); expect(JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[0]![0].bytes))).toEqual(raw);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

});
