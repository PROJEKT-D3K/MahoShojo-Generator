import { z } from './zod';

/** Public read transport budgets, never a cap on server eligibility or historical records. */
export const PUBLIC_RANKING_BODY_BUDGETS = { leaderboard: 1024 * 1024, search: 256 * 1024, tags: 1024 * 1024, seasons: 256 * 1024, archive: 4 * 1024 * 1024 } as const;
const integer = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const text = z.string();
const nullableText = text.nullable();
const queue = z.enum(['strict', 'free']);
const entityType = z.enum(['data_card', 'preset']);
export const PublicRankingFiltersSchema = z.object({
  queue, sort: z.enum(['rating', 'tech']), order: z.enum(['desc', 'asc']), includePresets: z.boolean(),
  isNative: z.enum(['any', '1', '0']), includeTagIds: z.array(text.max(200)).max(100), excludeTagIds: z.array(text.max(200)).max(100),
  minRating: integer.nullable(), maxRating: integer.nullable(), minGames: integer.nullable(), maxGames: integer.nullable(),
  minTechScore: integer.nullable(), maxTechScore: integer.nullable(),
}).strict();
export type PublicRankingFilters = z.infer<typeof PublicRankingFiltersSchema>;
export const PublicRankingSeasonIdSchema = text.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/);
export const PublicRankingRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('leaderboard'), filters: PublicRankingFiltersSchema, offset: integer.min(0).max(300), limit: integer.min(1).max(100) }).strict(),
  z.object({ kind: z.literal('search'), filters: PublicRankingFiltersSchema, q: text.trim().min(1).max(80), limit: integer.min(1).max(20) }).strict(),
  z.object({ kind: z.literal('tags') }).strict(),
  z.object({ kind: z.literal('seasons') }).strict(),
  z.object({ kind: z.literal('archive'), seasonId: PublicRankingSeasonIdSchema }).strict(),
]);
export type PublicRankingRequest = z.infer<typeof PublicRankingRequestSchema>;
export const PublicRankingSeasonExtremeSchema = z.object({ rating: z.number(), games: z.number(), occurredAt: text, tier: z.enum(['无牌', '白牌', '字牌', '花牌', '权杖']) });
export type PublicRankingSeasonExtreme = z.infer<typeof PublicRankingSeasonExtremeSchema>;
export const PublicRankingItemSchema = z.object({
  rank: integer.min(0), entityType, entityId: text, displayName: text, authorName: nullableText,
  rating: z.number(), games: z.number(), wins: z.number(), losses: z.number(), draws: z.number(), tier: text,
  techScore: z.number().nullable(), techLevel: nullableText, isNative: z.boolean().nullable(), tagIds: z.array(text),
  ratingUpdatedAt: nullableText.optional(), seasonPeak: PublicRankingSeasonExtremeSchema.nullable().optional(),
  seasonPeakTier: nullableText.optional(), seasonLow: PublicRankingSeasonExtremeSchema.nullable().optional(),
});
export type PublicRankingItem = z.infer<typeof PublicRankingItemSchema>;
export const PublicRankingListSchema = z.object({ success: z.literal(true), items: z.array(PublicRankingItemSchema).max(100) });
export const PublicRankingTagsSchema = z.object({ success: z.literal(true), tags: z.array(z.object({
  id: text, name: text, description: nullableText, category: nullableText, scope: z.enum(['user', 'system', 'admin']), isActive: z.boolean(),
})) });
export type PublicRankingTag = z.infer<typeof PublicRankingTagsSchema>['tags'][number];
export const PublicSeasonSpecialRulesSchema = z.object({
  mode: z.enum(['classic', 'kizuna', 'daily', 'scenario']).optional(), storyGuidance: text.optional(), scenarioPresetFilename: text.optional(),
  questionnaireLoreAllowed: z.boolean().optional(), questionnaireLorePresetIds: z.array(text).optional(),
});
const seasonFacts = {
  id: PublicRankingSeasonIdSchema, name: text, startsAt: text, endsAt: nullableText.optional(), description: text,
  specialRules: PublicSeasonSpecialRulesSchema.nullable().optional(),
};
export const PublicSeasonMetaSchema = z.object({ ...seasonFacts, status: z.enum(['current', 'history']), archivedAt: nullableText.optional() });
export type PublicSeasonMeta = z.infer<typeof PublicSeasonMetaSchema>;
export const PublicSeasonsSchema = z.object({ schemaVersion: z.literal(1), seasons: z.array(PublicSeasonMetaSchema) });
export type PublicSeasonsConfig = z.infer<typeof PublicSeasonsSchema>;
export const PublicSeasonQueueSchema = z.object({
  rating: z.number(), games: z.number(), wins: z.number(), losses: z.number(), draws: z.number(), ratingUpdatedAt: nullableText,
  seasonPeakRating: z.number().nullable().optional(), seasonPeakGames: z.number().nullable().optional(), seasonPeakAt: nullableText.optional(),
  seasonPeakTier: nullableText.optional(), seasonLowRating: z.number().nullable().optional(), seasonLowGames: z.number().nullable().optional(), seasonLowAt: nullableText.optional(),
});
export const PublicSeasonEntitySchema = z.object({
  entityType, entityId: text, displayName: text, authorName: nullableText.optional(), techScore: z.number().nullable(), techLevel: nullableText,
  isNative: z.boolean().nullable(), tagIds: z.array(text), queues: z.object({ strict: PublicSeasonQueueSchema.nullable().optional(), free: PublicSeasonQueueSchema.nullable().optional() }),
});
const ref = z.object({ entityType, entityId: text });
const board = z.object({ queue, total: integer.min(0), top: z.array(ref), bottom: z.array(ref) });
const archiveFacts = { generatedAt: text, season: z.object(seasonFacts), entities: z.array(PublicSeasonEntitySchema) };
export const PublicSeasonArchiveSchema = z.discriminatedUnion('schemaVersion', [
  z.object({ schemaVersion: z.literal(2), ...archiveFacts, leaderboards: z.object({ strict: board, free: board }) }),
  z.object({ schemaVersion: z.literal(3), ...archiveFacts, snapshotPolicy: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('full') }), z.object({ mode: z.literal('top_bottom'), top: integer.min(0), bottom: integer.min(0) }),
  ]), totalEligible: z.object({ strict: integer.min(0), free: integer.min(0) }) }),
]);
export type PublicSeasonArchive = z.infer<typeof PublicSeasonArchiveSchema>;
export const PublicRankingResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('leaderboard'), data: PublicRankingListSchema }).strict(),
  z.object({ kind: z.literal('search'), data: PublicRankingListSchema.extend({ items: z.array(PublicRankingItemSchema).max(20) }) }).strict(),
  z.object({ kind: z.literal('tags'), data: PublicRankingTagsSchema }).strict(),
  z.object({ kind: z.literal('seasons'), data: PublicSeasonsSchema }).strict(),
  z.object({ kind: z.literal('archive'), data: PublicSeasonArchiveSchema }).strict(),
]);
export type PublicRankingResponse = z.infer<typeof PublicRankingResponseSchema>;
export type PublicRankingKind = PublicRankingRequest['kind'];
export type PublicRankingDataMap = {
  leaderboard: z.infer<typeof PublicRankingListSchema>; search: z.infer<typeof PublicRankingListSchema>;
  tags: z.infer<typeof PublicRankingTagsSchema>; seasons: PublicSeasonsConfig; archive: PublicSeasonArchive;
};
export type PublicRankingData<K extends PublicRankingKind> = PublicRankingDataMap[K];

