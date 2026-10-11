/** Explicit opt-in harness: actual production TS preparation/owner -> test-only
 * stdin bridge -> actual Rust/SQLite. Not Tauri, Windows, or a model integration. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, statfsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createHash, webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import { DesktopArenaStorySession } from '../../src/features/arena/story-session';
import { branchCopyId, prepareStoryBranchCommit, type StoryBranchNativePort } from '../../src/platform/arena-story-branch-storage';
import { prepareStoryStorageCommit, savePreparedStoryCommit, prepareStorySessionDeletion, type StoryNativePort } from '../../src/platform/arena-story-storage';
import type { BattleStoryCommitSession } from '@mahoshojo/domain/arena-story-commit';
import { buildCompletedBattleStoryBranchRecords } from '@mahoshojo/domain/arena-story-branch';
import type { StoryBranchManifest, StoryBranchReceipt } from '@mahoshojo/contracts/desktop-arena-story-branch';
import type { StoryCommitManifest, StoryPartKind, StoryRecordDescriptor, StorySessionHead } from '@mahoshojo/contracts/desktop-arena-story';
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const [binary, outputArg, repoArg] = process.argv.slice(2);
assert.ok(binary && outputArg && repoArg, 'binary evidence-directory source-checkout required');
const output = resolve(outputArg), repo = resolve(repoArg); mkdirSync(output, { recursive: true });
const fixture = JSON.parse(readFileSync(join(repo, 'packages/contracts/fixtures/desktop-story-branch-storage.json'), 'utf8')) as {
  sourceCommits: Array<{ manifest: StoryCommitManifest; parts: Array<{ kind: StoryPartKind; document: string }> }>;
  cases: Array<{ manifest: StoryBranchManifest; receipt: StoryBranchReceipt; assembly: Omit<Parameters<typeof buildCompletedBattleStoryBranchRecords<BattleStoryCommitSession, object>>[0], 'mapChapterId'> }>;
};
const testName = 'arena_story::branch::storage::tests::completion_pipe::real_store_branch_completion_pipe';
function launch(root: string) {
  const child = spawn(binary!, ['--ignored', '--exact', testName, '--nocapture', '--test-threads=1'], {
    env: { ...process.env, MAHO_BRANCH_COMPLETION_PIPE_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = [], trace: unknown[] = [];
  let logBytes = 0, stderr = '', terminal = false;
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    logBytes += Buffer.byteLength(line); if (logBytes > 8 * 1024 * 1024) { child.kill(); return; }
    const marker = line.indexOf('BRANCH_PIPE ');
    if (marker < 0) return;
    const reply = JSON.parse(line.slice(marker + 12)), next = waiting.shift(); assert.ok(next, 'unexpected response');
    if (reply.ok) next.resolve(reply.value); else next.reject(reply.error);
  });
  const budget = setInterval(() => { const s = statfsSync(output); if (s.bavail * s.bsize < 256 * 1024 * 1024) child.kill(); }, 250);
  const timeout = setTimeout(() => child.kill(), 60_000);
  const closed = new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('close', code => { terminal = true; clearInterval(budget); clearTimeout(timeout); lines.close();
      const failure = new Error(`test-only pipe exited ${code}: ${stderr}`);
      for (const next of waiting.splice(0)) next.reject(failure);
      if (code === 0) done(); else reject(failure);
    });
  });
  void closed.catch(() => {});
  return {
    trace,
    call: (op: string, args: Record<string, unknown> = {}): Promise<unknown> => new Promise((resolveResult, reject) => {
      if (terminal) { reject(new Error('pipe closed')); return; }
      const frame = JSON.stringify({ op, ...args }); assert.ok(Buffer.byteLength(frame) < 8 * 1024 * 1024);
      trace.push({ op, ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'bytes')),
        ...(typeof args.bytes === 'string' ? { byteDigest: createHash('sha256').update(Buffer.from(args.bytes, 'base64')).digest('hex') } : {}) });
      waiting.push({ resolve: resolveResult, reject }); child.stdin.write(frame + '\n');
    }),
    close: async () => { if (!terminal) child.stdin.end(); await closed; },
  };
}
async function scenario(kind: 'success' | 'lost-reply' | 'rollback' | 'old-descriptor') {
  const root = mkdtempSync(join(output, `${kind}-`)), processes: unknown[] = [];
  let host = launch(root), hide: 'none' | 'null' | 'mismatch' | 'io' = 'none', lose = kind === 'lost-reply', rollback = kind === 'rollback';
  const call = (op: string, args?: Record<string, unknown>) => host.call(op, args);
  const append = (token: string, part: StoryPartKind, offset: number, bytes: Uint8Array) => call('append', { token, kind: part, offset, bytes: Buffer.from(bytes).toString('base64') });
  const reads: StoryNativePort = {
    begin: manifest => call('linear-begin', { manifest }), append, end: token => call('linear-end', { token }), abort: async token => { await call('abort', { token }); },
    receipt: (sessionId, operationId) => call('linear-receipt', { sessionId, operationId }),
    listSessions: (cursor, limit) => call('sessions', { cursor, limit }), listChapters: (sessionId, revision, cursor, limit) => call('chapters', { sessionId, revision, cursor, limit }),
    describe: (sessionId, revision, kind, recordId) => call('describe', { sessionId, revision, kind, recordId }),
    read: async (descriptor, offset, length) => Uint8Array.from(Buffer.from(await call('read', { descriptor, offset, length }) as string, 'base64')),
    continueState: (sessionId, revision, expectedHead) => call('continue', { sessionId, revision, expectedHead }),
    deleteSession: target => call('delete', { target }),
  };
  const branch: StoryBranchNativePort = {
    begin: manifest => call('branch-begin', { manifest }), append, abort: reads.abort,
    end: async token => {
      const fault = rollback ? 'rollback' : ''; rollback = false;
      const value = await call('branch-end', { token, fault });
      if (lose) { lose = false; hide = 'null'; throw new Error('outer response lost AFTER actual successful Native COMMIT'); }
      return value;
    },
    receipt: async (sessionId, operationId, requestDigest) => {
      const value = await call('branch-receipt', { sessionId, operationId, requestDigest });
      if (hide === 'null') return null;
      if (hide === 'io') throw new Error('synthetic query IO');
      if (hide === 'mismatch') return { ...(value as object), requestDigest: `sha256:${'f'.repeat(64)}` };
      return value;
    },
  };
  const prepared: ReturnType<typeof prepareStoryBranchCommit>[] = [];
  const owner = new DesktopArenaStorySession({ port: reads, branch: { port: branch, prepareCommit: (...args) => {
    const commit = prepareStoryBranchCommit(...args); prepared.push(commit); return commit;
  } }, exportMarkdown: async () => { throw new Error('not part of completion pipe'); } });
  try {
    for (const source of fixture.sourceCommits) {
      const begun = await reads.begin(source.manifest) as { token: string };
      for (const part of source.parts) await reads.append(begun.token, part.kind, 0, new TextEncoder().encode(part.document));
      await reads.end(begun.token);
    }
    owner.setExecutionScope('direct-A'); await owner.initialize();
    const f = structuredClone(fixture.cases[0]!), s = f.manifest.source;
    for (const key of ['session', 'seed', 'anchor', 'checkpoint'] as const) {
      const d = s[key]; const live = await reads.describe(d.sessionId, d.revision, d.kind, d.recordId) as StoryRecordDescriptor;
      assert.equal(live.digest, d.digest); assert.equal(live.byteLength, d.byteLength);
      Object.assign(d, live);
    }
    const frozenSource = structuredClone(s), oldInstance = s.session.instance;
    const complete = owner.captureBranchCompletion({ mode: 'direct', generationId: f.assembly.generated.generationId!, operationId: f.manifest.operationId, sessionId: f.manifest.sessionId, source: s });
    // From here the controlled synthetic producer has only frozen generation input.
    const records = buildCompletedBattleStoryBranchRecords({ ...f.assembly, mapChapterId: id => {
      const index = Number(/^source-c([1-3])$/u.exec(id)?.[1]); return index >= 1 && index <= f.assembly.prefixEndIndex ? branchCopyId(f.assembly.session.id, 'c', index) : undefined;
    } });
    if (kind === 'old-descriptor') { processes.push(host.trace); await host.close(); host = launch(root); }
    await complete.complete(records, { markdown: records.chapter.markdown, rawText: records.chapter.markdown, reasoning: '' });
    assert.equal(prepared.length, 1); assert.deepEqual(prepared[0]!.manifest.source, frozenSource);
    if (kind === 'rollback') {
      assert.equal(owner.getSnapshot().pending?.evidence, 'not-written');
      assert.equal((await reads.listSessions(null, 25) as { rows: unknown[] }).rows.length, 1);
      await owner.savePending(); assert.equal(prepared.length, 1);
      const begins = host.trace.filter((x: any) => x.op === 'branch-begin') as Array<{ manifest: unknown }>;
      assert.equal(begins.length, 2); assert.deepEqual(begins[0]!.manifest, begins[1]!.manifest);
    }
    if (kind === 'old-descriptor') {
      assert.equal(owner.getSnapshot().pending?.evidence, 'not-written'); assert.equal(owner.getSnapshot().resultSaved, false);
      await owner.savePending(); assert.equal(prepared.length, 1);
      assert.equal((await reads.listSessions(null, 25) as { rows: unknown[] }).rows.length, 1);
      const current = await reads.describe(s.session.sessionId, s.session.revision, 'session', s.session.recordId) as StoryRecordDescriptor;
      assert.notEqual(current.instance, oldInstance);
    } else if (kind === 'lost-reply') {
      assert.equal(owner.getSnapshot().pending?.evidence, 'unknown');
      for (const mode of ['null', 'mismatch', 'io'] as const) { hide = mode; await owner.savePending(); assert.equal(owner.getSnapshot().pending?.evidence, 'unknown'); }
      assert.equal(host.trace.filter((x: any) => x.op === 'branch-begin').length, 1);
      processes.push(host.trace); await host.close(); host = launch(root); hide = 'none';
      // Continue the saved target before recovering the old receipt, then delete source.
      const next = structuredClone(records), oldHead = next.chapter.id, oldCheckpoint = next.checkpoints[0]!.id;
      next.chapter.id = 'later-linear-operation'; next.chapter.action = 'continue' as 'branch'; next.chapter.index++;
      next.chapter.sourceChapterId = oldHead; next.chapter.generationId = 'later-generation';
      next.session.chapterCount++; next.session.lastChapterId = next.chapter.id;
      next.checkpoints[0]!.id = 'later-checkpoint'; next.checkpoints[0]!.boundaryIndex++; next.checkpoints[0]!.chapterId = next.chapter.id;
      const linear = await prepareStoryStorageCommit({ ...next, expectedRevision: records.chapter.index, expectedLastChapterId: oldHead, lastInputCheckpointId: oldCheckpoint });
      await savePreparedStoryCommit(reads, linear);
      const sourceHead = (await reads.listSessions(null, 25) as { rows: StorySessionHead[] }).rows.find(row => row.id === s.session.sessionId)!;
      await reads.deleteSession(await prepareStorySessionDeletion(reads, sourceHead));
      owner.setExecutionScope('direct-B'); await owner.savePending(); assert.equal(owner.getSnapshot().pending, null); assert.equal(owner.getSnapshot().resultSaved, true);
      await owner.readSavedResult();
      assert.equal(owner.getSnapshot().selected.status, 'loaded');
      if (owner.getSnapshot().selected.status === 'loaded') assert.equal((owner.getSnapshot().selected as { chapterId: string }).chapterId, records.chapter.id);
      assert.equal(host.trace.filter((x: any) => x.op === 'branch-begin').length, 0);
      const receipt = await branch.receipt(prepared[0]!.manifest.sessionId, prepared[0]!.manifest.operationId, prepared[0]!.requestDigest) as StoryBranchReceipt;
      assert.equal(receipt.chapterCount, records.chapter.index);
      const target = (await reads.listSessions(null, 25) as { rows: StorySessionHead[] }).rows[0]!;
      assert.equal(target.chapterCount, records.chapter.index + 1); assert.equal(prepared.length, 1);
    } else {
      assert.equal(owner.getSnapshot().resultSaved, true); assert.equal(owner.getSnapshot().selected.status, 'loaded');
    }
    processes.push(host.trace);
    const report = { kind, root, preparations: prepared.length, source: frozenSource, manifest: prepared[0]!.manifest, requestDigest: prepared[0]!.requestDigest,
      resultSaved: owner.getSnapshot().resultSaved, evidence: owner.getSnapshot().pending?.evidence ?? null,
      selected: owner.getSnapshot().selected.status === 'loaded' ? { status: 'loaded', chapterId: (owner.getSnapshot().selected as { chapterId: string }).chapterId, revision: owner.getSnapshot().active?.revision } : { status: owner.getSnapshot().selected.status }, processes };
    writeFileSync(join(output, `${kind}.json`), JSON.stringify(report, null, 2) + '\n'); return { kind, passed: true, preparations: prepared.length };
  } finally { owner.dispose(); await host.close(); }
}
async function main() {
  const results = [];
  for (const kind of ['success', 'lost-reply', 'rollback', 'old-descriptor'] as const) results.push(await scenario(kind));
  const report = { sourceCheckout: repo, binary: resolve(binary!), results, caveat: 'Controlled completed candidate; no model/anchor-reading UI. Actual Rust store/SQLite via test-only pipe, not Tauri/Windows/resource-gate acceptance.' };
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
