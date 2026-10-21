import type { GenerationRankingParticipant, GenerationRankingResponse } from '@mahoshojo/contracts/arena-generation-ranking';
import { getCombatantRankingEntityKey, type CombatantData } from '@mahoshojo/domain/arena-file-parser';

type EntitySource = Pick<CombatantData, 'isPreset' | 'filename' | 'sourceDataCardId'>;

const countKeys = (keys: readonly (string | null)[]) => {
  const counts = new Map<string, number>();
  for (const key of keys) if (key?.trim()) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
};

/** 仅把生成时的结算历史归到同一展示实体；绝不恢复来源资格或修改当前评分/预测。 */
export function projectDesktopGenerationRanking(input: {
  current: readonly EntitySource[];
  frozen: readonly EntitySource[] | null | undefined;
  ranking: GenerationRankingResponse | null | undefined;
  hostedGenerationId: string | null;
}) {
  const rows: (GenerationRankingParticipant | null)[] = input.current.map(() => null);
  const ranking = input.ranking;
  const participants = ranking?.success && ranking.state === 'ready' ? ranking.participants : [];
  const unmatched = participants.map((participant, index) => ({ participant, index }));
  if (!input.frozen || !input.hostedGenerationId || ranking?.generationId !== input.hostedGenerationId) return { rows, unmatched };

  const currentKeys = input.current.map(getCombatantRankingEntityKey);
  const currentCounts = countKeys(currentKeys);
  const frozenCounts = countKeys(input.frozen.map(getCombatantRankingEntityKey));
  const participantCounts = countKeys(participants.map(participant => participant.entityKey?.trim() || null));
  return { rows, unmatched: unmatched.filter(({ participant }) => {
    const key = participant.entityKey?.trim();
    if (!key || currentCounts.get(key) !== 1 || frozenCounts.get(key) !== 1 || participantCounts.get(key) !== 1) return true;
    rows[currentKeys.indexOf(key)] = participant;
    return false;
  }) };
}
