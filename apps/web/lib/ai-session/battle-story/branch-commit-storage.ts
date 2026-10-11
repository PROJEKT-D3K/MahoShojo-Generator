import { digestBattleStoryCommitValue as digest, freezeBattleStoryCommit } from '@mahoshojo/domain/arena-story-commit';
import { cloneBattleStoryActiveChaptersForNewSession, cloneBattleStoryCheckpointsForNewSession, remapBattleStorySummaryMeta, resolveAnchoredSummaryState, resolveBattleStoryChapterOutputCombatants } from '@mahoshojo/domain/arena-story-branch';
import { openAiSessionDb, requestToPromise, transactionToPromise } from '@/lib/ai-session/storage';
import { AI_SESSION_STORE_NAMES as stores } from '@/lib/ai-session/types';
import { BattleStoryCommitConflictError, BattleStoryCommitNotSavedError } from './commit-storage';
import type { BattleStoryChapterRecord, BattleStoryCheckpointRecord, BattleStorySessionRecord } from './types';

export type WebBattleStoryBranchSource = { session: BattleStorySessionRecord | null; chapters: BattleStoryChapterRecord[]; checkpoints: BattleStoryCheckpointRecord[] };
export type WebBattleStoryBranchExpected = { sourceSessionId: string; sourceDigest: string; anchorChapterId: string; anchorIndex: number };
export type WebBattleStoryBranchCommit = { version: 2; action: 'branch'; operationId: string; expected: WebBattleStoryBranchExpected; session: BattleStorySessionRecord; chapter: BattleStoryChapterRecord; copiedChapters: BattleStoryChapterRecord[]; checkpoints: BattleStoryCheckpointRecord[] };
export type WebBattleStoryBranchReceipt = { version: 2; kind: 'branch'; operationId: string; sessionId: string; chapterId: string; chapterIndex: number; chapterCount: number; prefixEndIndex: number; anchorChapterId: string; checkpointId: string; contentDigest: string };
const storeNames = [stores.battleStorySessions, stores.battleStoryChapters, stores.battleStoryCheckpoints];
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const validId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);
const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const canonicalSource = (source: WebBattleStoryBranchSource): WebBattleStoryBranchSource => ({
  session: source.session,
  chapters: [...source.chapters].sort((a, b) => a.index - b.index || compareIds(a.id, b.id)),
  checkpoints: [...source.checkpoints].sort((a, b) => a.boundaryIndex - b.boundaryIndex || compareIds(a.id, b.id)),
});
const check: (condition: unknown, message?: string) => asserts condition = (condition, message = '分支提交关系无效，尚未保存。') => { if (!condition) throw new BattleStoryCommitConflictError(message); };

/** Callback-only reads keep the caller's IDB transaction alive through CAS and writes.
 * Store cursors deliberately include malformed/unindexed orphan rows owned by this session.
 */
const readSourceInTransaction = (tx: IDBTransaction, sessionId: string, done: (source: WebBattleStoryBranchSource) => void, fail: (error: unknown) => void) => {
  const source: WebBattleStoryBranchSource = { session: null, chapters: [], checkpoints: [] };
  let pending = 3;
  const complete = () => { if (--pending === 0) done(canonicalSource(source)); };
  const session = tx.objectStore(stores.battleStorySessions).get(sessionId);
  session.onsuccess = () => { try { source.session = session.result ?? null; complete(); } catch (error) { fail(error); } };
  for (const [store, destination] of [[stores.battleStoryChapters, source.chapters], [stores.battleStoryCheckpoints, source.checkpoints]] as const) {
    const request = tx.objectStore(store).openCursor();
    request.onsuccess = () => { try {
      const cursor = request.result;
      if (!cursor) { complete(); return; }
      if (cursor.value.sessionId === sessionId) (destination as unknown[]).push(cursor.value);
      cursor.continue();
    } catch (error) { fail(error); } };
  }
};

export const readBattleStoryBranchSource = async (sessionId: string): Promise<WebBattleStoryBranchSource> => {
  const db = await openAiSessionDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, 'readonly');
    let result: WebBattleStoryBranchSource | undefined;
    let failure: unknown;
    tx.oncomplete = () => result ? resolve(result) : reject(new Error('分支源读取未完成'));
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('分支源读取失败'));
    tx.onerror = () => { failure ??= tx.error; };
    readSourceInTransaction(tx, sessionId, (source) => { result = source; }, (error) => { failure = error; tx.abort(); });
  });
};

