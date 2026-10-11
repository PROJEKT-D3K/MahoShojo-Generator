import type { BattleStoryBranchSummaryMeta } from './arena-story-branch';
import type { BattleStoryCommitSession } from './arena-story-records';
import { buildCompletedBattleStoryTailRewriteRecords, type BuildCompletedBattleStoryTailRewriteRecordsInput } from './arena-story-tail-rewrite';

type MiddleRewriteSession = BattleStoryCommitSession & {
  sessionSummary?: string;
  summaryMeta?: BattleStoryBranchSummaryMeta;
};
export type BuildCompletedBattleStoryMiddleRewriteRecordsInput<S extends MiddleRewriteSession, CardSnapshot = object> =
  BuildCompletedBattleStoryTailRewriteRecordsInput<S, CardSnapshot>;

/** Completed content stays intact until the host validates the original middle-chapter
 * identity. Replacement makes that chapter the new tail; it never keeps the old suffix.
 */
export const buildCompletedBattleStoryMiddleRewriteRecords = <S extends MiddleRewriteSession, CardSnapshot = object>(
  input: BuildCompletedBattleStoryMiddleRewriteRecordsInput<S, CardSnapshot>,
) => {
  const records = buildCompletedBattleStoryTailRewriteRecords(input);
  return { ...records, session: { ...records.session, chapterCount: input.targetChapter.index } };
};
