import '@/tests/helpers/fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAiSessionDbForTest, openAiSessionDb, requestToPromise, transactionToPromise } from '@/lib/ai-session/storage';
import { AI_SESSION_DB_NAME, AI_SESSION_STORE_NAMES } from '@/lib/ai-session/types';
import * as storage from '@/lib/ai-session/battle-story/storage';

const makeRecords = () => {
  const session = storage.createBattleStorySessionRecord({
    title: '父会话门禁',
    source: { mode: 'daily', language: 'zh-CN', storyLength: 'standard', generationMode: 'stream' },
    seed: { combatants: [], settings: { readArenaHistory: false, writeArenaHistory: false, readCurrentState: false, writeCurrentState: false, readNarrativeHistory: false, writeNarrativeHistory: false } },
    workingCombatants: [],
  });
  const chapter = storage.createBattleStoryChapterRecord({
    sessionId: session.id, index: 1, action: 'branch', title: '正文', markdown: '# 完整正文',
    reportJson: { extension: ['保留'] }, deterministicDigest: { chapterTitle: '正文' },
  });
  const checkpoint = storage.createBattleStoryCheckpointRecord({ sessionId: session.id, boundaryIndex: 1, chapterId: chapter.id, combatants: [{ extension: '原角色' }] });
  return { session, chapter, checkpoint };
};
type Records = ReturnType<typeof makeRecords>;
const writers = {
  chapter: (records: Records) => storage.putBattleStoryChapter(records.chapter),
  checkpoint: (records: Records) => storage.putBattleStoryCheckpoint(records.checkpoint),
  checkpoints: (records: Records) => storage.putBattleStoryCheckpoints([records.checkpoint]),
};
const allStores = [AI_SESSION_STORE_NAMES.battleStorySessions, AI_SESSION_STORE_NAMES.battleStoryChapters, AI_SESSION_STORE_NAMES.battleStoryCheckpoints];

beforeEach(async () => {
  await __resetAiSessionDbForTest();
  await requestToPromise(indexedDB.deleteDatabase(AI_SESSION_DB_NAME));
});
afterEach(async () => { vi.restoreAllMocks(); await __resetAiSessionDbForTest(); });

