import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/public-ranking.json';
import { PUBLIC_RANKING_BODY_BUDGETS, PublicRankingRequestSchema, parsePublicRankingResponse, publicRankingPath } from '../src/public-ranking';

const request = { kind: 'entityRating', entityType: 'data_card', entityId: 'public-card' } as const;
const body = fixture.responses.entityRating;
describe('current strict pivot rating is a fixed anonymous summary', () => {
  it('allows only a bounded data-card target, never caller-controlled queue or transport', () => {
    const parsed = PublicRankingRequestSchema.parse({ ...request, entityId: ' \ufeff旧 / ?&+%😀\n' });
    const url = new URL(publicRankingPath(parsed), 'https://example.test');
    expect(url.pathname).toBe('/api/arena/entity-rating');
    expect([...url.searchParams]).toEqual([['entityType', 'data_card'], ['entityId', '旧 / ?&+%😀'], ['queue', 'strict']]);
    expect(PUBLIC_RANKING_BODY_BUDGETS.entityRating).toBe(16 * 1024);
    for (const field of ['url', 'method', 'headers', 'path', 'body', 'queue', 'credentials', 'expectedUserId', 'seasonId', 'limit']) {
      expect(PublicRankingRequestSchema.safeParse({ ...request, [field]: 'forbidden' }).success).toBe(false);
    }
    for (const entityId of ['', ' \ufeff\n', '😀'.repeat(101)]) expect(PublicRankingRequestSchema.safeParse({ ...request, entityId }).success).toBe(false);
    expect(PublicRankingRequestSchema.safeParse({ ...request, entityId: '😀'.repeat(100) }).success).toBe(true);
    for (const entityType of ['preset', 'local', 'cache']) expect(PublicRankingRequestSchema.safeParse({ ...request, entityType }).success).toBe(false);
  });
  it('projects required handler facts without imposing an invented safe-integer cap', () => {
    expect(parsePublicRankingResponse(request, { kind: 'entityRating', data: { ...body, cookie: 'DROP', privateMetadata: 'DROP' } })).toEqual(body);
    for (const rating of [0, 1000, 2 ** 53, Number.MAX_VALUE]) {
      expect(parsePublicRankingResponse(request, { kind: 'entityRating', data: { ...body, rating, games: rating } })).toMatchObject({ rating, games: rating });
    }
    expect(parsePublicRankingResponse(request, { kind: 'entityRating', data: { ...body, found: false, rating: 1000, games: 0 } })).toMatchObject({ found: false, rating: 1000, games: 0 });
  });
  it('rejects wrong echoes, missing fields and malformed facts as a whole', () => {
    for (const [key, value] of [['success', false], ['queue', 'free'], ['entityType', 'preset'], ['entityId', 'other'], ['found', null], ['rating', -1], ['rating', 0.5], ['games', Infinity], ['games', null], ['games', '7']] as const) {
      expect(() => parsePublicRankingResponse(request, { kind: 'entityRating', data: { ...body, [key]: value } })).toThrow();
    }
    for (const key of Object.keys(body)) { const data: Record<string, unknown> = { ...body }; delete data[key]; expect(() => parsePublicRankingResponse(request, { kind: 'entityRating', data })).toThrow(); }
    expect(() => parsePublicRankingResponse(request, { kind: 'entityRating', data: Object.values(body) })).toThrow();
  });
});
