// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tavernModelResult } from './tavern-character-fixtures';
import { DesktopTavern } from '../src/app/tavern-page';
import { getDesktopAiConfigStore, resetDesktopAiConfigStoreForTests } from '../src/features/ai-config/use-desktop-ai-config';
import { DESKTOP_AI_CONFIG_STORAGE_KEY } from '../src/features/ai-config/desktop-ai-config-store';
import { listDesktopPresetEntries } from '../src/features/ai-config/desktop-ai-config';
import { TAVERN_AI_DRAFT_KEY } from '../src/features/tavern/session';
import type { AiExecutionRequest } from '@mahoshojo/contracts/ai-execution';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import * as safety from '@mahoshojo/domain/sensitive-word-filter';
import type { TavernGenerationInput } from '../src/features/tavern/generation';
import { convertTavernToMagicalGirlCard, readTavernLocalDocument } from '@mahoshojo/domain/tavern-card';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), execute: vi.fn(), export: vi.fn(), save: vi.fn(), put: vi.fn(), guard: vi.fn(), account: { userId: null as number | null, epoch: 0 } }));
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
vi.mock('../src/platform/local-card-bridge', () => ({ IpcLocalCardRepository: class { putIfAbsent = mocks.put; } }));
vi.mock('../src/features/tavern/host', () => ({ saveDesktopTavernCard: mocks.save, exportTavernFile: mocks.export, getDesktopTavernBase: vi.fn() }));
vi.mock('@mahoshojo/ui-web/shell', () => ({ ProductFooter: () => null }));
vi.mock('@mahoshojo/ui-web/character-card', () => ({ resolveMagicalGirlGradient: () => 'pink', MagicalGirlCard: ({ magicalGirl }: { magicalGirl: { appearance: { overallLook: string } } }) => <pre data-result="magical-girl">{magicalGirl.appearance.overallLook}</pre>, CanshouCard: ({ canshou }: { canshou: { appearance: string } }) => <pre data-result="canshou">{canshou.appearance}</pre>, GeneralCharacterCard: ({ general }: { general: { content: string } }) => <pre data-result="character">{general.content}</pre> }));
vi.mock('@mahoshojo/ui-web/scenario', () => ({ GeneralScenarioCard: ({ scenario }: { scenario: { content: string } }) => <pre data-result="scenario">{scenario.content}</pre> }));
let root: Root; let host: HTMLDivElement;
const raw = { name: 'Alice', description: '{{user}} 对 {{char}} 说话', unknown: { keep: true } };
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.includes(text))!;
const modeButton = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent === text)!;
const selectGenerationMode = async (text: string) => { await act(async () => modeButton(text).click()); await settle(); };
const click = async (text: string) => { await act(async () => button(text).click()); await settle(); };
async function upload(value = raw) {
  const bytes = new TextEncoder().encode(JSON.stringify(value)); const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'card.json', size: bytes.length, arrayBuffer: async () => bytes.buffer }] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}
async function chooseAi() { const input = host.querySelector<HTMLInputElement>('input[name="tavern-convert-mode"]:not(:checked)')!; await act(async () => input.click()); await settle(); }
async function template(value: string) { const select = host.querySelector<HTMLSelectElement>('select')!; await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }); }
const scenario = { title: '整理情景', scenario_type: '互动', description: '简介', elements: { scene: { place: '庭院' }, events: 'AI 整理正文', atmosphere: '轻松', development: ['探访'] } };
const complete = (input: TavernGenerationInput) => ({ status: 'completed', mode: 'direct-local', cardKind: input.template, rawText: '模型输出', card: input.template === 'magical-girl' || input.template === 'canshou' ? { ...tavernModelResult(input.template), _tavern: { raw: input.raw } } : input.template === 'scenario' ? { ...scenario, _tavern: { raw: input.raw } } : { templateId: input.template === 'general' ? '通用角色' : '通用情景', ...(input.template === 'general' ? { name: '整理角色' } : { title: '整理情景' }), content: 'AI 整理正文', _tavern: { raw: input.raw } } });
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.account = { userId: null, epoch: 0 };
  vi.clearAllMocks(); mocks.put.mockReset(); mocks.invoke.mockReset(); mocks.invoke.mockResolvedValue(true); mocks.execute.mockReset(); mocks.execute.mockImplementation(async (_options, input) => complete(input));
  localStorage.clear(); localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 2, selection: { executionPreference: 'client', clientConnectionId: 'local' }, hiddenPresetIds: [] })); resetDesktopAiConfigStoreForTests();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [{ code: 'zh-CN', name: '简体中文' }] })));
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const mount = async () => { await act(async () => root.render(<StrictMode><DesktopTavern /></StrictMode>)); await settle(); };

