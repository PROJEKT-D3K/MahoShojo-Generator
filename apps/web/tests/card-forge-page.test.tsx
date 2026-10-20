// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CardForgePage } from '@/components/card-forge/CardForgePage';

vi.mock('next/navigation', () => ({ useSearchParams: () => null }));
vi.mock('@/components/BattleDataModal', () => ({ default: () => null }));
vi.mock('@/components/shared/ImagePreviewModal', () => ({ ImagePreviewModal: () => null }));
vi.mock('@/components/AiProviderSelector', () => ({ default: () => null }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: async () => ({ hasSensitiveWords: false }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const face = { cardName: '原卡', cardType: 'character', rarity: 'epic', cost: 3, element: 'dark', attack: 2, defense: 1, hp: 3, effects: [], traits: [], flavorText: '', powerLevel: 'A', description: '', themeColor: '#EF4444' };

it('exposes shared theme preset names and selection in the real Web import and edit flow', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const presets = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')];
  const selectedNames = () => presets().filter((button) => button.getAttribute('aria-pressed') === 'true').map((button) => button.getAttribute('aria-label'));
  try {
    await act(async () => root.render(<CardForgePage />));
    const input = [...container.querySelectorAll('label')].find((label) => label.textContent?.trim() === '导入卡面 JSON')!.querySelector('input')!;
    const importFace = async (themeColor: string) => {
      Object.defineProperty(input, 'files', { configurable: true, value: [{ text: async () => JSON.stringify({ ...face, themeColor }) }] });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    };
    await importFace('#EF4444');
    expect(container.querySelector('.gc-name-text')?.textContent).toBe('原卡');
    expect(presets()).toHaveLength(8);
    expect(selectedNames()).toEqual(['主题色 #ef4444']);
    const blue = container.querySelector<HTMLButtonElement>('button[aria-label="主题色 #3b82f6"]')!;
    expect(blue.title).toBe('主题色 #3b82f6');
    blue.focus(); expect(document.activeElement).toBe(blue);
    act(() => blue.click());
    expect(selectedNames()).toEqual(['主题色 #3b82f6']);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="自定义主题色"]')?.value).toBe('#3b82f6');
    await importFace('#123456');
    expect(presets()).toHaveLength(8);
    expect(selectedNames()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); container.remove(); }
});
