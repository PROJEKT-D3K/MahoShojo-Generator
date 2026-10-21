import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/public-ranking.json';
import { PUBLIC_RANKING_BODY_BUDGETS, PublicRankingRequestSchema } from '@mahoshojo/contracts/public-ranking';
const mocks = vi.hoisted(() => ({ row: vi.fn(), queen: vi.fn() }));
vi.mock('@/lib/db/repositories/data-card-meta', () => ({ queryArenaPublicQueenEntityByQueue: mocks.queen }));
import { computeArenaBaseTier } from '@mahoshojo/domain/arena-tier';
vi.mock('@/lib/db/drizzle', () => ({ getDrizzleDbFromRuntime: () => ({ synthetic: true }) }));
vi.mock('@/lib/db/repositories/arena-read', () => ({ getArenaRatingByEntity: mocks.row }));
import handler from '@/app/api/arena/entity-rating/handler';
import { readWebRanking } from '@/lib/arena/read-public-ranking';
const request = { kind: 'entityRating', entityType: 'data_card', entityId: ' public-card ' } as const;
beforeEach(() => mocks.queen.mockResolvedValue(null));
afterEach(() => { vi.unstubAllGlobals(); mocks.row.mockReset(); mocks.queen.mockReset(); });
describe('existing entity-rating handler and public reader compatibility', () => {
  it.each([
    ['found', { rating: 1200, games: 7 }, { found: true, rating: 1200, games: 7 }],
    ['missing', null, { found: false, rating: 1000, games: 0 }],
    ['zero', { rating: -10, games: -1 }, { found: true, rating: 0, games: 0 }],
    ['fraction', { rating: 1200.9, games: 7.8 }, { found: true, rating: 1200, games: 7 }],
    ['large', { rating: 1.2345678901234567e100, games: Number.MAX_VALUE }, { found: true, rating: 1.2345678901234567e100, games: Number.MAX_VALUE }],
  ])('reads the real handler %s wire without changing its policies', async (name, row, facts) => {
    mocks.row.mockResolvedValue(row);
    let emitted: unknown;
    vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
      expect(options).toMatchObject({ credentials: 'omit', redirect: 'error' });
      const response = await handler(new Request(`https://example.test${path}`) as NextRequest);
      emitted = await response.clone().json();
      return response;
    }));
    const result = await readWebRanking(request);
    expect(result).toEqual({ success: true, queue: 'strict', entityType: 'data_card', entityId: 'public-card', ...facts, ...(facts.found ? { tier: computeArenaBaseTier(facts.rating, facts.games) } : {}) });
    expect(mocks.row).toHaveBeenCalledWith({ synthetic: true }, 'strict', 'data_card', 'public-card');
    if (name === 'found') expect(result).toMatchObject(fixture.responses.entityRating);
    const directory = process.env.PUBLIC_RANKING_HANDLER_WIRE_DIR;
    if (directory) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, `${name}.json`), JSON.stringify(emitted)); }
  });
  it.each(fixture.entityRatingTargets)('preserves the existing handler target: $request.entityType/$request.queue', async ({ request, response: expected }) => {
    mocks.row.mockResolvedValue({ rating: expected.rating, games: expected.games });
    let emitted: unknown;
    vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
      expect(options).toMatchObject({ credentials: 'omit', redirect: 'error' });
      const response = await handler(new Request(`https://example.test${path}`) as NextRequest);
      emitted = await response.clone().json();
      return response;
    }));
    await expect(readWebRanking(PublicRankingRequestSchema.parse(request))).resolves.toEqual({ ...expected, tier: computeArenaBaseTier(expected.rating, expected.games) });
    expect(mocks.row).toHaveBeenCalledWith({ synthetic: true }, request.queue, request.entityType, request.entityId);
    const directory = process.env.PUBLIC_RANKING_HANDLER_WIRE_DIR;
    if (directory) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, `${request.entityType}-${request.queue}.json`), JSON.stringify(emitted)); }
  });
  it.each([
    [700, 8, '无牌'], [1600, 4, '无牌'], [800, 5, '白牌'], [1000, 5, '字牌'], [1200, 5, '花牌'],
  ] as const)('基础段位 %s/%s 不依赖女王查询', async (rating, games, tier) => {
    mocks.row.mockResolvedValue({ rating, games });
    mocks.queen.mockRejectedValue(new Error('must not query Queen'));
    const response = await handler(new Request('https://example.test/api/arena/entity-rating?entityType=data_card&entityId=public-card') as NextRequest);
    expect(await response.json()).toMatchObject({ success: true, found: true, rating, games, tier });
    expect(mocks.queen).not.toHaveBeenCalled();
  });
  it.each(['queen', 'nonqueen', 'unknown'] as const)('emits %s tier wire for the production Native reader', async name => {
    mocks.row.mockResolvedValue({ rating: 1600, games: 8 });
    if (name === 'unknown') mocks.queen.mockRejectedValue(new Error('synthetic unavailable'));
    else mocks.queen.mockResolvedValue(name === 'queen' ? { entityType: 'data_card', entityId: 'public-card' } : null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await handler(new Request('https://example.test/api/arena/entity-rating?entityType=data_card&entityId=public-card') as NextRequest);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, rating: 1600, games: 8, found: true });
    if (name === 'unknown') expect(body).not.toHaveProperty('tier');
    else expect(body.tier).toBe(name === 'queen' ? '女王' : '权杖');
    const directory = process.env.PUBLIC_RANKING_HANDLER_WIRE_DIR;
    if (directory) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, `${name}.json`), JSON.stringify(body)); }
    warn.mockRestore();
  });
  it.each(fixture.entityRatingTargets)('returns authoritative Queen only for the exact $request.entityType/$request.queue', async ({ request }) => {
    mocks.row.mockResolvedValue({ rating: 1600, games: 8 });
    const get = async () => (await handler(new Request(`https://example.test/api/arena/entity-rating?entityType=${request.entityType}&entityId=${request.entityId}&queue=${request.queue}`) as NextRequest)).json();
    mocks.queen.mockResolvedValue({ entityType: request.entityType, entityId: request.entityId });
    expect(await get()).toMatchObject({ tier: '女王', rating: 1600, games: 8 });
    expect(mocks.queen).toHaveBeenLastCalledWith({ synthetic: true }, request.queue);
    mocks.queen.mockResolvedValue({ entityType: request.entityType, entityId: 'another' });
    expect(await get()).toMatchObject({ tier: '权杖' });
    // helper 返回 null 包括全局权杖人数不足三人，不猜测分页结果。
    mocks.queen.mockResolvedValue(null);
    expect(await get()).toMatchObject({ tier: '权杖' });
    mocks.queen.mockRejectedValue(new Error('synthetic Queen query failure'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failedTier = await get();
    expect(failedTier).toMatchObject({ success: true, found: true, rating: 1600, games: 8 });
    expect(failedTier).not.toHaveProperty('tier');
    warn.mockRestore();
    mocks.row.mockResolvedValue(null); mocks.queen.mockClear();
    expect(await get()).toMatchObject({ found: false, rating: 1000, games: 0 });
    expect(mocks.queen).not.toHaveBeenCalled();
  });
  it('applies the shared streamed budget and rejects identity substitution', async () => {
    expect(PublicRankingRequestSchema.safeParse(request).success).toBe(true);
    const budget = PUBLIC_RANKING_BODY_BUDGETS.entityRating;
    const bytes = new TextEncoder().encode(JSON.stringify(fixture.responses.entityRating));
    const exact = new Uint8Array(budget).fill(32); exact.set(bytes);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(exact)); vi.stubGlobal('fetch', fetcher);
    await expect(readWebRanking(request)).resolves.toEqual(fixture.responses.entityRating);
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(exact); controller.enqueue(new Uint8Array([32])); controller.close(); } })));
    await expect(readWebRanking(request)).rejects.toThrow('排行榜响应过大');
    fetcher.mockResolvedValueOnce(Response.json({ ...fixture.responses.entityRating, entityId: 'other' }));
    await expect(readWebRanking(request)).rejects.toThrow('排行榜响应协议无效');
  });
});
