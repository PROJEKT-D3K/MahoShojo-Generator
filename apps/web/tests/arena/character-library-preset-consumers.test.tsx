// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultFilters, rankingTransportFilters } from '@mahoshojo/domain/public-ranking';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';

vi.mock('@/lib/card-library-host', () => ({ useWebCardLibraryHost: () => ({ auth: { userId: null } }) }));
vi.mock('@mahoshojo/domain/presets', () => ({ PRESET_LIST: [{ name: '同名预设', filename: 'shared.json', type: 'magical-girl', description: '合成预设' }] }));
vi.mock('@/components/arena/hooks/useArenaData', () => ({ usePresetQuery: () => {
  const preset = { name: '同名预设', filename: 'shared.json', type: 'magical-girl', description: '合成预设' };
  return { data: [preset], grouped: { magicalGirl: [preset], canshou: [] }, isLoading: false, error: null };
} }));
vi.mock('@/components/arena/utils/characterValidator', () => ({
  validateMagicalGirlData: (data: unknown) => ({ success: true, data }),
  validateCanshouData: (data: unknown) => ({ success: true, data }),
}));
vi.mock('@/components/arena/hooks/useBattleActions', () => ({ useBattleActions: () => ({ handleSelectDataCard: vi.fn(), handleToggleCombatantDataCard: vi.fn() }) }));
vi.mock('@/components/ranking/LeaderboardEntityDetailsModal', () => ({ LeaderboardEntityDetailsModal: () => null }));

import { PresetSelector } from '@/components/arena/components/PresetSelector';
import { ArenaRankingModal } from '@/components/arena/components/ArenaRankingModal';

let root: Root; let container: HTMLDivElement; let client: QueryClient;
beforeEach(() => {
  localStorage.clear();
  useBattleStore.setState(useBattleStore.getInitialState(), true);
  useBattleStore.setState({ combatants: [{
    type: 'general-character', filename: 'shared.json', data: { name: '同名库角色' },
    cardLibrarySelectionId: 'local:separate', isValid: false, isPreset: false,
  }] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['tags', { kind: 'tags' }], { success: true, tags: [] });
  client.setQueryData(['seasonsConfig', { kind: 'seasons' }], { schemaVersion: 1, seasons: [] });
  client.setQueryData(['arenaLeaderboard', { kind: 'leaderboard', filters: rankingTransportFilters(defaultFilters), limit: 30, offset: 0 }], {
    success: true, items: [{ rank: 1, entityType: 'preset', entityId: 'shared.json', displayName: '同名预设', authorName: null,
      rating: 1000, games: 3, wins: 2, losses: 1, draws: 0, tier: '无牌', techScore: null, techLevel: null, isNative: true, tagIds: [] }],
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/presets/shared.json') return Response.json({ codename: '同名预设' });
    throw new Error(`Unexpected request: ${url}`);
  }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });
const render = (content: React.ReactNode) => act(async () => root.render(<QueryClientProvider client={client}>{content}</QueryClientProvider>));

describe('卡库同名来源不冒充预设', () => {
  it('预设选择器初始不误选；添加后撤选预设保留同名库角色', async () => {
    await render(<PresetSelector />);
    let button = container.querySelector<HTMLButtonElement>('button[aria-label="选择预设角色：同名预设"]');
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-pressed')).toBe('false');
    await act(async () => button!.click());
    expect(useBattleStore.getState().combatants).toHaveLength(2);
    button = container.querySelector<HTMLButtonElement>('button[aria-label="取消选择预设角色：同名预设"]');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(useBattleStore.getState().combatants).toMatchObject([{ cardLibrarySelectionId: 'local:separate', isPreset: false }]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/presets/shared.json');
  });

  it('旧上传角色没有卡库身份时保留既有预设文件名选择语义', async () => {
    useBattleStore.setState({ combatants: [{
      type: 'general-character', filename: 'shared.json', data: { name: '旧上传角色' }, isValid: false, isPreset: false,
    }] });
    await render(<PresetSelector />);
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="取消选择预设角色：同名预设"]');
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-pressed')).toBe('true');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('排行榜预设选中态已有 isPreset 隔离，不把同名库角色算成已加入', async () => {
    await render(<ArenaRankingModal isOpen onClose={() => undefined} />);
    expect(container.textContent).not.toContain('移除/已加入');
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === '加入参战');
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
