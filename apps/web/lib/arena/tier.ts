export * from '@mahoshojo/domain/arena-tier';
import { ARENA_PLACEMENT_GAMES, ARENA_SCEPTER_MIN_RATING, ARENA_QUEEN_MIN_SCEPTER_COUNT, type ArenaQueue, type ArenaEntityRef } from '@mahoshojo/domain/arena-tier';

type ListPublicScepterEntities = (
  queue: ArenaQueue,
  options: { minGames: number; minRating: number; limit: number },
) => Promise<Array<ArenaEntityRef | { entityType: unknown; entityId: unknown }>>;

const QUEEN_CACHE_TTL_MS = 30_000;
const queenCache = new Map<ArenaQueue, { value: ArenaEntityRef | null; expiresAt: number }>();

export async function queryArenaPublicQueenEntity(
  listPublicScepterEntities: ListPublicScepterEntities,
  queue: ArenaQueue,
): Promise<ArenaEntityRef | null> {
  const now = Date.now();
  const cached = queenCache.get(queue);
  if (cached && cached.expiresAt > now) return cached.value;

  const rows = await listPublicScepterEntities(queue, {
    minGames: ARENA_PLACEMENT_GAMES,
    minRating: ARENA_SCEPTER_MIN_RATING,
    limit: ARENA_QUEEN_MIN_SCEPTER_COUNT,
  });
  if (rows.length < ARENA_QUEEN_MIN_SCEPTER_COUNT) {
    queenCache.set(queue, { value: null, expiresAt: now + QUEEN_CACHE_TTL_MS });
    return null;
  }

  const row = rows[0];
  if (!row) {
    queenCache.set(queue, { value: null, expiresAt: now + QUEEN_CACHE_TTL_MS });
    return null;
  }

  const entityType = row.entityType === 'data_card' || row.entityType === 'preset' ? row.entityType : null;
  const entityId = typeof row.entityId === 'string' ? row.entityId.trim() : '';
  if (!entityType || !entityId) {
    queenCache.set(queue, { value: null, expiresAt: now + QUEEN_CACHE_TTL_MS });
    return null;
  }

  const value: ArenaEntityRef = { entityType, entityId };
  queenCache.set(queue, { value, expiresAt: now + QUEEN_CACHE_TTL_MS });
  return value;
}