describe('Desktop Tavern actual Direct journey', () => {
  it.each(['general', 'general-scenario', 'scenario', 'magical-girl', 'canshou'])('generates %s with frozen source and restores without replay', async kind => {
    await mount(); await upload(); await template(kind); if (kind !== 'scenario' && kind !== 'magical-girl') await chooseAi(); await click('开始转换');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute.mock.calls[0]!.slice(0, 3)).toEqual([
      expect.objectContaining({ profileId: 'local', providerTarget: { kind: 'custom', profileId: 'local' } }),
      expect.objectContaining({ raw, template: kind, language: 'zh-CN' }),
      expect.objectContaining({ mode: 'direct-local', generationMode: 'non-stream', modelId: 'model' }),
    ]);
    expect(host.querySelector('[data-result]')?.textContent).toContain('AI 整理正文');
    await click(kind === 'scenario' ? '下载情景卡 JSON' : kind === 'magical-girl' ? '下载魔法少女卡 JSON' : kind === 'canshou' ? '下载残兽卡 JSON' : '下载通用卡 JSON'); const exported = JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[0]![0].bytes));
    expect(exported).toMatchObject({ ...(kind === 'scenario' ? scenario : kind === 'magical-girl' ? { codename: '星花' } : kind === 'canshou' ? { name: '雾兽' } : { content: 'AI 整理正文' }), _tavern: { raw } });
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
    await mount(); await upload(); const before = localStorage.getItem(DESKTOP_AI_CONFIG_STORAGE_KEY); await template(kind); if (kind !== 'scenario' && kind !== 'magical-girl') await chooseAi();
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
  it.each(['general', 'magical-girl'])('protects unsaved connection edits when switching %s to rules', async kind => {
    await mount(); await upload(); await template(kind); if (kind !== 'magical-girl') await chooseAi(); await click('更新凭据');
    const name = [...host.querySelectorAll('label')].find(label => label.textContent?.includes('显示名'))!.querySelector('input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '未保存连接'); name.dispatchEvent(new Event('input', { bubbles: true })); });
    const change = async () => act(async () => host.querySelector<HTMLInputElement>('input[name="tavern-convert-mode"]')!.click());
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


describe('Desktop Tavern character mode selection', () => {
  it('exports and saves the shared magical-girl rules locally without AI, then restores the untouched original', async () => {
    const preference = { enabled: true, userReplacement: '访客', charReplacementMode: 'custom' as const, customCharReplacement: '{{user}}' };
    localStorage.setItem('mahoshojo.tavern.import.placeholder.v1', JSON.stringify(preference));
    const original = { ...raw, name: '{{char}} 星花', personality: '性格', scenario: '场景', first_mes: '{{user}} 开场', mes_example: '样例', tags: ['不映射标签'], signature: '不信任签名' };
    await mount(); await upload(original); await template('magical-girl');
    const rules = host.querySelector<HTMLInputElement>('input[name="tavern-convert-mode"]')!;
    expect(rules.disabled).toBe(false); expect(rules.checked).toBe(false);
    await act(async () => rules.click());
    expect(host.querySelector('[data-result="magical-girl"]')?.textContent).toBe('访客 对 {{user}} 说话');
    expect(host.textContent).toContain('魔法少女（保守规则映射）');
    expect(host.textContent).toContain('标签不进入魔法少女正文');
    expect(host.textContent).not.toContain('正文仅映射描述、性格、场景、开场白、对话样例与标签');
    await click('下载魔法少女卡 JSON');
    const exported = JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[0]![0].bytes));
    const candidate = readTavernLocalDocument(new TextEncoder().encode(JSON.stringify(original)), 'json').candidates[0];
    expect(exported).toEqual(convertTavernToMagicalGirlCard(candidate, preference));
    expect(exported.analysis.predictionBasis).toContain('【开场白】\n访客 开场');
    expect(exported).not.toHaveProperty('signature');
    mocks.save.mockResolvedValue('saved'); await click('保存魔法少女卡到本地库');
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(expect.anything(), exported);
    expect(host.textContent).toContain('已保存到本地卡库（未签名导入）');
    await upload(exported); await click('导出原件 JSON');
    expect(JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[1]![0].bytes))).toEqual(original);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.every(([url]) => url === '/languages.json')).toBe(true);
  });
  it('requires confirmation before replacing an unsaved magical-girl AI result with rules', async () => {
    await mount(); await upload(); await template('magical-girl'); await click('开始转换');
    const rules = host.querySelector<HTMLInputElement>('input[name="tavern-convert-mode"]')!;
    await act(async () => rules.click());
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('清除当前 AI 结果'));
    expect(rules.checked).toBe(false);
    expect(host.querySelector('[data-result="magical-girl"]')?.textContent).toBe('AI 整理正文');
    vi.mocked(window.confirm).mockReturnValue(true); await act(async () => rules.click());
    expect(rules.checked).toBe(true);
    expect(host.querySelector('[data-result="magical-girl"]')?.textContent).not.toContain('AI 整理正文');
    expect(JSON.parse(localStorage.getItem(TAVERN_AI_DRAFT_KEY)!).output.card).toBeNull();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it('keeps character rules available while magical-girl selection still defaults to AI', async () => {
    await mount(); await upload(); await template('canshou');
    expect(host.querySelector<HTMLInputElement>('input[name="tavern-convert-mode"]')?.disabled).toBe(false);
    expect(host.querySelector('[data-result="canshou"]')).not.toBeNull();
    await chooseAi(); expect(button('开始转换').disabled).toBe(false);
    await template('magical-girl');
    expect(host.querySelector<HTMLInputElement>('input[name="tavern-convert-mode"]')?.disabled).toBe(false);
    expect(host.querySelector<HTMLInputElement>('input[name="tavern-convert-mode"]:checked')?.parentElement?.textContent).toContain('AI 深度转换');
    expect(host.querySelector('[data-result]')).toBeNull();
    expect(mocks.execute).not.toHaveBeenCalled();
    await template('canshou');
    expect(host.querySelector<HTMLInputElement>('input[name="tavern-convert-mode"]:checked')?.parentElement?.textContent).toContain('AI 深度转换');
    await act(async () => host.querySelector<HTMLInputElement>('input[name="tavern-convert-mode"]')!.click());
    expect(host.querySelector('[data-result="canshou"]')).not.toBeNull();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});


describe('Desktop Tavern Direct streaming journey', () => {
  async function nativeStream() {
    const actual = await vi.importActual<typeof import('../src/features/tavern/generation')>('../src/features/tavern/generation');
    mocks.execute.mockImplementation((options, input, intent, signal, onPartialText) => actual.executeTavernGeneration({ ...options, createChannel: () => ({}) }, input, intent, signal, onPartialText));
    let request!: AiExecutionRequest;
    let channel!: { onmessage(event: AiStreamEvent): void };
    let finish!: () => void;
    let sequence = 0;
    const text = '# 星光\n名字：星光\n\n已收到的正文';
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== 'stream_target_ai') return true;
      request = args!.request as AiExecutionRequest;
      channel = args!.onEvent as typeof channel;
      const identity = { requestId: request.requestId, contractVersion: 1 as const, mode: request.mode };
      channel.onmessage({ ...identity, type: 'started', sequence: sequence++ });
      channel.onmessage({ ...identity, type: 'reasoning-delta', sequence: sequence++, delta: '独立思考内容' });
      channel.onmessage({ ...identity, type: 'text-delta', sequence: sequence++, delta: text });
      await new Promise<void>(resolve => { finish = resolve; });
    });
    return {
      text, request: () => request,
      finish: async (terminal: 'stop' | 'length' | 'eof') => act(async () => {
        if (terminal !== 'eof') {
          const identity = { requestId: request.requestId, contractVersion: 1 as const, mode: request.mode };
          channel.onmessage({ ...identity, type: 'result', sequence: sequence++, result: { ...identity, status: 'completed', finishReason: terminal, output: { text, reasoning: '独立思考内容' } } });
        }
        finish();
      }),
    };
  }

  it.each(['general', 'general-scenario', 'scenario', 'magical-girl', 'canshou'] as const)('streams %s through the real executor, then restores its actual general kind without dispatch', async kind => {
    const native = await nativeStream();
    await mount(); await upload(); await template(kind); if (kind !== 'scenario' && kind !== 'magical-girl') await chooseAi();
    await selectGenerationMode('流式');
    const expectedKind = kind === 'scenario' || kind === 'general-scenario' ? 'general-scenario' : 'general';
    expect(host.textContent).toContain(expectedKind === 'general' ? '生成【通用角色卡】' : '生成【通用情景卡】');
    await act(async () => { button('开始转换').click(); button('开始转换').click(); }); await settle();
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.execute.mock.calls[0]![2]).toMatchObject({ generationMode: 'stream', mode: 'direct-local', modelId: 'model' });
    expect(host.querySelector('[aria-label="流式正文预览"]')?.textContent).toContain('已收到的正文');
    expect(host.querySelector('[aria-label="流式正文预览"]')?.textContent).not.toContain('独立思考内容');
    expect(host.querySelector('[data-result]')).toBeNull();
    expect(modeButton('非流式').disabled).toBe(true);
    expect(modeButton('客户端').disabled).toBe(true); expect(modeButton('服务器').disabled).toBe(true);
    expect(native.request().messages).toHaveLength(1);
    await native.finish('stop'); await settle();
    expect(host.querySelector('[aria-label="流式正文预览"]')).toBeNull();
    expect(host.querySelector('[data-result]')?.textContent).toBe(native.text);
    await click('下载通用卡 JSON');
    const exported = JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[0]![0].bytes));
    expect(exported).toMatchObject({ templateId: expectedKind === 'general' ? '通用角色' : '通用情景', content: native.text, _tavern: { raw } });
    expect(exported).not.toHaveProperty('userAnswers'); expect(exported).not.toHaveProperty('elements'); expect(exported).not.toHaveProperty('signature');
    const stored = JSON.parse(localStorage.getItem(TAVERN_AI_DRAFT_KEY)!);
    expect(stored).toMatchObject({ generationMode: 'stream', input: { template: kind }, output: { cardKind: expectedKind, phase: 'completed' } });
    await act(async () => root.unmount()); root = createRoot(host); await mount();
    expect(modeButton('流式').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-result]')?.textContent).toBe(native.text); expect(mocks.execute).toHaveBeenCalledOnce();
    await click('导出原件 JSON'); expect(JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[1]![0].bytes))).toEqual(raw);
  });

  it.each(['length', 'eof', 'cancel'] as const)('exports %s accepted text and the original separately without offering a result card', async failure => {
    const native = await nativeStream(); await mount(); await upload(); await chooseAi(); await selectGenerationMode('流式'); await click('开始转换');
    if (failure === 'cancel') await click('取消转换');
    await native.finish(failure === 'cancel' ? 'stop' : failure); await settle();
    expect(host.querySelector('[data-result]')).toBeNull(); expect(host.textContent).not.toContain('生成完成');
    expect(host.textContent).toContain('不是完成卡');
    expect([...host.querySelectorAll('button')].some(item => item.textContent?.includes('保存通用卡'))).toBe(false);
    await click('导出未完成正文（文本）');
    expect(mocks.export.mock.calls[0]![0]).toMatchObject({ name: 'tavern-unfinished.txt', mimeType: 'text/plain;charset=utf-8' });
    expect(new TextDecoder().decode(mocks.export.mock.calls[0]![0].bytes)).toBe(native.text);
    await click('导出原件 JSON'); expect(JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[1]![0].bytes))).toEqual(raw);
    await selectGenerationMode('非流式');
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('原始输出'));
    expect(modeButton('流式').getAttribute('aria-pressed')).toBe('true');
    await act(async () => root.unmount()); root = createRoot(host); await mount();
    expect(host.textContent).toContain('不是完成卡'); expect(mocks.execute).toHaveBeenCalledOnce();
    await click('导出未完成正文（文本）'); expect(new TextDecoder().decode(mocks.export.mock.calls[2]![0].bytes)).toBe(native.text);
    vi.mocked(window.confirm).mockReturnValue(true); await selectGenerationMode('非流式');
    expect(host.textContent).not.toContain('AI 原始输出'); expect(modeButton('非流式').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the selected stream mode when switching to Hosted, and chooses JSON only explicitly', async () => {
    await mount(); await upload(); await chooseAi(); await selectGenerationMode('流式');
    expect(modeButton('服务器').disabled).toBe(false);
    await click('服务器');
    expect(modeButton('流式').getAttribute('aria-pressed')).toBe('true'); expect(modeButton('流式').disabled).toBe(false);
    expect(button('开始转换').disabled).toBe(false); await click('开始转换');
    expect(mocks.execute.mock.calls[0]![2]).toMatchObject({ mode: 'hosted-stream', generationMode: 'stream' });
    vi.mocked(window.confirm).mockReturnValue(true); await selectGenerationMode('非流式'); await click('开始转换');
    expect(mocks.execute.mock.calls[1]![2]).toMatchObject({ mode: 'hosted-json', generationMode: 'non-stream' });
  });

  it('cancels stream credential preparation before dispatch and keeps frozen draft input/mode', async () => {
    await mount(); await upload(); await chooseAi(); await selectGenerationMode('流式');
    const store = getDesktopAiConfigStore(); const entry = listDesktopPresetEntries(new Set()).find(item => item.directCapableModels.length)!;
    await act(async () => { store.selectProviderTarget({ kind: 'preset', providerId: entry.preset.id }); store.selectPresetModel(entry.preset.id, entry.directCapableModels[0]!.value); }); await settle();
    let finish!: (value: boolean) => void;
    mocks.invoke.mockImplementation(async (command: string) => command === 'has_provider_secret' ? new Promise<boolean>(resolve => { finish = resolve; }) : true);
    await click('开始转换'); expect(store.isPreparingGeneration()).toBe(true);
    expect(modeButton('非流式').disabled).toBe(true); expect(host.querySelector<HTMLSelectElement>('select')?.disabled).toBe(true);
    await click('取消转换'); await act(async () => finish(true)); await settle();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(TAVERN_AI_DRAFT_KEY)!)).toMatchObject({ generationMode: 'stream', input: { raw, template: 'general', language: 'zh-CN' } });
  });

  it('retries saving a completed general scenario without replaying generation or losing its original', async () => {
    const { webcrypto } = await import('node:crypto'); vi.stubGlobal('crypto', webcrypto);
    const native = await nativeStream(); await mount(); await upload(); await template('scenario'); await selectGenerationMode('流式');
    await click('开始转换'); await native.finish('stop'); await settle();
    mocks.put.mockRejectedValueOnce(new Error('disk full')).mockResolvedValue({ written: true });
    await click('保存通用卡到本地库');
    expect(host.textContent).toContain('保存到本地卡库失败'); expect(host.querySelector('[data-result]')?.textContent).toBe(native.text);
    await click('导出原件 JSON'); expect(JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[0]![0].bytes))).toEqual(raw);
    await click('保存通用卡到本地库');
    expect(host.textContent).toContain('已保存到本地卡库（未签名 AI 转换）');
    expect(mocks.put).toHaveBeenCalledTimes(2); expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.put.mock.calls[1]![0]).toMatchObject({ cardType: 'scenario', data: { templateId: '通用情景', content: native.text, _tavern: { raw } }, provenance: { kind: 'unsigned', execution: 'direct-local' } });
  });

  it('keeps unfinished text exportable after draft writes fail', async () => {
    const native = await nativeStream(); await mount(); await upload(); await chooseAi(); await selectGenerationMode('流式');
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) { if (key === TAVERN_AI_DRAFT_KEY) throw new Error('full'); setItem.call(this, key, value); });
    await click('开始转换'); await native.finish('eof'); await settle();
    expect(host.textContent).toContain('当前内容仅保留在此页面');
    await click('导出未完成正文（文本）'); expect(new TextDecoder().decode(mocks.export.mock.calls[0]![0].bytes)).toBe(native.text);
    await click('导出原件 JSON'); expect(JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[1]![0].bytes))).toEqual(raw);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });
});

