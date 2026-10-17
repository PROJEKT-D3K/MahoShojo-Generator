import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/public-ranking.json';
import { PUBLIC_RANKING_BODY_BUDGETS, PublicRankingRequestSchema, PublicRankingResponseSchema, parsePublicRankingResponse, publicRankingPath } from '../src/public-ranking';

describe('public ranking read boundary', () => {
  it('keeps all fixed paths, body budgets and public nested projections', () => {
    expect(PUBLIC_RANKING_BODY_BUDGETS).toEqual(fixture.budgets);
    for (const kind of ['leaderboard', 'search', 'tags', 'seasons', 'archive', 'ratingHistory', 'entityRating'] as const) {
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

describe('recent strict rating summary', () => {
  const request = { kind: 'ratingHistory', entityType: 'data_card', entityId: 'public-card' } as const;
  const body = fixture.responses.ratingHistory;
  it('normalizes only the target ID and sends a fixed strict route without season/limit/auth', () => {
    const parsed = PublicRankingRequestSchema.parse({ kind: 'ratingHistory', entityType: 'preset', entityId: ' \ufeff旧 / ?&+%😀.json\n' });
    const url = new URL(publicRankingPath(parsed), 'https://example.test');
    expect(url.pathname).toBe('/api/arena/entity-rating-history');
    expect([...url.searchParams]).toEqual([['entityType', 'preset'], ['entityId', '旧 / ?&+%😀.json'], ['queue', 'strict']]);
    for (const extra of ['queue', 'limit', 'seasonId', 'url', 'path', 'headers', 'method', 'credentials', 'expectedUserId']) {
      expect(PublicRankingRequestSchema.safeParse({ ...request, [extra]: 'forbidden' }).success).toBe(false);
    }
    expect(PublicRankingRequestSchema.safeParse({ ...request, entityId: ' \ufeff\n' }).success).toBe(false);
    expect(PublicRankingRequestSchema.safeParse({ ...request, entityType: 'local' }).success).toBe(false);
  });
  it('projects every public layer and preserves nullable, signed, zero and legacy string facts', () => {
    const output = parsePublicRankingResponse({ kind: 'ratingHistory', entityType: 'data_card', entityId: ' public-card ' }, { kind: 'ratingHistory', data: body });
    expect(JSON.stringify(output)).not.toContain('DROP');
    expect(output.items[0]?.appliedAt).toBeNull(); expect(output.items[0]?.initiator).toEqual({ userId: null, username: null });
    expect(output.items[2]).toMatchObject({ createdAt: 'legacy-date', delta: 0, afterRating: -10, initiator: { userId: -1 } });
    expect(parsePublicRankingResponse(request, { kind: 'ratingHistory', data: { ...body, items: [] } }).items).toEqual([]);
    expect(parsePublicRankingResponse(request, { kind: 'ratingHistory', data: { ...body, items: Array(10).fill(body.items[0]) } }).items).toHaveLength(10);
  });
  it('fails the whole read for mismatched identity, non-strict, overlong or malformed summaries', () => {
    const bad: unknown[] = [[], { ...body, success: false }, { ...body, entityType: 'preset' }, { ...body, entityId: 'another' },
      { ...body, queue: 'free' }, { ...body, items: Array(11).fill(body.items[0]) }, { ...body, items: [[]] }];
    for (const key of ['appliedAt', 'delta', 'afterRating', 'opponent', 'initiator'] as const) {
      const item: Record<string, unknown> = { ...body.items[0] }; delete item[key]; bad.push({ ...body, items: [item] });
    }
    for (const key of ['userId', 'username']) {
      const initiator: Record<string, unknown> = { ...body.items[0]!.initiator }; delete initiator[key];
      bad.push({ ...body, items: [{ ...body.items[0], initiator }] });
    }
    for (const key of ['delta', 'afterRating']) for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null]) bad.push({ ...body, items: [{ ...body.items[0], [key]: value }] });
    for (const result of ['constructor', '__proto__', 'invalid']) bad.push({ ...body, items: [{ ...body.items[0], result }] });
    for (const value of [[], null, { userId: 1.5, username: null }]) bad.push({ ...body, items: [{ ...body.items[0], initiator: value }] });
    bad.push({ ...body, items: [{ ...body.items[0], opponent: [] }] });
    for (const data of bad) expect(() => parsePublicRankingResponse(request, { kind: 'ratingHistory', data })).toThrow();
    expect(() => parsePublicRankingResponse(request, { kind: 'tags', data: fixture.responses.tags })).toThrow();
  });
});
