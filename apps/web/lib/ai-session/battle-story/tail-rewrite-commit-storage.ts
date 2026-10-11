import { digestBattleStoryCommitValue as digest, freezeBattleStoryCommit } from '@mahoshojo/domain/arena-story-commit';
import { buildCompletedBattleStoryTailRewriteRecords, resolveBattleStoryChapterInputCombatants } from '@mahoshojo/domain/arena-story-tail-rewrite';
import { openAiSessionDb, requestToPromise, transactionToPromise } from '@/lib/ai-session/storage';
import { AI_SESSION_STORE_NAMES as stores } from '@/lib/ai-session/types';
import { BattleStoryCommitConflictError, BattleStoryCommitNotSavedError } from './commit-storage';
import { assertBattleStorySourceGraph, canonicalBattleStorySource, readBattleStorySource, readBattleStorySourceInTransaction, type WebBattleStorySource } from './source-storage';
import type { BattleStoryChapterRecord, BattleStoryCheckpointRecord, BattleStorySessionRecord } from './types';

export type WebBattleStoryTailRewriteSource = WebBattleStorySource;
export type WebBattleStoryTailRewriteExpected = {
  sourceSessionId: string; sourceDigest: string; targetChapterId: string; targetIndex: number;
};
export type WebBattleStoryTailRewriteCommit = {
  version: 1; action: 'tail-rewrite'; operationId: string; expected: WebBattleStoryTailRewriteExpected;
  session: BattleStorySessionRecord; chapter: BattleStoryChapterRecord; checkpoint: BattleStoryCheckpointRecord;
};
export type WebBattleStoryTailRewriteReceipt = {
  version: 3; kind: 'tail-rewrite'; operationId: string; sessionId: string; chapterId: string;
  chapterIndex: number; chapterCount: number; targetChapterId: string; checkpointId: string; contentDigest: string;
};
const storeNames = [stores.battleStorySessions, stores.battleStoryChapters, stores.battleStoryCheckpoints];
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const validId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const check: (condition: unknown, message?: string) => asserts condition = (
  condition, message = '尾章重写提交关系无效，尚未保存。',
) => { if (!condition) throw new BattleStoryCommitConflictError(message); };

export const readBattleStoryTailRewriteSource = readBattleStorySource;

const assertSourceGraph = (source: WebBattleStoryTailRewriteSource, targetId: string) => {
  const { session, active } = assertBattleStorySourceGraph(source);
  const target = active.at(-1)!;
  check(target.id === targetId && target.index === session.chapterCount, '重写目标已不是最新活动章，本章尚未保存。');
  return { session, target };
};

export const captureBattleStoryTailRewriteExpected = (
  source: WebBattleStoryTailRewriteSource, targetChapterId: string,
): WebBattleStoryTailRewriteExpected => {
  const { session, target } = assertSourceGraph(source, targetChapterId);
  return {
    sourceSessionId: session.id, sourceDigest: digest(canonicalBattleStorySource(source)),
    targetChapterId: target.id, targetIndex: target.index,
  };
};

const receiptKeys = ['version', 'kind', 'operationId', 'sessionId', 'chapterId', 'chapterIndex', 'chapterCount', 'targetChapterId', 'checkpointId', 'contentDigest'];
export const isWebBattleStoryTailRewriteReceipt = (value: unknown): value is WebBattleStoryTailRewriteReceipt => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as WebBattleStoryTailRewriteReceipt;
  return Object.keys(receipt).length === receiptKeys.length && receiptKeys.every((key) => hasOwn(receipt, key))
    && receipt.version === 3 && receipt.kind === 'tail-rewrite'
    && [receipt.operationId, receipt.sessionId, receipt.chapterId, receipt.targetChapterId, receipt.checkpointId].every(validId)
    && receipt.chapterId === receipt.operationId && receipt.targetChapterId !== receipt.chapterId
    && Number.isSafeInteger(receipt.chapterIndex) && receipt.chapterIndex >= 1 && receipt.chapterCount === receipt.chapterIndex
    && typeof receipt.contentDigest === 'string' && digestPattern.test(receipt.contentDigest)
    && new TextEncoder().encode(JSON.stringify(receipt)).length <= 2048;
};

