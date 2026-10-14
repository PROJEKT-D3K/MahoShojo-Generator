// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TavernExportFile } from '@mahoshojo/ui-web/tavern';
import { resetDesktopAiConfigStoreForTests } from '../src/features/ai-config/use-desktop-ai-config';
import { DesktopTavern } from '../src/app/tavern-page';
import { getPlaceholderPngBytes, replacePngTextChunks } from '@mahoshojo/domain/tavern-card';

const mocks = vi.hoisted(() => ({ save: vi.fn<(repository: unknown, data: unknown) => Promise<string>>(async () => 'saved'), export: vi.fn<(file: TavernExportFile) => void>() }));
vi.mock('../src/features/account/use-desktop-cloud-session', () => {
  const state = { bootstrapped: true, account: null, verification: 'signed-out', authFlow: { kind: 'idle' } };
  return { useDesktopCloudSession: () => ({ state, store: { getSnapshot: () => state, getCredentialEpoch: () => 0 } }) };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => true) }));
vi.mock('../src/platform/provider-profile-bridge', () => ({ listProviderProfileIds: async () => [] }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({}), Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('../src/app/useLeaveGuard', () => ({ useLeaveGuard: () => ({ ready: true }) }));
vi.mock('../src/features/external-links/external-links-provider', () => ({ useExternalLinks: () => ({ openFixed: vi.fn() }) }));
vi.mock('../src/platform/local-card-bridge', () => ({ IpcLocalCardRepository: class {} }));
vi.mock('../src/features/tavern/host', () => ({ saveDesktopTavernCard: mocks.save, exportTavernFile: mocks.export, getDesktopTavernBase: vi.fn() }));
vi.mock('@mahoshojo/ui-web/shell', () => ({ ProductFooter: () => null }));
vi.mock('@mahoshojo/ui-web/character-card', () => ({ CanshouCard: ({ canshou }: { canshou: { name: string; appearance: string; coreEmotion: string; researcherNotes: string } }) => <pre data-canshou-name={canshou.name}>{canshou.appearance}|{canshou.coreEmotion}|{canshou.researcherNotes}</pre>, GeneralCharacterCard: ({ general }: { general: { name: string; content: string } }) => <pre data-projection-name={general.name}>{general.content}</pre> }));

vi.mock('@mahoshojo/ui-web/scenario', () => ({ GeneralScenarioCard: ({ scenario }: { scenario: { title: string; content: string } }) => <pre data-scenario-title={scenario.title}>{scenario.content}</pre> }));

let root: Root; let container: HTMLDivElement;
const key = 'mahoshojo.tavern.import.placeholder.v1';
const field = (name: string) => container.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!;
const button = (text: string) => [...container.querySelectorAll('button')].find((element) => element.textContent === text)!;
const projected = () => container.querySelector('[data-projection-name]')?.textContent;
async function edit(name: string, value: string) { await act(async () => { const input = field(name); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function upload(raw: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  const file = { name: 'test.json', size: bytes.length, arrayBuffer: async () => bytes.buffer };
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); resetDesktopAiConfigStoreForTests(); vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] }))); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('Desktop Tavern real placeholder journey', () => {
  it('restores shared preferences and regenerates preview/export/save from the original', async () => {
    localStorage.setItem(key, JSON.stringify({ enabled: true, userReplacement: '旧用户', charReplacementMode: 'auto', customCharReplacement: '' }));
    act(() => root.render(<DesktopTavern />));
    const raw = { name: 'Alice', description: '{{user}} 对 {{char}} 说话', extensions: { keep: '{{user}}' } };
    await upload(raw); expect(projected()).toContain('旧用户 对 Alice 说话');
    await edit('用户占位符替换文本', '新用户'); expect(projected()).toContain('新用户 对 Alice 说话'); expect(projected()).not.toContain('旧用户');
    await act(async () => button('下载通用卡 JSON').click());
    const exported = JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[0][0].bytes));
    expect(exported.content).toContain('新用户 对 Alice'); expect(exported._tavern.raw).toEqual(raw);
    await act(async () => button('保存通用卡到本地库').click());
    expect(mocks.save.mock.calls[0][1]).toEqual(exported);
    await act(async () => field('替换占位符').click()); expect(projected()).toContain('{{user}} 对 {{char}}');
    await upload({ name: 'Bob', description: '{{char}}' }); await act(async () => field('替换占位符').click()); expect(projected()).toContain('Bob'); expect(projected()).not.toContain('Alice');
  });
  it('selects the shared Canshou preview and exports, saves and restores the same original', async () => {
    act(() => root.render(<DesktopTavern />));
    const raw = { name: '残兽', description: '{{user}} 外观', personality: '情感', scenario: '场景', mes_example: '样例', first_mes: '开场不入正文', tags: ['标签不入正文'] };
    await upload(raw); await edit('用户占位符替换文本', '访客');
    const selector = container.querySelector<HTMLSelectElement>('select')!;
    await act(async () => { selector.value = 'canshou'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    const preview = container.querySelector('[data-canshou-name]')!;
    expect(preview.textContent).toContain('访客 外观|情感|【场景】'); expect(preview.textContent).not.toContain('不入正文');
    expect(projected()).toBeUndefined(); expect(container.textContent).toContain('开场白与标签不进入残兽正文');
    await act(async () => button('下载残兽卡 JSON').click());
    const file = mocks.export.mock.calls[0][0]; const exported = JSON.parse(new TextDecoder().decode(file.bytes));
    expect(file.name).toBe('残兽.json'); expect(exported).toMatchObject({ name: '残兽', appearance: '访客 外观', _tavern: { raw } });
    await act(async () => button('保存残兽卡到本地库').click()); expect(mocks.save.mock.calls[0][1]).toEqual(exported);
    await upload(exported); await act(async () => button('导出原件 JSON').click());
    expect(JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[1][0].bytes))).toEqual(raw);
    await act(async () => { selector.value = 'general-scenario'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('[data-canshou-name]')).toBeNull(); expect(container.querySelector('[data-scenario-title]')).not.toBeNull();
    await act(async () => { selector.value = 'general'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(projected()).toContain('开场不入正文');
  });
  it('switches to a general scenario, exports/saves its title and restores its Tavern original', async () => {
    act(() => root.render(<DesktopTavern />));
    const raw = { name: '庭院', description: '背景', scenario: '场景', first_mes: '{{user}} 开场', extra: { keep: true } };
    await upload(raw);
    const selector = container.querySelector<HTMLSelectElement>('select')!;
    expect([...selector.options].map((option) => option.value)).toEqual(['general', 'general-scenario', 'canshou', 'scenario']);
    await act(async () => { selector.value = 'general-scenario'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(projected()).toBeUndefined(); expect(container.querySelector('[data-scenario-title]')?.textContent).toContain('## 场景概览');
    await act(async () => button('下载通用卡 JSON').click());
    const file = mocks.export.mock.calls[0][0]; const exported = JSON.parse(new TextDecoder().decode(file.bytes));
    expect(file.name).toBe('庭院.json'); expect(exported).toMatchObject({ templateId: '通用情景', title: '庭院', _tavern: { raw } });
    await act(async () => button('保存通用卡到本地库').click()); expect(mocks.save.mock.calls[0][1]).toEqual(exported);
    await upload(exported); await act(async () => button('导出原件 JSON').click());
    expect(JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[1][0].bytes))).toEqual(raw);
    await act(async () => { selector.value = 'general'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(projected()).toContain('背景'); expect(container.querySelector('[data-scenario-title]')).toBeNull();
  });
  it('keeps the selected source, controls and original export after budget failure and recovers without reimport', async () => {
    act(() => root.render(<DesktopTavern />));
    const raw = { name: 'Alice', description: '{{user}}'.repeat(9000) };
    await upload(raw); await edit('用户占位符替换文本', 'x'.repeat(4096));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('32 MiB'); expect(projected()).toBeUndefined(); expect(field('用户占位符替换文本').value).toHaveLength(4096);
    await act(async () => button('导出原件 JSON').click());
    expect(JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[0][0].bytes))).toEqual(raw);
    await act(async () => field('替换占位符').click()); expect(projected()).toContain('{{user}}'); expect(container.querySelector('[role="alert"]')).toBeNull();
    await upload({ bad: true }); expect(projected()).toContain('{{user}}'); expect(button('导出原件 JSON')).toBeDefined();
    expect(JSON.parse(localStorage.getItem(key)!).enabled).toBe(false);
  });
  it('re-resolves auto replacement when switching PNG candidates, always retaining the selected original', async () => {
    act(() => root.render(<DesktopTavern />));
    const first = { name: 'Alice', description: '{{char}} A' }; const second = { name: 'Bob', description: '{{char}} B' };
    const bytes = replacePngTextChunks(getPlaceholderPngBytes(), [{ keyword: 'ccv3', text: JSON.stringify(first) }, { keyword: 'chara', text: JSON.stringify(second) }]);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'two.png', size: bytes.length, arrayBuffer: async () => bytes.slice().buffer }] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(projected()).toContain('Alice A');
    await act(async () => container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click());
    expect(projected()).toContain('Bob B'); expect(field('角色占位符替换文本').value).toBe('Bob');
    await act(async () => button('下载通用卡 JSON').click());
    expect(JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[0][0].bytes))._tavern.raw).toEqual(second);
    await act(async () => container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0].click()); expect(projected()).toContain('Alice A');
  });
});
