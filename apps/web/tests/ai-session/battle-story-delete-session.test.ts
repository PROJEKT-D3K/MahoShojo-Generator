import '@/tests/helpers/fake-indexeddb';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { __resetAiSessionDbForTest, openAiSessionDb, requestToPromise, transactionToPromise } from '@/lib/ai-session/storage';
import { AI_SESSION_DB_NAME, AI_SESSION_STORE_NAMES } from '@/lib/ai-session/types';
import * as storage from '@/lib/ai-session/battle-story/storage';
import { freezeBattleStoryCommit } from '@mahoshojo/domain/arena-story-commit';

async function seed(count: number, title = '待删除完整会话') {
  const session = storage.createBattleStorySessionRecord({ title, source: { mode: 'daily', language: 'zh-CN', storyLength: 'standard', generationMode: 'stream' }, seed: { combatants: [], settings: { readArenaHistory: false, writeArenaHistory: false, readCurrentState: false, writeCurrentState: false, readNarrativeHistory: false, writeNarrativeHistory: false } }, workingCombatants: [] });
  const db = await openAiSessionDb(); const tx = db.transaction([AI_SESSION_STORE_NAMES.battleStorySessions, AI_SESSION_STORE_NAMES.battleStoryChapters, AI_SESSION_STORE_NAMES.battleStoryCheckpoints], 'readwrite');
  const chapters = [];
  for (let index = 1; index <= count; index++) {
    const chapter = storage.createBattleStoryChapterRecord({ sessionId: session.id, index, action: index === 1 ? 'start' : 'continue', title: `第${index}章`, markdown: `原正文${index}`, reportJson: { extension: '保留' }, deterministicDigest: { chapterTitle: `第${index}章` } });
    if (index % 2 === 0) chapter.status = 'superseded';
    tx.objectStore(AI_SESSION_STORE_NAMES.battleStoryChapters).put(chapter); chapters.push(chapter);
    tx.objectStore(AI_SESSION_STORE_NAMES.battleStoryCheckpoints).put(storage.createBattleStoryCheckpointRecord({ sessionId: session.id, boundaryIndex: index, chapterId: chapter.id, combatants: [{ source: title }] }));
  }
  session.chapterCount = count; session.lastChapterId = chapters.at(-1)?.id ?? null;
  tx.objectStore(AI_SESSION_STORE_NAMES.battleStorySessions).put(session); await transactionToPromise(tx);
  return { session, chapters };
}
const snapshots = async (id: string) => ({ session: await storage.getBattleStorySession(id), chapters: await storage.listBattleStoryChaptersBySession(id, { limit: 9999, includeSuperseded: true }), checkpoints: await storage.listBattleStoryCheckpointsBySession(id, { limit: 9999 }) });
beforeEach(async () => { await __resetAiSessionDbForTest(); await requestToPromise(indexedDB.deleteDatabase(AI_SESSION_DB_NAME)); });
afterEach(async () => { vi.restoreAllMocks(); await __resetAiSessionDbForTest(); });
it.each([0, 1, 501])('deletes %i chapters including superseded and all checkpoints, preserving other branches', async (count) => {
  const a = await seed(count); const b = await seed(2, '其它分支');
  await storage.updateBattleStorySession(b.session.id, current => ({ ...current, branchOf: { sessionId: a.session.id, chapterId: a.session.lastChapterId ?? 'old', chapterIndex: 1, createdAt: current.createdAt } }));
  const other = await snapshots(b.session.id); const expected = freezeBattleStoryCommit((await storage.getBattleStorySession(a.session.id))!);
  expect(await storage.deleteBattleStorySession(a.session.id, expected)).toEqual({ status: 'deleted', deletedSession: true, deletedChapterCount: count, deletedCheckpointCount: count });
  expect(await snapshots(a.session.id)).toEqual({ session: null, chapters: [], checkpoints: [] }); expect(await snapshots(b.session.id)).toEqual(other);
  expect(await storage.deleteBattleStorySession(a.session.id, expected)).toEqual({ status: 'currently-absent', deletedSession: false, deletedChapterCount: 0, deletedCheckpointCount: 0 });
});
it('old confirmation conflicts with a later head/summary without deleting any record', async () => {
  const a = await seed(2); const expected = freezeBattleStoryCommit((await storage.getBattleStorySession(a.session.id))!);
  await storage.updateBattleStorySession(a.session.id, current => ({ ...current, sessionSummary: '新摘要', updatedAt: current.updatedAt + 1 }));
  const before = await snapshots(a.session.id); expect((await storage.deleteBattleStorySession(a.session.id, expected)).status).toBe('conflict'); expect(await snapshots(a.session.id)).toEqual(before);
});
it.each(['chapter-before', 'chapter-after', 'checkpoint-before', 'checkpoint-after', 'session-before', 'session-after'] as const)('%s fault abort rolls back all stores', async (at) => {
  const a = await seed(3); const before = await snapshots(a.session.id);
  const cursorDelete = IDBCursor.prototype.delete; const storeDelete = IDBObjectStore.prototype.delete;
  const cursorSpy = vi.spyOn(IDBCursor.prototype, 'delete').mockImplementation(function (this: IDBCursor) {
    const source = this.source as IDBIndex; const kind = source.objectStore.name === AI_SESSION_STORE_NAMES.battleStoryChapters ? 'chapter' : 'checkpoint';
    if (at === `${kind}-before`) throw new Error('injected before');
    const result = cursorDelete.call(this); if (at === `${kind}-after`) source.objectStore.transaction.abort(); return result;
  });
  const storeSpy = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    if (this.name !== AI_SESSION_STORE_NAMES.battleStorySessions) return storeDelete.call(this, key);
    if (at === 'session-before') throw new Error('injected before');
    const result = storeDelete.call(this, key); if (at === 'session-after') this.transaction.abort(); return result;
  });
  await expect(storage.deleteBattleStorySession(a.session.id, before.session!)).rejects.toBeInstanceOf(storage.BattleStoryDeleteNotWrittenError);
  cursorSpy.mockRestore(); storeSpy.mockRestore(); expect(await snapshots(a.session.id)).toEqual(before);
});
it('rejects a mismatched expected identity before a transaction and keeps original records', async () => {
  const a = await seed(1); const before = await snapshots(a.session.id);
  await expect(storage.deleteBattleStorySession(a.session.id, { ...a.session, id: 'wrong' })).rejects.toThrow('身份不匹配'); expect(await snapshots(a.session.id)).toEqual(before);
});
