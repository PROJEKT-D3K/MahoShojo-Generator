// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  items: [] as Array<{
    rank: number; entityType: 'data_card' | 'preset'; entityId: string; displayName: string;
    authorName: null; rating: number; games: number; wins: number; losses: number; draws: number;
    tier: string; techScore: null; techLevel: null; isNative: null; tagIds: string[];
  }>,
  state: {
    combatants: [{ data: {}, sourceDataCardId: 'pivot', filename: 'pivot.json', isPreset: false }],
    addCombatant: vi.fn(), removeCombatant: vi.fn(), setError: vi.fn(),
  },
}));
vi.mock('@/components/ranking/use-ranking-query', () => ({
  useWebRankingQuery: ({ request }: { request: { kind: string } }) => ({
    data: request.kind === 'leaderboard' ? { success: true, items: mocks.items }
      : request.kind === 'tags' ? { success: true, tags: [] } : undefined,
    isLoading: false, isError: false,
  }),
  webRankingCache: { isCanonicalQuery: () => false },
}));
vi.mock('@/lib/card-library-host', () => ({ useWebCardLibraryHost: () => ({ auth: { userId: null } }) }));
vi.mock('next/link', () => ({ default: (props: ComponentProps<'a'>) => <a {...props} /> }));
vi.mock('@/components/ranking/LeaderboardEntityDetailsModal', () => ({ LeaderboardEntityDetailsModal: () => null }));
vi.mock('@/components/ranking/TechBadge', () => ({ TechBadge: () => null }));
vi.mock('@/components/ranking/TierBadge', () => ({ TierBadge: () => null }));
vi.mock('@/components/arena/hooks/useBattleActions', () => ({ useBattleActions: () => ({ handleToggleCombatantDataCard: vi.fn() }) }));
vi.mock('@/components/arena/hooks/useArenaData', () => ({ usePresetQuery: () => ({ data: [] }) }));
vi.mock('@/components/arena/stores/useBattleStore', () => ({ getArenaRosterCombatantKey: vi.fn(), useBattleStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state) }));
vi.mock('@/lib/arena/rank-cache', () => ({ isCanonicalPublicLeaderboardQuery: () => false, upsertArenaRankCacheFromLeaderboard: vi.fn() }));
vi.mock('@/lib/data-card-read-mappers', () => ({ isPublicVisibility: vi.fn(), mapPublicDataCardRowToBattleSelectionPayload: vi.fn() }));
vi.mock('@/lib/localStorage', () => ({ addUsedCard: vi.fn(), isCardUsed: vi.fn() }));
vi.mock('@/lib/text', () => ({ buildTitleDisplay: (value: string) => ({ display: value, full: value }) }));
vi.mock('@/lib/seasons', () => ({ getCurrentSeason: () => null, formatSeasonTitle: vi.fn() }));
vi.mock('@/components/arena/utils/characterValidator', () => ({ validateCanshouData: vi.fn(), validateMagicalGirlData: vi.fn() }));

import { ArenaRankingModal } from '@/components/arena/components/ArenaRankingModal';

const item = (entityId: string, rating: number, games: number, entityType: 'data_card' | 'preset' = 'data_card'): typeof mocks.items[number] => ({
  rank: 1, entityType, entityId, displayName: entityId, authorName: null, rating, games,
  wins: 0, losses: 0, draws: 0, tier: '花牌', techScore: null, techLevel: null, isNative: null, tagIds: [],
});
let container: HTMLDivElement;
let root: Root;
const render = async () => { await act(async () => { root.render(<ArenaRankingModal isOpen onClose={vi.fn()} />); }); };
const prefilter = () => [...container.querySelectorAll('input[type="checkbox"]')].find((input) => input.closest('label')?.textContent?.includes('严格')) as HTMLInputElement;
const togglePrefilter = async () => { await act(async () => { prefilter().click(); }); };
const rowNames = () => [...container.querySelectorAll('tbody button[aria-label]')].map((button) => button.textContent);

beforeEach(() => {
  mocks.state.combatants = [{ data: {}, sourceDataCardId: 'pivot', filename: 'pivot.json', isPreset: false }];
  mocks.items = [item('pivot', 1300, 6), item('too-far', 1750, 8), item('boundary', 1700, 8)];
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

describe('ArenaRankingModal strict range prefilter', () => {
  it('filters low-games opponents at the server 400-point limit, and restores rows when disabled', async () => {
    await render(); expect(rowNames()).toEqual(['pivot', 'too-far', 'boundary']);
    await togglePrefilter(); expect(rowNames()).toEqual(['boundary']);
    await togglePrefilter(); expect(rowNames()).toEqual(['pivot', 'too-far', 'boundary']);
  });

  it('labels the range-only prefilter without promising server scoring eligibility', async () => {
    await render();
    expect(prefilter().closest('label')?.textContent).toContain('严格分差预筛');
    expect(container.textContent).toContain('最终计分仍由服务器判定');
    expect(container.textContent).toContain('冷却');
    expect(container.textContent).not.toContain('严格可计分');
  });

  it.each([
    { pivotRating: 1300, pivotGames: 9, opponentRating: 1701, opponentGames: 10, visible: false },
    { pivotRating: 1300, pivotGames: 10, opponentRating: 1701, opponentGames: 9, visible: false },
    { pivotRating: 1300, pivotGames: 10, opponentRating: 1701, opponentGames: 10, visible: true },
    { pivotRating: 700, pivotGames: 9, opponentRating: 1199, opponentGames: 9, visible: true },
  ])('uses the canonical tier and placement boundary: $pivotGames/$opponentGames games, visible=$visible', async ({ pivotRating, pivotGames, opponentRating, opponentGames, visible }) => {
    mocks.items = [item('pivot', pivotRating, pivotGames), item('opponent', opponentRating, opponentGames)];
    await render(); await togglePrefilter();
    expect(rowNames()).toEqual(visible ? ['opponent'] : []);
  });

  it('preserves preset opponents and exempts a preset pivot from the data-card range prefilter', async () => {
    mocks.items.push(item('preset-opponent', 2500, 6, 'preset'));
    await render(); await togglePrefilter(); expect(rowNames()).toEqual(['boundary', 'preset-opponent']);
    mocks.state.combatants = [{ data: {}, sourceDataCardId: '', filename: 'M01_centaurea.json', isPreset: true }];
    mocks.items = [item('M01_centaurea.json', 1300, 6, 'preset'), item('too-far', 1750, 8)];
    await render(); expect(rowNames()).toEqual(['too-far']);
  });

  it('disables the prefilter on the free queue without removing leaderboard rows', async () => {
    await render(); await togglePrefilter();
    const queue = container.querySelector('select')!;
    await act(async () => { queue.value = 'free'; queue.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(prefilter().disabled).toBe(true); expect(prefilter().checked).toBe(false);
    expect(rowNames()).toEqual(['pivot', 'too-far', 'boundary']);
  });
});