/** Fixed public paths. Hosts own transport, cache lifetime and cancellation. */
export function publicRankingPath(request: PublicRankingRequest): string {
  if (request.kind === 'tags') return '/api/tags';
  if (request.kind === 'seasons') return '/config/seasons.json';
  if (request.kind === 'archive') return `/data/seasons/archive_${PublicRankingSeasonIdSchema.parse(request.seasonId)}.json`;
  const f = request.filters;
  const params = new URLSearchParams({ queue: f.queue, sort: f.sort, order: f.order, includePresets: f.includePresets ? '1' : '0', isNative: f.isNative, limit: String(request.limit) });
  if (request.kind === 'search') params.set('q', request.q);
  else params.set('offset', String(request.offset));
  if (f.includeTagIds.length) params.set('tagIds', f.includeTagIds.join(','));
  if (f.excludeTagIds.length) params.set('excludeTagIds', f.excludeTagIds.join(','));
  for (const name of ['minRating', 'maxRating', 'minGames', 'maxGames', 'minTechScore', 'maxTechScore'] as const) {
    if (f[name] !== null) params.set(name, String(f[name]));
  }
  return `/api/arena/leaderboard${request.kind === 'search' ? '/search' : ''}?${params.toString()}`;
}

/** The echoed kind and returned ranks belong to this exact read, never an inferred total. */
export function parsePublicRankingResponse<R extends PublicRankingRequest>(request: R, raw: unknown): PublicRankingData<R['kind']> {
  const result = PublicRankingResponseSchema.parse(raw);
  if (result.kind !== request.kind
    || (request.kind === 'archive' && result.kind === 'archive' && result.data.season.id !== request.seasonId)
    || (request.kind === 'leaderboard' && result.kind === 'leaderboard' && (result.data.items.length > Math.min(request.limit, 300 - request.offset)
      || result.data.items.some((item, index) => item.rank !== request.offset + index + 1)))
    || (request.kind === 'search' && result.kind === 'search' && (result.data.items.length > request.limit || result.data.items.some((item) => item.rank !== 0)))) {
    throw new Error('排行榜返回协议或目标不匹配');
  }
  return result.data as PublicRankingData<R['kind']>;
}
