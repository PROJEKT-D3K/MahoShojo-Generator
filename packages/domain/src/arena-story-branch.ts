/** Pure projections for owned story snapshots; no validation or persistence authority.
 * Allocators preserve each host's existing identity policy. They must supply fresh IDs.
 * Payloads/extensions are retained by shallow copy; callers own snapshot isolation.
 */
export type BattleStoryBranchChapter = {
  id: string;
  sessionId: string;
  index: number;
  status?: 'active' | 'superseded';
  sourceChapterId?: string | null;
  supersededByChapterId?: string | null;
};

export type BattleStoryBranchCheckpoint = {
  id: string;
  sessionId: string;
  boundaryIndex: number;
  chapterId?: string | null;
};

export type BattleStoryBranchSummaryMeta = {
  coveredUntilChapterIndex: number;
  coveredChapterIds: string[];
};

const normalizeText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export const cloneBattleStoryActiveChaptersForNewSession = <Chapter extends BattleStoryBranchChapter>(input: {
  chapters: Chapter[];
  newSessionId: string;
  allocateId: (chapter: Chapter) => string;
}): {
  chapters: Chapter[];
  chapterIdMap: Map<string, string>;
} => {
  const activeChapters = input.chapters
    .filter((chapter) => chapter.status !== 'superseded')
    .sort((left, right) => left.index - right.index);

  const chapterIdMap = new Map<string, string>();
  const cloned = activeChapters.map((chapter) => {
    const nextId = input.allocateId(chapter);
    chapterIdMap.set(chapter.id, nextId);
    return {
      ...chapter,
      id: nextId,
      sessionId: input.newSessionId,
      status: 'active' as const,
      supersededByChapterId: null,
    };
  });

  const normalized = cloned.map((chapter) => ({
    ...chapter,
    sourceChapterId: chapter.sourceChapterId ? (chapterIdMap.get(chapter.sourceChapterId) ?? null) : null,
  }));

  return {
    chapters: normalized,
    chapterIdMap,
  };
};

export const cloneBattleStoryCheckpointsForNewSession = <Checkpoint extends BattleStoryBranchCheckpoint>(input: {
  checkpoints: Checkpoint[];
  newSessionId: string;
  chapterIdMap: Map<string, string>;
  maxBoundaryIndex?: number;
  allocateId: (checkpoint: Checkpoint) => string;
}): Checkpoint[] => {
  const maxBoundaryIndex =
    typeof input.maxBoundaryIndex === 'number' && Number.isFinite(input.maxBoundaryIndex)
      ? Math.max(0, Math.floor(input.maxBoundaryIndex))
      : Number.MAX_SAFE_INTEGER;

  return input.checkpoints
    .filter((checkpoint) => checkpoint.boundaryIndex <= maxBoundaryIndex)
    .sort((left, right) => left.boundaryIndex - right.boundaryIndex)
    .map((checkpoint) => ({
      ...checkpoint,
      id: input.allocateId(checkpoint),
      sessionId: input.newSessionId,
      chapterId: checkpoint.chapterId ? (input.chapterIdMap.get(checkpoint.chapterId) ?? null) : null,
    }));
};

export const buildBattleStoryBranchLabel = (input: {
  chapterIndex: number;
  chapterTitle?: string | null;
}): string => {
  const index = Math.max(1, Math.floor(input.chapterIndex));
  const title = normalizeText(input.chapterTitle);
  return title ? `从第 ${index} 章《${title}》分支` : `从第 ${index} 章分支`;
};

export const remapBattleStorySummaryMeta = <Summary extends BattleStoryBranchSummaryMeta>(
  summaryMeta: Summary | undefined,
  chapterIdMap: Map<string, string>
): Summary | undefined => {
  if (!summaryMeta) return undefined;

  const coveredChapterIds = summaryMeta.coveredChapterIds
    .map((chapterId) => chapterIdMap.get(chapterId) ?? null)
    .filter((chapterId): chapterId is string => Boolean(chapterId));

  return {
    ...summaryMeta,
    coveredChapterIds,
  };
};

export const resolveAnchoredSummaryState = <Summary extends BattleStoryBranchSummaryMeta>(input: {
  sessionSummary?: string;
  summaryMeta?: Summary;
  maxCoveredChapterIndex: number;
  invalidateWhenCoveredAtOrBeyond?: boolean;
}): {
  sessionSummary?: string;
  summaryMeta?: Summary;
} => {
  const coveredUntil = input.summaryMeta?.coveredUntilChapterIndex ?? 0;
  const isUnsafe = input.invalidateWhenCoveredAtOrBeyond
    ? coveredUntil >= input.maxCoveredChapterIndex
    : coveredUntil > input.maxCoveredChapterIndex;
  if (isUnsafe) {
    return {
      sessionSummary: undefined,
      summaryMeta: undefined,
    };
  }
  return {
    sessionSummary: input.sessionSummary,
    summaryMeta: input.summaryMeta,
  };
};

export const toBattleStoryRecordCombatants = (value: unknown): Array<Record<string, unknown>> | null => {
  if (!Array.isArray(value)) return null;
  const normalized = value.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
  );
  return normalized.length > 0 ? normalized : null;
};

export const resolveBattleStoryChapterOutputCombatants = (input: {
  session: { workingCombatants: unknown[] };
  checkpoints: ReadonlyArray<{ boundaryIndex: number; combatants: unknown[] }>;
  chapter: { id: string; index: number };
  latestChapter: { id: string } | null;
}): Array<Record<string, unknown>> | null => {
  const fromCheckpoint = toBattleStoryRecordCombatants(
    input.checkpoints.find((checkpoint) => checkpoint.boundaryIndex === input.chapter.index)?.combatants
  );
  if (fromCheckpoint) return fromCheckpoint;
  if (input.latestChapter && input.latestChapter.id === input.chapter.id) {
    return toBattleStoryRecordCombatants(input.session.workingCombatants);
  }
  return null;
};
