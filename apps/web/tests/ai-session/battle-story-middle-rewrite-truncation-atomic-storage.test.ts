import '@/tests/helpers/fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildCompletedBattleStoryMiddleRewriteRecords } from '@mahoshojo/domain/arena-story-middle-rewrite';
import { buildCompletedBattleStoryTailRewriteRecords, resolveBattleStoryChapterInputCombatants } from '@mahoshojo/domain/arena-story-tail-rewrite';
import { buildCompletedBattleStoryCommit, captureBattleStoryCommitExpected } from '@mahoshojo/domain/arena-story-commit';
import { __resetAiSessionDbForTest, openAiSessionDb, transactionToPromise } from '@/lib/ai-session/storage';
import { AI_SESSION_DB_NAME, AI_SESSION_STORE_NAMES as stores } from '@/lib/ai-session/types';
import * as storage from '@/lib/ai-session/battle-story/storage';
import { isWebBattleStoryBranchReceipt } from '@/lib/ai-session/battle-story/branch-commit-storage';
import { isWebBattleStoryTailRewriteReceipt } from '@/lib/ai-session/battle-story/tail-rewrite-commit-storage';
import { isWebBattleStoryMiddleRewriteReceipt, type WebBattleStoryMiddleRewriteCommit, type WebBattleStoryMiddleRewriteReceipt } from '@/lib/ai-session/battle-story/middle-rewrite-commit-storage';

beforeEach(async () => {
  await __resetAiSessionDbForTest();
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(AI_SESSION_DB_NAME); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
});
afterEach(async () => { vi.restoreAllMocks(); await __resetAiSessionDbForTest(); });
const rawPut = async (store: string, record: unknown) => {
  const db = await openAiSessionDb(); const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(record); await transactionToPromise(tx);
};
const rawDelete = async (store: string, id: string) => {
  const db = await openAiSessionDb(); const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id); await transactionToPromise(tx);
};
const read = () => storage.readBattleStorySource('source');
const prepare = async (operationId = 'operation', targetId = 'c2'): Promise<WebBattleStoryMiddleRewriteCommit> => {
  const source = await read(); const session = source.session!;
  const target = source.chapters.find((chapter) => chapter.id === targetId)!;
  const latestChapter = source.chapters.find((chapter) => chapter.id === session.lastChapterId)!;
  const inputCombatants = resolveBattleStoryChapterInputCombatants({ session, checkpoints: source.checkpoints, chapter: target, latestChapter })!;
  return { version: 1, action: 'middle-rewrite', operationId,
    expected: storage.captureBattleStoryMiddleRewriteExpected(source, target.id),
    ...buildCompletedBattleStoryMiddleRewriteRecords({
      session, targetChapter: target, operationId, checkpointId: `${operationId}-cp`, now: 100,
      source: { ...session.source, modelId: 'new-model' }, inputCombatants,
      generated: { chapterIndex: target.index, markdown: `# 重写 ${operationId}\n全文\u0000😀\ud800`, reportJson: { nested: [null, false, '完整'] },
        digest: { chapterTitle: '重写标题' }, generationId: 'generation', cardSnapshot: { userGuidance: '完整引导' },
        nextWorkingCombatants: [{ name: operationId }] },
    }),
  };
};
const fixture = async (count = 4) => {
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
};
const truncate = async (targetId = 'c2') => storage.buildBattleStoryTruncationCommit(await read(), targetId, 200);
const append = async (operationId: string) => {
  const source = await read(); const session = source.session!;
  return storage.commitCompletedBattleStoryChapter(buildCompletedBattleStoryCommit({
    action: 'continue', session, expected: captureBattleStoryCommitExpected({ session, chapters: source.chapters, checkpoint: source.checkpoints.at(-1)! }),
    operationId, checkpointId: `${operationId}-cp`, now: 200, source: session.source, inputCombatants: session.workingCombatants,
    generated: { chapterIndex: session.chapterCount + 1, markdown: '后续', reportJson: {}, digest: { chapterTitle: '后续' }, nextWorkingCombatants: [{ name: operationId }] },
  }));
};
const prepareTail = async (): Promise<storage.WebBattleStoryTailRewriteCommit> => {
  const source = await read(); const session = source.session!;
  const target = source.chapters.find((chapter) => chapter.id === session.lastChapterId)!;
  const inputCombatants = resolveBattleStoryChapterInputCombatants({ session, checkpoints: source.checkpoints, chapter: target, latestChapter: target })!;
  return { version: 1, action: 'tail-rewrite', operationId: 'tail',
    expected: storage.captureBattleStoryTailRewriteExpected(source, target.id),
    ...buildCompletedBattleStoryTailRewriteRecords({ session, targetChapter: target, operationId: 'tail', checkpointId: 'tail-cp', now: 201,
      source: session.source, inputCombatants,
      generated: { chapterIndex: target.index, markdown: '新尾章', reportJson: {}, digest: { chapterTitle: '新尾章' }, nextWorkingCombatants: [{ name: 'tail' }] },
    }),
  };
};
const rewriteTail = async () => storage.commitCompletedBattleStoryTailRewrite(await prepareTail());

