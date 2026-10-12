import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/public-ranking.json';
import { PUBLIC_RANKING_BODY_BUDGETS, PublicRankingRequestSchema, PublicRankingResponseSchema, publicRankingPath } from '../src/public-ranking';

describe('public ranking read boundary', () => {
  it('keeps all five fixed paths, body budgets and public nested projections', () => {
    expect(PUBLIC_RANKING_BODY_BUDGETS).toEqual(fixture.budgets);
    for (const kind of ['leaderboard', 'search', 'tags', 'seasons', 'archive'] as const) {
      const request = PublicRankingRequestSchema.parse(fixture.requests[kind]);
      expect(publicRankingPath(request).split('?')[0]).toBe(fixture.paths[kind]);
      const wire = PublicRankingResponseSchema.parse({ kind, data: fixture.responses[kind] });
      expect(JSON.stringify(wire)).not.toContain('DROP');
    }
    const request = PublicRankingRequestSchema.parse(fixture.requests.search);
    expect(new URL(publicRankingPath(request), 'https://example.test').searchParams.get('q')).toBe(fixture.requests.search.q);
  });
  it.each([
    [], ['tags'], { kind: 'tags', url: 'https://evil.test' }, { kind: 'tags', headers: {} },
    { ...fixture.requests.leaderboard, filters: [] }, { ...fixture.requests.leaderboard, filters: { ...fixture.requests.leaderboard.filters, expectedUserId: 42 } },
    { ...fixture.requests.leaderboard, offset: 301 }, { ...fixture.requests.leaderboard, limit: 101 },
    { ...fixture.requests.search, limit: 21 }, { ...fixture.requests.search, q: '😀'.repeat(41) },
    { ...fixture.requests.search, q: '   ' }, { kind: 'archive', seasonId: '../S3' }, { kind: 'archive', seasonId: '%2fS3' },
    { ...fixture.requests.leaderboard, filters: { ...fixture.requests.leaderboard.filters, minRating: Number.MAX_SAFE_INTEGER + 1 } },
    { ...fixture.requests.leaderboard, filters: { ...fixture.requests.leaderboard.filters, minRating: 1.5 } },
  ])('rejects nonobjects, extras, escaped routes and unsafe integers: %j', (value) => {
    expect(PublicRankingRequestSchema.safeParse(value).success).toBe(false);
  });
  it('retains null/absent facts and rejects positional objects at every public nested layer', () => {
    const wire = PublicRankingResponseSchema.parse({ kind: 'seasons', data: fixture.responses.seasons });
    expect(wire.kind === 'seasons' && wire.data.seasons[0]).not.toHaveProperty('endsAt');
    for (const body of [[], { ...fixture.responses.archive, season: [] }, { ...fixture.responses.archive, entities: [[]] },
      { ...fixture.responses.archive, snapshotPolicy: [] }, { ...fixture.responses.archive, entities: [{ ...fixture.responses.archive.entities[0], queues: { strict: [] } }] }]) {
      expect(PublicRankingResponseSchema.safeParse({ kind: 'archive', data: body }).success).toBe(false);
    }
  });
});
