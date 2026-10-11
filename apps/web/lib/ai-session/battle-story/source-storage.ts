import { openAiSessionDb } from '@/lib/ai-session/storage';
import { AI_SESSION_STORE_NAMES as stores } from '@/lib/ai-session/types';
import { BattleStoryCommitConflictError } from './commit-storage';
import type { BattleStoryChapterRecord, BattleStoryCheckpointRecord, BattleStorySessionRecord } from './types';

export type WebBattleStorySource = {
  session: BattleStorySessionRecord | null;
  chapters: BattleStoryChapterRecord[];
  checkpoints: BattleStoryCheckpointRecord[];
};
const storeNames = [stores.battleStorySessions, stores.battleStoryChapters, stores.battleStoryCheckpoints];
const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const canonicalBattleStorySource = (source: WebBattleStorySource): WebBattleStorySource => ({
  session: source.session,
  chapters: [...source.chapters].sort((a, b) => a.index - b.index || compareIds(a.id, b.id)),
  checkpoints: [...source.checkpoints].sort((a, b) => a.boundaryIndex - b.boundaryIndex || compareIds(a.id, b.id)),
});

/** Callback-only reads keep the caller's IDB transaction alive through CAS and writes.
 * Store cursors deliberately include malformed/unindexed orphan rows owned by this session.
 */
export const readBattleStorySourceInTransaction = (tx: IDBTransaction, sessionId: string, done: (source: WebBattleStorySource) => void, fail: (error: unknown) => void) => {
  const source: WebBattleStorySource = { session: null, chapters: [], checkpoints: [] };
  let pending = 3;
  const complete = () => { if (--pending === 0) done(canonicalBattleStorySource(source)); };
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

export const readBattleStorySource = async (sessionId: string): Promise<WebBattleStorySource> => {
  const db = await openAiSessionDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, 'readonly');
    let result: WebBattleStorySource | undefined;
    let failure: unknown;
    tx.oncomplete = () => result ? resolve(result) : reject(new Error('故事源读取未完成'));
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('故事源读取失败'));
    tx.onerror = () => { failure ??= tx.error; };
    readBattleStorySourceInTransaction(tx, sessionId, (source) => { result = source; }, (error) => { failure = error; tx.abort(); });
  });
};

const validSourceId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const checkSource: (condition: unknown, message?: string) => asserts condition = (condition, message = '源故事关系无效。') => {
  if (!condition) throw new BattleStoryCommitConflictError(message);
};

/** Validate the complete owned graph, including rows absent from compound indexes. */
export const assertBattleStorySourceGraph = (source: WebBattleStorySource) => {
  const session = source.session;
  checkSource(session && validSourceId(session.id));
  const ordered = canonicalBattleStorySource(source);
  const active = ordered.chapters.filter((chapter) => chapter.status !== 'superseded');
  const count = session.chapterCount;
  checkSource(Number.isSafeInteger(count) && count >= 1 && active.length === count
    && session.lastChapterId === active.at(-1)?.id
    && active.every((chapter, index) => chapter.index === index + 1 && !chapter.supersededByChapterId)
    && new Set(source.chapters.map((chapter) => chapter.id)).size === source.chapters.length
    && new Set(source.checkpoints.map((checkpoint) => checkpoint.id)).size === source.checkpoints.length
    && new Set(source.checkpoints.map((checkpoint) => checkpoint.boundaryIndex)).size === source.checkpoints.length
    && source.chapters.every((chapter) => validSourceId(chapter.id) && chapter.sessionId === session.id
      && Number.isSafeInteger(chapter.index) && chapter.index >= 1 && chapter.index <= count
      && (chapter.status === undefined || chapter.status === 'active' || chapter.status === 'superseded'))
    && source.checkpoints.every((checkpoint) => validSourceId(checkpoint.id) && checkpoint.sessionId === session.id
      && Number.isSafeInteger(checkpoint.boundaryIndex) && checkpoint.boundaryIndex >= 0 && checkpoint.boundaryIndex <= count
      && (checkpoint.boundaryIndex === 0 ? !checkpoint.chapterId
        : checkpoint.chapterId === active[checkpoint.boundaryIndex - 1]?.id)),
  '源故事关系无效，请检查已保存章节后再操作。');
  return { session, active };
};