// The original generation owns one immutable package and digest, including across retries.
const receipts = new WeakMap<WebBattleStoryTailRewriteCommit, WebBattleStoryTailRewriteReceipt>();
export const createBattleStoryTailRewriteReceipt = (input: WebBattleStoryTailRewriteCommit): WebBattleStoryTailRewriteReceipt => {
  try {
    const cached = receipts.get(input);
    if (cached) return cached;
    const commit = freezeBattleStoryCommit(input);
    const receipt: WebBattleStoryTailRewriteReceipt = {
      version: 3, kind: 'tail-rewrite', operationId: commit.operationId, sessionId: commit.session.id,
      chapterId: commit.chapter.id, chapterIndex: commit.chapter.index, chapterCount: commit.session.chapterCount,
      targetChapterId: commit.expected.targetChapterId, checkpointId: commit.checkpoint.id, contentDigest: digest(commit),
    };
    check(isWebBattleStoryTailRewriteReceipt(receipt));
    Object.freeze(receipt);
    receipts.set(commit, receipt);
    return receipt;
  } catch (error) {
    throw error instanceof BattleStoryCommitNotSavedError ? error : new BattleStoryCommitNotSavedError(error);
  }
};

const exactReceipt = (
  chapter: (BattleStoryChapterRecord & { commitReceipt?: unknown }) | undefined,
  sessionId: string, operationId: string, contentDigest: string,
): WebBattleStoryTailRewriteReceipt | null => {
  const receipt = chapter?.commitReceipt;
  return isWebBattleStoryTailRewriteReceipt(receipt) && receipt.sessionId === sessionId
    && receipt.operationId === operationId && receipt.contentDigest === contentDigest
    && chapter?.id === receipt.chapterId && chapter.sessionId === receipt.sessionId
    && chapter.index === receipt.chapterIndex && chapter.action === 'rewrite'
    && chapter.sourceChapterId === receipt.targetChapterId ? receipt : null;
};

export const getBattleStoryTailRewriteOperationReceipt = async (
  sessionId: string, operationId: string, contentDigest: string,
): Promise<WebBattleStoryTailRewriteReceipt | null> => {
  const db = await openAiSessionDb();
  const tx = db.transaction(stores.battleStoryChapters, 'readonly');
  const completed = transactionToPromise(tx);
  const [chapter] = await Promise.all([requestToPromise(tx.objectStore(stores.battleStoryChapters).get(operationId)), completed]);
  return exactReceipt(chapter, sessionId, operationId, contentDigest);
};

const assertWriteSet = (commit: WebBattleStoryTailRewriteCommit) => {
  const { expected, session, chapter, checkpoint } = commit;
  const index = expected.targetIndex;
  check(commit.version === 1 && commit.action === 'tail-rewrite' && validId(commit.operationId)
    && validId(expected.sourceSessionId) && validId(expected.targetChapterId)
    && typeof expected.sourceDigest === 'string' && digestPattern.test(expected.sourceDigest)
    && Number.isSafeInteger(index) && index >= 1
    && session.id === expected.sourceSessionId && session.chapterCount === index && session.lastChapterId === commit.operationId
    && chapter.id === commit.operationId && chapter.id !== expected.targetChapterId
    && chapter.sessionId === session.id && chapter.index === index && chapter.action === 'rewrite'
    && chapter.status === 'active' && !chapter.supersededByChapterId && !hasOwn(chapter, 'commitReceipt')
    && chapter.sourceChapterId === expected.targetChapterId
    && validId(checkpoint.id) && checkpoint.sessionId === session.id && checkpoint.boundaryIndex === index
    && checkpoint.chapterId === chapter.id && digest(checkpoint.combatants) === digest(session.workingCombatants));
};

/** Re-project against the actual CAS source so title, count, seed, plan, ancestry and
 * opaque session members cannot be silently dropped or changed by the caller.
 */
