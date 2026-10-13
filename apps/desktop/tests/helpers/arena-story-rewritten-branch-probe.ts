/** Opt-in real TS projections -> test-only schema-12 pipe -> Native SQLite.
 * Completed prose is synthetic. No model, registered IPC, UI or user database. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  StoryChapterDocument, StoryChapterPage, StoryCheckpointDocument, StoryCommitManifest, StoryPartKind,
  StoryRecordDescriptor, StorySessionDocument, StorySessionHead, StorySessionPage,
} from '@mahoshojo/contracts/desktop-arena-story';
import { buildCompletedBattleStoryRecords } from '@mahoshojo/domain/arena-story-commit';
import {
  buildBattleStoryBranchLabel, buildCompletedBattleStoryBranchRecords,
  cloneBattleStoryActiveChaptersForNewSession, cloneBattleStoryCheckpointsForNewSession,
} from '@mahoshojo/domain/arena-story-branch';
import { buildCompletedBattleStoryTailRewriteRecords } from '@mahoshojo/domain/arena-story-tail-rewrite';
import { readStoryBranchSource, readStoryBranchSummaryIds } from '../../src/platform/arena-story-branch-source';
import { branchCopyId, freezeStoryBranchIdentity, prepareStoryBranchCommit, savePreparedStoryBranchCommit,
  type StoryBranchNativePort } from '../../src/platform/arena-story-branch-storage';
import { readStoryTailRewriteSource } from '../../src/platform/arena-story-tail-rewrite-source';
import { freezeStoryTailRewriteIdentity, prepareStoryTailRewriteCommit, savePreparedStoryTailRewriteCommit,
  type StoryTailRewriteNativePort } from '../../src/platform/arena-story-tail-rewrite-storage';
import { prepareStoryStorageCommit, savePreparedStoryCommit, type StoryNativePort } from '../../src/platform/arena-story-storage';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const [binaryArg, outputArg, repoArg, nativeSourceArg] = process.argv.slice(2);
assert.ok(binaryArg && outputArg && repoArg && nativeSourceArg, 'binary evidence-directory source-checkout native-source-snapshot required');
const binary = resolve(binaryArg), output = resolve(outputArg), repo = resolve(repoArg);
mkdirSync(output, { recursive: true });
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fixture = JSON.parse(readFileSync(join(repo, 'packages/contracts/fixtures/desktop-story-tail-rewrite-storage.json'), 'utf8')) as {
  sourceCommits: Array<{ manifest: StoryCommitManifest; parts: Array<{ kind: StoryPartKind; document: string }> }>;
};
function launch(root: string) {
  const available = statfsSync(output); assert.ok(available.bavail * available.bsize >= 256 * 1024 * 1024, '256 MiB free-space floor');
  const child = spawn(binary, ['--ignored', '--exact', 'arena_story::branch::tail_rewrite::completion_pipe::real_store_tail_rewrite_completion_pipe', '--nocapture', '--test-threads=1'], {
    env: { ...process.env, MAHO_TAIL_REWRITE_PIPE_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = [], trace: Array<Record<string, unknown>> = [];
  let terminal = false, stderr = '', bytes = 0;
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    bytes += Buffer.byteLength(line); if (bytes > 8 * 1024 * 1024) { child.kill(); return; }
    const marker = line.indexOf('TAIL_REWRITE_PIPE '); if (marker < 0) return;
    const response = JSON.parse(line.slice(marker + 'TAIL_REWRITE_PIPE '.length)), next = waiting.shift();
    assert.ok(next, 'unexpected pipe response');
    if (response.ok) next.resolve(response.value); else next.reject(response.error);
  });
  const timeout = setTimeout(() => child.kill(), 60_000);
  const budget = setInterval(() => { const stat = statfsSync(output); if (stat.bavail * stat.bsize < 256 * 1024 * 1024) child.kill(); }, 250);
  const closed = new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('close', code => {
      terminal = true; clearTimeout(timeout); clearInterval(budget); lines.close();
      const error = new Error(`rewritten branch pipe exited ${code}: ${stderr}`);
      for (const pending of waiting.splice(0)) pending.reject(error);
      if (code === 0) done(); else reject(error);
    });
  }); void closed.catch(() => {});
  return { trace, call: (op: string, args: Record<string, unknown> = {}): Promise<unknown> => new Promise((done, reject) => {
    if (terminal) { reject(new Error('pipe closed')); return; }
    const frame = JSON.stringify({ op, ...args }); assert.ok(Buffer.byteLength(frame) < 8 * 1024 * 1024);
    trace.push({ op, ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'bytes')),
      ...(typeof args.bytes === 'string' ? { byteDigest: sha(Buffer.from(args.bytes, 'base64')) } : {}) });
    waiting.push({ resolve: done, reject }); child.stdin.write(frame + '\n');
  }), close: async () => { if (!terminal) child.stdin.end(); await closed; } };
}
type RecordKey = [StoryRecordDescriptor['kind'], string];
async function scenario(count: 1 | 3) {
  const root = mkdtempSync(join(output, `rewrite-${count}-`)), host = launch(root);
  const call = (op: string, args?: Record<string, unknown>) => host.call(op, args);
  const append = (token: string, kind: StoryPartKind, offset: number, bytes: Uint8Array) => call('append', { token, kind, offset, bytes: Buffer.from(bytes).toString('base64') });
  const reads: StoryNativePort = {
    begin: manifest => call('linear-begin', { manifest }), append, end: token => call('linear-end', { token }), abort: async token => { await call('abort', { token }); },
    receipt: (sessionId, operationId) => call('linear-receipt', { sessionId, operationId }),
    listSessions: (cursor, limit) => call('sessions', { cursor, limit }), listChapters: (sessionId, revision, cursor, limit) => call('chapters', { sessionId, revision, cursor, limit }),
    describe: (sessionId, revision, kind, recordId) => call('describe', { sessionId, revision, kind, recordId }),
    read: async (descriptor, offset, length) => Uint8Array.from(Buffer.from(await call('read', { descriptor, offset, length }) as string, 'base64')),
    continueState: (sessionId, revision, expectedHead) => call('continue', { sessionId, revision, expectedHead }), deleteSession: target => call('delete', { target }),
  };
  const branch: StoryBranchNativePort = { begin: manifest => call('branch-begin', { manifest }), append, abort: reads.abort,
    end: token => call('branch-end', { token }), receipt: (sessionId, operationId, requestDigest) => call('branch-receipt', { sessionId, operationId, requestDigest }) };
  const tail: StoryTailRewriteNativePort = { begin: manifest => call('tail-begin', { manifest }), append, abort: reads.abort,
    end: token => call('tail-end', { token }), receipt: (sessionId, operationId, requestDigest) => call('tail-receipt', { sessionId, operationId, requestDigest }) };
  const source = { resolveAnchor: (request: Parameters<typeof readStoryBranchSource>[2]) => call('branch-anchor', { request }) };
  const headOf = async (id: string) => {
    const head = (await reads.listSessions(null, 25) as StorySessionPage).rows.find(row => row.id === id); assert.ok(head); return head;
  };
  const rawRecord = async (head: StorySessionHead, kind: StoryRecordDescriptor['kind'], id: string) => {
    const descriptor = await reads.describe(head.id, head.revision, kind, id) as StoryRecordDescriptor;
    assert.ok(descriptor.byteLength < 4 * 1024 * 1024, 'small synthetic record only');
    const bytes = await reads.read(descriptor, 0, descriptor.byteLength);
    assert.equal(`sha256:${sha(bytes)}`, descriptor.digest);
    return Buffer.from(bytes).toString('utf8');
  };
  const graphOf = async (head: StorySessionHead, checkpointIds: string[], history: RecordKey[] = []) => {
    const rows = (await reads.listChapters(head.id, head.revision, null, 25) as StoryChapterPage).rows;
    assert.equal(rows.length, head.chapterCount);
    const keys: RecordKey[] = [['session', head.id], ['seed', head.id], ...rows.map(row => ['chapter', row.id] as RecordKey),
      ...checkpointIds.map(id => ['checkpoint', id] as RecordKey), ...history];
    const raw = new Map<string, string>();
    for (const [kind, id] of keys) if (!raw.has(`${kind}:${id}`)) raw.set(`${kind}:${id}`, await rawRecord(head, kind, id));
    return { raw, keys, chapters: [...raw].filter(([key]) => key.startsWith('chapter:')).map(([, value]) => JSON.parse(value) as StoryChapterDocument),
      checkpoints: checkpointIds.map(id => JSON.parse(raw.get(`checkpoint:${id}`)!) as StoryCheckpointDocument),
      session: JSON.parse(raw.get(`session:${head.id}`)!) as StorySessionDocument,
      seed: JSON.parse(raw.get(`seed:${head.id}`)!) as { combatants: unknown[] } };
  };
  const generated = (index: number, id: string, roles: unknown[]) => ({ chapterIndex: index, generationId: `${id}-generation`,
    markdown: `# ${id}\n完整合成正文 😀`, reportJson: { nested: { retained: '\ud800', sourceChapterId: 'opaque-unchanged' } },
    digest: { chapterTitle: id, bodyExcerpt: '完整摘要' }, nextWorkingCombatants: structuredClone(roles) });
  const branchReports: unknown[] = [];
  const copyBranch = async (head: StorySessionHead, checkpointIds: string[], k: number, targetId: string, history: RecordKey[] = []) => {
    // Full hydration is test-only: compare the real domain's expected projection
    // with records physically copied by Native, never supply copied rows to Native.
    const original = await graphOf(head, checkpointIds, history);
    const anchor = original.chapters.find(chapter => chapter.status === 'active' && chapter.index === k); assert.ok(anchor);
    const snapshot = await readStoryBranchSource(reads, source, { sessionId: head.id, revision: head.revision,
      expectedChapterCount: head.chapterCount, expectedLastChapterId: head.lastChapterId, anchorIndex: k, anchorChapterId: anchor.id });
    assert.equal(snapshot.anchor.action, anchor.action); assert.equal(snapshot.anchor.sourceChapterId, anchor.sourceChapterId);
    assert.deepEqual(snapshot.recentWindow.map(chapter => chapter.chapterId), original.chapters
      .filter(chapter => chapter.status === 'active' && chapter.index <= k).slice(-12).map(chapter => chapter.id));
    const identity = freezeStoryBranchIdentity({ operationId: `${targetId}-new`, sessionId: targetId, source: snapshot.source });
    const summaryIds = await readStoryBranchSummaryIds(reads, snapshot, targetId);
    const expected = cloneBattleStoryActiveChaptersForNewSession({ chapters: original.chapters.filter(chapter => chapter.index <= k),
      newSessionId: targetId, allocateId: chapter => branchCopyId(targetId, 'c', chapter.index) });
    const expectedCheckpoints = cloneBattleStoryCheckpointsForNewSession({ checkpoints: original.checkpoints,
      newSessionId: targetId, chapterIdMap: expected.chapterIdMap, maxBoundaryIndex: k,
      allocateId: checkpoint => branchCopyId(targetId, 'p', checkpoint.boundaryIndex) });
    assert.equal(expected.chapters.length, k); assert.equal(expectedCheckpoints.length, k + 1);
    const records = buildCompletedBattleStoryBranchRecords({
      session: { ...snapshot.session, id: targetId, seed: snapshot.seed, workingCombatants: snapshot.workingCombatants,
        createdAt: 100, branchOf: { sessionId: head.id, chapterId: anchor.id, chapterIndex: k, chapterTitle: anchor.title },
        branchLabel: buildBattleStoryBranchLabel({ chapterIndex: k, chapterTitle: anchor.title }) },
      source: snapshot.session.source, inputCombatants: snapshot.workingCombatants, prefixEndIndex: k,
      targetAnchorChapterId: branchCopyId(targetId, 'c', k), mapChapterId: id => summaryIds[id],
      operationId: identity.operationId, checkpointId: `${targetId}-output`, now: 101,
      generated: generated(k + 1, targetId, snapshot.workingCombatants),
    });
    const commit = prepareStoryBranchCommit(identity, records), receipt = await savePreparedStoryBranchCommit(branch, commit);
    const targetHead = await headOf(targetId), targetCheckpointIds = [...expectedCheckpoints.map(checkpoint => checkpoint.id), records.checkpoints[0]!.id];
    const actual = await graphOf(targetHead, targetCheckpointIds);
    assert.deepEqual(actual.chapters.slice(0, k), expected.chapters, 'Native copied chapters equal real domain projection');
    assert.deepEqual(actual.checkpoints.slice(0, k + 1), expectedCheckpoints, 'Native copied checkpoints equal real domain projection');
    for (const chapter of expected.chapters) {
      if (chapter.action === 'rewrite') assert.equal(chapter.sourceChapterId, null, 'superseded source must not be remapped to prior active chapter');
      const originalId = [...expected.chapterIdMap].find(([, id]) => id === chapter.id)![0];
      const token = original.raw.get(`chapter:${originalId}`)!.match(/"opaque":1e\+02,"opaque":\{[^}]*\}/u)?.[0];
      if (token) assert.ok(actual.raw.get(`chapter:${chapter.id}`)!.includes(token), 'unknown duplicate/number/escape tokens survive physical copy');
    }
    for (const [kind, id] of original.keys) assert.equal(await rawRecord(head, kind, id), original.raw.get(`${kind}:${id}`), 'branch cannot mutate any source original');
    for (const { kind, prepared } of commit.parts) {
      const id = (prepared.value as { id: string }).id;
      const sent = JSON.parse(Buffer.concat([...prepared.chunks(4 * 1024 * 1024)]).toString('utf8'));
      assert.deepEqual(JSON.parse(await rawRecord(targetHead, kind === 'checkpoint1' ? 'checkpoint' : kind, id)), sent);
    }
    branchReports.push({ targetId, k, receipt, actions: expected.chapters.map(chapter => chapter.action),
      generationIds: expected.chapters.map(chapter => chapter.generationId), sourceLinks: expected.chapters.map(chapter => chapter.sourceChapterId) });
    return { head: targetHead, checkpointIds: targetCheckpointIds };
  };
  try {
    for (const input of fixture.sourceCommits.slice(0, count)) {
      const begun = await reads.begin(input.manifest) as { token: string };
      for (const part of input.parts) await append(begun.token, part.kind, 0, Buffer.from(part.document));
      await reads.end(begun.token);
    }
    const checkpointIds = Array.from({ length: count + 1 }, (_, index) => `source-p${index}`), history: RecordKey[] = [];
    for (let round = 1; round <= 2; round++) {
      const head = await headOf('golden-source');
      const snapshot = await readStoryTailRewriteSource(reads, { resolveSource: request => call('tail-source', { request }) }, {
        sessionId: head.id, expectedRevision: head.revision, expectedChapterCount: head.chapterCount, targetChapterId: head.lastChapterId,
      });
      const identity = freezeStoryTailRewriteIdentity({ sessionId: head.id, operationId: `rewrite-${round}`, source: snapshot.source });
      const records = buildCompletedBattleStoryTailRewriteRecords({ session: { ...snapshot.session, seed: snapshot.seed, workingCombatants: snapshot.workingCombatants },
        targetChapter: snapshot.target, operationId: identity.operationId, checkpointId: `rewrite-p${round}`, now: 10 + round,
        source: snapshot.session.source, inputCombatants: snapshot.workingCombatants, generated: generated(count, identity.operationId, snapshot.workingCombatants) });
      Object.assign(records.chapter, { extension: { unchanged: '中😀\ud800', nestedId: snapshot.target.id } });
      const commit = prepareStoryTailRewriteCommit(identity, records), receipt = await savePreparedStoryTailRewriteCommit(tail, commit);
      assert.equal(receipt.version, 3); assert.equal(receipt.chapterCount, count); assert.equal(receipt.revision, count + round);
      history.push(['chapter', snapshot.target.id], ['checkpoint', checkpointIds[count]!]); checkpointIds[count] = records.checkpoint.id;
    }
    let head = await headOf('golden-source');
    if (count > 1) await copyBranch(head, checkpointIds, count - 1, 'before-rewrite', history);
    await copyBranch(head, checkpointIds, count, 'at-rewrite', history);
    const current = await graphOf(head, checkpointIds, history), roles = current.checkpoints.at(-1)!.combatants;
    const continued = buildCompletedBattleStoryRecords({ action: 'continue', session: { ...current.session, seed: current.seed, workingCombatants: roles },
      operationId: 'continued-source', checkpointId: 'continued-output', now: 20, source: current.session.source, inputCombatants: roles,
      generated: generated(count + 1, 'continued-source', roles) });
    await savePreparedStoryCommit(reads, await prepareStoryStorageCommit({ ...continued, expectedRevision: head.revision,
      expectedLastChapterId: head.lastChapterId, lastInputCheckpointId: checkpointIds[count] }));
    checkpointIds.push('continued-output'); head = await headOf('golden-source');
    const copied = await copyBranch(head, checkpointIds, count + 1, 'after-rewrite', history);
    await copyBranch(copied.head, copied.checkpointIds, copied.head.chapterCount, 'copied-rewrite-and-branch');
    if (count === 1) {
      for (let index = 3; index <= 13; index++) {
        const session = JSON.parse(await rawRecord(head, 'session', head.id)) as StorySessionDocument;
        const records = buildCompletedBattleStoryRecords({ action: 'continue', session: { ...session, seed: current.seed, workingCombatants: roles },
          operationId: `long-source-${index}`, checkpointId: `long-output-${index}`, now: 20 + index,
          source: session.source, inputCombatants: roles, generated: generated(index, `long-source-${index}`, roles) });
        await savePreparedStoryCommit(reads, await prepareStoryStorageCommit({ ...records, expectedRevision: head.revision,
          expectedLastChapterId: head.lastChapterId, lastInputCheckpointId: checkpointIds.at(-1) }));
        checkpointIds.push(records.checkpoints[0]!.id); head = await headOf(head.id);
      }
      // The same real rewrite is the first window item at k=12 and outside the
      // bounded read window at k=13. Native still copies and audits all 1..k.
      await copyBranch(head, checkpointIds, 12, 'rewrite-at-window-edge', history);
      await copyBranch(head, checkpointIds, 13, 'rewrite-outside-window', history);
    }
    const report = { count, passed: true, branchReports, trace: host.trace };
    writeFileSync(join(output, `rewrite-${count}.json`), JSON.stringify(report, null, 2) + '\n');
    return { count, passed: true, branches: branchReports.length };
  } catch (error) {
    writeFileSync(join(output, `rewrite-${count}-failure.json`), JSON.stringify({ count,
      error: error instanceof Error ? { message: error.message, stack: error.stack, cause: error.cause } : error, branchReports, trace: host.trace }, null, 2));
    throw error;
  } finally { await host.close(); }
}
function snapshotSources() {
  const files: string[] = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path); else if (/\.(ts|tsx|json)$/u.test(entry.name)) files.push(path);
    }
  };
  collect(join(repo, 'apps/desktop/src'));
  for (const pkg of readdirSync(join(repo, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const path = join(repo, 'packages', pkg.name);
    if (readdirSync(path).includes('src')) collect(join(path, 'src'));
    files.push(join(path, 'package.json'));
  }
  files.push(join(repo, 'apps/desktop/tests/helpers/arena-story-rewritten-branch-probe.ts'));
  files.push(join(repo, 'packages/contracts/fixtures/desktop-story-tail-rewrite-storage.json'));
  const native = JSON.parse(readFileSync(nativeSourceArg!, 'utf8')) as Record<string, string>;
  for (const [path, expected] of Object.entries(native)) assert.equal(sha(readFileSync(path)), expected, `Native source changed: ${path}`);
  return { typescript: Object.fromEntries(files.sort().map(path => [path, sha(readFileSync(path))])), native };
}
async function binaryDigest() { const hash = createHash('sha256'); for await (const chunk of createReadStream(binary)) hash.update(chunk); return hash.digest('hex'); }
async function main() {
  const before = { sources: snapshotSources(), binary: await binaryDigest() }, results = [];
  writeFileSync(join(output, 'sources-before.json'), JSON.stringify(before, null, 2));
  try { for (const count of [1, 3] as const) results.push(await scenario(count)); }
  finally {
    const after = { sources: snapshotSources(), binary: await binaryDigest() };
    writeFileSync(join(output, 'sources-after.json'), JSON.stringify(after, null, 2));
    assert.deepEqual(after, before, 'TS/Native inputs and binary must stay frozen during verification');
  }
  const report = { passed: true, binary, sourceCheckout: repo, sourceStable: true, results,
    caveat: 'Real TS domain/read/storage and Native SQLite. Synthetic prose only; no model, IPC/ACL, UI, Windows/Tauri or large-history resource acceptance.' };
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
