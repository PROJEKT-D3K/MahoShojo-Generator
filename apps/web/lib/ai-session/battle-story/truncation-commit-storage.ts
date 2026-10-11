import { digestBattleStoryCommitValue as digest, freezeBattleStoryCommit } from '@mahoshojo/domain/arena-story-commit';
import { buildBattleStoryTruncatedSession } from '@mahoshojo/domain/arena-story-truncation';
import { openAiSessionDb } from '@/lib/ai-session/storage';
import { AI_SESSION_STORE_NAMES as stores } from '@/lib/ai-session/types';
import { BattleStoryCommitConflictError, BattleStoryCommitNotSavedError } from './commit-storage';
import { assertBattleStorySourceGraph, canonicalBattleStorySource, readBattleStorySourceInTransaction, type WebBattleStorySource } from './source-storage';
import type { BattleStorySessionRecord } from './types';

export type WebBattleStoryTruncationExpected = {
  sourceSessionId: string; sourceDigest: string; targetChapterId: string; targetIndex: number;
};
export type WebBattleStoryTruncationCommit = {
  version: 1; action: 'truncation'; expected: WebBattleStoryTruncationExpected; session: BattleStorySessionRecord;
};
const storeNames = [stores.battleStorySessions, stores.battleStoryChapters, stores.battleStoryCheckpoints];
const check: (condition: unknown, message?: string) => asserts condition = (
  condition, message = '源故事已变化，章节尚未删除。',
) => { if (!condition) throw new BattleStoryCommitConflictError(message); };

const assertSourceTarget = (source: WebBattleStorySource, targetChapterId: string) => {
  const { session, active } = assertBattleStorySourceGraph(source);
  const target = active.find((chapter) => chapter.id === targetChapterId);
  check(target && target.index >= 2, '删除目标已不是原活动章，章节尚未删除。');
  return { session, target, previousChapter: active[target.index - 2]! };
};

export const captureBattleStoryTruncationExpected = (
  source: WebBattleStorySource, targetChapterId: string,
): WebBattleStoryTruncationExpected => {
  const { session, target } = assertSourceTarget(source, targetChapterId);
  return {
    sourceSessionId: session.id, sourceDigest: digest(canonicalBattleStorySource(source)),
    targetChapterId: target.id, targetIndex: target.index,
  };
};

export const buildBattleStoryTruncationCommit = (
  source: WebBattleStorySource, targetChapterId: string, now: number,
): WebBattleStoryTruncationCommit => {
  try {
    const { session, target, previousChapter } = assertSourceTarget(source, targetChapterId);
    return {
      version: 1, action: 'truncation', expected: captureBattleStoryTruncationExpected(source, targetChapterId),
      session: buildBattleStoryTruncatedSession({ session, targetChapter: target, previousChapter, checkpoints: source.checkpoints, now }),
    };
  } catch (error) { throw new BattleStoryCommitNotSavedError(error); }
};

/** No persistent deletion receipt is introduced. Only oncomplete proves success;
 * an uncertain host response must be observed read-only, never replayed as a new delete.
 */
export const commitBattleStoryTruncation = async (input: WebBattleStoryTruncationCommit): Promise<void> => {
  let commit: WebBattleStoryTruncationCommit; let db: IDBDatabase;
  try {
    commit = freezeBattleStoryCommit(input);
    check(commit.version === 1 && commit.action === 'truncation');
    digest(commit);
    db = await openAiSessionDb();
  } catch (error) { throw new BattleStoryCommitNotSavedError(error); }
  return await new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(storeNames, 'readwrite'); }
    catch (error) { reject(new BattleStoryCommitNotSavedError(error)); return; }
    let written = false; let failure: unknown;
    const abort = (error: unknown) => {
      failure = error;
      try { tx.abort(); } catch (abortError) { reject(abortError); }
    };
    tx.oncomplete = () => written ? resolve() : reject(new Error('章节删除结果未知，请重新读取原会话。'));
    tx.onabort = () => reject(new BattleStoryCommitNotSavedError(failure ?? tx.error ?? new Error('章节删除事务已回滚。')));
    tx.onerror = () => { failure ??= tx.error; };
    try {
      readBattleStorySourceInTransaction(tx, commit.expected.sourceSessionId, (source) => {
        check(digest(source) === commit.expected.sourceDigest);
        const projected = buildBattleStoryTruncationCommit(source, commit.expected.targetChapterId, commit.session.updatedAt);
        check(digest(projected) === digest(commit), '删除后的会话投影无效，章节尚未删除。');
        const chapters = tx.objectStore(stores.battleStoryChapters);
        for (const chapter of source.chapters) {
          if (chapter.index >= commit.expected.targetIndex) chapters.delete(chapter.id);
        }
        const checkpoints = tx.objectStore(stores.battleStoryCheckpoints);
        for (const checkpoint of source.checkpoints) {
          if (checkpoint.boundaryIndex >= commit.expected.targetIndex) checkpoints.delete(checkpoint.id);
        }
        tx.objectStore(stores.battleStorySessions).put(commit.session);
        written = true;
      }, abort);
    } catch (error) { abort(error); }
  });
};
