import type { PublicRankingItem as LeaderboardItem, PublicSeasonArchive as SeasonArchive, PublicSeasonMeta as SeasonMeta, PublicSeasonsConfig as SeasonsConfig, PublicRankingFilters } from '@mahoshojo/contracts/public-ranking';
import { ARENA_QUEEN_MIN_SCEPTER_COUNT, applyQueenTier, computeArenaBaseTier, isArenaScepterTier } from './arena-tier';
import { buildStrictLeaderboardSeasonExtrema } from './ranking-season-extrema';

type Queue = 'strict' | 'free';
type Sort = 'rating' | 'tech';
type SortOrder = 'desc' | 'asc';
type NativeFilter = 'any' | '1' | '0';

export type RankingFilters = {
  queue: Queue;
  sort: Sort;
  order: SortOrder;
  includePresets: boolean;
  isNative: NativeFilter;
  includeTagIds: string[];
  excludeTagIds: string[];
  minRating: string;
  maxRating: string;
  minGames: string;
  maxGames: string;
  minTechScore: string;
  maxTechScore: string;
};

type HistoryBaseItem = Omit<LeaderboardItem, 'rank' | 'tier'>;

const buildRowKey = (entityType: LeaderboardItem['entityType'], entityId: string): string => `${entityType}:${entityId}`;

const compareQueenCandidate = (a: HistoryBaseItem, b: HistoryBaseItem): number => {
  if (a.rating !== b.rating) return a.rating > b.rating ? -1 : 1;
  if (a.games !== b.games) return a.games > b.games ? -1 : 1;

  const aUpdated = typeof a.ratingUpdatedAt === 'string' ? a.ratingUpdatedAt : '';
  const bUpdated = typeof b.ratingUpdatedAt === 'string' ? b.ratingUpdatedAt : '';
  if (aUpdated !== bUpdated) return aUpdated > bUpdated ? -1 : 1;

  if (a.entityType !== b.entityType) return a.entityType.localeCompare(b.entityType);
  if (a.entityId !== b.entityId) return a.entityId.localeCompare(b.entityId);
  return 0;
};

const deriveArchiveQueenKey = (items: HistoryBaseItem[]): string | null => {
  const candidates = items.filter((item) => isArenaScepterTier(item.rating, item.games));
  if (candidates.length < ARENA_QUEEN_MIN_SCEPTER_COUNT) return null;

  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const next = candidates[i];
    if (next && compareQueenCandidate(next, best) < 0) best = next;
  }

  return buildRowKey(best.entityType, best.entityId);
};

export const defaultFilters: RankingFilters = {
  queue: 'strict',
  sort: 'rating',
  order: 'desc',
  includePresets: true,
  isNative: 'any',
  includeTagIds: [],
  excludeTagIds: [],
  minRating: '',
  maxRating: '',
  minGames: '',
  maxGames: '',
  minTechScore: '',
  maxTechScore: '',
};

export const normalizeFilters = (filters: RankingFilters): RankingFilters => ({
  ...filters,
  order: filters.order === 'asc' ? 'asc' : 'desc',
  includeTagIds: Array.from(new Set(filters.includeTagIds)).sort(),
  excludeTagIds: Array.from(new Set(filters.excludeTagIds)).sort(),
  minRating: filters.minRating.trim(),
  maxRating: filters.maxRating.trim(),
  minGames: filters.minGames.trim(),
  maxGames: filters.maxGames.trim(),
  minTechScore: filters.minTechScore.trim(),
  maxTechScore: filters.maxTechScore.trim(),
});

export const filtersKey = (filters: RankingFilters) => JSON.stringify(filters);

const parseOptionalInt = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const result = Math.floor(parsed);
  return Number.isSafeInteger(result) ? result : null;
};

export const LIVE_LEADERBOARD_TOP_RANK_LIMIT = 300;

export const formatBattleModeLabel = (mode: string): string => {
  const normalized = mode.trim();
  const map: Record<string, string> = {
    classic: '经典',
    scenario: '情景',
    daily: '日常',
    kizuna: '羁绊',
  };
  return map[normalized] ?? normalized;
};


