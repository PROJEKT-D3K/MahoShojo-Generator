// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopTavern } from '../src/app/tavern-page';
import { getPlaceholderPngBytes, replacePngTextChunks } from '@mahoshojo/domain/tavern-card';

const mocks = vi.hoisted(() => ({ save: vi.fn<(repository: unknown, data: unknown) => Promise<string>>(async () => 'saved'), export: vi.fn<(file: { bytes: Uint8Array }) => void>() }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({}), Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('../src/app/useLeaveGuard', () => ({ useLeaveGuard: () => ({ ready: true }) }));
vi.mock('../src/features/external-links/external-links-provider', () => ({ useExternalLinks: () => ({ openFixed: vi.fn() }) }));
vi.mock('../src/platform/local-card-bridge', () => ({ IpcLocalCardRepository: class {} }));
vi.mock('../src/features/tavern/host', () => ({ saveDesktopTavernCard: mocks.save, exportTavernFile: mocks.export, getDesktopTavernBase: vi.fn() }));
vi.mock('@mahoshojo/ui-web/shell', () => ({ ProductFooter: () => null }));
vi.mock('@mahoshojo/ui-web/character-card', () => ({ GeneralCharacterCard: ({ general }: { general: { name: string; content: string } }) => <pre data-projection-name={general.name}>{general.content}</pre> }));

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
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

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
