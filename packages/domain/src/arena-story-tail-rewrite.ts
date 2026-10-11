import { resolveAnchoredSummaryState, toBattleStoryRecordCombatants, type BattleStoryBranchSummaryMeta } from './arena-story-branch';
import type { BattleStoryCommitSession, BuildCompletedBattleStoryRecordsInput, BattleStoryCommitChapter, BattleStoryCommitCheckpoint } from './arena-story-records';

/** Preserve legacy input precedence without inventing a historical role snapshot. */
export const resolveBattleStoryChapterInputCombatants = (input: {
  session: { seed: { combatants: unknown[] }; lastChapterInputCombatants?: unknown[] };
  checkpoints: ReadonlyArray<{ boundaryIndex: number; combatants: unknown[] }>;
  chapter: { id: string; index: number };
  latestChapter: { id: string } | null;
}): Array<Record<string, unknown>> | null => {
  const checkpoint = toBattleStoryRecordCombatants(
    input.checkpoints.find((candidate) => candidate.boundaryIndex === input.chapter.index - 1)?.combatants,
  );
  if (checkpoint) return checkpoint;
  if (input.chapter.index === 1) return toBattleStoryRecordCombatants(input.session.seed.combatants);
  if (input.latestChapter?.id === input.chapter.id) {
    return toBattleStoryRecordCombatants(input.session.lastChapterInputCombatants);
  }
  return null;
};

type TailRewriteSession = BattleStoryCommitSession & {
  sessionSummary?: string;
  summaryMeta?: BattleStoryBranchSummaryMeta;
};
export type BuildCompletedBattleStoryTailRewriteRecordsInput<S extends TailRewriteSession, CardSnapshot = object> =
  Omit<BuildCompletedBattleStoryRecordsInput<S, CardSnapshot>, 'action' | 'initialCheckpointId'> & {
    targetChapter: { id: string; index: number };
  };

/** A pure projection of an already completed generation. The host supplies identities,
 * time and owned input; storage validates its index and source graph after retention.
 */
export const buildCompletedBattleStoryTailRewriteRecords = <S extends TailRewriteSession, CardSnapshot = object>(
  input: BuildCompletedBattleStoryTailRewriteRecordsInput<S, CardSnapshot>,
): { session: S; chapter: BattleStoryCommitChapter<CardSnapshot>; checkpoint: BattleStoryCommitCheckpoint } => {
  const { generated, session, targetChapter, now } = input;
  const summary = resolveAnchoredSummaryState({
    sessionSummary: session.sessionSummary, summaryMeta: session.summaryMeta,
    maxCoveredChapterIndex: targetChapter.index, invalidateWhenCoveredAtOrBeyond: true,
  });
  const chapter: BattleStoryCommitChapter<CardSnapshot> = {
    id: input.operationId, sessionId: session.id, index: generated.chapterIndex,
    action: 'rewrite', status: 'active', sourceChapterId: targetChapter.id,
    ...(generated.generationId ? { generationId: generated.generationId } : {}),
    title: generated.digest.chapterTitle?.trim() || generated.digest.chapterTitle || `第 ${generated.chapterIndex} 章`,
    markdown: generated.markdown, reportJson: generated.reportJson ?? {},
    ...(generated.cardSnapshot ? { cardSnapshot: generated.cardSnapshot } : {}),
    deterministicDigest: generated.digest, createdAt: now,
  };
  return {
    session: {
      ...session, source: input.source, ...summary,
      workingCombatants: generated.nextWorkingCombatants,
      lastChapterInputCombatants: input.inputCombatants,
      lastChapterId: chapter.id, updatedAt: now,
    },
    chapter,
    checkpoint: {
      id: input.checkpointId, sessionId: session.id, boundaryIndex: generated.chapterIndex,
      chapterId: chapter.id, combatants: generated.nextWorkingCombatants, createdAt: now,
    },
  };
};
