'use client';

import { useQuery } from '@tanstack/react-query';
import type { RankingQueryHook, RankingRankCache } from '@mahoshojo/ui-web/ranking';
import { readWebRanking } from '@/lib/arena/read-public-ranking';
import { getArenaCachedRank, isCanonicalPublicLeaderboardQuery, upsertArenaRankCacheFromLeaderboard } from '@/lib/arena/rank-cache';

const keys = { seasons: 'seasonsConfig', tags: 'tags', leaderboard: 'arenaLeaderboard', search: 'arenaLeaderboardSearch', archive: 'seasonArchive', ratingHistory: 'entityRatingHistory', entityRating: 'entityRating' } as const;
export const useWebRankingQuery: RankingQueryHook = ({ request, enabled, staleTime }) => useQuery({
  queryKey: [keys[request.kind], request],
  queryFn: ({ signal }) => readWebRanking(request, signal),
  enabled, staleTime,
});
export const webRankingCache: RankingRankCache = {
  isCanonicalQuery: isCanonicalPublicLeaderboardQuery,
  getRank: getArenaCachedRank,
  onLiveItems: upsertArenaRankCacheFromLeaderboard,
};
