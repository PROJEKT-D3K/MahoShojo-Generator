import type { GenerationRankingQueue, GenerationRankingQueueResult, PublicGenerationRankingSnapshot } from '@mahoshojo/contracts/arena-generation-ranking';
export { parseGenerationRankingResponse, requireGenerationRankingResponse } from '@mahoshojo/contracts/arena-generation-ranking';
export type { GenerationRankingQueue, GenerationRankingQueueResult, GenerationRankingParticipant, PublicGenerationRankingSnapshot, GenerationRankingResponse } from '@mahoshojo/contracts/arena-generation-ranking';

type InternalSnapshotShape = {
  status?: unknown;
  combatantCount?: unknown;
};

export const buildPublicGenerationRankingSnapshot = <T extends InternalSnapshotShape>(
  snapshot: T,
): PublicGenerationRankingSnapshot => ({
  status: typeof snapshot.status === 'string' ? snapshot.status : null,
  combatantCount:
    typeof snapshot.combatantCount === 'number' && Number.isFinite(snapshot.combatantCount)
      ? snapshot.combatantCount
      : null,
});

type GenerationRankingCacheState =
  | {
      success: true;
      state: 'pending' | 'ready';
      participants?: Array<{
        queues: Record<GenerationRankingQueue, { eventStatus: GenerationRankingQueueResult['eventStatus'] }>;
      }>;
    }
  | { success: false };

export const getGenerationRankingCacheControl = (
  response: GenerationRankingCacheState,
): string => {
  if (!response.success) return 'public, max-age=0, s-maxage=60';
  if (response.state === 'pending') return 'no-store';
  const hasFailedOrSkipped = response.participants?.some((participant) =>
    Object.values(participant.queues).some(
      (queue) => queue.eventStatus === 'failed' || queue.eventStatus === 'skipped',
    ),
  );
  if (hasFailedOrSkipped) return 'public, max-age=0, s-maxage=60';
  return 'public, max-age=0, s-maxage=3600';
};
