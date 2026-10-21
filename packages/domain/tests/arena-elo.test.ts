import { describe, expect, it } from 'vitest';
import { computeEloExpectedScore, predictArenaPair } from '../src/arena-elo';

describe('双端评分预测', () => {
  it('保留原有 Elo 计算及互补结果', () => {
    expect(computeEloExpectedScore(1000, 1000)).toBe(0.5);
    expect(computeEloExpectedScore(1400, 1000)).toBeCloseTo(10 / 11);
    const pair = predictArenaPair({ strict: 1400, free: 10 }, { strict: 1000, free: 20 })!;
    expect(pair.map(item => [item.queue, item.expectedPct])).toEqual([['strict', 91], ['strict', 9]]);
  });
  it('严格缺项时只退到双方完整自由评分，不交叉拼队列', () => {
    expect(predictArenaPair({ strict: null, free: 0 }, { strict: 1000, free: 0 })?.[0]).toMatchObject({ queue: 'free', expectedPct: 50 });
    expect(predictArenaPair({ strict: 1200, free: null }, { strict: null, free: 1100 })).toBeNull();
    expect(predictArenaPair({ strict: NaN, free: Infinity }, { strict: 1000, free: 1000 })).toBeNull();
  });
});
