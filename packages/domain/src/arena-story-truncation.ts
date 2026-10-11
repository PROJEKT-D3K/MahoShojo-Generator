import { resolveAnchoredSummaryState, type BattleStoryBranchSummaryMeta } from './arena-story-branch';
import type { BattleStoryCommitSession } from './arena-story-records';
import { resolveBattleStoryChapterInputCombatants } from './arena-story-tail-rewrite';

type TruncationSession = BattleStoryCommitSession & {
  sessionSummary?: string;
  summaryMeta?: BattleStoryBranchSummaryMeta;
};

/** Deleting k and its suffix restores its input boundary using the established legacy
 * input precedence. The current head's output is never a historical input fallback.
 */
export const buildBattleStoryTruncatedSession = <S extends TruncationSession>(input: {
  session: S;
  targetChapter: { id: string; index: number };
  previousChapter: { id: string; index: number };
  checkpoints: ReadonlyArray<{ boundaryIndex: number; combatants: unknown[] }>;
  now: number;
}): S => {
  const index = input.targetChapter.index;
  const latestChapter = input.session.lastChapterId ? { id: input.session.lastChapterId } : null;
  const workingCombatants = resolveBattleStoryChapterInputCombatants({
    session: input.session, checkpoints: input.checkpoints, chapter: input.targetChapter, latestChapter,
  });
  if (!workingCombatants) throw new Error('该章节缺少“回退状态”快照，暂时无法安全删除。');
  const lastChapterInputCombatants = resolveBattleStoryChapterInputCombatants({
    session: input.session, checkpoints: input.checkpoints, chapter: input.previousChapter, latestChapter,
  }) ?? undefined;
  return {
    ...input.session,
    ...resolveAnchoredSummaryState({
      sessionSummary: input.session.sessionSummary, summaryMeta: input.session.summaryMeta,
      maxCoveredChapterIndex: index, invalidateWhenCoveredAtOrBeyond: true,
    }),
    workingCombatants, lastChapterInputCombatants,
    lastChapterId: input.previousChapter.id, chapterCount: index - 1, updatedAt: input.now,
  };
};