describe('Desktop Tavern Hosted streaming page', () => {
  async function hostedStream() {
    const actual = await vi.importActual<typeof import('../src/features/tavern/generation')>('../src/features/tavern/generation');
    mocks.execute.mockImplementation((options, input, intent, signal, onPartialText) => actual.executeTavernGeneration({ ...options, createChannel: () => ({}) }, input, intent, signal, onPartialText));
    let channel!: { onmessage(event: unknown): void }; let finish!: () => void;
    const markdown = '# 星光\n完整正文';
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== 'stream_hosted_ai') return true;
      channel = args!.onEvent as typeof channel;
      channel.onmessage({ event: 'markdown', data: { chunk: markdown } });
      await new Promise<void>(resolve => { finish = resolve; });
    });
    return { markdown, emit: (event: unknown) => channel.onmessage(event), finish: async (reason?: string) => {
      await act(async () => { if (reason) channel.onmessage({ event: 'done', data: { ok: true, tavernCompletion: { version: 1, finishReason: reason } } }); finish(); }); await settle();
    } };
  }
  async function setup(preset = false) {
    localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 2, selection: { executionPreference: 'server', clientConnectionId: 'local' }, hiddenPresetIds: [] })); resetDesktopAiConfigStoreForTests();
    await mount(); await upload(); await chooseAi(); await selectGenerationMode('流式');
    if (preset) {
      const store = getDesktopAiConfigStore();
      await act(async () => { store.selectProviderTarget({ kind: 'preset', providerId: 'deepseek' }); store.selectPresetModel('deepseek', 'deepseek-chat'); }); await settle();
    }
  }
  it.each(['system', 'preset'] as const)('dispatches frozen %s stream, single-flights and applies its cooldown only', async provider => {
    const native = await hostedStream(); await setup(provider === 'preset');
    await act(async () => { button('开始转换').click(); button('开始转换').click(); }); await settle();
    expect(mocks.execute).toHaveBeenCalledOnce(); expect(mocks.execute.mock.calls[0]![2]).toMatchObject({ mode: 'hosted-stream', generationMode: 'stream' });
    expect(host.querySelector('input[type="file"]')?.hasAttribute('disabled')).toBe(true);
    expect(modeButton('非流式').disabled).toBe(true); expect(host.querySelector('[data-result]')).toBeNull();
    await native.finish('stop'); expect(host.querySelector('[data-result]')?.textContent).toBe(native.markdown);
    expect(localStorage.getItem(`tavernConvertCooldown:${provider === 'system' ? 'system' : 'custom'}`)).not.toBeNull();
    expect(localStorage.getItem(`tavernConvertCooldown:${provider === 'system' ? 'custom' : 'system'}`)).toBeNull();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'stream_hosted_ai')).toHaveLength(1);
  });
  it('keeps cancelled body export-only, waits for invoke, and confirms uncertain regeneration', async () => {
    const native = await hostedStream(); await setup(); await click('开始转换'); await click('取消转换');
    expect(button('转换中…').disabled).toBe(true); expect(host.querySelector('[data-result]')).toBeNull();
    await native.finish('stop');
    expect(host.textContent).toContain('无法确认'); expect(host.querySelector('[data-result]')).toBeNull();
    await click('导出未完成正文'); expect(new TextDecoder().decode(mocks.export.mock.calls[0]![0].bytes)).toBe(native.markdown);
    expect(mocks.put).not.toHaveBeenCalled();
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 121_000);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1050)); });
    vi.mocked(window.confirm).mockReturnValueOnce(true).mockReturnValueOnce(false);
    await click('开始转换'); expect(mocks.execute).toHaveBeenCalledOnce();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('上次转换是否已在服务器执行仍无法确认'));
  });
  it.each(['identity', 'credential'] as const)('rechecks %s after async readiness and never calls underlying stream invoke or cooldown', async change => {
    await hostedStream(); await setup();
    const actualCheck = safety.strictCheck; let ready!: (value: Awaited<ReturnType<typeof safety.strictCheck>>) => void;
    vi.spyOn(safety, 'strictCheck').mockImplementationOnce(() => new Promise(resolve => { ready = resolve; }));
    await click('开始转换');
    expect(mocks.execute).toHaveBeenCalledOnce(); expect(mocks.invoke.mock.calls.filter(([command]) => command === 'stream_hosted_ai')).toHaveLength(0);
    if (change === 'identity') mocks.account.userId = 7; else mocks.account.epoch++;
    await act(async () => ready(await actualCheck(''))); await settle();
    expect(host.textContent).toContain('准备期间账号状态已变化');
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'stream_hosted_ai')).toHaveLength(0);
    expect(localStorage.getItem('tavernConvertCooldown:system')).toBeNull();
    expect(JSON.parse(localStorage.getItem(TAVERN_AI_DRAFT_KEY)!)).toMatchObject({ input: { raw }, generationMode: 'stream', output: { phase: 'failed', card: null } });
  });
  it('reports 429 retry seconds, keeps body exportable and never offers a completed-card save', async () => {
    const native = await hostedStream(); await setup(); await click('开始转换');
    const start = Date.now();
    await act(async () => native.emit({ event: 'error', data: { ok: false, error: '请稍后再试', code: 'rate-limited', retryAfterSeconds: 9 } })); await native.finish();
    expect(host.textContent).toContain('请稍后再试'); expect(host.querySelector('[data-result]')).toBeNull();
    expect(Number(localStorage.getItem('tavernConvertCooldown:system'))).toBeGreaterThanOrEqual(start + 9000);
    await click('导出未完成正文'); expect(mocks.export).toHaveBeenCalledOnce(); expect(mocks.put).not.toHaveBeenCalled();
  });
});
