'use client';

import Link from 'next/link';
import { useState } from 'react';
import { RankingPageView } from '@mahoshojo/ui-web/ranking';
import { readWebRanking } from '@/lib/arena/read-public-ranking';
import { LeaderboardEntityDetailsModal, type LeaderboardEntityDetailsTarget } from './LeaderboardEntityDetailsModal';
import { useWebRankingQuery, webRankingCache } from './use-ranking-query';

export function RankingPage() {
  const [detailsEntity, setDetailsEntity] = useState<LeaderboardEntityDetailsTarget | null>(null);
  return <>
    <RankingPageView useRankingQuery={useWebRankingQuery} readRanking={readWebRanking} Link={Link} cache={webRankingCache}
      onOpenEntityDetails={setDetailsEntity} canOpenScenarioPresets />
    <LeaderboardEntityDetailsModal isOpen={Boolean(detailsEntity)} onClose={() => setDetailsEntity(null)} entity={detailsEntity} />
  </>;
}
