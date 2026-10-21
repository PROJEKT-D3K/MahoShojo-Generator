import { z } from '../src/zod';
import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/public-ranking.json';
import { PUBLIC_RANKING_BODY_BUDGETS, PublicRankingRequestSchema, parsePublicRankingResponse, publicRankingPath } from '../src/public-ranking';

const request = { kind: 'entityRating', entityType: 'data_card', entityId: 'public-card' } as const;
const body = fixture.responses.entityRating;
describe('current entity rating is a fixed anonymous summary', () => {
  it('accepts old missing/null tier, validates canonical new tiers, and preserves the old decoder projection', () => {
    // 冻结新增字段之前的普通 object 解码形状，不用新版 schema 模拟旧客户端。
    const oldDecoder = z.object({ success: z.literal(true), queue: z.enum(['strict', 'free']), entityType: z.enum(['data_card', 'preset']), entityId: z.string(), found: z.boolean(), rating: z.number().nonnegative().refine(Number.isInteger), games: z.number().nonnegative().refine(Number.isInteger) });
    expect(oldDecoder.parse({ ...body, tier: '女王' })).toEqual(body);
    expect(parsePublicRankingResponse(request, { kind: 'entityRating', data: body })).toEqual(body);
    for (const tier of [null, '无牌', '白牌', '字牌', '花牌', '权杖', '女王']) {
      expect(parsePublicRankingResponse(request, { kind: 'entityRating', data: { ...body, tier } })).toMatchObject({ tier });
    }
    for (const tier of ['Queen', 'unknown', '', 1, {}, []]) expect(() => parsePublicRankingResponse(request, { kind: 'entityRating', data: { ...body, tier } })).toThrow();
  });
  it('keeps omitted queue compatible with strict pivot and rejects unbounded targets or transport', () => {
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
    for (const entityType of ['local', 'cache', 'constructor']) expect(PublicRankingRequestSchema.safeParse({ ...request, entityType }).success).toBe(false);
  });
  it.each(fixture.entityRatingTargets)('reads only the matching fixed entity and queue: $request.entityType/$request.queue', ({ request, response }) => {
    const parsed = PublicRankingRequestSchema.parse(request);
    const url = new URL(publicRankingPath(parsed), 'https://example.test');
    expect(url.pathname).toBe('/api/arena/entity-rating');
    expect([...url.searchParams]).toEqual([['entityType', request.entityType], ['entityId', request.entityId], ['queue', request.queue]]);
    expect(parsePublicRankingResponse(parsed, { kind: 'entityRating', data: response })).toEqual(response);
    for (const [key, value] of [['queue', request.queue === 'strict' ? 'free' : 'strict'], ['entityType', request.entityType === 'preset' ? 'data_card' : 'preset'], ['entityId', 'other']] as const) {
      expect(() => parsePublicRankingResponse(parsed, { kind: 'entityRating', data: { ...response, [key]: value } })).toThrow();
    }
    expect(parsePublicRankingResponse(parsed, { kind: 'entityRating', data: { ...response, found: false, rating: 1000, games: 0 } })).toMatchObject({ found: false, rating: 1000, games: 0 });
  });
  it('rejects non-enum queues instead of treating them as strict', () => {
    for (const queue of ['unknown', 'constructor', '', null, [], 0]) expect(PublicRankingRequestSchema.safeParse({ ...request, queue }).success).toBe(false);
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