export function deriveRankingArchiveSnapshot(data: SeasonArchive, queue: Queue) {
    const entities = Array.isArray(data.entities) ? data.entities : [];

    const items: HistoryBaseItem[] = [];
    for (const entity of entities) {
      if (!entity) continue;
      const entityType = entity.entityType === 'preset' ? 'preset' : 'data_card';
      const entityId = typeof entity.entityId === 'string' ? entity.entityId : '';
      if (!entityId) continue;

      const snapshot = queue === 'free' ? entity.queues?.free : entity.queues?.strict;
      if (!snapshot) continue;
      const extrema = queue === 'strict' ? buildStrictLeaderboardSeasonExtrema('strict', snapshot) : null;

      items.push({
        entityType,
        entityId,
        displayName: entity.displayName ?? entityId,
        authorName: typeof entity.authorName === 'string' ? entity.authorName : null,
        rating: typeof snapshot.rating === 'number' && Number.isFinite(snapshot.rating) ? snapshot.rating : 0,
        games: typeof snapshot.games === 'number' && Number.isFinite(snapshot.games) ? snapshot.games : 0,
        wins: typeof snapshot.wins === 'number' && Number.isFinite(snapshot.wins) ? snapshot.wins : 0,
        losses: typeof snapshot.losses === 'number' && Number.isFinite(snapshot.losses) ? snapshot.losses : 0,
        draws: typeof snapshot.draws === 'number' && Number.isFinite(snapshot.draws) ? snapshot.draws : 0,
        techScore: entity.techScore,
        techLevel: entity.techLevel,
        isNative: entity.isNative,
        tagIds: Array.isArray(entity.tagIds) ? entity.tagIds : [],
        ratingUpdatedAt: typeof snapshot.ratingUpdatedAt === 'string' ? snapshot.ratingUpdatedAt : null,
        seasonPeak: queue === 'strict' ? extrema?.seasonPeak ?? null : null,
        seasonPeakTier: queue === 'strict' ? extrema?.seasonPeakTier ?? null : null,
        seasonLow: queue === 'strict' ? extrema?.seasonLow ?? null : null,
      });
    }

    const queenKey = deriveArchiveQueenKey(items);

    const totalEligible = (() => {
      if (data.schemaVersion === 3) {
        const raw = queue === 'free' ? data.totalEligible?.free : data.totalEligible?.strict;
        return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
      }
      const board = queue === 'free' ? data.leaderboards?.free : data.leaderboards?.strict;
      const raw = board?.total;
      return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    })();

    const { topCount, bottomCount, snapshotMode } = (() => {
      if (data.schemaVersion === 2) {
        const board = queue === 'free' ? data.leaderboards?.free : data.leaderboards?.strict;
        return {
          snapshotMode: 'top_bottom' as const,
          topCount: Array.isArray(board?.top) ? board.top.length : 0,
          bottomCount: Array.isArray(board?.bottom) ? board.bottom.length : 0,
        };
      }

      const policy = data.snapshotPolicy;
      if (policy?.mode === 'top_bottom') {
        return {
          snapshotMode: 'top_bottom' as const,
          topCount: Math.min(Math.max(0, Math.floor(policy.top)), totalEligible),
          bottomCount: Math.min(Math.max(0, Math.floor(policy.bottom)), totalEligible),
        };
      }

      return { snapshotMode: 'full' as const, topCount: 0, bottomCount: 0 };
    })();

    return { totalEligible, topCount, bottomCount, items, queenKey, snapshotMode };
}

