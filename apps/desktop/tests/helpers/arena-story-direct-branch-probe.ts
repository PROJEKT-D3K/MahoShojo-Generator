/** Explicit opt-in: actual Direct producer + adapter + frozen save -> test-only
 * Rust stdin bridge -> actual SQLite/backup/restore. Model transport is synthetic;
 * no branch IPC registration, credentials, paid model, Tauri or Windows claim. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { mkdirSync, mkdtempSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { StoryChapterPage, StoryRecordDescriptor } from '@mahoshojo/contracts/desktop-arena-story';
import type { StoryBranchSource } from '@mahoshojo/contracts/desktop-arena-story-branch';
import { DesktopArenaStorySession } from '../../src/features/arena/story-session';
import { branchCopyId, prepareStoryBranchCommit, type PreparedStoryBranchCommit, type StoryBranchNativePort } from '../../src/platform/arena-story-branch-storage';
import { prepareStorySessionDeletion, readStoryRecord, savePreparedStoryCommit, type StoryNativePort } from '../../src/platform/arena-story-storage';
import { branchFixtureRoles, buildDirectBranchFixture, directBranchExecution, directBranchText, installDirectBranchFixture } from './arena-story-direct-branch-fixture';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const [binaryArg, outputArg, repoArg] = process.argv.slice(2);
assert.ok(binaryArg && outputArg && repoArg, 'binary evidence-directory source-checkout required');
const binary = resolve(binaryArg), output = resolve(outputArg), repo = resolve(repoArg); mkdirSync(output, { recursive: true });
type Trace = { op: string; [key: string]: unknown };
function launch(root: string) {
  const child = spawn(binary, ['--ignored', '--exact', 'arena_story::branch::storage::tests::completion_pipe::real_store_branch_completion_pipe', '--nocapture', '--test-threads=1'], {
    env: { ...process.env, MAHO_BRANCH_COMPLETION_PIPE_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = [], trace: Trace[] = [];
  let stderr = '', logBytes = 0, terminal = false;
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    logBytes += Buffer.byteLength(line); if (logBytes > 8 * 1024 * 1024) { child.kill(); return; }
    const marker = line.indexOf('BRANCH_PIPE '); if (marker < 0) return;
    const reply = JSON.parse(line.slice(marker + 12)), next = waiting.shift(); assert.ok(next, 'unexpected response');
    if (reply.ok) next.resolve(reply.value); else next.reject(reply.error);
  });
  const budget = setInterval(() => { const s = statfsSync(output); if (s.bavail * s.bsize < 256 * 1024 * 1024) child.kill(); }, 250);
  const timeout = setTimeout(() => child.kill(), 60_000);
  const closed = new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('close', code => { terminal = true; clearInterval(budget); clearTimeout(timeout); lines.close();
      const error = new Error(`branch pipe exit ${code}: ${stderr}`); for (const item of waiting.splice(0)) item.reject(error);
      if (code === 0) done(); else reject(error);
    });
  }); void closed.catch(() => {});
  return { trace, call: (op: string, args: Record<string, unknown> = {}): Promise<unknown> => new Promise((resolveResult, reject) => {
    if (terminal) { reject(new Error('pipe closed')); return; }
    const frame = JSON.stringify({ op, ...args }); assert.ok(Buffer.byteLength(frame) < 8 * 1024 * 1024);
    trace.push({ op, ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'bytes')),
      ...(typeof args.bytes === 'string' ? { byteDigest: createHash('sha256').update(Buffer.from(args.bytes, 'base64')).digest('hex') } : {}) });
    waiting.push({ resolve: resolveResult, reject }); child.stdin.write(frame + '\n');
  }), close: async () => { if (!terminal) child.stdin.end(); await closed; } };
}
type Kind = 'success' | 'cancel' | 'invalid' | 'capacity' | 'source-conflict' | 'rollback' | 'unknown' | 'read-restart' | 'read-restore' | 'mapping-selection' | 'prepare-selection';
async function scenario(kind: Kind) {
  const root = mkdtempSync(join(output, `${kind}-`)), f = await buildDirectBranchFixture();
  const processes: Trace[][] = []; let host = launch(root), mapping = false, changed = false;
  let source: StoryBranchSource | undefined, backupId = '', hide: 'none' | 'null' | 'mismatch' | 'io' = 'none';
  let fault = kind === 'rollback' ? 'rollback' : '', lose = kind === 'unknown';
  const prepared: PreparedStoryBranchCommit[] = [];
  const call = (op: string, args?: Record<string, unknown>) => host.call(op, args);
  const restart = async () => { processes.push(host.trace); await host.close(); host = launch(root); };
  const append: StoryNativePort['append'] = (token, part, offset, bytes) => call('append', { token, kind: part, offset, bytes: Buffer.from(bytes).toString('base64') });
  let owner: DesktopArenaStorySession;
  const reads: StoryNativePort = {
    begin: manifest => call('linear-begin', { manifest }), append, end: token => call('linear-end', { token }), abort: async token => { await call('abort', { token }); },
    receipt: (sessionId, operationId) => call('linear-receipt', { sessionId, operationId }),
    listSessions: (cursor, limit) => call('sessions', { cursor, limit }),
    listChapters: async (sessionId, revision, cursor, limit) => {
      const page = await call('chapters', { sessionId, revision, cursor, limit });
      if (mapping && !changed && cursor?.index === 50 && sessionId === f.sessionId) {
        changed = true;
        if (kind === 'read-restore') { await call('prepare-restore', { backupId }); await restart(); }
        if (kind === 'read-restart') await restart();
        if (kind === 'mapping-selection') { await owner.selectChapter(f.chapterIds[0]!); await owner.selectSession(f.head); }
      }
      return page;
    },
    describe: (sessionId, revision, recordKind, recordId) => call('describe', { sessionId, revision, kind: recordKind, recordId }),
    read: async (descriptor, offset, length) => Uint8Array.from(Buffer.from(await call('read', { descriptor, offset, length }) as string, 'base64')),
    continueState: (sessionId, revision, expectedHead) => call('continue', { sessionId, revision, expectedHead }),
    deleteSession: target => call('delete', { target }),
  };
  const branch: StoryBranchNativePort = {
    begin: manifest => call('branch-begin', { manifest }), append, abort: reads.abort,
    end: async token => { const currentFault = fault; fault = ''; const value = await call('branch-end', { token, fault: currentFault });
      if (lose) { lose = false; hide = 'null'; throw new Error('outer reply lost after actual commit'); } return value; },
    receipt: async (sessionId, operationId, requestDigest) => {
      const value = await call('branch-receipt', { sessionId, operationId, requestDigest });
      if (hide === 'io') throw new Error('synthetic receipt read failure'); if (hide === 'null') return null;
      return hide === 'mismatch' && value ? { ...(value as object), requestDigest: `sha256:${'f'.repeat(64)}` } : value;
    },
  };
  owner = new DesktopArenaStorySession({ port: reads, branch: { port: branch,
    source: { resolveAnchor: async request => { const response = await call('branch-anchor', { request }) as { source: StoryBranchSource }; source = structuredClone(response.source); return response; } },
    prepareCommit: (identity, records) => { const commit = kind === 'capacity' ? prepareStoryBranchCommit(identity, records, 1) : prepareStoryBranchCommit(identity, records); prepared.push(commit); return commit; } },
    exportMarkdown: async () => { throw new Error('full branch export is not an unsaved chapter export'); } });
  try {
    await installDirectBranchFixture(reads, f); owner.setExecutionScope('direct-original'); await owner.initialize();
    if (kind === 'read-restore') backupId = (await call('backup') as { backupId: string }).backupId;
    const before = host.trace.length; mapping = true;
    const rawText = kind === 'invalid' ? '<!-- MAHOSHOJO_ARENA_META {invalid -->' : directBranchText;
    const execution = directBranchExecution({ rawText, onRequest: async () => { if (kind === 'source-conflict') await savePreparedStoryCommit(reads, f.next); },
      afterText: async () => {
        if (kind === 'cancel') await new Promise<void>(done => {
          let unsubscribe = () => {};
          const accepted = () => { if (owner.getSnapshot().result?.rawText === rawText) { unsubscribe(); owner.cancel(); done(); } };
          unsubscribe = owner.subscribe(accepted); accepted();
        });
      } });
    await owner.generateBranch({ mode: 'direct', anchor: f.anchor, userGuidance: '在原边界之后向北' }, async run => {
      if (kind === 'prepare-selection') { await owner.selectChapter(f.chapterIds[0]!); await owner.selectSession(f.head); }
      await execution.prepare(run);
    });
    const preModelRefusals: Kind[] = ['read-restart', 'read-restore', 'mapping-selection', 'prepare-selection'];
    assert.equal(execution.requests.length, preModelRefusals.includes(kind) ? 0 : 1, `${kind}: model count`);
    if (execution.requests.length) {
      const request = JSON.parse(execution.requests[0]!.arenaInputJson!);
      assert.deepEqual(request.combatants, branchFixtureRoles(53)); assert.match(request.internalGuidance, /分支续写第 54 章/u);
      assert.ok(request.internalGuidance.includes(f.anchor.anchorChapterId));
    }
    const zeroTargets = preModelRefusals.includes(kind) || ['cancel', 'invalid', 'capacity', 'source-conflict'].includes(kind);
    if (zeroTargets) {
      assert.equal((await reads.listSessions(null, 25) as { rows: unknown[] }).rows.length, 1);
      assert.equal(owner.getSnapshot().resultSaved, false);
      if (['cancel', 'invalid', 'capacity', 'source-conflict'].includes(kind)) assert.equal(owner.getSnapshot().result?.rawText, rawText);
      if (kind !== 'source-conflict') assert.equal([...processes.flat(), ...host.trace].filter(item => item.op === 'branch-begin').length, 0);
      if (kind === 'source-conflict') { assert.equal(owner.getSnapshot().pending?.evidence, 'not-written'); await owner.savePending(); assert.equal(prepared.length, 1); }
      if (kind === 'read-restart' || kind === 'read-restore') {
        const current = await reads.describe(f.sessionId, f.total, 'session', f.sessionId) as StoryRecordDescriptor;
        assert.notEqual(current.instance, source!.session.instance); assert.equal(current.digest, source!.session.digest);
        assert.equal(current.revision, source!.session.revision); assert.ok(changed);
      }
    } else if (kind === 'rollback') {
      assert.equal(owner.getSnapshot().pending?.evidence, 'not-written');
      assert.equal((await reads.listSessions(null, 25) as { rows: unknown[] }).rows.length, 1);
      await owner.savePending(); assert.equal(owner.getSnapshot().resultSaved, true);
    } else if (kind === 'unknown') {
      assert.equal(owner.getSnapshot().pending?.evidence, 'unknown');
      for (const mode of ['null', 'mismatch', 'io'] as const) { hide = mode; await owner.savePending(); assert.equal(owner.getSnapshot().pending?.evidence, 'unknown'); }
      assert.equal(host.trace.filter(item => item.op === 'branch-begin').length, 1);
      await reads.deleteSession(await prepareStorySessionDeletion(reads, f.head));
      await restart(); hide = 'none'; owner.setExecutionScope('direct-new'); await owner.savePending();
      assert.equal(owner.getSnapshot().resultSaved, true); assert.equal(owner.getSnapshot().pending, null);
      assert.equal(host.trace.filter(item => item.op === 'branch-begin').length, 0);
    } else {
      assert.equal(owner.getSnapshot().resultSaved, true); assert.equal(prepared.length, 1);
      const commit = prepared[0]!, target = commit.manifest.sessionId;
      assert.deepEqual(commit.manifest.source, source);
      const session = commit.parts[0]!.prepared.value as { summaryMeta: { coveredChapterIds: string[] }; branchOf: { chapterId: string } };
      assert.deepEqual(session.summaryMeta.coveredChapterIds, f.coveredIndices.map(i => branchCopyId(target, 'c', i)));
      assert.equal(session.branchOf.chapterId, f.anchor.anchorChapterId);
      const generatedTrace = host.trace.slice(before), sourceReads = generatedTrace.filter(item => item.op === 'read' && (item.descriptor as StoryRecordDescriptor).sessionId === f.sessionId);
      assert.deepEqual(sourceReads.filter(item => (item.descriptor as StoryRecordDescriptor).kind === 'chapter').map(item => (item.descriptor as StoryRecordDescriptor).recordId), f.chapterIds.slice(41, 53));
      assert.deepEqual(sourceReads.at(-1), { op: 'read', descriptor: source!.session, offset: 0, length: 1 });
      assert.deepEqual(generatedTrace.filter(item => item.op === 'chapters' && item.sessionId === f.sessionId).map(item => [item.cursor, item.limit]), [[null, 50], [{ id: f.chapterIds[49], index: 50 }, 3]]);
      const sourceNow = await reads.describe(f.sessionId, f.total, 'session', f.sessionId); assert.deepEqual(sourceNow, source!.session);
      // A correct inherited sparse summary must remain legal for ordinary continuation.
      await owner.continue('分支后的普通续写', execution.prepare); assert.equal(execution.requests.length, 2);
      const head = owner.getSnapshot().active!; assert.equal(head.chapterCount, 55); assert.equal(owner.getSnapshot().resultSaved, true);
      const continued = await readStoryRecord(reads, await reads.describe(head.id, head.revision, 'session', head.id) as StoryRecordDescriptor) as { summaryMeta: { coveredUntilChapterIndex: number; coveredChapterIds: string[] } };
      assert.equal(continued.summaryMeta.coveredUntilChapterIndex, 55);
      assert.deepEqual(continued.summaryMeta.coveredChapterIds, [...session.summaryMeta.coveredChapterIds, head.lastChapterId]);
      // Exact copied chapter provenance is a legal source; it is not another model execution receipt.
      const copied = branchCopyId(head.id, 'c', 53), copiedPage = await reads.listChapters(head.id, head.revision, { id: branchCopyId(head.id, 'c', 50), index: 50 }, 5) as StoryChapterPage;
      assert.ok(copiedPage.rows.some(row => row.id === copied && row.index === 53));
      await owner.generateBranch({ mode: 'direct', anchor: { sessionId: head.id, revision: head.revision, expectedLastChapterId: head.lastChapterId,
        expectedChapterCount: head.chapterCount, anchorChapterId: copied, anchorIndex: 53 }, userGuidance: '复制章再分支' }, execution.prepare);
      assert.equal(execution.requests.length, 3); assert.equal(prepared.length, 2); assert.equal(owner.getSnapshot().resultSaved, true);
      assert.equal(prepared[1]!.manifest.source.anchor.recordId, copied);
    }
    if (kind !== 'success') { assert.ok(prepared.length <= 1); assert.equal(execution.requests.length, preModelRefusals.includes(kind) ? 0 : 1); }
    const traces = [...processes, host.trace], begins = traces.flat().filter(item => item.op === 'branch-begin');
    if (kind === 'rollback' || kind === 'source-conflict') { assert.equal(begins.length, 2); assert.deepEqual(begins[0], begins[1]); }
    const report = { kind, passed: true, root, models: execution.requests.length, preparations: prepared.length,
      source, prepared: prepared.map(commit => ({ manifest: commit.manifest, requestDigest: commit.requestDigest })),
      resultSaved: owner.getSnapshot().resultSaved, evidence: owner.getSnapshot().pending?.evidence ?? null, traces };
    writeFileSync(join(output, `${kind}.json`), JSON.stringify(report, null, 2) + '\n');
    return { kind, passed: true, models: execution.requests.length, preparations: prepared.length };
  } catch (error) {
    writeFileSync(join(output, `${kind}-failure.json`), JSON.stringify({ kind, error: String(error), source, state: owner.getSnapshot(),
      prepared: prepared.map(commit => ({ manifest: commit.manifest, requestDigest: commit.requestDigest })), traces: [...processes, host.trace] }, null, 2) + '\n');
    throw error;
  } finally { owner.dispose(); await host.close(); }
}
async function main() {
  const results = [];
  for (const kind of ['success', 'cancel', 'invalid', 'capacity', 'source-conflict', 'rollback', 'unknown', 'read-restart', 'read-restore', 'mapping-selection', 'prepare-selection'] as const) results.push(await scenario(kind));
  const report = { binary, sourceCheckout: repo, results, caveat: 'Actual internal Direct producer/adapter and Rust SQLite/backup/restore; synthetic model transport. No default branch IPC/UI, resource-gate, paid-model, Tauri or Windows acceptance.' };
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
