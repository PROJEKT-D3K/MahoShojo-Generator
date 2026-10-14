// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TavernLocalProjection, TavernPlaceholderFields, useTavernPlaceholderPreference, TAVERN_PLACEHOLDER_PREFERENCE_KEY } from '../src/tavern';
import { MAX_TAVERN_TEXT_BYTES } from '@mahoshojo/domain/tavern-card';

let root: Root; let container: HTMLDivElement;
const key = 'mahoshojo.tavern.import.placeholder.v1';
function Harness({ name = ' {{char}} ', disabled = false }: { name?: string; disabled?: boolean }) {
  const { preference, setPreference } = useTavernPlaceholderPreference();
  return <TavernPlaceholderFields preference={preference} onChange={setPreference} name={name} disabled={disabled} />;
}
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const field = (name: string) => container.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!;
async function edit(name: string, value: string) { await act(async () => { const input = field(name); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
describe('shared Tavern placeholder preference owner and controls', () => {
  it('restores all four legacy fields before any write, including StrictMode replay', () => {
    expect(TAVERN_PLACEHOLDER_PREFERENCE_KEY).toBe(key);
    const stored = { enabled: false, userReplacement: '', charReplacementMode: 'custom', customCharReplacement: '  ' };
    localStorage.setItem(key, JSON.stringify(stored));
    const write = vi.spyOn(Storage.prototype, 'setItem');
    act(() => root.render(<StrictMode><Harness /></StrictMode>));
    expect(field('替换占位符').checked).toBe(false); expect(field('用户占位符替换文本').value).toBe(''); expect(field('角色占位符替换文本').value).toBe('  ');
    const writes = write.mock.calls.filter(([item]) => item === key);
    expect(writes.length).toBeGreaterThan(0); expect(writes.every(([, value]) => JSON.stringify(JSON.parse(value)) === JSON.stringify(stored))).toBe(true);
  });
  it('keeps auto fallback separate from the legacy custom-mode seed, and allows clearing it', async () => {
    act(() => root.render(<Harness />));
    expect(field('角色占位符替换文本').value).toBe('角色');
    await act(async () => field('使用角色名').click());
    expect(field('角色占位符替换文本').value).toBe('{{char}}');
    await edit('角色占位符替换文本', '');
    expect(JSON.parse(localStorage.getItem(key)!).customCharReplacement).toBe('');
    await edit('用户占位符替换文本', '$&');
    expect(JSON.parse(localStorage.getItem(key)!).userReplacement).toBe('$&');
  });
  it('falls back field-by-field for malformed storage and tolerates unavailable storage', () => {
    localStorage.setItem(key, JSON.stringify({ enabled: 'no', userReplacement: 'saved', charReplacementMode: 'bad', customCharReplacement: 7 }));
    act(() => root.render(<Harness name="Alice" />));
    expect(field('替换占位符').checked).toBe(true); expect(field('用户占位符替换文本').value).toBe('saved'); expect(field('角色占位符替换文本').value).toBe('Alice');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => act(() => field('替换占位符').click())).not.toThrow();
  });
  it.each(['{', 'null', '[]'])('restores defaults for malformed or non-record %s preferences', (stored) => {
    localStorage.setItem(key, stored); act(() => root.render(<Harness name="Alice" />));
    expect(field('用户占位符替换文本').value).toBe('【某人】'); expect(field('使用角色名').checked).toBe(true);
  });
  it('still allows in-memory changes when both storage reads and writes throw', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    act(() => root.render(<Harness name="Alice" />)); await edit('用户占位符替换文本', 'local'); expect(field('用户占位符替换文本').value).toBe('local');
  });
  it('restores edits after remount and respects the host operation lock', async () => {
    act(() => root.render(<Harness />)); await edit('用户占位符替换文本', 'remember');
    act(() => root.render(<div />)); act(() => root.render(<Harness disabled />));
    expect(field('用户占位符替换文本').value).toBe('remember'); expect([...container.querySelectorAll('input')].every((input) => input.disabled)).toBe(true);
  });
  it.each(['character', 'scenario'] as const)('enforces the exact final %s JSON UTF-8 budget including raw, Markdown and escapes', async (kind) => {
    const save = vi.fn(async () => 'saved' as const); const exportFile = vi.fn();
    const data = { ...(kind === 'scenario' ? { templateId: '通用情景', title: '中😀' } : { templateId: '通用角色', name: '中😀' }), content: '# 角色：中😀\n\\\"\u0000', _tavern: { raw: { name: '{{char}}', description: '原件', padding: '' } } };
    const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    data._tavern.raw.padding = 'a'.repeat(MAX_TAVERN_TEXT_BYTES - size(data));
    expect(size(data)).toBe(MAX_TAVERN_TEXT_BYTES);
    act(() => root.render(<TavernLocalProjection data={data} saveCard={save} exportFile={exportFile} />));
    await act(async () => container.querySelector('button')!.click()); expect(exportFile).toHaveBeenCalledTimes(1); expect(exportFile.mock.calls[0][0].bytes.length).toBe(MAX_TAVERN_TEXT_BYTES);
    const oversized = { ...data, content: data.content + '\n' };
    expect(size(oversized)).toBe(MAX_TAVERN_TEXT_BYTES + 2);
    act(() => root.render(<TavernLocalProjection data={oversized} saveCard={save} exportFile={exportFile} />));
    await act(async () => container.querySelector('button')!.click());
    await act(async () => container.querySelectorAll('button')[1].click());
    expect(exportFile).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled(); expect(container.textContent).toContain('4 MiB');
  });
});