export function filterRankingArchive(historySnapshot: ReturnType<typeof deriveRankingArchiveSnapshot> | null, appliedFilters: RankingFilters): LeaderboardItem[] {
    const list = historySnapshot?.items ?? [];
    const queenKey = historySnapshot?.queenKey ?? null;
    const minRating = parseOptionalInt(appliedFilters.minRating);
    const maxRating = parseOptionalInt(appliedFilters.maxRating);
    const minGames = parseOptionalInt(appliedFilters.minGames);
    const maxGames = parseOptionalInt(appliedFilters.maxGames);
    const minTechScore = parseOptionalInt(appliedFilters.minTechScore);
    const maxTechScore = parseOptionalInt(appliedFilters.maxTechScore);
    const includeTags = new Set(appliedFilters.includeTagIds);
    const excludeTags = new Set(appliedFilters.excludeTagIds);

    const filtered = list.filter((item) => {
      if (!appliedFilters.includePresets && item.entityType === 'preset') return false;

      if (appliedFilters.isNative === '1') {
        if (item.entityType !== 'data_card') return false;
        if (item.isNative !== true) return false;
      } else if (appliedFilters.isNative === '0') {
        if (item.entityType !== 'data_card') return false;
        if (item.isNative !== false) return false;
      }

      if (includeTags.size > 0 && item.entityType === 'data_card') {
        const hasAny = item.tagIds.some((id) => includeTags.has(id));
        if (!hasAny) return false;
      }
      if (includeTags.size > 0 && item.entityType === 'preset') {
        // 与线上规则对齐：预设不受标签筛选影响
      }

      if (excludeTags.size > 0 && item.entityType === 'data_card') {
        const hasExcluded = item.tagIds.some((id) => excludeTags.has(id));
        if (hasExcluded) return false;
      }

      if (minRating != null && item.rating < minRating) return false;
      if (maxRating != null && item.rating > maxRating) return false;
      if (minGames != null && item.games < minGames) return false;
      if (maxGames != null && item.games > maxGames) return false;

      if (minTechScore != null || maxTechScore != null) {
        if (item.entityType !== 'data_card') return false;
        if (typeof item.techScore !== 'number' || !Number.isFinite(item.techScore)) return false;
        if (minTechScore != null && item.techScore < minTechScore) return false;
        if (maxTechScore != null && item.techScore > maxTechScore) return false;
      }

      return true;
    });

    const order = appliedFilters.order === 'asc' ? 'asc' : 'desc';
    const sort = appliedFilters.sort === 'tech' ? 'tech' : 'rating';

    const compareText = (a: string, b: string) => a.localeCompare(b, 'zh-CN');
    const compareNumber = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);

    filtered.sort((a, b) => {
      if (sort === 'tech') {
        const aNull = a.techScore == null;
        const bNull = b.techScore == null;
        if (aNull !== bNull) return aNull ? 1 : -1;

        if (a.techScore != null && b.techScore != null) {
          const tech = compareNumber(a.techScore, b.techScore);
          if (tech !== 0) return order === 'asc' ? tech : -tech;
        }

        const rating = compareNumber(a.rating, b.rating);
        if (rating !== 0) return -rating;
        const games = compareNumber(a.games, b.games);
        if (games !== 0) return -games;
      } else {
        const rating = compareNumber(a.rating, b.rating);
        if (rating !== 0) return order === 'asc' ? rating : -rating;
        const games = compareNumber(a.games, b.games);
        if (games !== 0) return -games;
      }

      const aUpdated = typeof a.ratingUpdatedAt === 'string' ? a.ratingUpdatedAt : '';
      const bUpdated = typeof b.ratingUpdatedAt === 'string' ? b.ratingUpdatedAt : '';
      if (aUpdated !== bUpdated) return bUpdated.localeCompare(aUpdated);

      if (a.entityType !== b.entityType) return compareText(a.entityType, b.entityType);
      if (a.entityId !== b.entityId) return compareText(a.entityId, b.entityId);
      return 0;
    });

    return filtered.map((item, index) => {
      const baseTier = computeArenaBaseTier(item.rating, item.games);
      const isQueen = queenKey === buildRowKey(item.entityType, item.entityId);
      const tier = applyQueenTier(baseTier, isQueen);
      return {
        ...item,
        rank: index + 1,
        tier,
      };
    });
}

export const isSafeSeasonId = (value: string): boolean => {
  if (typeof value !== 'string') return false;
  const id = value.trim();
  if (!id) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(id);
};

export const getCurrentSeason = (config: SeasonsConfig | null | undefined): SeasonMeta | null => {
  const seasons = config?.seasons;
  if (!Array.isArray(seasons)) return null;
  return seasons.find((s) => s.status === 'current') ?? null;
};

export const formatSeasonTitle = (season: Pick<SeasonMeta, 'id' | 'name'>): string => {
  const name = typeof season.name === 'string' ? season.name.trim() : '';
  const id = typeof season.id === 'string' ? season.id.trim() : '';
  if (!name) return id;
  if (!id) return name;
  if (name.includes(id)) return name;
  return `${name}（${id}）`;
};

export const formatYmdSlash = (ymd: string): string => {
  const trimmed = typeof ymd === 'string' ? ymd.trim() : '';
  if (!trimmed) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed.replace(/-/g, '/');
  return trimmed;
};

export const seasonArchiveUrl = (seasonId: string): string => {
  return `/data/seasons/archive_${encodeURIComponent(seasonId)}.json`;
};

export function rankingTransportFilters(filters: RankingFilters): PublicRankingFilters {
  return { ...filters, minRating: parseOptionalInt(filters.minRating), maxRating: parseOptionalInt(filters.maxRating),
    minGames: parseOptionalInt(filters.minGames), maxGames: parseOptionalInt(filters.maxGames),
    minTechScore: parseOptionalInt(filters.minTechScore), maxTechScore: parseOptionalInt(filters.maxTechScore) };
}
