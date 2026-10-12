import { describe, expect, it } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/public-ranking.json';
import { PublicSeasonArchiveSchema, type PublicSeasonArchive } from '@mahoshojo/contracts/public-ranking';
import { defaultFilters, deriveRankingArchiveSnapshot, filterRankingArchive, normalizeFilters, rankingTransportFilters } from '../src/public-ranking';

const base = PublicSeasonArchiveSchema.parse(fixture.responses.archive);
const entity = (id: string, rating: number, tech: number | null = null, extra = {}) => ({ ...base.entities[0]!, entityId: id, displayName: id, techScore: tech,
  queues: { strict: { rating, games: 20, wins: 12, losses: 7, draws: 1, ratingUpdatedAt: '2026-03-01' } }, ...extra });
const archive = (entities: PublicSeasonArchive['entities']): PublicSeasonArchive => ({ ...base, entities });
describe('shared archive ranking facts', () => {
  it('derives queen before filters and recomputes rank/tier under current rules', () => {
    const snapshot = deriveRankingArchiveSnapshot(archive([entity('queen', 1900), entity('second', 1800), entity('third', 1700)]), 'strict');
    expect(snapshot.queenKey).toBe('data_card:queen');
    const rows = filterRankingArchive(snapshot, { ...defaultFilters, maxRating: '1850' });
    expect(rows.map((item) => [item.entityId, item.rank, item.tier])).toEqual([['second', 1, '权杖'], ['third', 2, '权杖']]);
    expect(filterRankingArchive(snapshot, defaultFilters)[0]?.tier).toBe('女王');
  });
  it.each(['asc', 'desc'] as const)('keeps null technology last in %s order and stable rating/games/id ties', (order) => {
    const snapshot = deriveRankingArchiveSnapshot(archive([entity('null', 2000), entity('b', 1600, 50), entity('a', 1600, 50), entity('low', 1500, 10)]), 'strict');
    const rows = filterRankingArchive(snapshot, { ...defaultFilters, sort: 'tech', order });
    expect(rows.at(-1)?.entityId).toBe('null');
    expect(rows.filter((item) => item.techScore === 50).map((item) => item.entityId)).toEqual(['a', 'b']);
    expect(rows[0]?.entityId).toBe(order === 'asc' ? 'low' : 'a');
  });
  it('does not reinterpret unknown native as nonnative, and keeps preset/tag policy', () => {
    const snapshot = deriveRankingArchiveSnapshot(archive([entity('unknown', 1700), entity('no', 1600, 20, { isNative: false, tagIds: ['x'] }), entity('preset', 1500, null, { entityType: 'preset' })]), 'strict');
    expect(filterRankingArchive(snapshot, { ...defaultFilters, isNative: '0' }).map((item) => item.entityId)).toEqual(['no']);
    expect(filterRankingArchive(snapshot, { ...defaultFilters, includeTagIds: ['none'] }).map((item) => item.entityId)).toEqual(['preset']);
    expect(filterRankingArchive(snapshot, { ...defaultFilters, minTechScore: '1' }).map((item) => item.entityId)).toEqual(['no']);
  });
  it('preserves v2 top/bottom, v3 full/top_bottom and missing extrema without inventing them', () => {
    const entities = [entity('a', 1700)];
    const v2: PublicSeasonArchive = { schemaVersion: 2, season: base.season, generatedAt: base.generatedAt, entities, leaderboards: {
      strict: { queue: 'strict', total: 99, top: [{ entityType: 'data_card', entityId: 'a' }], bottom: [] },
      free: { queue: 'free', total: 0, top: [], bottom: [] },
    } };
    expect(deriveRankingArchiveSnapshot(v2, 'strict')).toMatchObject({ snapshotMode: 'top_bottom', totalEligible: 99, topCount: 1, bottomCount: 0 });
    expect(deriveRankingArchiveSnapshot(archive(entities), 'strict')).toMatchObject({ snapshotMode: 'full' });
    const v3: PublicSeasonArchive = { ...base, schemaVersion: 3, entities, snapshotPolicy: { mode: 'top_bottom', top: 100, bottom: 50 }, totalEligible: { strict: 10, free: 0 } };
    expect(deriveRankingArchiveSnapshot(v3, 'strict')).toMatchObject({ topCount: 10, bottomCount: 10, totalEligible: 10 });
    expect(filterRankingArchive(deriveRankingArchiveSnapshot(v2, 'strict'), defaultFilters)[0]).toMatchObject({ seasonPeak: null, seasonLow: null, seasonPeakTier: null });
    expect(deriveRankingArchiveSnapshot(v2, 'free').items).toEqual([]);
  });
  it('normalizes draft filters and uses only safe numeric wire values', () => {
    const filters = normalizeFilters({ ...defaultFilters, minRating: ' 1.9 ', includeTagIds: ['b', 'a', 'a'], minGames: 'NaN', maxGames: '9007199254740992' });
    expect(filters.includeTagIds).toEqual(['a', 'b']);
    expect(rankingTransportFilters(filters)).toMatchObject({ minRating: 1, minGames: null, maxGames: null });
  });
});
