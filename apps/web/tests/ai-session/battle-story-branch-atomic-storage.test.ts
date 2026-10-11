import '@/tests/helpers/fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildCompletedBattleStoryCommit, captureBattleStoryCommitExpected } from '@mahoshojo/domain/arena-story-commit';
import { __resetAiSessionDbForTest, openAiSessionDb, transactionToPromise } from '@/lib/ai-session/storage';
import { AI_SESSION_DB_NAME, AI_SESSION_STORE_NAMES as stores } from '@/lib/ai-session/types';
import * as storage from '@/lib/ai-session/battle-story/storage';
import { isWebBattleStoryBranchReceipt, type WebBattleStoryBranchCommit, type WebBattleStoryBranchReceipt } from '@/lib/ai-session/battle-story/branch-commit-storage';
import { cloneBattleStoryActiveChaptersForNewSession, cloneBattleStoryCheckpointsForNewSession } from '@mahoshojo/domain/arena-story-branch';

beforeEach(async () => { await __resetAiSessionDbForTest(); await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase(AI_SESSION_DB_NAME); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); }); });
afterEach(async () => { vi.restoreAllMocks(); await __resetAiSessionDbForTest(); });
const fixture = async (count = 2, k = count): Promise<WebBattleStoryBranchCommit> => {
  const session = { ...storage.createBattleStorySessionRecord({ title: 'source', source: { mode: 'daily', language: 'zh', storyLength: 'standard', generationMode: 'stream' }, seed: { combatants: [{ name: 'a' }], settings: { readArenaHistory: false, writeArenaHistory: false, readCurrentState: false, writeCurrentState: false, readNarrativeHistory: false, writeNarrativeHistory: false } }, workingCombatants: [{ name: 'a' }] }), id: 'source', chapterCount: count, lastChapterId: `c${count}` };
  await storage.putBattleStorySession(session);
  for (let i = 1; i <= count; i++) await storage.putBattleStoryChapter({ ...storage.createBattleStoryChapterRecord({ sessionId: 'source', index: i, action: i === 1 ? 'start' : 'continue', title: `chapter${i}`, markdown: `全文${i}`, reportJson: { opaque: { nested: ['完整'] } }, deterministicDigest: { chapterTitle: `${i}` }, sourceChapterId: i === 1 ? undefined : `c${i - 1}` }), id: `c${i}` });
  for (let i = 0; i <= count; i++) await storage.putBattleStoryCheckpoint({ ...storage.createBattleStoryCheckpointRecord({ sessionId: 'source', boundaryIndex: i, chapterId: i ? `c${i}` : undefined, combatants: [{ name: 'a' }] }), id: `p${i}` });
  const source = await storage.readBattleStoryBranchSource('source');
  const projected = cloneBattleStoryActiveChaptersForNewSession({ chapters: source.chapters.filter((c) => c.index <= k), newSessionId: 'target', allocateId: (c) => `copy${c.index}` });
  const checkpoints = cloneBattleStoryCheckpointsForNewSession({ checkpoints: source.checkpoints, newSessionId: 'target', chapterIdMap: projected.chapterIdMap, maxBoundaryIndex: k, allocateId: (cp) => `cp${cp.boundaryIndex}` });
  const chapter = { ...source.chapters[k - 1]!, id: 'operation', sessionId: 'target', index: k + 1, action: 'branch' as const, sourceChapterId: `copy${k}`, markdown: '新章' };
  checkpoints.push({ id: 'output', sessionId: 'target', boundaryIndex: k + 1, chapterId: chapter.id, combatants: [{ name: 'after' }], createdAt: 3 });
  return { version: 2, action: 'branch', operationId: chapter.id, expected: storage.captureBattleStoryBranchExpected(source, `c${k}`), session: { ...session, id: 'target', lastChapterId: chapter.id, chapterCount: k + 1, workingCombatants: [{ name: 'after' }], lastChapterInputCombatants: [{ name: 'a' }], branchOf: { sessionId: 'source', chapterId: `c${k}`, chapterIndex: k, createdAt: 3 } }, chapter, copiedChapters: projected.chapters, checkpoints };
};
const rawPut = async (store: string, record: unknown) => { const db = await openAiSessionDb(); const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(record); await transactionToPromise(tx); };
const emptyTarget = async () => expect(await storage.readBattleStoryBranchSource('target')).toEqual({ session: null, chapters: [], checkpoints: [] });