describe('legacy story child writes require a parent in the same transaction', () => {
  it.each(Object.keys(writers) as (keyof typeof writers)[])('%s rejects after deletion without issuing any put', async (kind) => {
    const records = makeRecords();
    await storage.putBattleStorySession(records.session);
    await storage.deleteBattleStorySession(records.session.id);
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    await expect(writers[kind](records)).rejects.toThrow('未找到 battle story session');
    expect(put).not.toHaveBeenCalled();
    expect(await storage.getBattleStorySession(records.session.id)).toBeNull();
    expect(await storage.listBattleStoryChaptersBySession(records.session.id, { includeSuperseded: true })).toEqual([]);
    expect(await storage.listBattleStoryCheckpointsBySession(records.session.id)).toEqual([]);
  });

  it('batch checks every parent before any put and does not partially update valid checkpoints', async () => {
    const valid = makeRecords(); const missing = makeRecords();
    await storage.putBattleStorySession(valid.session);
    await storage.putBattleStoryCheckpoint(valid.checkpoint);
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    await expect(storage.putBattleStoryCheckpoints([
      { ...valid.checkpoint, combatants: [{ changed: true }] }, missing.checkpoint,
    ])).rejects.toThrow('未找到 battle story session');
    expect(put).not.toHaveBeenCalled();
    expect(await storage.listBattleStoryCheckpointsBySession(valid.session.id)).toEqual([valid.checkpoint]);
    expect(await storage.listBattleStoryCheckpointsBySession(missing.session.id)).toEqual([]);
  });

  it('normal chapter/single/batch writes retain exact records, including multiple parent sessions', async () => {
    const first = makeRecords(); const second = makeRecords();
    await storage.putBattleStorySession(first.session); await storage.putBattleStorySession(second.session);
    await storage.putBattleStoryChapter(first.chapter);
    await storage.putBattleStoryCheckpoint(first.checkpoint);
    const updated = { ...first.checkpoint, combatants: [{ extension: ['保留', '更新'] }] };
    await storage.putBattleStoryCheckpoints([updated, second.checkpoint]);
    expect(await storage.getBattleStoryChapter(first.chapter.id)).toEqual(first.chapter);
    expect(await storage.listBattleStoryCheckpointsBySession(first.session.id)).toEqual([updated]);
    expect(await storage.listBattleStoryCheckpointsBySession(second.session.id)).toEqual([second.checkpoint]);
    expect(await storage.getBattleStorySession(first.session.id)).toEqual(first.session);
    await expect(storage.putBattleStoryCheckpoints([])).resolves.toBeUndefined();
  });

  it('does not repair or overwrite a pre-existing orphan when rejecting a new write', async () => {
    const records = makeRecords();
    const db = await openAiSessionDb();
    const seed = db.transaction(allStores, 'readwrite');
    seed.objectStore(AI_SESSION_STORE_NAMES.battleStoryChapters).put(records.chapter);
    seed.objectStore(AI_SESSION_STORE_NAMES.battleStoryCheckpoints).put(records.checkpoint);
    await transactionToPromise(seed);
    await expect(storage.putBattleStoryChapter({ ...records.chapter, markdown: '替换正文' })).rejects.toThrow();
    await expect(storage.putBattleStoryCheckpoint({ ...records.checkpoint, combatants: [] })).rejects.toThrow();
    expect(await storage.getBattleStorySession(records.session.id)).toBeNull();
    expect(await storage.getBattleStoryChapter(records.chapter.id)).toEqual(records.chapter);
    expect(await storage.listBattleStoryCheckpointsBySession(records.session.id)).toEqual([records.checkpoint]);
  });

  it.each(Object.keys(writers) as (keyof typeof writers)[])('%s rejects a transaction abort even after the child request succeeded', async (kind) => {
    const records = makeRecords(); await storage.putBattleStorySession(records.session);
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      const request = original.apply(this, args);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(writers[kind](records)).rejects.toBeTruthy();
    expect(await storage.getBattleStoryChapter(records.chapter.id)).toBeNull();
    expect(await storage.listBattleStoryCheckpointsBySession(records.session.id)).toEqual([]);
    expect(await storage.getBattleStorySession(records.session.id)).toEqual(records.session);
  });

  it.each(Object.keys(writers) as (keyof typeof writers)[])('%s keeps a second connection deletion behind the parent check and child write', async (kind) => {
    const records = makeRecords(); await storage.putBattleStorySession(records.session);
    const other = await requestToPromise(indexedDB.open(AI_SESSION_DB_NAME));
    const order: string[] = [];
    let deletion: Promise<void> | undefined;
    const getKey = IDBObjectStore.prototype.getKey;
    vi.spyOn(IDBObjectStore.prototype, 'getKey').mockImplementation(function(this: IDBObjectStore, ...args) {
      const request = getKey.apply(this, args);
      if (this.name === AI_SESSION_STORE_NAMES.battleStorySessions) {
        request.addEventListener('success', () => {
          // Queue the competing transaction after the parent read, before the writer's success handler.
          this.transaction.addEventListener('complete', () => order.push('write'));
          const transaction = other.transaction(allStores, 'readwrite');
          transaction.objectStore(AI_SESSION_STORE_NAMES.battleStorySessions).delete(records.session.id);
          transaction.objectStore(AI_SESSION_STORE_NAMES.battleStoryChapters).clear();
          transaction.objectStore(AI_SESSION_STORE_NAMES.battleStoryCheckpoints).clear();
          deletion = transactionToPromise(transaction).then(() => { order.push('delete'); });
        });
      }
      return request;
    });
    try {
      await writers[kind](records);
      expect(deletion).toBeDefined(); await deletion;
      expect(order).toEqual(['write', 'delete']);
      expect(await storage.getBattleStorySession(records.session.id)).toBeNull();
      expect(await storage.getBattleStoryChapter(records.chapter.id)).toBeNull();
      expect(await storage.listBattleStoryCheckpointsBySession(records.session.id)).toEqual([]);
    } finally { other.close(); }
  });

  it.each(Object.keys(writers) as (keyof typeof writers)[])('%s rejects a changed child parent identity while the parent lookup is pending', async (kind) => {
    const records = makeRecords();
    await storage.putBattleStorySession(records.session);
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const getKey = IDBObjectStore.prototype.getKey;
    vi.spyOn(IDBObjectStore.prototype, 'getKey').mockImplementation(function(this: IDBObjectStore, ...args) {
      const request = getKey.apply(this, args);
      request.addEventListener('success', () => {
        records.chapter.sessionId = 'missing-parent'; records.checkpoint.sessionId = 'missing-parent';
      });
      return request;
    });
    await expect(writers[kind](records)).rejects.toThrow('所属会话已变化');
    expect(put).not.toHaveBeenCalled();
    expect(await storage.getBattleStoryChapter(records.chapter.id)).toBeNull();
    expect(await storage.listBattleStoryCheckpointsBySession(records.session.id)).toEqual([]);
    expect(await storage.listBattleStoryChaptersBySession('missing-parent')).toEqual([]);
    expect(await storage.listBattleStoryCheckpointsBySession('missing-parent')).toEqual([]);
  });
});
