// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESET_LIST } from '@mahoshojo/domain/presets';
import { PresetSelector } from '@/components/arena/components/PresetSelector';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';

vi.mock('@/components/arena/hooks/useArenaData', () => ({ usePresetQuery: () => ({ grouped: { magicalGirl: PRESET_LIST.filter(preset => preset.type === 'magical-girl'), canshou: PRESET_LIST.filter(preset => preset.type === 'canshou') }, isLoading: false, error: null }) }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  useBattleStore.setState({ combatants: [], isGenerating: false, loadingPreset: null, error: null });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(readFileSync(resolve(process.cwd(), '../../content', String(input).slice(1)), 'utf8'))));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('Web character preset selector shared composition', () => {
  it('retains real selection/deselection, original download links and independent page positions', async () => {
    await act(async () => root.render(<PresetSelector />));
    const girls = [...container.querySelectorAll('h3')].find(item => item.textContent === '选择预设魔法少女')!.parentElement!;
    const monsters = [...container.querySelectorAll('h3')].find(item => item.textContent === '选择预设残兽')!.parentElement!;
    const select = () => girls.querySelector<HTMLButtonElement>('[aria-pressed]')!;
    await act(async () => select().click());
    expect(useBattleStore.getState().combatants[0]).toMatchObject({ filename: 'M01_centaurea.json', isPreset: true, isValid: true });
    expect(select().getAttribute('aria-pressed')).toBe('true');
    const link = girls.querySelector<HTMLAnchorElement>('[download]')!;
    expect(link.getAttribute('href')).toBe('/presets/M01_centaurea.json'); expect(link.download).toBe('M01_centaurea.json');
    await act(async () => select().click()); expect(useBattleStore.getState().combatants).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => [...girls.querySelectorAll('button')].find(button => button.textContent === '下一页')!.click());
    expect(girls.textContent).toContain('第 2 /'); expect(monsters.textContent).toContain('第 1 /');
    await act(async () => useBattleStore.setState({ isGenerating: true }));
    expect(select().disabled).toBe(true); expect(monsters.querySelector<HTMLButtonElement>('[aria-pressed]')!.disabled).toBe(true);
  });
});
