'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RankingPageView, type RankingQueryHook, type RankingRankCache } from '@mahoshojo/ui-web/ranking';
import { readWebRanking } from '@/lib/arena/read-public-ranking';
import { LeaderboardEntityDetailsModal, type LeaderboardEntityDetailsTarget } from './LeaderboardEntityDetailsModal';
import { getArenaCachedRank, isCanonicalPublicLeaderboardQuery, upsertArenaRankCacheFromLeaderboard } from '@/lib/arena/rank-cache';

const keys = { seasons: 'seasonsConfig', tags: 'tags', leaderboard: 'arenaLeaderboard', search: 'arenaLeaderboardSearch', archive: 'seasonArchive', ratingHistory: 'entityRatingHistory', entityRating: 'entityRating' } as const;
const useRankingQuery: RankingQueryHook = ({ request, enabled, staleTime }) => useQuery({
  queryKey: [keys[request.kind], request],
  queryFn: ({ signal }) => readWebRanking(request, signal),
  enabled, staleTime,
});
const cache: RankingRankCache = {
  isCanonicalQuery: isCanonicalPublicLeaderboardQuery,
  getRank: getArenaCachedRank,
  onLiveItems: upsertArenaRankCacheFromLeaderboard,
};

export function RankingPage() {
  const [detailsEntity, setDetailsEntity] = useState<LeaderboardEntityDetailsTarget | null>(null);
  return <>
    <RankingPageView useRankingQuery={useRankingQuery} readRanking={readWebRanking} Link={Link} cache={cache}
      onOpenEntityDetails={setDetailsEntity} canOpenScenarioPresets />
    <LeaderboardEntityDetailsModal isOpen={Boolean(detailsEntity)} onClose={() => setDetailsEntity(null)} entity={detailsEntity} />
  </>;
}