const operations = [
  { name: 'middle rewrite', writes: 9, prepare, save: (input: unknown) => storage.commitCompletedBattleStoryMiddleRewrite(input as WebBattleStoryMiddleRewriteCommit) },
  { name: 'truncation', writes: 7, prepare: truncate, save: (input: unknown) => storage.commitBattleStoryTruncation(input as storage.WebBattleStoryTruncationCommit) },
] as const;

for (const operation of operations) describe(`${operation.name} atomic graph`, () => {
  it.each(['early-text', 'superseded-extension'] as const)('fences %s outside the twelve-chapter request window', async (kind) => {
    await fixture(16);
    const old = { ...(await storage.getBattleStoryChapter('c1'))!, id: 'old1', status: 'superseded', opaque: { nested: 'original' } };
    await rawPut(stores.battleStoryChapters, old);
    const commit = operation.name === 'middle rewrite' ? await prepare('operation', 'c14') : await truncate('c14');
    if (kind === 'early-text') await rawPut(stores.battleStoryChapters, { ...(await storage.getBattleStoryChapter('c1'))!, markdown: '窗口外更改' });
    else await rawPut(stores.battleStoryChapters, { ...old, opaque: { nested: 'changed' } });
    const before = await read(); await expect(operation.save(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError);
    expect(await read()).toEqual(before);
  });

  it.each(['early-text', 'opaque-chapter', 'summary', 'opaque-session', 'early-checkpoint', 'superseded', 'unindexed-chapter', 'unindexed-checkpoint', 'append', 'rewrite', 'truncate', 'delete'] as const)('full source CAS rejects %s without further writes', async (kind) => {
    await fixture(16); const commit = await operation.prepare();
    if (kind === 'early-text' || kind === 'opaque-chapter') await rawPut(stores.battleStoryChapters, { ...(await storage.getBattleStoryChapter('c1'))!, ...(kind === 'early-text' ? { markdown: 'changed' } : { extension: true }) });
    if (kind === 'summary' || kind === 'opaque-session') await rawPut(stores.battleStorySessions, { ...(await storage.getBattleStorySession('source'))!, ...(kind === 'summary' ? { sessionSummary: 'changed' } : { extension: true }) });
    if (kind === 'early-checkpoint') await rawPut(stores.battleStoryCheckpoints, { ...(await storage.getBattleStoryCheckpointByBoundary('source', 0))!, extension: true });
    if (kind === 'superseded') await rawPut(stores.battleStoryChapters, { ...(await storage.getBattleStoryChapter('c1'))!, id: 'superseded', status: 'superseded' });
    if (kind === 'unindexed-chapter') await rawPut(stores.battleStoryChapters, { id: 'orphan', sessionId: 'source', status: 'superseded' });
    if (kind === 'unindexed-checkpoint') await rawPut(stores.battleStoryCheckpoints, { id: 'orphan', sessionId: 'source' });
    if (kind === 'append') await append('later');
    if (kind === 'rewrite') await rewriteTail();
    if (kind === 'truncate') await storage.commitBattleStoryTruncation(await truncate('c16'));
    if (kind === 'delete') await storage.deleteBattleStorySession('source');
    const changed = await read();
    await expect(operation.save(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError);
    expect(await read()).toEqual(changed);
  });

  for (const fault of ['abort', 'quota'] as const) it.each(Array.from({ length: operation.writes }, (_, index) => index + 1))(`${fault} at write %s rolls back every record`, async (index) => {
    await fixture(); const commit = await operation.prepare(); const before = await read(); let writes = 0;
    for (const method of ['put', 'add', 'delete'] as const) {
      const original = IDBObjectStore.prototype[method];
      vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function(this: IDBObjectStore, ...args: unknown[]) {
        const shouldFail = ++writes === index;
        if (fault === 'quota' && shouldFail) throw new DOMException('quota', 'QuotaExceededError');
        const request = Reflect.apply(original, this, args) as IDBRequest;
        if (shouldFail) request.addEventListener('success', () => this.transaction.abort());
        return request;
      });
    }
    await expect(operation.save(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError);
    expect(await read()).toEqual(before);
  });

  it('waits for the transaction completion handler, never individual request success', async () => {
    await fixture(); const commit = await operation.prepare(); let release: (() => void) | undefined; let settled = false;
    let completed!: () => void; const gate = new Promise<void>((resolve) => { completed = resolve; });
    const original = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function(this: IDBDatabase, ...args) {
      const tx = original.apply(this, args);
      if (args[1] === 'readwrite') Object.defineProperty(tx, 'oncomplete', { configurable: true,
        set(handler: (event: Event) => void) { tx.addEventListener('complete', (event) => { release = () => handler.call(tx, event); completed(); }); },
      });
      return tx;
    });
    const pending = operation.save(commit).then(() => { settled = true; });
    await gate; expect(settled).toBe(false); release!(); await pending; expect(settled).toBe(true);
  });

  it.each(['title', 'seed', 'plan', 'branchOf', 'opaque', 'summary', 'input', 'output', 'head', 'count', 'target', 'index', 'digest'] as const)('rejects a tampered %s projection', async (kind) => {
    await fixture(); const commit = await operation.prepare(); const before = await read();
    if (kind === 'title') commit.session.title = 'changed';
    if (kind === 'seed') commit.session.seed.combatants = [{ changed: true }];
    if (kind === 'plan') commit.session.chapterPlan!.totalChapters += 1;
    if (kind === 'branchOf') delete commit.session.branchOf;
    if (kind === 'opaque') Reflect.deleteProperty(commit.session, 'opaque');
    if (kind === 'summary') commit.session.sessionSummary = 'invented';
    if (kind === 'input') commit.session.lastChapterInputCombatants = [{ wrong: true }];
    if (kind === 'output') commit.session.workingCombatants = [{ wrong: true }];
    if (kind === 'head') commit.session.lastChapterId = 'invented';
    if (kind === 'count') commit.session.chapterCount += 1;
    if (kind === 'target') commit.expected.targetChapterId = 'c3';
    if (kind === 'index') commit.expected.targetIndex += 1;
    if (kind === 'digest') commit.expected.sourceDigest = `sha256:${'0'.repeat(64)}`;
    await expect(operation.save(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError);
    expect(await read()).toEqual(before);
  });

  it('freezes the exact original package before awaiting storage', async () => {
    await fixture(); const commit = await operation.prepare(); const pending = operation.save(commit);
    expect(Object.isFrozen(commit)).toBe(true); expect(Object.isFrozen(commit.session.seed.combatants)).toBe(true);
    expect(() => { commit.session.title = 'changed'; }).toThrow(); await pending;
  });

  it.each(['safe', 'covering', 'beyond', 'no-meta'] as const)('preserves the established %s summary rule', async (kind) => {
    await fixture(); const session = (await storage.getBattleStorySession('source'))!;
    await rawPut(stores.battleStorySessions, { ...session, sessionSummary: '原摘要', ...(kind === 'no-meta' ? {} : {
      summaryMeta: { coveredUntilChapterIndex: kind === 'safe' ? 1 : kind === 'covering' ? 2 : 3,
        coveredChapterIds: ['c1'], refreshedAt: 20, mode: 'ai', opaque: true },
    }) });
    await operation.save(await operation.prepare()); const saved = await read();
    expect(saved.session?.sessionSummary).toBe(kind === 'safe' || kind === 'no-meta' ? '原摘要' : undefined);
    if (kind === 'safe') expect(saved.session?.summaryMeta).toMatchObject({ coveredChapterIds: ['c1'], opaque: true });
  });
});

describe('middle rewrite receipt and write boundaries', () => {
  it('reads one full canonical graph beyond the prompt window for either captured operation', async () => {
    await fixture(16); const spy = vi.spyOn(IDBDatabase.prototype, 'transaction'); const source = await read();
    expect(spy).toHaveBeenCalledTimes(1); expect(spy.mock.calls[0]?.[1]).toBe('readonly'); spy.mockRestore();
    expect(source.chapters).toHaveLength(16); expect(source.checkpoints).toHaveLength(17);
    const reverse = { ...source, chapters: [...source.chapters].reverse(), checkpoints: [...source.checkpoints].reverse() };
    expect(storage.captureBattleStoryMiddleRewriteExpected(reverse, 'c2')).toEqual(storage.captureBattleStoryMiddleRewriteExpected(source, 'c2'));
    expect(storage.captureBattleStoryTruncationExpected(reverse, 'c2')).toEqual(storage.captureBattleStoryTruncationExpected(source, 'c2'));
  });

  it.each(['tail', 'superseded', 'missing'] as const)('rejects a %s target rather than reinterpreting the requested rewrite', async (kind) => {
    await fixture(); await rawPut(stores.battleStoryChapters, { ...(await storage.getBattleStoryChapter('c2'))!, id: 'old2', status: 'superseded' });
    const source = await read(); const target = kind === 'tail' ? 'c4' : kind === 'superseded' ? 'old2' : 'missing';
    expect(() => storage.captureBattleStoryMiddleRewriteExpected(source, target)).toThrow(); expect(await read()).toEqual(source);
  });

  it('supersedes only the target, retains earlier superseded rows, and deletes the complete suffix', async () => {
    await fixture();
    for (const index of [1, 2, 3]) await rawPut(stores.battleStoryChapters, { ...(await storage.getBattleStoryChapter(`c${index}`))!, id: `old${index}`, status: 'superseded' });
    const commit = await prepare(); const before = await read(); const receipt = await storage.commitCompletedBattleStoryMiddleRewrite(commit); const saved = await read();
    expect(saved.session).toEqual(commit.session); expect(saved.session?.chapterCount).toBe(2);
    expect(saved.chapters).toEqual([...before.chapters.filter((chapter) => chapter.index <= 2).map((chapter) => chapter.id === 'c2'
      ? { ...chapter, status: 'superseded', supersededByChapterId: 'operation' } : chapter), { ...commit.chapter, commitReceipt: receipt }].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id)));
    expect(saved.checkpoints).toEqual([...before.checkpoints.filter((checkpoint) => checkpoint.boundaryIndex < 2), commit.checkpoint]);
    expect(await storage.getBattleStoryOperationReceipt('operation')).toBeNull();
    expect(await storage.getBattleStoryBranchOperationReceipt('source', 'operation', receipt.contentDigest)).toBeNull();
    expect(await storage.getBattleStoryTailRewriteOperationReceipt('source', 'operation', receipt.contentDigest)).toBeNull();
  });

  it('keeps historical exact success after another middle rewrite, reopen, tail rewrite and append', async () => {
    await fixture(); const commit = await prepare(); const first = await storage.commitCompletedBattleStoryMiddleRewrite(commit);
    await append('later'); const secondCommit = await prepare('second', 'operation');
    await storage.commitCompletedBattleStoryMiddleRewrite(secondCommit); await __resetAiSessionDbForTest(); await rewriteTail(); await append('latest');
    const before = await read(); expect(await storage.commitCompletedBattleStoryMiddleRewrite(commit)).toEqual(first);
    expect(await storage.getBattleStoryMiddleRewriteOperationReceipt('source', 'operation', first.contentDigest)).toEqual(first);
    expect(await read()).toEqual(before);
    expect(await storage.getBattleStoryMiddleRewriteOperationReceipt('wrong', 'operation', first.contentDigest)).toBeNull();
    expect(await storage.getBattleStoryMiddleRewriteOperationReceipt('source', 'operation', `sha256:${'0'.repeat(64)}`)).toBeNull();
  });

  it.each(['truncation', 'session', 'receipt'] as const)('cannot resurrect an operation removed by %s deletion', async (kind) => {
    await fixture(); const commit = await prepare(); const receipt = await storage.commitCompletedBattleStoryMiddleRewrite(commit);
    if (kind === 'truncation') await storage.commitBattleStoryTruncation(await truncate('operation'));
    if (kind === 'session') await storage.deleteBattleStorySession('source');
    if (kind === 'receipt') { const chapter = { ...(await storage.getBattleStoryChapter('operation'))! }; Reflect.deleteProperty(chapter, 'commitReceipt'); await rawPut(stores.battleStoryChapters, chapter); }
    const before = await read();
    expect(await storage.getBattleStoryMiddleRewriteOperationReceipt('source', 'operation', receipt.contentDigest)).toBeNull();
    await expect(storage.commitCompletedBattleStoryMiddleRewrite(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError);
    expect(await read()).toEqual(before);
  });

  it.each(['operation-key', 'checkpoint-key', 'deleted-checkpoint-key'] as const)('rejects %s collision without overwriting foreign data', async (kind) => {
    await fixture(); const commit = await prepare();
    if (kind === 'operation-key') await rawPut(stores.battleStoryChapters, { ...commit.chapter, sessionId: 'other' });
    if (kind === 'checkpoint-key') await rawPut(stores.battleStoryCheckpoints, { ...commit.checkpoint, sessionId: 'other' });
    if (kind === 'deleted-checkpoint-key') commit.checkpoint.id = 'p4';
    const before = await read(); await expect(storage.commitCompletedBattleStoryMiddleRewrite(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError);
    expect(await read()).toEqual(before);
    if (kind === 'operation-key') expect((await storage.getBattleStoryChapter('operation'))?.sessionId).toBe('other');
    if (kind === 'checkpoint-key') expect((await storage.getBattleStoryCheckpointByBoundary('other', 2))?.id).toBe('operation-cp');
  });

  it('rejects same-operation changed retries while the original immutable receipt remains exact', async () => {
    await fixture(); const commit = await prepare(); const receipt = storage.createBattleStoryMiddleRewriteReceipt(commit);
    expect(Object.isFrozen(receipt)).toBe(true); expect(storage.createBattleStoryMiddleRewriteReceipt(commit)).toBe(receipt);
    expect(await storage.commitCompletedBattleStoryMiddleRewrite(commit)).toBe(receipt);
    const changed = structuredClone(commit); changed.chapter.markdown += 'changed'; const before = await read();
    await expect(storage.commitCompletedBattleStoryMiddleRewrite(changed)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError);
    expect(await read()).toEqual(before);
  });

  it('does not accept a shape-valid receipt with a different checkpoint identity as exact success', async () => {
    await fixture(); const commit = await prepare(); const receipt = await storage.commitCompletedBattleStoryMiddleRewrite(commit);
    await rawPut(stores.battleStoryChapters, { ...(await storage.getBattleStoryChapter('operation'))!,
      commitReceipt: { ...receipt, checkpointId: 'different-checkpoint' },
    });
    const before = await read(); const writes = ['put', 'add', 'delete'].map((method) => vi.spyOn(IDBObjectStore.prototype, method as 'put'));
    await expect(storage.commitCompletedBattleStoryMiddleRewrite(commit)).rejects.toThrow('回执与保存包不一致');
    for (const write of writes) expect(write).not.toHaveBeenCalled(); expect(await read()).toEqual(before);
  });

  it('first chapter uses seed fallback, middle chapters cannot borrow tail input when their checkpoint is missing', async () => {
    await fixture(); await rawDelete(stores.battleStoryCheckpoints, 'p1'); const source = await read();
    const commit = await prepare(); const before = await read();
    await expect(storage.commitCompletedBattleStoryMiddleRewrite(commit)).rejects.toThrow('章前输入状态'); expect(await read()).toEqual(before);
    await rawDelete(stores.battleStoryCheckpoints, 'p0'); await storage.commitCompletedBattleStoryMiddleRewrite(await prepare('first-rewrite', 'c1'));
    expect((await read()).session).toMatchObject({ chapterCount: 1, lastChapterInputCombatants: source.session!.seed.combatants });
  });

  it('closed bounded v3 receipt is separate from the other receipt kinds', () => {
    const receipt: WebBattleStoryMiddleRewriteReceipt = { version: 3, kind: 'middle-rewrite', operationId: 'o'.repeat(128), sessionId: 's'.repeat(128),
      chapterId: 'o'.repeat(128), chapterIndex: Number.MAX_SAFE_INTEGER, chapterCount: Number.MAX_SAFE_INTEGER,
      targetChapterId: 't'.repeat(128), checkpointId: 'p'.repeat(128), contentDigest: `sha256:${'f'.repeat(64)}` };
    expect(isWebBattleStoryMiddleRewriteReceipt(receipt)).toBe(true); expect(Buffer.byteLength(JSON.stringify(receipt))).toBe(917);
    expect(createHash('sha256').update(JSON.stringify(receipt)).digest('hex')).toBe('e0fbeebcb925e33ef8b5f4a66d1d2b81e4da55038879c2c75992ce2c557711ec');
    expect(isWebBattleStoryBranchReceipt(receipt)).toBe(false); expect(isWebBattleStoryTailRewriteReceipt(receipt)).toBe(false);
    for (const changed of [{ extra: true }, { version: 1 }, { version: 2 }, { kind: 'branch' }, { kind: 'tail-rewrite' }, { operationId: '中' }, { checkpointId: 'p'.repeat(129) },
      { chapterCount: 2 }, { chapterIndex: 0, chapterCount: 0 }, { targetChapterId: receipt.chapterId }, { contentDigest: `sha256:${'F'.repeat(64)}` }]) {
      expect(isWebBattleStoryMiddleRewriteReceipt({ ...receipt, ...changed })).toBe(false);
    }
  });
});

describe('truncation identity and projection', () => {
  it('retains an earlier exact rewrite receipt when only its later suffix is removed', async () => {
    await fixture(); const rewrite = await prepare(); const receipt = await storage.commitCompletedBattleStoryMiddleRewrite(rewrite);
    await append('later'); await storage.commitBattleStoryTruncation(await truncate('later'));
    const before = await read();
    expect(await storage.getBattleStoryMiddleRewriteOperationReceipt('source', 'operation', receipt.contentDigest)).toEqual(receipt);
    expect(await storage.commitCompletedBattleStoryMiddleRewrite(rewrite)).toEqual(receipt); expect(await read()).toEqual(before);
  });

  it('deletes all active/superseded suffix rows and restores the saved prefix intact', async () => {
    await fixture();
    for (const index of [1, 2, 3]) await rawPut(stores.battleStoryChapters, { ...(await storage.getBattleStoryChapter(`c${index}`))!, id: `old${index}`, status: 'superseded' });
    const before = await read(); const commit = await truncate(); await storage.commitBattleStoryTruncation(commit); const saved = await read();
    expect(saved.session).toEqual({ ...before.session, workingCombatants: [{ name: 'state1' }], lastChapterInputCombatants: [{ name: 'state0' }],
      sessionSummary: undefined, summaryMeta: undefined, lastChapterId: 'c1', chapterCount: 1, updatedAt: 200 });
    expect(saved.chapters).toEqual(before.chapters.filter((chapter) => chapter.index < 2));
    expect(saved.checkpoints).toEqual(before.checkpoints.filter((checkpoint) => checkpoint.boundaryIndex < 2));
    await expect(storage.commitBattleStoryTruncation(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError);
    expect(await read()).toEqual(saved);
  });

  it('preserves sparse legacy input precedence for deleting the latest and a first-chapter prefix', async () => {
    await fixture(2); await storage.deleteBattleStoryCheckpointsFromBoundary({ sessionId: 'source', startBoundaryIndex: 0 });
    await storage.commitBattleStoryTruncation(await truncate());
    expect((await read()).session).toMatchObject({ workingCombatants: [{ name: 'state1' }], lastChapterInputCombatants: [{ name: 'state0' }], chapterCount: 1 });
  });

  it('rejects a missing middle rollback state, but leaves an unavailable previous input undefined', async () => {
    await fixture(); await rawDelete(stores.battleStoryCheckpoints, 'p1'); const before = await read();
    expect(() => storage.buildBattleStoryTruncationCommit(before, 'c2', 100)).toThrow('回退状态');
    await storage.commitBattleStoryTruncation(await truncate('c3'));
    expect((await read()).session).toMatchObject({ workingCombatants: [{ name: 'state2' }], lastChapterInputCombatants: undefined, chapterCount: 2 });
  });

  it.each(['first', 'superseded', 'missing'] as const)('rejects %s target instead of deleting another chapter', async (kind) => {
    await fixture(); await rawPut(stores.battleStoryChapters, { ...(await storage.getBattleStoryChapter('c2'))!, id: 'old2', status: 'superseded' });
    const source = await read(); const target = kind === 'first' ? 'c1' : kind === 'superseded' ? 'old2' : 'missing';
    expect(() => storage.captureBattleStoryTruncationExpected(source, target)).toThrow(); expect(await read()).toEqual(source);
  });
});

it('serializes a competing middle rewrite, deletion, and tail rewrite without stale writes', async () => {
  await fixture(); const middle = await prepare(); const deletion = await truncate(); const tail = await prepareTail();
  const results = await Promise.allSettled([storage.commitCompletedBattleStoryMiddleRewrite(middle), storage.commitBattleStoryTruncation(deletion), storage.commitCompletedBattleStoryTailRewrite(tail)]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const source = await read(); const count = source.session!.chapterCount;
  expect(source.chapters.filter((chapter) => chapter.status !== 'superseded')).toHaveLength(count);
  expect(source.checkpoints).toHaveLength(count + 1);
});

it('serializes concurrent middle rewrites to the same original target', async () => {
  await fixture(); const first = await prepare(); const second = await prepare('second');
  const results = await Promise.allSettled([storage.commitCompletedBattleStoryMiddleRewrite(first), storage.commitCompletedBattleStoryMiddleRewrite(second)]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const source = await read(); expect(source.session?.chapterCount).toBe(2);
  expect(source.chapters).toHaveLength(3); expect(source.checkpoints).toHaveLength(3);
});