export const captureBattleStoryBranchExpected = (source: WebBattleStoryBranchSource, anchorId: string): WebBattleStoryBranchExpected => {
  check(source.session && validId(source.session.id));
  const session = source.session;
  const ordered = canonicalSource(source);
  const active = ordered.chapters.filter((chapter) => chapter.status !== 'superseded');
  check(Number.isSafeInteger(session.chapterCount) && session.chapterCount >= 1
    && active.length === session.chapterCount && session.lastChapterId === active.at(-1)?.id
    && active.every((chapter, index) => chapter.index === index + 1)
    && new Set(source.chapters.map((chapter) => chapter.id)).size === source.chapters.length
    && new Set(source.checkpoints.map((checkpoint) => checkpoint.id)).size === source.checkpoints.length
    && new Set(source.checkpoints.map((checkpoint) => checkpoint.boundaryIndex)).size === source.checkpoints.length
    && source.chapters.every((chapter) => chapter.sessionId === session.id)
    && source.checkpoints.every((checkpoint) => checkpoint.sessionId === session.id), '源故事关系无效，请检查已保存章节后再分支。');
  const anchor = active.find((chapter) => chapter.id === anchorId);
  check(anchor && Number.isSafeInteger(anchor.index) && anchor.index >= 1);
  return { sourceSessionId: source.session.id, sourceDigest: digest(canonicalSource(source)), anchorChapterId: anchor.id, anchorIndex: anchor.index };
};

const receiptKeys = ['version', 'kind', 'operationId', 'sessionId', 'chapterId', 'chapterIndex', 'chapterCount', 'prefixEndIndex', 'anchorChapterId', 'checkpointId', 'contentDigest'];
export const isWebBattleStoryBranchReceipt = (value: unknown): value is WebBattleStoryBranchReceipt => {
  if (!value || typeof value !== 'object') return false;
  const r = value as WebBattleStoryBranchReceipt;
  return Object.keys(r).length === receiptKeys.length && receiptKeys.every((key) => Object.prototype.hasOwnProperty.call(r, key))
    && r.version === 2 && r.kind === 'branch'
    && [r.operationId, r.sessionId, r.chapterId, r.anchorChapterId, r.checkpointId].every(validId)
    && r.chapterId === r.operationId && Number.isSafeInteger(r.prefixEndIndex) && r.prefixEndIndex >= 1 && r.prefixEndIndex < Number.MAX_SAFE_INTEGER
    && r.chapterIndex === r.prefixEndIndex + 1 && r.chapterCount === r.chapterIndex
    && typeof r.contentDigest === 'string' && digestPattern.test(r.contentDigest)
    && new TextEncoder().encode(JSON.stringify(r)).length <= 2048;
};
export const createBattleStoryBranchReceipt = (commit: WebBattleStoryBranchCommit): WebBattleStoryBranchReceipt => {
  const receipt: WebBattleStoryBranchReceipt = {
    version: 2, kind: 'branch', operationId: commit.operationId, sessionId: commit.session.id,
    chapterId: commit.chapter.id, chapterIndex: commit.chapter.index, chapterCount: commit.session.chapterCount,
    prefixEndIndex: commit.expected.anchorIndex, anchorChapterId: commit.chapter.sourceChapterId!,
    checkpointId: commit.checkpoints.find((cp) => cp.boundaryIndex === commit.chapter.index)?.id ?? '', contentDigest: digest(commit),
  };
  check(isWebBattleStoryBranchReceipt(receipt));
  return receipt;
};
const exactReceipt = (chapter: (BattleStoryChapterRecord & { commitReceipt?: unknown }) | undefined, target: string, operationId: string, contentDigest: string) => {
  const r = chapter?.commitReceipt;
  return isWebBattleStoryBranchReceipt(r) && r.sessionId === target && r.operationId === operationId && r.contentDigest === contentDigest
    && chapter?.id === r.chapterId && chapter.sessionId === r.sessionId && chapter.index === r.chapterIndex ? r : null;
};
export const getBattleStoryBranchOperationReceipt = async (targetSessionId: string, operationId: string, contentDigest: string): Promise<WebBattleStoryBranchReceipt | null> => {
  const db = await openAiSessionDb();
  const tx = db.transaction(stores.battleStoryChapters, 'readonly');
  const completed = transactionToPromise(tx);
  const [chapter] = await Promise.all([requestToPromise(tx.objectStore(stores.battleStoryChapters).get(operationId)), completed]);
  return exactReceipt(chapter, targetSessionId, operationId, contentDigest);
};

