// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArenaEditorWorkspaceLayout, buildArenaEditorSections } from '../src/arena';
import { useSessionSidebarPreference, MAGIC_TEA_PARTY_SIDEBAR_PREFERENCE_KEY as key } from '../src/magic-tea-party';
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); localStorage.clear(); });
function Sidebar() {
  const { pinnedCollapsed, recentCollapsed, setPinnedCollapsed, setRecentCollapsed } = useSessionSidebarPreference();
  return <><button aria-label="pinned" aria-expanded={!pinnedCollapsed} onClick={() => setPinnedCollapsed(v => !v)} />
    <button aria-label="recent" aria-expanded={!recentCollapsed} onClick={() => setRecentCollapsed(v => !v)} /></>;
}
async function sidebar() { await act(async () => root.render(<StrictMode><Sidebar /></StrictMode>)); }
async function click(label: string) { await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()); }
it('restores legacy sidebar values before writing, survives StrictMode and remounts', async () => {
  localStorage.setItem(key, JSON.stringify({ pinnedCollapsed: true, recentCollapsed: false }));
  const writes = vi.spyOn(Storage.prototype, 'setItem');
  await sidebar();
  expect(container.querySelector('[aria-label="pinned"]')?.getAttribute('aria-expanded')).toBe('false');
  expect(writes.mock.calls.filter(([k]) => k === key).every(([, value]) => JSON.parse(value).pinnedCollapsed === true)).toBe(true);
  await click('recent'); await sidebar();
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ pinnedCollapsed: true, recentCollapsed: true });
  await act(async () => root.unmount()); root = createRoot(container); await sidebar();
  expect([...container.querySelectorAll('button')].map(b => b.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
});
it.each(['null', '[]', '{', '{"pinnedCollapsed":"true","recentCollapsed":true}'])('handles malformed sidebar preference %s', async raw => {
  localStorage.setItem(key, raw); await sidebar();
  expect(container.querySelector('[aria-label="pinned"]')?.getAttribute('aria-expanded')).toBe('true');
  await click('pinned'); expect(container.querySelector('[aria-label="pinned"]')?.getAttribute('aria-expanded')).toBe('false');
});
it('keeps toggles usable when localStorage access fails', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  await sidebar(); await click('pinned'); await click('recent'); await sidebar();
  expect([...container.querySelectorAll('button')].map(b => b.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
});
it('only builds supplied semantic sections with legacy keys and host defaults', () => {
  const sections = buildArenaEditorSections([
    { kind: 'roster', description: '', content: null, keepMounted: true },
    { kind: 'materials', description: '', content: null, defaultOpen: false },
    { kind: 'characterDatabase', title: '本地角色库', description: '', content: null },
  ]);
  expect(sections.map(s => s.kind)).toEqual(['roster', 'materials', 'characterDatabase']);
  expect(sections[0]).toMatchObject({ storageKey: 'arena.section.combatants.open', column: 'left', keepMounted: true });
  expect(sections[1]).toMatchObject({ storageKey: 'arena.section.materials.open', column: 'right', defaultOpen: false });
  expect(sections[2].title).toBe('本地角色库');
});
it('scenario auto-open is edge-triggered and preserves manual folding across rerenders', async () => {
  localStorage.setItem('arena.section.scenario.open', '0');
  const render = async (autoOpen: boolean) => act(async () => root.render(<ArenaEditorWorkspaceLayout sections={buildArenaEditorSections([
    { kind: 'scenario', description: '', content: <input defaultValue="draft" />, keepMounted: true, defaultOpen: true, autoOpen },
  ])} />));
  await render(false); expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  await render(true); expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
  await act(async () => container.querySelector('button')!.click());
  await render(true); expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('input')?.value).toBe('draft'); expect(localStorage.getItem('arena.section.scenario.open')).toBe('0');
  await render(false); await render(true); expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
});
it.each(['corrupt', 'unavailable'])('Arena defaults stay independent of sidebar preferences with %s storage', async mode => {
  localStorage.setItem('arena.section.materials.open', 'not-a-boolean');
  localStorage.setItem(key, JSON.stringify({ pinnedCollapsed: true, recentCollapsed: true }));
  if (mode === 'unavailable') {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  }
  await act(async () => root.render(<><Sidebar /><ArenaEditorWorkspaceLayout sections={buildArenaEditorSections([
    { kind: 'materials', description: '', content: 'materials', defaultOpen: false },
  ])} /></>));
  const section = container.querySelector<HTMLButtonElement>('button[aria-controls]')!;
  expect(section.getAttribute('aria-expanded')).toBe('false');
  await act(async () => section.click());
  expect(section.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('[aria-label="pinned"]')?.getAttribute('aria-expanded')).toBe(mode === 'unavailable' ? 'true' : 'false');
});
