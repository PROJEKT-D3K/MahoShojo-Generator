export type EloPredictionV1 = {
  method: 'elo';
  version: 1;
  player: { rating: number; games: number };
  opponent: { rating: number; games: number };
  /**
   * Elo 期望得分（在“无平局”假设下可视为胜率）。
   * 取值范围 [0,1]。
   */
  expectedScore: number;
};

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) return 0.5;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
};

export const computeEloExpectedScore = (ratingA: number, ratingB: number): number => {
  const a = Number.isFinite(ratingA) ? ratingA : 0;
  const b = Number.isFinite(ratingB) ? ratingB : a;
  const exp = (b - a) / 400;
  const expected = 1 / (1 + Math.pow(10, exp));
  return clamp01(expected);
};

export type ArenaQueueRatings = { strict: number | null; free: number | null };
export type ArenaEloPrediction = {
  queue: 'strict' | 'free'; expectedScore: number; expectedPct: number; selfRating: number; opponentRating: number;
};
/** 只比较双方已有的同队列评分；不把缺失值替换为初始分。 */
export function predictArenaPair(first: ArenaQueueRatings, second: ArenaQueueRatings): readonly [ArenaEloPrediction, ArenaEloPrediction] | null {
  const present = (value: number | null): value is number => typeof value === 'number' && Number.isFinite(value);
  const queue = present(first.strict) && present(second.strict) ? 'strict' : present(first.free) && present(second.free) ? 'free' : null;
  if (!queue) return null;
  const a = first[queue]!, b = second[queue]!;
  const prediction = (selfRating: number, opponentRating: number): ArenaEloPrediction => {
    const expectedScore = computeEloExpectedScore(selfRating, opponentRating);
    return { queue, expectedScore, expectedPct: Math.round(expectedScore * 100), selfRating, opponentRating };
  };
  return [prediction(a, b), prediction(b, a)];
}