const assertWriteSet = (commit: WebBattleStoryBranchCommit) => {
  const { session, chapter, expected, checkpoints, copiedChapters } = commit;
  const k = expected.anchorIndex;
  check(commit.version === 2 && commit.action === 'branch' && validId(commit.operationId)
    && validId(session.id) && validId(expected.sourceSessionId) && validId(expected.anchorChapterId)
    && digestPattern.test(expected.sourceDigest) && session.id !== expected.sourceSessionId
    && Number.isSafeInteger(k) && k >= 1 && k < Number.MAX_SAFE_INTEGER
    && chapter.id === commit.operationId && chapter.action === 'branch' && chapter.index === k + 1
    && chapter.status === 'active' && !chapter.supersededByChapterId
    && session.lastChapterId === chapter.id && session.chapterCount === k + 1 && copiedChapters.length === k);
  const chapters = [...copiedChapters, chapter];
  check(new Set(chapters.map((c) => c.id)).size === chapters.length && new Set(checkpoints.map((cp) => cp.id)).size === checkpoints.length);
  check(chapters.every((c, index) => validId(c.id) && c.sessionId === session.id && c.index === index + 1 && c.status === 'active' && !Object.prototype.hasOwnProperty.call(c, 'commitReceipt')));
  check(chapter.sourceChapterId === copiedChapters.at(-1)?.id);
  check(checkpoints.every((cp) => validId(cp.id) && cp.sessionId === session.id && Number.isSafeInteger(cp.boundaryIndex) && cp.boundaryIndex >= 0 && cp.boundaryIndex <= k + 1));
  check(new Set(checkpoints.map((cp) => cp.boundaryIndex)).size === checkpoints.length);
  const output = checkpoints.find((cp) => cp.boundaryIndex === k + 1);
  const anchor = checkpoints.find((cp) => cp.boundaryIndex === k);
  const seed = checkpoints.find((cp) => cp.boundaryIndex === 0);
  check(output && anchor && seed && output.chapterId === chapter.id && !seed.chapterId);
  check(digest(output.combatants) === digest(session.workingCombatants));
  check(session.branchOf?.sessionId === expected.sourceSessionId && session.branchOf.chapterId === expected.anchorChapterId && session.branchOf.chapterIndex === k);
};

