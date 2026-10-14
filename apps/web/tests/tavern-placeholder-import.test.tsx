// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { convertTavernToCanshouCard, convertTavernToGeneralScenarioCard, readTavernLocalDocument } from '@mahoshojo/domain/tavern-card';
import { TavernImportPanel } from '@/components/tavern/TavernImportPanel';

const mocks = vi.hoisted(() => ({ download: vi.fn<(blob: Blob, name: string) => void>(), save: vi.fn(async () => 'saved'), projection: null as Record<string, unknown> | null }));
vi.mock('@/components/AiProviderSelector', () => ({ default: () => null }));
vi.mock('@/components/TachieGenerator', () => ({ default: () => null }));
vi.mock('@/components/SaveToCloudButton', () => ({ default: () => null }));
vi.mock('@/components/GeneralCharacterCard', () => ({ default: ({ general }: { general: Record<string, unknown> }) => { mocks.projection = general; return <pre data-projection>{String(general.content)}</pre>; } }));
vi.mock('@/components/GeneralScenarioCard', () => ({ default: ({ scenario }: { scenario: Record<string, unknown> }) => { mocks.projection = scenario; return <pre data-projection>{String(scenario.content)}</pre>; } }));
vi.mock('@/components/MagicalGirlCard', () => ({ default: () => null }));
vi.mock('@/components/CanshouCard', () => ({ default: ({ canshou }: { canshou: Record<string, unknown> }) => { mocks.projection = canshou; return <pre data-projection>{String(canshou.appearance)}</pre>; } }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/lib/cooldown', () => ({ useCooldown: () => ({ isCooldown: false, remainingTime: 0, startCooldown: vi.fn() }) }));
vi.mock('@/lib/app-router-adapter', () => ({ useAppRouterAdapter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: mocks.download, revokeBlobUrl: vi.fn() }));
vi.mock('@/lib/local-library/card-repository', () => ({ getLocalCardRepository: () => ({}) }));
vi.mock('@mahoshojo/local-library/imported-unsigned-card', () => ({ saveImportedUnsignedCard: mocks.save }));

let root: Root; let container: HTMLDivElement;
const key = 'mahoshojo.tavern.import.placeholder.v1';
const field = (name: string) => container.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!;
const button = (text: string) => [...container.querySelectorAll('button')].find((element) => element.textContent === text)!;
const checkbox = (text: string) => [...container.querySelectorAll('label')].find((element) => element.textContent?.includes(text))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
async function click(text: string) { await act(async () => button(text).click()); }
async function edit(name: string, value: string) { await act(async () => { const input = field(name); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function upload(raw: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'test.json', size: bytes.length, arrayBuffer: async () => bytes.buffer }] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); mocks.projection = null; vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => [] }))); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('Web Tavern real shared placeholder import', () => {
  it('retains Web AI, streaming and language controls through the shared conversion UI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => [{ code: 'zh-CN', name: '中文' }, { code: 'en', name: 'English' }] })));
    await act(async () => root.render(<TavernImportPanel />));
    await upload({ name: 'Alice', description: '原文' }); await click('生成角色卡');
    expect(container.querySelector('[data-projection]')).not.toBeNull();
    const modes = container.querySelectorAll<HTMLInputElement>('input[name="tavern-convert-mode"]');
    expect(modes).toHaveLength(2);
    await act(async () => modes[1].click());
    expect(modes[1].checked).toBe(true);
    expect(container.querySelector('[data-projection]')).toBeNull();
    expect(button('流式').disabled).toBe(false); expect(button('非流式').disabled).toBe(false);
    expect(container.textContent).toContain('使用官方 Key 冷却为');
    await click('流式'); expect(button('流式').getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('流式生成会实时输出 Markdown');
    const languageToggle = [...container.querySelectorAll('button')].find((element) => element.textContent?.startsWith('生成语言'))!;
    if (languageToggle.getAttribute('aria-expanded') !== 'true') await act(async () => languageToggle.click());
    const language = container.querySelector<HTMLSelectElement>('select[aria-label="生成语言"]')!;
    await act(async () => { language.value = 'en'; language.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(language.value).toBe('en');
    await act(async () => languageToggle.click()); expect(container.textContent).toContain('当前：en');
    await act(async () => modes[0].click());
    expect(button('流式')).toBeUndefined(); expect(button('生成角色卡').disabled).toBe(false);
    await click('生成角色卡'); expect(mocks.projection?.content).toContain('原文');
  });
  it('uses shared preferences and rules while retaining original meta/raw and invalidating stale output', async () => {
    localStorage.setItem(key, JSON.stringify({ enabled: true, userReplacement: '$&', charReplacementMode: 'auto', customCharReplacement: '' }));
    await act(async () => root.render(<TavernImportPanel />));
    const raw = { name: 'Alice', description: '{{user}} {{char}}' };
    await upload(raw); await act(async () => checkbox('同时保存').click()); await click('生成角色卡');
    expect(mocks.projection?.content).toContain('$& Alice');
    expect(mocks.projection?._tavern).toMatchObject({ raw, meta: { name: 'Alice', description: '{{user}} {{char}}' } });
    await edit('用户占位符替换文本', '{{char}}'); expect(container.querySelector('[data-projection]')).toBeNull();
    await click('生成角色卡'); expect(mocks.projection?.content).toContain('Alice Alice');
    await act(async () => field('替换占位符').click()); await click('生成角色卡'); expect(mocks.projection?.content).toContain('{{user}} {{char}}');
    await upload({ bad: true }); expect(container.querySelector('[data-projection]')?.textContent).toContain('{{user}} {{char}}'); expect(field('替换占位符')).not.toBeNull();
  });
  it('shares the Desktop conservative Canshou mapping with optional raw and character local save', async () => {
    await act(async () => root.render(<TavernImportPanel />));
    const raw = { name: '残兽', description: '外观', personality: '情感', scenario: '场景', mes_example: '样例', first_mes: '不映射开场', tags: ['不映射标签'], extensions: { script: 'inert' } };
    await upload(raw);
    const selector = [...container.querySelectorAll('select')].find((select) => [...select.options].some((option) => option.value === 'canshou'))!;
    await act(async () => { selector.value = 'canshou'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    await click('生成角色卡'); await click('下载数据卡 JSON');
    const withoutRaw = JSON.parse(await mocks.download.mock.calls[0][0].text());
    const desktop = convertTavernToCanshouCard(readTavernLocalDocument(new TextEncoder().encode(JSON.stringify(raw)), 'json').candidates[0]);
    const { _tavern, ...body } = desktop;
    expect(withoutRaw).toMatchObject(body); expect(withoutRaw._tavern).not.toHaveProperty('raw');
    expect(container.textContent).toContain('开场白与标签不进入残兽正文'); expect(container.textContent).toContain('未保留完整原件');
    await click('保存残兽卡到本地库'); expect(mocks.save).toHaveBeenNthCalledWith(1, expect.anything(), withoutRaw, '残兽', 'character');
    await act(async () => checkbox('同时保存').click()); await click('生成角色卡'); await click('下载数据卡 JSON');
    const withRaw = JSON.parse(await mocks.download.mock.calls[1][0].text());
    expect(withRaw).toMatchObject(desktop); expect(_tavern.raw).toEqual(raw);
    expect(readTavernLocalDocument(new TextEncoder().encode(JSON.stringify(withRaw)), 'json').candidates[0].parsed).toEqual(raw);
    await click('保存残兽卡到本地库'); expect(mocks.save).toHaveBeenNthCalledWith(2, expect.anything(), withRaw, '残兽', 'character');
  });
  it('keeps all five templates and shares the Desktop scenario mapping without changing keepRaw', async () => {
    await act(async () => root.render(<TavernImportPanel />));
    const raw = { name: '庭院', description: '背景', scenario: '场景', personality: '安静', first_mes: '开场' };
    await upload(raw);
    const selector = [...container.querySelectorAll('select')].find((select) => [...select.options].some((option) => option.value === 'general-scenario'))!;
    expect([...selector.options].map((option) => option.value)).toEqual(['general', 'general-scenario', 'magical-girl', 'canshou', 'scenario']);
    await act(async () => { selector.value = 'general-scenario'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    await click('生成情景卡');
    const desktop = convertTavernToGeneralScenarioCard(readTavernLocalDocument(new TextEncoder().encode(JSON.stringify(raw)), 'json').candidates[0]);
    expect(mocks.projection).toEqual({ title: desktop.title, content: desktop.content });
    await click('下载数据卡 JSON');
    const withoutRaw = JSON.parse(await mocks.download.mock.calls[0][0].text());
    expect(withoutRaw).toMatchObject({ templateId: desktop.templateId, title: desktop.title, content: desktop.content });
    expect(withoutRaw._tavern).not.toHaveProperty('raw');
    await click('保存通用卡到本地库');
    expect(mocks.save).toHaveBeenNthCalledWith(1, expect.anything(), withoutRaw, '庭院', 'scenario');
    await act(async () => checkbox('同时保存').click()); await click('生成情景卡');
    await click('下载数据卡 JSON');
    const withRaw = JSON.parse(await mocks.download.mock.calls[1][0].text());
    expect(withRaw).toMatchObject(desktop);
    expect(withRaw._tavern.raw).toEqual(raw);
    expect(mocks.projection).toEqual({ title: desktop.title, content: desktop.content });
    await click('保存通用卡到本地库');
    expect(mocks.save).toHaveBeenNthCalledWith(2, expect.anything(), withRaw, '庭院', 'scenario');
  });
  it('keeps the original export and settings after amplification rejection and recovers in place', async () => {
    await act(async () => root.render(<TavernImportPanel />));
    const raw = { name: 'Alice', description: '{{user}}'.repeat(9000) };
    await upload(raw); await edit('用户占位符替换文本', 'x'.repeat(4096));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('32 MiB'); expect(button('生成角色卡').disabled).toBe(true);
    expect(field('用户占位符替换文本').value).toHaveLength(4096);
    await click('导出原件 JSON'); expect(JSON.parse(await mocks.download.mock.calls[0][0].text())).toEqual(raw);
    await edit('用户占位符替换文本', '好'); expect(button('生成角色卡').disabled).toBe(false);
    await click('生成角色卡'); expect(mocks.projection?.content).toContain('好好'); expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it('keeps a new source read authoritative when an earlier clipboard action rejects late', async () => {
    let rejectCopy!: (error: Error) => void;
    const writeText = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectCopy = reject; }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await act(async () => root.render(<TavernImportPanel />));
    await upload({ name: 'Alice', description: '{{user}} A' }); await click('生成角色卡'); await click('复制 JSON'); await click('复制数据卡 JSON');
    expect(writeText).toHaveBeenCalledTimes(1);
    let finishRead!: (buffer: ArrayBuffer) => void;
    const bytes = new TextEncoder().encode(JSON.stringify({ name: 'Bob', description: '{{user}} B' }));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'B.json', size: bytes.length, arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; }) }] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(button('复制数据卡 JSON')).toBeUndefined(); expect(button('保存通用卡到本地库')).toBeUndefined(); expect(container.querySelector('[data-projection]')).toBeNull(); expect(field('替换占位符').disabled).toBe(true);
    await act(async () => rejectCopy(new Error('old clipboard rejection')));
    expect(button('生成角色卡').disabled).toBe(true); expect(container.textContent).toContain('解析中'); expect(container.textContent).not.toContain('old clipboard rejection');
    await act(async () => finishRead(bytes.buffer));
    expect(button('生成角色卡').disabled).toBe(false); await click('生成角色卡'); expect(mocks.projection?.name).toBe('Bob'); expect(mocks.projection?.content).toContain('【某人】 B');
  });
  it('does not revive a previous output through delimiter-bearing settings when the new replacement exceeds budget', async () => {
    const padding = 'x'.repeat(4096);
    localStorage.setItem(key, JSON.stringify({ enabled: true, userReplacement: `a|charMode=custom|char=${padding}`, charReplacementMode: 'custom', customCharReplacement: 'z' }));
    await act(async () => root.render(<TavernImportPanel />));
    await upload({ name: 'Alice', description: '{{char}}'.repeat(9000) }); await click('生成角色卡');
    expect(container.querySelector('[data-projection]')?.textContent).toContain('zzzz');
    await edit('用户占位符替换文本', 'a'); await edit('角色占位符替换文本', `${padding}|charMode=custom|char=z`);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('32 MiB');
    expect(container.querySelector('[data-projection]')).toBeNull(); expect(button('下载数据卡 JSON')).toBeUndefined(); expect(button('保存通用卡到本地库')).toBeUndefined();
    expect(field('角色占位符替换文本').value).toBe(`${padding}|charMode=custom|char=z`);
    await edit('角色占位符替换文本', 'safe'); await click('生成角色卡'); expect(mocks.projection?.content).toContain('safesafe');
  });
  it('also distinguishes delimiter-bearing settings when both replacements fit the budget', async () => {
    localStorage.setItem(key, JSON.stringify({ enabled: true, userReplacement: 'a|charMode=custom|char=x', charReplacementMode: 'custom', customCharReplacement: 'z' }));
    await act(async () => root.render(<TavernImportPanel />));
    await upload({ name: 'Alice', description: '{{char}}' }); await click('生成角色卡');
    await edit('用户占位符替换文本', 'a'); await edit('角色占位符替换文本', 'x|charMode=custom|char=z');
    expect(container.querySelector('[role="alert"]')).toBeNull(); expect(container.querySelector('[data-projection]')).toBeNull();
    await click('生成角色卡'); expect(mocks.projection?.content).toContain('x|charMode=custom|char=z');
  });
});
