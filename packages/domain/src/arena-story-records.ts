import type { BattleStoryDeterministicDigest } from './arena-battle-story-session';

/** Pure completed-record projection. Keep runtime hashing, protocol schemas and
 * platform adapters outside this leaf so branch consumers remain domain-only.
 */
export type BattleStoryCommitSession = {
  id: string; title: string; createdAt: number; updatedAt: number;
  source: object; seed: { combatants: unknown[] }; workingCombatants: unknown[];
  lastChapterInputCombatants?: unknown[]; lastChapterId?: string | null; chapterCount: number;
};
export type BattleStoryCommitChapter<CardSnapshot = object> = {
  id: string; sessionId: string; index: number; action: 'start' | 'continue' | 'branch' | 'rewrite';
  status: 'active' | 'superseded'; sourceChapterId?: string | null; generationId?: string | null;
  title: string; markdown: string; reportJson: Record<string, unknown>; cardSnapshot?: CardSnapshot;
  deterministicDigest: BattleStoryDeterministicDigest; createdAt: number;
};
export type BattleStoryCommitCheckpoint = {
  id: string; sessionId: string; boundaryIndex: number; chapterId?: string | null;
  combatants: unknown[]; createdAt: number;
};
export type BuildCompletedBattleStoryRecordsInput<S extends BattleStoryCommitSession = BattleStoryCommitSession, CardSnapshot = object> = {
  action: 'start' | 'continue'; session: S;
  operationId: string; checkpointId: string; initialCheckpointId?: string; now: number;
  source: S['source']; inputCombatants: unknown[];
  generated: {
    chapterIndex: number; markdown: string; reportJson: Record<string, unknown>;
    digest: BattleStoryDeterministicDigest; generationId?: string | null; cardSnapshot?: CardSnapshot | null;
    nextWorkingCombatants: unknown[];
  };
};

export type BattleStoryCompletedRecords<S extends BattleStoryCommitSession = BattleStoryCommitSession, CardSnapshot = object> = {
  session: S;
  chapter: BattleStoryCommitChapter<CardSnapshot>;
  checkpoints: BattleStoryCommitCheckpoint[];
};

/**
 * Shared record assembly, independent of the host's CAS representation. No time, IDs,
 * storage, model calls or platform effects are created here. Keep generated content even
 * when its announced index is invalid: validate at save time, after the host retains it.
 */
export const buildCompletedBattleStoryRecords = <S extends BattleStoryCommitSession, CardSnapshot = object>(
  input: BuildCompletedBattleStoryRecordsInput<S, CardSnapshot>,
): BattleStoryCompletedRecords<S, CardSnapshot> => {
  const { generated, session, action, now } = input;
  const previousCount = action === 'start' ? 0 : session.chapterCount;
  if (!Number.isSafeInteger(previousCount) || previousCount < 0
    || (action === 'start' && !input.initialCheckpointId)) {
    throw new Error('完成章与预期会话位置不一致，未保存本章。');
  }
  const title = generated.digest.chapterTitle?.trim() || generated.digest.chapterTitle || `第 ${generated.chapterIndex} 章`;
  const chapter: BattleStoryCommitChapter<CardSnapshot> = {
    id: input.operationId, sessionId: session.id, index: generated.chapterIndex, action, status: 'active',
    ...(action === 'continue' && session.lastChapterId ? { sourceChapterId: session.lastChapterId } : {}),
    ...(generated.generationId ? { generationId: generated.generationId } : {}),
    title, markdown: generated.markdown, reportJson: generated.reportJson ?? {},
    ...(generated.cardSnapshot ? { cardSnapshot: generated.cardSnapshot } : {}),
    deterministicDigest: generated.digest, createdAt: now,
  };
  const checkpoints: BattleStoryCommitCheckpoint[] = [];
  if (action === 'start') checkpoints.push({
    id: input.initialCheckpointId!, sessionId: session.id, boundaryIndex: 0,
    combatants: input.inputCombatants, createdAt: now,
  });
  checkpoints.push({
    id: input.checkpointId, sessionId: session.id, boundaryIndex: generated.chapterIndex,
    chapterId: chapter.id, combatants: generated.nextWorkingCombatants, createdAt: now,
  });
  return {
    session: {
      ...session, source: input.source,
      title: action === 'start' || session.title === '未命名连续战报'
        ? generated.digest.chapterTitle || session.title : session.title,
      workingCombatants: generated.nextWorkingCombatants, lastChapterInputCombatants: input.inputCombatants,
      lastChapterId: chapter.id, chapterCount: previousCount + 1, updatedAt: now,
    },
    chapter, checkpoints,
  };
};