/** Validate copied values against the actual source, preserving opaque business extensions. */
const assertSourceAndCopies = (commit: WebBattleStoryBranchCommit, source: WebBattleStoryBranchSource) => {
  const { expected, copiedChapters, checkpoints, session } = commit;
  check(source.session && digest(source) === expected.sourceDigest, '源故事已变化，分支尚未保存。');
  check(digest(session.seed) === digest(source.session.seed)
    && digest({ plan: session.chapterPlan }) === digest({ plan: source.session.chapterPlan }));
  const active = source.chapters.filter((c) => c.status !== 'superseded');
  check(active.length === source.session.chapterCount && active.every((c, i) => c.index === i + 1)
    && source.session.lastChapterId === active.at(-1)?.id && active[expected.anchorIndex - 1]?.id === expected.anchorChapterId);
  const prefix = active.slice(0, expected.anchorIndex);
  const cleanPrefix = prefix.map((c) => { const clean = { ...c } as BattleStoryChapterRecord & { commitReceipt?: unknown }; delete clean.commitReceipt; return clean; });
  const projected = cloneBattleStoryActiveChaptersForNewSession({ chapters: cleanPrefix, newSessionId: session.id, allocateId: (c) => copiedChapters[c.index - 1]!.id });
  check(digest(projected.chapters) === digest(copiedChapters));
  const sourceCheckpoints = source.checkpoints.filter((cp) => cp.boundaryIndex <= expected.anchorIndex);
  const projectedCheckpoints = cloneBattleStoryCheckpointsForNewSession({ checkpoints: sourceCheckpoints, newSessionId: session.id, chapterIdMap: projected.chapterIdMap, maxBoundaryIndex: expected.anchorIndex, allocateId: (cp) => checkpoints.find((target) => target.boundaryIndex === cp.boundaryIndex)?.id ?? '' });
  for (const cp of projectedCheckpoints) check(digest(cp) === digest(checkpoints.find((target) => target.boundaryIndex === cp.boundaryIndex)));
  for (const cp of checkpoints.filter((cp) => cp.boundaryIndex <= expected.anchorIndex)) {
    if (sourceCheckpoints.some((original) => original.boundaryIndex === cp.boundaryIndex)) continue;
    check(cp.boundaryIndex === 0 || cp.boundaryIndex === expected.anchorIndex);
    if (cp.boundaryIndex === expected.anchorIndex) check(cp.chapterId === copiedChapters.at(-1)?.id);
    const combatants = cp.boundaryIndex === 0 ? source.session.seed.combatants : resolveBattleStoryChapterOutputCombatants({ session: source.session, checkpoints: source.checkpoints, chapter: prefix.at(-1)!, latestChapter: active.at(-1) ?? null });
    check(combatants && digest(cp.combatants) === digest(combatants));
  }
  const inputCombatants = resolveBattleStoryChapterOutputCombatants({ session: source.session, checkpoints: source.checkpoints, chapter: prefix.at(-1)!, latestChapter: active.at(-1) ?? null });
  check(inputCombatants && digest(inputCombatants) === digest(session.lastChapterInputCombatants ?? null));
  const summary = resolveAnchoredSummaryState({ sessionSummary: source.session.sessionSummary, summaryMeta: source.session.summaryMeta, maxCoveredChapterIndex: expected.anchorIndex });
  check(digest({ value: session.sessionSummary }) === digest({ value: summary.sessionSummary })
    && digest({ value: session.summaryMeta }) === digest({ value: remapBattleStorySummaryMeta(summary.summaryMeta, projected.chapterIdMap) }));
};

export const commitCompletedBattleStoryBranch = async (input: WebBattleStoryBranchCommit): Promise<WebBattleStoryBranchReceipt> => {
  let commit: WebBattleStoryBranchCommit; let receipt: WebBattleStoryBranchReceipt; let db: IDBDatabase;
  try { commit = freezeBattleStoryCommit(input); assertWriteSet(commit); receipt = createBattleStoryBranchReceipt(commit); db = await openAiSessionDb(); }
  catch (error) { throw new BattleStoryCommitNotSavedError(error); }
  return await new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(storeNames, 'readwrite'); } catch (error) { reject(new BattleStoryCommitNotSavedError(error)); return; }
    let result: WebBattleStoryBranchReceipt | undefined; let failure: unknown;
    const abort = (error: unknown) => { failure = error; try { tx.abort(); } catch (abortError) { reject(abortError); } };
    tx.oncomplete = () => result ? resolve(result) : reject(new Error('分支保存结果未知，请查询原回执。'));
    tx.onabort = () => reject(new BattleStoryCommitNotSavedError(failure ?? tx.error ?? new Error('分支保存事务已回滚。')));
    tx.onerror = () => { failure ??= tx.error; };
    const chapters = tx.objectStore(stores.battleStoryChapters);
    const existing = chapters.get(commit.operationId);
    existing.onsuccess = () => { try {
      const previous = exactReceipt(existing.result, commit.session.id, commit.operationId, receipt.contentDigest);
      if (previous) { result = previous; return; }
      check(!existing.result, '同一保存操作内容不一致，未覆盖原记录。');
      readSourceInTransaction(tx, commit.session.id, (target) => {
        check(!target.session && !target.chapters.length && !target.checkpoints.length, '分支目标或所属记录已存在，未覆盖原记录。');
        readSourceInTransaction(tx, commit.expected.sourceSessionId, (source) => {
          assertSourceAndCopies(commit, source);
          tx.objectStore(stores.battleStorySessions).add(commit.session);
          for (const chapter of commit.copiedChapters) chapters.add(chapter);
          chapters.add({ ...commit.chapter, commitReceipt: receipt });
          for (const checkpoint of commit.checkpoints) tx.objectStore(stores.battleStoryCheckpoints).add(checkpoint);
          result = receipt;
        }, abort);
      }, abort);
    } catch (error) { abort(error); } };
  });
};