describe('Web branch v2 atomic graph', () => {
  it('records the current full-store cost: unrelated rows are visited once on read and twice on new commit', async () => {
    const commit = await fixture(2, 1);
    await rawPut(stores.battleStorySessions, { ...commit.session, id: 'unrelated' });
    await rawPut(stores.battleStoryChapters, { ...commit.chapter, id: 'unrelatedChapter', sessionId: 'unrelated' });
    await rawPut(stores.battleStoryCheckpoints, { ...commit.checkpoints[0]!, id: 'unrelatedCheckpoint', sessionId: 'unrelated' });
    const openCursor = IDBObjectStore.prototype.openCursor;
    const visits: string[] = [];
    const scan = vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function(this: IDBObjectStore, ...args) {
      const request = openCursor.apply(this, args);
      request.addEventListener('success', () => {
        if (request.result?.value.sessionId === 'unrelated') visits.push(this.name);
      });
      return request;
    });
    await storage.readBattleStoryBranchSource('source');
    expect(visits.sort()).toEqual([stores.battleStoryChapters, stores.battleStoryCheckpoints].sort());
    visits.length = 0;
    await storage.commitCompletedBattleStoryBranch(commit);
    expect(visits.sort()).toEqual([stores.battleStoryChapters, stores.battleStoryChapters,
      stores.battleStoryCheckpoints, stores.battleStoryCheckpoints].sort());
    scan.mockRestore();
    expect((await storage.getBattleStoryChapter('unrelatedChapter'))?.sessionId).toBe('unrelated');
  });

  it('one readonly snapshot includes >12 chapters; exact success survives reopen/source deletion/target append', async () => {
    const commit = await fixture(16, 2); const spy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const snapshot = await storage.readBattleStoryBranchSource('source');
    expect(spy).toHaveBeenCalledTimes(1); expect(spy.mock.calls[0]?.[1]).toBe('readonly'); spy.mockRestore();
    expect(snapshot.chapters).toHaveLength(16); expect(snapshot.checkpoints).toHaveLength(17);
    expect(storage.captureBattleStoryBranchExpected({ ...snapshot, chapters: [...snapshot.chapters].reverse(), checkpoints: [...snapshot.checkpoints].reverse() }, 'c2')).toEqual(commit.expected);
    const receipt = await storage.commitCompletedBattleStoryBranch(commit);
    expect((await storage.readBattleStoryBranchSource('target')).chapters).toHaveLength(3);
    expect(await storage.getBattleStoryOperationReceipt(commit.operationId)).toBeNull();
    await storage.deleteBattleStorySession('source'); await __resetAiSessionDbForTest();
    const target = await storage.readBattleStoryBranchSource('target');
    const continuation = buildCompletedBattleStoryCommit({ action: 'continue', session: target.session!, expected: captureBattleStoryCommitExpected({ session: target.session!, chapters: target.chapters, checkpoint: target.checkpoints.at(-1)! }), operationId: 'later', checkpointId: 'laterCP', now: 8, source: target.session!.source, inputCombatants: target.session!.workingCombatants, generated: { chapterIndex: 4, markdown: '后续', reportJson: {}, digest: { chapterTitle: '后续' }, nextWorkingCombatants: [{ name: 'later' }] } });
    await storage.commitCompletedBattleStoryChapter(continuation);
    expect(await storage.getBattleStoryBranchOperationReceipt('target', 'operation', receipt.contentDigest)).toEqual(receipt);
    expect(await storage.commitCompletedBattleStoryBranch(commit)).toEqual(receipt);
    expect(await storage.getBattleStoryBranchOperationReceipt('other', 'operation', receipt.contentDigest)).toBeNull();
    expect(await storage.getBattleStoryBranchOperationReceipt('target', 'operation', `sha256:${'0'.repeat(64)}`)).toBeNull();
    expect((await storage.getBattleStorySession('target'))?.chapterCount).toBe(4);
  });
  it.each(['early-text', 'opaque', 'summary', 'suffix-checkpoint', 'delete', 'superseded'] as const)('full source CAS rejects %s', async (kind) => {
    const commit = await fixture(16, kind === 'early-text' || kind === 'opaque' ? 16 : 2);
    if (kind === 'early-text' || kind === 'opaque') { const c = (await storage.getBattleStoryChapter('c1'))!; await storage.putBattleStoryChapter({ ...c, ...(kind === 'early-text' ? { markdown: 'changed' } : { extension: { changed: true } }) }); }
    if (kind === 'summary') await storage.updateBattleStorySession('source', (s) => ({ ...s, sessionSummary: 'new' }));
    if (kind === 'suffix-checkpoint') await storage.putBattleStoryCheckpoint({ ...(await storage.getBattleStoryCheckpointByBoundary('source', 16))!, combatants: [{ changed: true }] });
    if (kind === 'delete') await storage.deleteBattleStorySession('source');
    if (kind === 'superseded') await storage.putBattleStoryChapter({ ...(await storage.getBattleStoryChapter('c1'))!, id: 'old', status: 'superseded' });
    await expect(storage.commitCompletedBattleStoryBranch(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError); await emptyTarget();
  });
  it('same-content ABA is same identity', async () => { const commit = await fixture(); const original = (await storage.getBattleStoryChapter('c1'))!; await storage.putBattleStoryChapter({ ...original, markdown: 'temporary' }); await storage.putBattleStoryChapter(original); await expect(storage.commitCompletedBattleStoryBranch(commit)).resolves.toMatchObject({ version: 2 }); });
  it.each(['session', 'orphan-chapter', 'orphan-checkpoint', 'chapter-key', 'checkpoint-key'] as const)('rejects %s without overwriting', async (kind) => {
    const commit = await fixture();
    if (kind === 'session') await storage.putBattleStorySession(commit.session);
    if (kind === 'orphan-chapter') await rawPut(stores.battleStoryChapters, { ...commit.chapter, id: 'orphan', index: undefined });
    if (kind === 'orphan-checkpoint') await rawPut(stores.battleStoryCheckpoints, { ...commit.checkpoints[0]!, id: 'orphan', boundaryIndex: undefined });
    if (kind === 'chapter-key') await rawPut(stores.battleStoryChapters, { ...commit.copiedChapters[0]!, sessionId: 'other' });
    if (kind === 'checkpoint-key') await rawPut(stores.battleStoryCheckpoints, { ...commit.checkpoints[0]!, sessionId: 'other' });
    await expect(storage.commitCompletedBattleStoryBranch(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError); expect(await storage.getBattleStoryChapter('operation')).toBeNull();
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('request-success abort at write %i leaves no half graph', async (index) => {
    const commit = await fixture(); const add = IDBObjectStore.prototype.add; let writes = 0;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args) { const request = add.apply(this, args); if (++writes === index) request.addEventListener('success', () => this.transaction.abort()); return request; });
    await expect(storage.commitCompletedBattleStoryBranch(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError); await emptyTarget();
  });
  it('quota fault rolls back all enqueued writes', async () => {
    const commit = await fixture(); const add = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args) { if (this.name === stores.battleStoryCheckpoints) throw new DOMException('quota', 'QuotaExceededError'); return add.apply(this, args); });
    await expect(storage.commitCompletedBattleStoryBranch(commit)).rejects.toThrow('quota'); await emptyTarget();
  });
  it.each(['receipt', 'markdown', 'roles', 'summary', 'duplicate', 'source-link'] as const)('rejects invalid %s write set', async (kind) => {
    const commit = await fixture();
    if (kind === 'receipt') Object.assign(commit.copiedChapters[0]!, { commitReceipt: { version: 1 } });
    if (kind === 'markdown') commit.copiedChapters[0]!.markdown = 'tampered';
    if (kind === 'roles') commit.session.workingCombatants = [{ wrong: true }];
    if (kind === 'summary') commit.session.sessionSummary = 'invented';
    if (kind === 'duplicate') commit.copiedChapters[1]!.id = commit.copiedChapters[0]!.id;
    if (kind === 'source-link') commit.copiedChapters[1]!.sourceChapterId = 'source-c1';
    await expect(storage.commitCompletedBattleStoryBranch(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError); await emptyTarget();
  });
  it('legacy active rewrite keeps history action, strips receipt, maps superseded source link to null, and preserves extensions', async () => {
    const commit = await fixture();
    const original = (await storage.getBattleStoryChapter('c1'))!;
    await rawPut(stores.battleStoryChapters, { ...original, id: 'old', status: 'superseded', opaque: { keep: ['all'] } });
    await rawPut(stores.battleStoryChapters, { ...original, action: 'rewrite', sourceChapterId: 'old', commitReceipt: { version: 1 }, opaque: { keep: ['all'] } });
    Object.assign(commit.copiedChapters[0]!, { action: 'rewrite', sourceChapterId: null, opaque: { keep: ['all'] } });
    commit.expected = storage.captureBattleStoryBranchExpected(await storage.readBattleStoryBranchSource('source'), 'c2');
    await storage.commitCompletedBattleStoryBranch(commit);
    expect(await storage.getBattleStoryChapter('copy1')).toMatchObject({ action: 'rewrite', sourceChapterId: null, opaque: { keep: ['all'] } });
    expect(await storage.getBattleStoryOperationReceipt('copy1')).toBeNull();
  });
  it('sparse legacy checkpoints allow seed and latest working fallback without inventing intermediate checkpoints', async () => {
    const commit = await fixture(4);
    await storage.deleteBattleStoryCheckpointsFromBoundary({ sessionId: 'source', startBoundaryIndex: 0 });
    commit.checkpoints = commit.checkpoints.filter((cp) => [0, 4, 5].includes(cp.boundaryIndex));
    commit.expected = storage.captureBattleStoryBranchExpected(await storage.readBattleStoryBranchSource('source'), 'c4');
    await storage.commitCompletedBattleStoryBranch(commit);
    expect((await storage.readBattleStoryBranchSource('target')).checkpoints.map((cp) => cp.boundaryIndex)).toEqual([0, 4, 5]);
  });
  it('safe summary IDs map to copied prefix identities', async () => {
    const commit = await fixture();
    const summaryMeta = { coveredUntilChapterIndex: 1, coveredChapterIds: ['c1'], refreshedAt: 4, mode: 'ai' as const };
    await storage.updateBattleStorySession('source', (s) => ({ ...s, sessionSummary: 'safe', summaryMeta }));
    commit.expected = storage.captureBattleStoryBranchExpected(await storage.readBattleStoryBranchSource('source'), 'c2');
    commit.session.sessionSummary = 'safe'; commit.session.summaryMeta = { ...summaryMeta, coveredChapterIds: ['copy1'] };
    await storage.commitCompletedBattleStoryBranch(commit);
    expect((await storage.getBattleStorySession('target'))?.summaryMeta?.coveredChapterIds).toEqual(['copy1']);
  });
  it.each(['head', 'count', 'gap', 'duplicate-id', 'chapter-owner', 'checkpoint-owner'] as const)('capture rejects malformed %s before generation', async (kind) => {
    await fixture(); const snapshot = await storage.readBattleStoryBranchSource('source');
    if (kind === 'head') snapshot.session!.lastChapterId = 'wrong';
    if (kind === 'count') snapshot.session!.chapterCount += 1;
    if (kind === 'gap') snapshot.chapters[1]!.index = 3;
    if (kind === 'duplicate-id') snapshot.chapters[1]!.id = snapshot.chapters[0]!.id;
    if (kind === 'chapter-owner') snapshot.chapters[0]!.sessionId = 'other';
    if (kind === 'checkpoint-owner') snapshot.checkpoints[0]!.sessionId = 'other';
    expect(() => storage.captureBattleStoryBranchExpected(snapshot, 'c2')).toThrow();
  });
  it('synthesized anchor checkpoint cannot point back to source', async () => {
    const commit = await fixture();
    await storage.deleteBattleStoryCheckpointsFromBoundary({ sessionId: 'source', startBoundaryIndex: 2 });
    commit.expected = storage.captureBattleStoryBranchExpected(await storage.readBattleStoryBranchSource('source'), 'c2');
    commit.checkpoints.find((cp) => cp.boundaryIndex === 2)!.chapterId = 'c2';
    await expect(storage.commitCompletedBattleStoryBranch(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError); await emptyTarget();
  });
  it('calling commit immediately freezes the caller-owned graph before any await', async () => {
    const commit = await fixture(); const original = structuredClone(commit);
    const saved = storage.commitCompletedBattleStoryBranch(commit);
    expect(Object.isFrozen(commit)).toBe(true);
    expect(() => { commit.session.title = 'mutated'; }).toThrow();
    expect(() => { commit.chapter.reportJson.mutated = true; }).toThrow();
    expect(() => { (commit.checkpoints.at(-1)!.combatants[0] as { name: string }).name = 'mutated'; }).toThrow();
    expect(() => { commit.copiedChapters[0]!.markdown = 'mutated'; }).toThrow();
    await saved;
    expect(await storage.getBattleStorySession('target')).toEqual(original.session);
    expect((await storage.getBattleStoryChapter('operation'))?.reportJson).toEqual(original.chapter.reportJson);
    expect((await storage.readBattleStoryBranchSource('target')).checkpoints).toEqual(original.checkpoints);
  });
  it.each(['append', 'rewrite'] as const)('source suffix %s after capture rejects stale branch', async (kind) => {
    const commit = await fixture(4, 2);
    if (kind === 'append') {
      const source = await storage.readBattleStoryBranchSource('source');
      await storage.commitCompletedBattleStoryChapter(buildCompletedBattleStoryCommit({ action: 'continue', session: source.session!, expected: captureBattleStoryCommitExpected({ session: source.session!, chapters: source.chapters, checkpoint: source.checkpoints.at(-1)! }), operationId: 'source-next', checkpointId: 'source-next-cp', now: 10, source: source.session!.source, inputCombatants: source.session!.workingCombatants, generated: { chapterIndex: 5, markdown: '源后缀续写', reportJson: {}, digest: { chapterTitle: '续写' }, nextWorkingCombatants: [{ name: 'next' }] } }));
    } else {
      const old = (await storage.getBattleStoryChapter('c4'))!;
      await storage.putBattleStoryChapter({ ...old, status: 'superseded', supersededByChapterId: 'rewritten' });
      await storage.putBattleStoryChapter({ ...old, id: 'rewritten', action: 'rewrite', sourceChapterId: 'c4', markdown: '源后缀重写' });
      await storage.updateBattleStorySession('source', (session) => ({ ...session, lastChapterId: 'rewritten' }));
      await storage.putBattleStoryCheckpoint({ ...(await storage.getBattleStoryCheckpointByBoundary('source', 4))!, chapterId: 'rewritten' });
    }
    await expect(storage.commitCompletedBattleStoryBranch(commit)).rejects.toBeInstanceOf(storage.BattleStoryCommitNotSavedError); await emptyTarget();
  });
  it('closed receipt max-ID golden is 943 UTF8 bytes', () => {
    const r: WebBattleStoryBranchReceipt = { version: 2, kind: 'branch', operationId: 'o'.repeat(128), sessionId: 's'.repeat(128), chapterId: 'o'.repeat(128), chapterIndex: Number.MAX_SAFE_INTEGER, chapterCount: Number.MAX_SAFE_INTEGER, prefixEndIndex: Number.MAX_SAFE_INTEGER - 1, anchorChapterId: 'a'.repeat(128), checkpointId: 'p'.repeat(128), contentDigest: `sha256:${'f'.repeat(64)}` };
    expect(isWebBattleStoryBranchReceipt(r)).toBe(true); expect(Buffer.byteLength(JSON.stringify(r))).toBe(943);
    expect(createHash('sha256').update(JSON.stringify(r)).digest('hex')).toBe('d35efc84b0f681481619df0089be06bc74b5ac8c4da4e405374c48e41e125c6b');
    expect(isWebBattleStoryBranchReceipt({ ...r, extra: true })).toBe(false); expect(isWebBattleStoryBranchReceipt({ ...r, operationId: '中' })).toBe(false); expect(isWebBattleStoryBranchReceipt({ ...r, contentDigest: `sha256:${'F'.repeat(64)}` })).toBe(false);
  });
});
