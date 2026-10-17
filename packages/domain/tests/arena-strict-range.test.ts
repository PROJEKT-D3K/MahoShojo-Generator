import { describe, expect, it } from 'vitest';
import {
  getStrictMaxAbsDiffForRatings,
  getStrictRangeCheckResult,
  isArenaTierAtLeastFlower,
  shouldEnforceStrictRangeLimit,
  STRICT_LOW_GAMES_MAX_ABS_DIFF,
  STRICT_LOW_GAMES_THRESHOLD,
} from '../src/arena-strict-range';

describe('strict range shared rules', () => {
  it('keeps the server low-games policy constants', () => {
    expect(STRICT_LOW_GAMES_THRESHOLD).toBe(10);
    expect(STRICT_LOW_GAMES_MAX_ABS_DIFF).toBe(400);
  });

  it('requires at least one placed flower or scepter rating', () => {
    expect(isArenaTierAtLeastFlower('字牌')).toBe(false);
    expect(isArenaTierAtLeastFlower('花牌')).toBe(true);
    expect(isArenaTierAtLeastFlower('权杖')).toBe(true);
    expect(shouldEnforceStrictRangeLimit({ rating: 1199, games: 20 }, { rating: 2500, games: 4 })).toBe(false);
    expect(getStrictRangeCheckResult({ rating: 700, games: 9 }, { rating: 1199, games: 9 })).toBeNull();
    expect(shouldEnforceStrictRangeLimit({ rating: 1200, games: 5 }, { rating: 700, games: 9 })).toBe(true);
  });

  it.each([
    [700, 20, 2000], [900, 20, 1000], [1100, 20, 900], [1300, 20, 800], [1750, 20, 1000], [1750, 4, 2000],
  ])('uses the higher rating base tier at %s/%s games', (rating, games, maximum) => {
    expect(getStrictMaxAbsDiffForRatings({ rating: 500, games: 20 }, { rating, games })).toBe(maximum);
  });

  it('uses the higher game count when ratings tie', () => {
    const a = { rating: 1300, games: 4 };
    const b = { rating: 1300, games: 10 };
    expect(getStrictMaxAbsDiffForRatings(a, b)).toBe(800);
    expect(getStrictMaxAbsDiffForRatings(b, a)).toBe(800);
  });

  it.each([400, 401, 450])('applies the low-games limit symmetrically at %s points', (difference) => {
    const a = Object.freeze({ rating: 1300, games: 6 });
    const b = Object.freeze({ rating: 1300 + difference, games: 10 });
    expect(getStrictRangeCheckResult(a, b)).toEqual({
      absDiff: difference, maxAbsDiff: 400, exceededBy: Math.max(0, difference - 400),
      aRating: a.rating, bRating: b.rating, aGames: a.games, bGames: b.games, lowGamesTightened: true,
    });
    expect(getStrictRangeCheckResult(b, a)).toEqual({
      absDiff: difference, maxAbsDiff: 400, exceededBy: Math.max(0, difference - 400),
      aRating: b.rating, bRating: a.rating, aGames: b.games, bGames: a.games, lowGamesTightened: true,
    });
  });

  it('stops tightening at ten games without changing the base tier limit', () => {
    expect(getStrictRangeCheckResult({ rating: 1300, games: 9 }, { rating: 1750, games: 10 }))
      .toMatchObject({ maxAbsDiff: 400, exceededBy: 50, lowGamesTightened: true });
    expect(getStrictRangeCheckResult({ rating: 1300, games: 10 }, { rating: 1750, games: 10 }))
      .toMatchObject({ maxAbsDiff: 1000, exceededBy: 0, lowGamesTightened: false });
  });
});
