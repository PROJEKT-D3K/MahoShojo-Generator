'use client';

import { EntityRatingHistoryButton as SharedEntityRatingHistoryButton, type EntityRatingHistoryButtonProps } from '@mahoshojo/ui-web/ranking';
import { readWebRanking } from '@/lib/arena/read-public-ranking';

export function EntityRatingHistoryButton(props: Omit<EntityRatingHistoryButtonProps, 'readRanking'>) {
  return <SharedEntityRatingHistoryButton {...props} readRanking={readWebRanking} />;
}
