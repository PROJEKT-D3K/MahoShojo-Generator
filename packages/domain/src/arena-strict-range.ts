import { computeArenaBaseTier, type ArenaBaseTier } from './arena-tier';

export type StrictRangeRating = { rating: number; games: number };

export const isArenaTierAtLeastFlower = (tier: ArenaBaseTier): boolean => tier === '花牌' || tier === '权杖';

export const shouldEnforceStrictRangeLimit = (a: StrictRangeRating, b: StrictRangeRating): boolean => {
  const aTier = computeArenaBaseTier(a.rating, a.games);
  const bTier = computeArenaBaseTier(b.rating, b.games);
  return isArenaTierAtLeastFlower(aTier) || isArenaTierAtLeastFlower(bTier);
};

export const STRICT_LOW_GAMES_THRESHOLD = 10;
export const STRICT_LOW_GAMES_MAX_ABS_DIFF = 400;

const STRICT_MAX_ABS_DIFF_BY_TIER: Record<ArenaBaseTier, number> = {
  '无牌': 2000,
  '白牌': 1000,
  '字牌': 900,
  '花牌': 800,
  '权杖': 1000,
};

export const getStrictMaxAbsDiffForRatings = (a: StrictRangeRating, b: StrictRangeRating): number => {
  const aTier = computeArenaBaseTier(a.rating, a.games);
  const bTier = computeArenaBaseTier(b.rating, b.games);
  const pick = a.rating > b.rating ? aTier : b.rating > a.rating ? bTier : (a.games >= b.games ? aTier : bTier);
  return STRICT_MAX_ABS_DIFF_BY_TIER[pick] ?? 1000;
};

export type StrictRangeCheckResult = {
  absDiff: number;
  maxAbsDiff: number;
  exceededBy: number;
  aRating: number;
  bRating: number;
  aGames: number;
  bGames: number;
  lowGamesTightened: boolean;
};

export const getStrictRangeCheckResult = (
  a: StrictRangeRating,
  b: StrictRangeRating,
): StrictRangeCheckResult | null => {
  if (!shouldEnforceStrictRangeLimit(a, b)) return null;

  const absDiff = Math.abs(a.rating - b.rating);
  const baseMaxAbsDiff = getStrictMaxAbsDiffForRatings(a, b);
  const lowGamesTightened = a.games < STRICT_LOW_GAMES_THRESHOLD || b.games < STRICT_LOW_GAMES_THRESHOLD;
  const maxAbsDiff = lowGamesTightened ? Math.min(baseMaxAbsDiff, STRICT_LOW_GAMES_MAX_ABS_DIFF) : baseMaxAbsDiff;

  return {
    absDiff,
    maxAbsDiff,
    exceededBy: Math.max(0, absDiff - maxAbsDiff),
    aRating: a.rating,
    bRating: b.rating,
    aGames: a.games,
    bGames: b.games,
    lowGamesTightened,
  };
};
