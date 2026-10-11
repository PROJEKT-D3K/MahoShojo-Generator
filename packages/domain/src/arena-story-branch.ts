import { buildCompletedBattleStoryRecords, type BattleStoryCommitSession, type BuildCompletedBattleStoryRecordsInput } from './arena-story-records';

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

export type BattleStoryBranchLink =
  | { kind: 'root' }
  | { kind: 'parent'; sessionId: string; chapterIndex: number; chapterTitle?: string }
  | { kind: 'invalid' };

/** Read only the display relationship; this does not validate a persisted session. */
export function readBattleStoryBranchLink(value: unknown): BattleStoryBranchLink {
  if (value === undefined) return { kind: 'root' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid' };

  const { sessionId, chapterIndex, chapterTitle } = value as Record<string, unknown>;
  if (
    typeof sessionId !== 'string' || !sessionId.trim()
    || typeof chapterIndex !== 'number' || !Number.isSafeInteger(chapterIndex) || chapterIndex < 1
    || (chapterTitle !== undefined && typeof chapterTitle !== 'string')
  ) return { kind: 'invalid' };

  return {
    kind: 'parent', sessionId, chapterIndex,
    ...(chapterTitle === undefined ? {} : { chapterTitle }),
  };
}

export type BattleStoryBranchChainStop =
  | { kind: 'root' }
  | { kind: 'missing'; sessionId: string }
  | { kind: 'cycle'; sessionId: string }
  | { kind: 'invalid'; sessionId: string };

/** Project only known nodes, retaining their references and reporting incomplete ancestry. */
export function buildBattleStoryBranchChain<Node extends {
  id: string;
  updatedAt: number;
  parent: BattleStoryBranchLink;
}>(input: {
  sessions: readonly Node[];
  activeSession: Node | null;
}): { chain: Node[]; children: Node[]; stop: BattleStoryBranchChainStop | null } {
  const { sessions, activeSession } = input;
  if (!activeSession) return { chain: [], children: [], stop: null };

  const sessionMap = new Map(sessions.map((session) => [session.id, session]));
  sessionMap.set(activeSession.id, activeSession);
  const visited = new Set<string>();
  const chain: Node[] = [];
  let cursor = activeSession;
  let stop: BattleStoryBranchChainStop;

  while (true) {
    visited.add(cursor.id);
    chain.push(cursor);
    const parent = cursor.parent;
    if (parent.kind === 'root') {
      stop = { kind: 'root' };
      break;
    }
    if (parent.kind === 'invalid') {
      stop = { kind: 'invalid', sessionId: cursor.id };
      break;
    }
    if (visited.has(parent.sessionId)) {
      stop = { kind: 'cycle', sessionId: parent.sessionId };
      break;
    }
    const next = sessionMap.get(parent.sessionId);
    if (!next) {
      stop = { kind: 'missing', sessionId: parent.sessionId };
      break;
    }
    cursor = next;
  }

  const children = [...sessionMap.values()]
    .filter((session) => session.id !== activeSession.id
      && session.parent.kind === 'parent' && session.parent.sessionId === activeSession.id)
    .sort((left, right) => right.updatedAt - left.updatedAt
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  return { chain: chain.reverse(), children, stop };
}

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

/** Assemble only the new three records. Native can map each summary ID without
 * hydrating a historical prefix; Web supplies its existing random-ID map.
 * The caller owns the independent source/draft and retains this result before validation.
 */
export const buildCompletedBattleStoryBranchRecords = <
  S extends BattleStoryCommitSession & { summaryMeta?: BattleStoryBranchSummaryMeta }, CardSnapshot = object,
>(input: Omit<BuildCompletedBattleStoryRecordsInput<S, CardSnapshot>, 'action' | 'initialCheckpointId'> & {
  prefixEndIndex: number;
  targetAnchorChapterId: string;
  mapChapterId: (sourceId: string) => string | undefined;
}) => {
  const records = buildCompletedBattleStoryRecords({
    ...input,
    action: 'continue',
    session: { ...input.session, chapterCount: input.prefixEndIndex, lastChapterId: input.targetAnchorChapterId },
  });
  const summaryMeta = input.session.summaryMeta;
  return {
    session: {
      ...records.session,
      title: input.session.title,
      ...(summaryMeta ? { summaryMeta: {
        ...summaryMeta,
        coveredChapterIds: summaryMeta.coveredChapterIds
          .map(input.mapChapterId).filter((id): id is string => Boolean(id)),
      } } : {}),
    },
    chapter: { ...records.chapter, action: 'branch' as const },
    checkpoints: records.checkpoints,
  };
};