const assertSourceAndProjection = (commit: WebBattleStoryTailRewriteCommit, source: WebBattleStoryTailRewriteSource) => {
  const { expected, session, chapter, checkpoint } = commit;
  check(digest(source) === expected.sourceDigest, '源故事已变化，重写尚未保存。');
  const { session: current, target } = assertSourceGraph(source, expected.targetChapterId);
  check(current.id === expected.sourceSessionId && target.index === expected.targetIndex);
  const inputCombatants = resolveBattleStoryChapterInputCombatants({
    session: current, checkpoints: source.checkpoints, chapter: target, latestChapter: target,
  });
  check(inputCombatants, '该章节缺少“章前输入状态”快照，暂时无法安全重写。');
  check(!source.checkpoints.some((record) => record.id === checkpoint.id), '新检查点身份已存在，未覆盖原记录。');
  const projected = buildCompletedBattleStoryTailRewriteRecords({
    session: current, targetChapter: target, operationId: commit.operationId,
    checkpointId: checkpoint.id, now: chapter.createdAt, source: session.source, inputCombatants,
    generated: {
      chapterIndex: chapter.index, markdown: chapter.markdown, reportJson: chapter.reportJson,
      digest: chapter.deterministicDigest, generationId: chapter.generationId, cardSnapshot: chapter.cardSnapshot,
      nextWorkingCombatants: session.workingCombatants,
    },
  });
  check(digest(projected) === digest({ session, chapter, checkpoint }));
  return target;
};

/** The three-store transaction owns exact success, full-source CAS and every write.
 * Existing receipts remain on superseded chapters; success never resurrects a deleted graph.
 */
export const commitCompletedBattleStoryTailRewrite = async (
  input: WebBattleStoryTailRewriteCommit,
): Promise<WebBattleStoryTailRewriteReceipt> => {
  let commit: WebBattleStoryTailRewriteCommit; let receipt: WebBattleStoryTailRewriteReceipt; let db: IDBDatabase;
  try {
    commit = freezeBattleStoryCommit(input);
    assertWriteSet(commit);
    receipt = createBattleStoryTailRewriteReceipt(commit);
    db = await openAiSessionDb();
  } catch (error) { throw new BattleStoryCommitNotSavedError(error); }
  return await new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(storeNames, 'readwrite'); }
    catch (error) { reject(new BattleStoryCommitNotSavedError(error)); return; }
    let result: WebBattleStoryTailRewriteReceipt | undefined; let failure: unknown;
    const abort = (error: unknown) => {
      failure = error;
      try { tx.abort(); } catch (abortError) { reject(abortError); }
    };
    tx.oncomplete = () => result ? resolve(result) : reject(new Error('重写保存结果未知，请查询原回执。'));
    tx.onabort = () => reject(new BattleStoryCommitNotSavedError(failure ?? tx.error ?? new Error('重写保存事务已回滚。')));
    tx.onerror = () => { failure ??= tx.error; };
    try {
      const chapters = tx.objectStore(stores.battleStoryChapters);
      const existing = chapters.get(commit.operationId);
      existing.onsuccess = () => { try {
        const previous = exactReceipt(existing.result, commit.session.id, commit.operationId, receipt.contentDigest);
        if (previous) { result = previous; return; }
        check(!existing.result, '同一保存操作内容不一致，未覆盖原记录。');
        readBattleStorySourceInTransaction(tx, commit.session.id, (source) => {
          const target = assertSourceAndProjection(commit, source);
          chapters.put({ ...target, status: 'superseded', supersededByChapterId: commit.chapter.id });
          chapters.add({ ...commit.chapter, commitReceipt: receipt });
          const checkpoints = tx.objectStore(stores.battleStoryCheckpoints);
          const previousCheckpoint = source.checkpoints.find((record) => record.boundaryIndex === commit.expected.targetIndex);
          if (previousCheckpoint) checkpoints.delete(previousCheckpoint.id);
          checkpoints.add(commit.checkpoint);
          tx.objectStore(stores.battleStorySessions).put(commit.session);
          result = receipt;
        }, abort);
      } catch (error) { abort(error); } };
    } catch (error) { abort(error); }
  });
};
