import '@/tests/helpers/fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildCompletedBattleStoryTailRewriteRecords, resolveBattleStoryChapterInputCombatants } from '@mahoshojo/domain/arena-story-tail-rewrite';
import { buildCompletedBattleStoryCommit, captureBattleStoryCommitExpected } from '@mahoshojo/domain/arena-story-commit';
import { __resetAiSessionDbForTest, openAiSessionDb, transactionToPromise } from '@/lib/ai-session/storage';
import { AI_SESSION_DB_NAME, AI_SESSION_STORE_NAMES as stores } from '@/lib/ai-session/types';
import * as storage from '@/lib/ai-session/battle-story/storage';
import { isWebBattleStoryBranchReceipt } from '@/lib/ai-session/battle-story/branch-commit-storage';
import { isWebBattleStoryTailRewriteReceipt, type WebBattleStoryTailRewriteCommit, type WebBattleStoryTailRewriteReceipt } from '@/lib/ai-session/battle-story/tail-rewrite-commit-storage';

beforeEach(async () => {
  await __resetAiSessionDbForTest();
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(AI_SESSION_DB_NAME); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
});
afterEach(async () => { vi.restoreAllMocks(); await __resetAiSessionDbForTest(); });
const rawPut = async (store: string, record: unknown) => {
  const db = await openAiSessionDb(); const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(record); await transactionToPromise(tx);
};
const read = () => storage.readBattleStoryTailRewriteSource('source');
const prepare = async (operationId = 'operation'): Promise<WebBattleStoryTailRewriteCommit> => {
  const source = await read(); const session = source.session!;
  const target = source.chapters.find((chapter) => chapter.id === session.lastChapterId)!;
  const inputCombatants = resolveBattleStoryChapterInputCombatants({ session, checkpoints: source.checkpoints, chapter: target, latestChapter: target })!;
  return { version: 1, action: 'tail-rewrite', operationId,
    expected: storage.captureBattleStoryTailRewriteExpected(source, target.id),
    ...buildCompletedBattleStoryTailRewriteRecords({
      session, targetChapter: target, operationId, checkpointId: `${operationId}-cp`, now: 100,
      source: { ...session.source, modelId: 'new-model' }, inputCombatants,
      generated: { chapterIndex: target.index, markdown: `# 重写 ${operationId}\n全文\u0000😀\ud800`, reportJson: { nested: [null, false, '完整'] },
        digest: { chapterTitle: '重写标题' }, generationId: 'generation', cardSnapshot: { userGuidance: '完整引导' },
        nextWorkingCombatants: [{ name: operationId }] },
    }),
  };
};
const fixture = async (count = 2) => {
  const session = { ...storage.createBattleStorySessionRecord({
    title: '未命名连续战报', source: { mode: 'daily', language: 'zh', storyLength: 'standard', generationMode: 'stream' },
    seed: { combatants: [{ name: 'state0' }], settings: { readArenaHistory: false, writeArenaHistory: false, readCurrentState: false, writeCurrentState: false, readNarrativeHistory: false, writeNarrativeHistory: false } },
    workingCombatants: [{ name: `state${count}` }], lastChapterInputCombatants: [{ name: `state${count - 1}` }],
    chapterPlan: { totalChapters: count, source: 'user', locked: true },
    branchOf: { sessionId: 'parent', chapterId: 'parent-c', chapterIndex: 4, createdAt: 0 },
  }), id: 'source', chapterCount: count, lastChapterId: `c${count}`, opaque: { keep: ['原文\u0000😀\ud800'] } };
  await rawPut(stores.battleStorySessions, session);
  for (let index = 1; index <= count; index++) await rawPut(stores.battleStoryChapters, {
    ...storage.createBattleStoryChapterRecord({ sessionId: session.id, index, action: index === 1 ? 'start' : 'continue',
      title: `第${index}章`, markdown: `旧正文${index}`, reportJson: { extension: true }, deterministicDigest: { chapterTitle: `第${index}章` },
      sourceChapterId: index > 1 ? `c${index - 1}` : undefined }),
    id: `c${index}`, opaque: { keep: index }, commitReceipt: { legacy: index },
  });
  for (let boundaryIndex = 0; boundaryIndex <= count; boundaryIndex++) await rawPut(stores.battleStoryCheckpoints, {
    id: `p${boundaryIndex}`, sessionId: session.id, boundaryIndex, chapterId: boundaryIndex ? `c${boundaryIndex}` : undefined,
    combatants: [{ name: `state${boundaryIndex}` }], createdAt: 1, opaque: { checkpoint: boundaryIndex },
  });
  return prepare();
};

