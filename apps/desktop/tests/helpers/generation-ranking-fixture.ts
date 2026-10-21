import type { GenerationRankingParticipant, GenerationRankingQueueResult, GenerationRankingResponse } from '@mahoshojo/contracts/arena-generation-ranking';

export const rankingQueue = (patch: Partial<GenerationRankingQueueResult> = {}): GenerationRankingQueueResult => ({
  eligible: true, ineligibleReasons: [], eventStatus: 'applied', skipReason: null,
  rating: 0, games: 1, tier: null, delta: 0, rank: null, total: null, rankDelta: null, ...patch,
});
export const rankingParticipant = (entityKey: string | null, patch: Partial<GenerationRankingParticipant> = {}): GenerationRankingParticipant => ({
  displayName: '同名角色', entityType: 'unknown', entityId: null, entityKey, dataCardId: null, presetId: null,
  techScore: null, techLevel: null, queues: { strict: rankingQueue(), free: rankingQueue() }, ...patch,
});
export const readyRanking = (participants: GenerationRankingParticipant[], generationId = 'generation-a'): GenerationRankingResponse => ({
  success: true, generationId, state: 'ready', snapshot: { status: 'completed', combatantCount: participants.length }, participants,
});