describe('Web tail rewrite atomic graph', () => {
  it('uses one readonly full graph snapshot, beyond the recent window, with canonical ordering', async () => {
    const commit = await fixture(16);
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction'); const snapshot = await read();
    expect(spy).toHaveBeenCalledTimes(1); expect(spy.mock.calls[0]?.[1]).toBe('readonly'); spy.mockRestore();
    expect(snapshot.chapters).toHaveLength(16); expect(snapshot.checkpoints).toHaveLength(17);
    expect(storage.captureBattleStoryTailRewriteExpected({ ...snapshot, chapters: [...snapshot.chapters].reverse(), checkpoints: [...snapshot.checkpoints].reverse() }, 'c16')).toEqual(commit.expected);
  });

  it('atomically supersedes only the old tail, preserves old receipts/extensions, and replaces only its boundary', async () => {
    const commit = await fixture(); const before = await read();
    const receipt = await storage.commitCompletedBattleStoryTailRewrite(commit); const saved = await read();
    expect(saved.session).toEqual(commit.session);
    expect(saved.session).toMatchObject({ title: before.session!.title, chapterCount: 2,
      chapterPlan: before.session!.chapterPlan, branchOf: before.session!.branchOf, opaque: { keep: ['原文\u0000😀\ud800'] } });
    expect(saved.chapters.find((chapter) => chapter.id === 'c1')).toEqual(before.chapters[0]);
    expect(saved.chapters.find((chapter) => chapter.id === 'c2')).toEqual({ ...before.chapters[1], status: 'superseded', supersededByChapterId: 'operation' });
    expect(saved.chapters.find((chapter) => chapter.id === 'operation')).toEqual({ ...commit.chapter, commitReceipt: receipt });
    expect(saved.checkpoints).toEqual([...before.checkpoints.slice(0, -1), commit.checkpoint]);
    expect(await storage.getBattleStoryOperationReceipt('operation')).toBeNull();
    expect(await storage.getBattleStoryBranchOperationReceipt('source', 'operation', receipt.contentDigest)).toBeNull();
    expect(isWebBattleStoryBranchReceipt(receipt)).toBe(false);
  });

  it('preserves exact historical success across repeated tail rewrites, reopen and later append', async () => {
    const commit = await fixture(); const first = await storage.commitCompletedBattleStoryTailRewrite(commit);
    const secondCommit = await prepare('second'); const second = await storage.commitCompletedBattleStoryTailRewrite(secondCommit);
    expect((await storage.getBattleStoryChapter('operation'))).toMatchObject({ status: 'superseded', commitReceipt: first });
    await __resetAiSessionDbForTest();
    const source = await read();
    await storage.commitCompletedBattleStoryChapter(buildCompletedBattleStoryCommit({
      action: 'continue', session: source.session!, expected: captureBattleStoryCommitExpected({ session: source.session!, chapters: source.chapters, checkpoint: source.checkpoints.at(-1)! }),
      operationId: 'later', checkpointId: 'later-cp', now: 200, source: source.session!.source,
      inputCombatants: source.session!.workingCombatants,
      generated: { chapterIndex: 3, markdown: '后续', reportJson: {}, digest: { chapterTitle: '后续' }, nextWorkingCombatants: [{ name: 'later' }] },
    }));
    expect(await storage.getBattleStoryTailRewriteOperationReceipt('source', 'operation', first.contentDigest)).toEqual(first);
    expect(await storage.commitCompletedBattleStoryTailRewrite(commit)).toEqual(first);
    expect(await storage.commitCompletedBattleStoryTailRewrite(secondCommit)).toEqual(second);
    expect((await read()).session?.lastChapterId).toBe('later');
    expect(await storage.getBattleStoryTailRewriteOperationReceipt('other', 'operation', first.contentDigest)).toBeNull();
    expect(await storage.getBattleStoryTailRewriteOperationReceipt('source', 'operation', `sha256:${'0'.repeat(64)}`)).toBeNull();
  });

  it('does not resurrect a truly deleted session or receipt', async () => {
    const commit = await fixture(); const receipt = await storage.commitCompletedBattleStoryTailRewrite(commit);
    await storage.deleteBattleStorySession('source');
    expect(await storage.getBattleStoryTailRewriteOperationReceipt('source', 'operation', receipt.contentDigest)).toBeNull();
    await expect(storage.commitCompletedBattleStoryTailRewrite(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError);
    expect(await read()).toEqual({ session: null, chapters: [], checkpoints: [] });
  });

  it.each(['early-text', 'opaque-chapter', 'summary', 'opaque-session', 'early-checkpoint', 'superseded', 'unindexed-chapter', 'unindexed-checkpoint', 'head', 'delete'] as const)('full source CAS rejects %s without any additional writes', async (kind) => {
    const commit = await fixture(16);
    if (kind === 'early-text' || kind === 'opaque-chapter') await rawPut(stores.battleStoryChapters, { ...(await storage.getBattleStoryChapter('c1'))!, ...(kind === 'early-text' ? { markdown: 'changed' } : { extension: true }) });
    if (kind === 'summary' || kind === 'opaque-session' || kind === 'head') await rawPut(stores.battleStorySessions, { ...(await storage.getBattleStorySession('source'))!, ...(kind === 'summary' ? { sessionSummary: 'changed' } : kind === 'head' ? { lastChapterId: 'changed' } : { extension: true }) });
    if (kind === 'early-checkpoint') await rawPut(stores.battleStoryCheckpoints, { ...(await storage.getBattleStoryCheckpointByBoundary('source', 0))!, extension: true });
    if (kind === 'superseded') await rawPut(stores.battleStoryChapters, { ...(await storage.getBattleStoryChapter('c1'))!, id: 'superseded', status: 'superseded' });
    if (kind === 'unindexed-chapter') await rawPut(stores.battleStoryChapters, { id: 'orphan', sessionId: 'source', status: 'superseded' });
    if (kind === 'unindexed-checkpoint') await rawPut(stores.battleStoryCheckpoints, { id: 'orphan', sessionId: 'source' });
    if (kind === 'delete') await storage.deleteBattleStorySession('source');
    const changed = await read();
    await expect(storage.commitCompletedBattleStoryTailRewrite(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError);
    expect(await read()).toEqual(changed); expect(await storage.getBattleStoryChapter('operation')).toBeNull();
  });

  it('same-content ABA is the same source identity', async () => {
    const commit = await fixture(); const original = (await storage.getBattleStoryChapter('c1'))!;
    await rawPut(stores.battleStoryChapters, { ...original, markdown: 'temporary' }); await rawPut(stores.battleStoryChapters, original);
    await expect(storage.commitCompletedBattleStoryTailRewrite(commit)).resolves.toMatchObject({ kind: 'tail-rewrite' });
  });

  it.each([1, 2, 3, 4, 5])('request-success abort at write %s rolls back the complete graph', async (index) => {
    const commit = await fixture(); const before = await read(); let writes = 0;
    for (const method of ['put', 'add', 'delete'] as const) {
      const original = IDBObjectStore.prototype[method];
      vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function(this: IDBObjectStore, ...args: unknown[]) {
        const request = Reflect.apply(original, this, args) as IDBRequest;
        if (++writes === index) request.addEventListener('success', () => this.transaction.abort());
        return request;
      });
    }
    await expect(storage.commitCompletedBattleStoryTailRewrite(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError);
    expect(await read()).toEqual(before);
  });

  it('quota failure after enqueued chapter writes rolls back every record', async () => {
    const commit = await fixture(); const before = await read(); const original = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === stores.battleStoryCheckpoints) throw new DOMException('quota', 'QuotaExceededError');
      return original.apply(this, args);
    });
    await expect(storage.commitCompletedBattleStoryTailRewrite(commit)).rejects.toThrow('quota'); expect(await read()).toEqual(before);
  });

  it.each(['operation-key', 'checkpoint-key', 'old-checkpoint-key'] as const)('rejects %s collisions without overwriting', async (kind) => {
    const commit = await fixture();
    if (kind === 'operation-key') await rawPut(stores.battleStoryChapters, { ...commit.chapter, sessionId: 'other' });
    if (kind === 'checkpoint-key') await rawPut(stores.battleStoryCheckpoints, { ...commit.checkpoint, sessionId: 'other' });
    if (kind === 'old-checkpoint-key') commit.checkpoint.id = 'p2';
    const before = await read();
    await expect(storage.commitCompletedBattleStoryTailRewrite(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError);
    expect(await read()).toEqual(before);
    if (kind === 'operation-key') expect((await storage.getBattleStoryChapter('operation'))?.sessionId).toBe('other');
  });

  it.each(['title', 'seed', 'plan', 'branchOf', 'opaque', 'summary', 'input', 'output', 'time', 'index', 'receipt', 'chapter-title', 'target', 'count'] as const)('rejects tampered %s write sets', async (kind) => {
    const commit = await fixture(); const before = await read();
    if (kind === 'title') commit.session.title = 'changed';
    if (kind === 'seed') commit.session.seed.combatants = [{ changed: true }];
    if (kind === 'plan') commit.session.chapterPlan!.totalChapters += 1;
    if (kind === 'branchOf') delete commit.session.branchOf;
    if (kind === 'opaque') delete (commit.session as unknown as Record<string, unknown>).opaque;
    if (kind === 'summary') commit.session.sessionSummary = 'invented';
    if (kind === 'input') commit.session.lastChapterInputCombatants = [{ wrong: true }];
    if (kind === 'output') commit.checkpoint.combatants = [{ wrong: true }];
    if (kind === 'time') commit.session.updatedAt += 1;
    if (kind === 'index') commit.chapter.index += 1;
    if (kind === 'receipt') Object.assign(commit.chapter, { commitReceipt: { version: 1 } });
    if (kind === 'chapter-title') commit.chapter.title = 'invented';
    if (kind === 'target') commit.expected.targetChapterId = 'c1';
    if (kind === 'count') commit.session.chapterCount += 1;
    await expect(storage.commitCompletedBattleStoryTailRewrite(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError);
    expect(await read()).toEqual(before);
  });

  it.each(['head', 'count', 'middle-target', 'gap', 'chapter-owner', 'duplicate-id', 'checkpoint-owner', 'duplicate-boundary', 'checkpoint-link', 'checkpoint-range', 'unindexed-chapter', 'unindexed-checkpoint'] as const)('capture rejects malformed %s before generation', async (kind) => {
    await fixture(); const source = await read();
    if (kind === 'head') source.session!.lastChapterId = 'wrong';
    if (kind === 'count') source.session!.chapterCount += 1;
    if (kind === 'gap') source.chapters[1]!.index = 3;
    if (kind === 'chapter-owner') source.chapters[0]!.sessionId = 'other';
    if (kind === 'duplicate-id') source.chapters[1]!.id = source.chapters[0]!.id;
    if (kind === 'checkpoint-owner') source.checkpoints[0]!.sessionId = 'other';
    if (kind === 'duplicate-boundary') source.checkpoints[1]!.boundaryIndex = 0;
    if (kind === 'checkpoint-link') source.checkpoints[1]!.chapterId = 'wrong';
    if (kind === 'checkpoint-range') source.checkpoints[2]!.boundaryIndex = 3;
    if (kind === 'unindexed-chapter') Object.assign(source.chapters[0]!, { index: undefined });
    if (kind === 'unindexed-checkpoint') Object.assign(source.checkpoints[0]!, { boundaryIndex: undefined });
    expect(() => storage.captureBattleStoryTailRewriteExpected(source, kind === 'middle-target' ? 'c1' : 'c2')).toThrow();
  });

  it.each([1, 2])('sparse legacy checkpoints use the established input fallback for chapter %s', async (count) => {
    await fixture(count); await storage.deleteBattleStoryCheckpointsFromBoundary({ sessionId: 'source', startBoundaryIndex: 0 });
    const commit = await prepare(); await storage.commitCompletedBattleStoryTailRewrite(commit);
    expect((await read()).checkpoints).toEqual([commit.checkpoint]);
    expect(commit.session.lastChapterInputCombatants).toEqual([{ name: `state${count - 1}` }]);
  });

  it.each(['safe', 'covering', 'beyond', 'no-meta'] as const)('projects %s summaries without changing their provenance', async (kind) => {
    await fixture(); const session = (await storage.getBattleStorySession('source'))!;
    await rawPut(stores.battleStorySessions, { ...session, sessionSummary: '原摘要', ...(kind === 'no-meta' ? {} : {
      summaryMeta: { coveredUntilChapterIndex: kind === 'safe' ? 1 : kind === 'covering' ? 2 : 3,
        coveredChapterIds: ['c1'], refreshedAt: 20, mode: 'ai', opaque: true },
    }) });
    const commit = await prepare(); await storage.commitCompletedBattleStoryTailRewrite(commit);
    expect((await read()).session?.sessionSummary).toBe(kind === 'safe' || kind === 'no-meta' ? '原摘要' : undefined);
    if (kind === 'safe') expect((await read()).session?.summaryMeta).toMatchObject({ coveredChapterIds: ['c1'], opaque: true });
  });

  it('freezes the original package before any await and caches its original immutable receipt', async () => {
    const commit = await fixture(); const receipt = storage.createBattleStoryTailRewriteReceipt(commit);
    expect(Object.isFrozen(commit)).toBe(true); expect(Object.isFrozen(receipt)).toBe(true);
    expect(() => { commit.chapter.markdown = 'changed'; }).toThrow();
    expect(() => { commit.chapter.reportJson.changed = true; }).toThrow();
    expect(() => { (commit.checkpoint.combatants[0] as { name: string }).name = 'changed'; }).toThrow();
    expect(storage.createBattleStoryTailRewriteReceipt(commit)).toBe(receipt);
    expect(await storage.commitCompletedBattleStoryTailRewrite(commit)).toBe(receipt);
    expect(storage.createBattleStoryTailRewriteReceipt(commit)).toBe(receipt);
  });

  it('classifies receipt preparation errors as definitely not saved before the writer starts', async () => {
    const commit = await fixture(); const before = await read();
    commit.chapter.reportJson.invalid = Number.POSITIVE_INFINITY;
    expect(() => storage.createBattleStoryTailRewriteReceipt(commit)).toThrow(storage.BattleStoryCommitNotSavedError);
    expect(await read()).toEqual(before);
  });

  it('serializes concurrent rewrites so only one replacement succeeds', async () => {
    const first = await fixture(); const second = await prepare('other-operation');
    const results = await Promise.allSettled([storage.commitCompletedBattleStoryTailRewrite(first), storage.commitCompletedBattleStoryTailRewrite(second)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const saved = await read(); expect(saved.chapters.filter((chapter) => chapter.status === 'active')).toHaveLength(2);
    expect(saved.chapters).toHaveLength(3); expect(saved.checkpoints).toHaveLength(3);
  });

  it('rejects a changed retry using the same operation and preserves the original receipt', async () => {
    const commit = await fixture(); const receipt = await storage.commitCompletedBattleStoryTailRewrite(commit);
    const changed = structuredClone(commit); changed.chapter.markdown += 'changed';
    const before = await read();
    await expect(storage.commitCompletedBattleStoryTailRewrite(changed)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError);
    expect(await read()).toEqual(before);
    expect(await storage.getBattleStoryTailRewriteOperationReceipt('source', 'operation', receipt.contentDigest)).toEqual(receipt);
  });

  it('closed bounded v3 receipt rejects foreign discriminants, invalid fields and the old readers', () => {
    const receipt: WebBattleStoryTailRewriteReceipt = { version: 3, kind: 'tail-rewrite', operationId: 'o'.repeat(128), sessionId: 's'.repeat(128),
      chapterId: 'o'.repeat(128), chapterIndex: Number.MAX_SAFE_INTEGER, chapterCount: Number.MAX_SAFE_INTEGER,
      targetChapterId: 't'.repeat(128), checkpointId: 'p'.repeat(128), contentDigest: `sha256:${'f'.repeat(64)}` };
    expect(isWebBattleStoryTailRewriteReceipt(receipt)).toBe(true); expect(Buffer.byteLength(JSON.stringify(receipt))).toBe(915);
    expect(createHash('sha256').update(JSON.stringify(receipt)).digest('hex')).toBe('d013a90da69a9f36684867aac642f825a71f0833ab2cf920353a52cfa79ddfa9');
    for (const changed of [{ extra: true }, { version: 1 }, { version: 2 }, { kind: 'branch' }, { operationId: '中' }, { checkpointId: 'p'.repeat(129) },
      { chapterCount: 2 }, { chapterIndex: 0, chapterCount: 0 }, { targetChapterId: receipt.chapterId }, { contentDigest: `sha256:${'F'.repeat(64)}` }]) {
      expect(isWebBattleStoryTailRewriteReceipt({ ...receipt, ...changed })).toBe(false);
    }
    expect(isWebBattleStoryBranchReceipt(receipt)).toBe(false);
  });
});
