/** Opt-in default JS binder -> real Tauri command macros/ACL (MockRuntime) -> SQLite.
 * A bounded stdin carrier replaces the OS webview transport, not command dispatch.
 * Model events are synthetic; this is not a Windows/webview or real-provider test. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { mkdirSync, mkdtempSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { StoryRecordDescriptor, StorySessionHead } from '@mahoshojo/contracts/desktop-arena-story';
import { createIpcStoryNativePort, STORY_IPC, type StoryInvoke } from '../../src/platform/arena-story-native';
import { createIpcStoryBranchNativePort, createIpcStoryBranchSourcePort, STORY_BRANCH_IPC } from '../../src/platform/arena-story-branch-native';
import { branchCopyId, prepareStoryBranchCommit, type PreparedStoryBranchCommit } from '../../src/platform/arena-story-branch-storage';
import { prepareStorySessionDeletion, savePreparedStoryCommit } from '../../src/platform/arena-story-storage';
import { DesktopArenaStorySession } from '../../src/features/arena/story-session';
import { buildDirectBranchFixture, directBranchExecution, installDirectBranchFixture } from './arena-story-direct-branch-fixture';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const [binaryArg, outputArg] = process.argv.slice(2);
assert.ok(binaryArg && outputArg, 'compiled full Tauri test binary and evidence directory required');
const binary = resolve(binaryArg), output = resolve(outputArg); mkdirSync(output, { recursive: true });
type Request = { cmd: string; args?: Record<string, unknown>; raw?: string; headers?: Record<string, string>; webview?: 'main-ui' | 'untrusted' };
type Trace = Omit<Request, 'raw'> & { rawBytes?: number };
function launch(root: string) {
  const child = spawn(binary, ['--ignored', '--exact', 'arena_story_command_pipe_tests::real_command_branch_pipe', '--nocapture', '--test-threads=1'], {
    env: { ...process.env, MAHO_BRANCH_COMMAND_PIPE_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = [], trace: Trace[] = [];
  let terminal = false, stderr = '', bytesRead = 0;
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    bytesRead += Buffer.byteLength(line); if (bytesRead > 8 * 1024 * 1024) { child.kill(); return; }
    const index = line.indexOf('BRANCH_COMMAND_PIPE '); if (index < 0) return;
    const reply = JSON.parse(line.slice(index + 'BRANCH_COMMAND_PIPE '.length)), item = waiting.shift();
    assert.ok(item, 'unexpected response');
    if (!reply.ok) item.reject(reply.error);
    else if (typeof reply.raw === 'string') {
      const bytes = Uint8Array.from(Buffer.from(reply.raw, 'base64')); item.resolve(bytes.buffer);
    } else item.resolve(reply.value);
  });
  const timeout = setTimeout(() => child.kill(), 90_000);
  const budget = setInterval(() => { const stat = statfsSync(output); if (stat.bavail * stat.bsize < 256 * 1024 * 1024) child.kill(); }, 500);
  const closed = new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('close', code => {
      terminal = true; clearTimeout(timeout); clearInterval(budget); lines.close();
      const error = new Error(`command probe exited ${code}: ${stderr}`);
      for (const item of waiting.splice(0)) item.reject(error);
      if (code === 0) done(); else reject(error);
    });
  }); void closed.catch(() => {});
  return { trace, call: (request: Request): Promise<unknown> => new Promise((resolveResult, reject) => {
    if (terminal) { reject(new Error('command probe closed')); return; }
    const frame = JSON.stringify(request); assert.ok(Buffer.byteLength(frame) < 8 * 1024 * 1024);
    const { raw, ...metadata } = request;
    trace.push({ ...metadata, ...(raw === undefined ? {} : { rawBytes: Buffer.from(raw, 'base64').byteLength }) });
    waiting.push({ resolve: resolveResult, reject }); child.stdin.write(frame + '\n');
  }), close: async () => { if (!terminal) child.stdin.end(); await closed; } };
}
type Kind = 'success' | 'unknown' | 'source-conflict' | 'cancel-before-end' | 'cancel-after-end' | 'late-selection' | 'restart-source';
async function scenario(kind: Kind) {
  const root = mkdtempSync(join(output, `${kind}-`)), f = await buildDirectBranchFixture(2, 3);
  let host = launch(root), hide: 'none' | 'null' | 'mismatch' | 'io' = 'none', lose = kind === 'unknown';
  const traces: Trace[][] = [], prepared: PreparedStoryBranchCommit[] = [];
  let owner: DesktopArenaStorySession, armed = false, cancelled = false;
  const restart = async () => { traces.push(host.trace); await host.close(); host = launch(root); };
  const invoke: StoryInvoke = async (cmd, args, options) => {
    const request: Request = args instanceof Uint8Array
      ? { cmd, raw: Buffer.from(args).toString('base64'), headers: options?.headers }
      : { cmd, args };
    const value = await host.call(request);
    if (armed && cmd === STORY_IPC.append && kind === 'cancel-before-end' && !cancelled) { cancelled = true; owner.cancel(); }
    if (cmd === STORY_BRANCH_IPC.end) {
      if (kind === 'cancel-after-end') owner.cancel();
      if (kind === 'late-selection') await owner.selectSession(f.head);
      if (lose) { lose = false; hide = 'null'; throw new Error('outer ACK lost after real command COMMIT'); }
    }
    if (cmd === STORY_BRANCH_IPC.receipt) {
      if (hide === 'null') return null;
      if (hide === 'io') throw new Error('synthetic receipt transport failure');
      if (hide === 'mismatch' && value) return { ...(value as object), requestDigest: `sha256:${'f'.repeat(64)}` };
    }
    return value;
  };
  // Actual default tauriInvoke reads this host bridge. Do not inject port methods.
  Object.defineProperty(globalThis, 'window', { value: { __TAURI_INTERNALS__: { invoke } }, configurable: true });
  const reads = createIpcStoryNativePort(), branch = createIpcStoryBranchNativePort(), source = createIpcStoryBranchSourcePort();
  owner = new DesktopArenaStorySession({ port: reads, branch: { port: branch, source, prepareCommit: (...args) => {
    const value = prepareStoryBranchCommit(...args); prepared.push(value); return value;
  } }, exportMarkdown: async () => { throw new Error('export outside command probe'); } });
  try {
    await installDirectBranchFixture(reads, f); owner.setExecutionScope('direct-original'); await owner.initialize();
    const generationStart = host.trace.length;
    const execution = directBranchExecution({ onRequest: async () => {
      if (kind === 'source-conflict') await savePreparedStoryCommit(reads, f.next);
      if (kind === 'restart-source') await restart();
    } });
    armed = true;
    await owner.generateBranch({ mode: 'direct', anchor: f.anchor, userGuidance: '正式命令测试' }, execution.prepare);
    armed = false;
    assert.equal(execution.requests.length, 1);
    if (kind === 'unknown') {
      assert.equal(owner.getSnapshot().pending?.evidence, 'unknown');
      for (const value of ['null', 'mismatch', 'io'] as const) {
        hide = value; await owner.savePending(); assert.equal(owner.getSnapshot().pending?.evidence, 'unknown');
      }
      assert.equal(host.trace.filter(x => x.cmd === STORY_BRANCH_IPC.begin).length, 1);
      assert.equal(host.trace.filter(x => x.cmd === STORY_BRANCH_IPC.end).length, 1);
      await reads.deleteSession(await prepareStorySessionDeletion(reads, f.head)); await restart(); hide = 'none';
      owner.setExecutionScope('new-scope'); await owner.savePending();
      assert.equal(owner.getSnapshot().resultSaved, true); assert.equal(owner.getSnapshot().pending, null);
      assert.equal(host.trace.filter(x => x.cmd === STORY_BRANCH_IPC.begin || x.cmd === STORY_BRANCH_IPC.end).length, 0);
    } else if (['source-conflict', 'restart-source', 'cancel-before-end'].includes(kind)) {
      assert.equal(owner.getSnapshot().resultSaved, false);
      assert.equal((await reads.listSessions(null, 25) as { rows: unknown[] }).rows.length, 1);
      if (kind === 'cancel-before-end') assert.equal(host.trace.filter(x => x.cmd === STORY_BRANCH_IPC.end).length, 0);
      else {
        assert.equal(owner.getSnapshot().pending?.evidence, 'not-written');
        await owner.savePending(); assert.equal(prepared.length, 1);
        const begins = [...traces.flat(), ...host.trace].filter(x => x.cmd === STORY_BRANCH_IPC.begin);
        assert.equal(begins.length, 2); assert.deepEqual(begins[0]!.args, begins[1]!.args);
      }
    } else {
      assert.equal(owner.getSnapshot().resultSaved, true); assert.equal(prepared.length, 1);
      if (kind === 'late-selection') assert.equal(owner.getSnapshot().active?.id, f.sessionId);
      if (kind === 'success') {
        const generated = host.trace.slice(generationStart);
        assert.equal(generated.filter(x => x.cmd === STORY_IPC.describe && x.args?.sessionId === f.sessionId).length, 0);
        const copied = branchCopyId(prepared[0]!.manifest.sessionId, 'c', f.k);
        // Saved branch supports unchanged v1 continuation and copied-source branching.
        await owner.continue('原线性续写', execution.prepare); assert.equal(owner.getSnapshot().resultSaved, true);
        const head = owner.getSnapshot().active!; assert.equal(head.chapterCount, 4);
        await owner.generateBranch({ mode: 'direct', anchor: { sessionId: head.id, revision: head.revision,
          expectedChapterCount: head.chapterCount, expectedLastChapterId: head.lastChapterId, anchorChapterId: copied, anchorIndex: f.k }, userGuidance: '复制章分支' }, execution.prepare);
        assert.equal(prepared.length, 2); assert.equal(owner.getSnapshot().resultSaved, true);
        await boundaryChecks(host, reads, branch, prepared[0]!, f);
      }
    }
    const report = { kind, passed: true, preparations: prepared.length, resultSaved: owner.getSnapshot().resultSaved,
      evidence: owner.getSnapshot().pending?.evidence ?? null, traces: [...traces, host.trace] };
    writeFileSync(join(output, `${kind}.json`), JSON.stringify(report, null, 2) + '\n'); return { kind, passed: true };
  } catch (error) {
    writeFileSync(join(output, `${kind}-failure.json`), JSON.stringify({ kind, error: String(error),
      state: owner.getSnapshot(), prepared: prepared.map(commit => ({ manifest: commit.manifest, requestDigest: commit.requestDigest })),
      traces: [...traces, host.trace] }, null, 2) + '\n');
    throw error;
  } finally { owner.dispose(); await host.close(); }
}
async function boundaryChecks(host: ReturnType<typeof launch>, reads: ReturnType<typeof createIpcStoryNativePort>, branch: ReturnType<typeof createIpcStoryBranchNativePort>,
  prepared: PreparedStoryBranchCommit, f: Awaited<ReturnType<typeof buildDirectBranchFixture>>) {
  const branchToken = (await branch.begin(prepared.manifest) as { token: string }).token;
  for (const part of prepared.parts) {
    let offset = 0;
    for (const bytes of part.prepared.chunks(4 * 1024 * 1024)) { await branch.append(branchToken, part.kind, offset, bytes); offset += bytes.byteLength; }
  }
  await assert.rejects(reads.end(branchToken), { code: 'story-invalid' });
  assert.equal((await branch.end(branchToken) as { requestDigest: string }).requestDigest, prepared.requestDigest);
  await branch.abort(branchToken);
  const original = f.commits[0]!, completedLinearToken = (await reads.begin(original.manifest) as { token: string }).token;
  for (const part of original.parts) {
    let offset = 0;
    for (const bytes of part.prepared.chunks(4 * 1024 * 1024)) { await reads.append(completedLinearToken, part.kind, offset, bytes); offset += bytes.byteLength; }
  }
  await assert.rejects(branch.end(completedLinearToken), { code: 'story-invalid' });
  assert.equal((await reads.end(completedLinearToken) as { operationId: string }).operationId, original.manifest.operationId);
  await reads.abort(completedLinearToken);
  const linearToken = (await reads.begin(f.next.manifest) as { token: string }).token;
  const headers = { 'x-story-token': linearToken, 'x-story-part': 'session', 'x-story-offset': '0' };
  await assert.rejects(host.call({ cmd: STORY_IPC.append, args: { bytes: [1] }, headers }), { code: 'story-invalid' });
  for (const [key, value] of [['x-story-token', '../invalid'], ['x-story-part', 'Chapter'], ['x-story-offset', '01']] as const) {
    await assert.rejects(host.call({ cmd: STORY_IPC.append, raw: 'eA==', headers: { ...headers, [key]: value } }), { code: 'story-invalid' });
  }
  await assert.rejects(host.call({ cmd: STORY_IPC.append, raw: '', headers }), { code: 'story-too-large' });
  await assert.rejects(host.call({ cmd: STORY_IPC.append, raw: Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64'), headers }), { code: 'story-too-large' });
  await assert.rejects(host.call({ cmd: STORY_BRANCH_IPC.end, args: { token: '../invalid' } }), { code: 'story-invalid' });
  await assert.rejects(host.call({ cmd: STORY_BRANCH_IPC.begin, args: { manifest: { ...prepared.manifest, extra: true } } }));
  for (const cmd of Object.values(STORY_BRANCH_IPC)) {
    const args = cmd === STORY_BRANCH_IPC.begin ? { manifest: prepared.manifest }
      : cmd === STORY_BRANCH_IPC.end ? { token: branchToken }
        : cmd === STORY_BRANCH_IPC.receipt ? { sessionId: prepared.manifest.sessionId, operationId: prepared.manifest.operationId, requestDigest: prepared.requestDigest }
          : { request: f.anchor };
    await assert.rejects(host.call({ cmd, args, webview: 'untrusted' }), /not allowed|denied|forbidden/iu);
  }
  await reads.abort(linearToken);
  // The original source remains unchanged; descriptor equality is checked by read.
  const descriptor = await reads.describe(f.sessionId, f.total, 'session', f.sessionId) as StoryRecordDescriptor;
  await reads.read(descriptor, 0, 1);
  assert.equal((await reads.listSessions(null, 25) as { rows: StorySessionHead[] }).rows.find(row => row.id === f.sessionId)!.chapterCount, f.total);
}
async function main() {
  const results = [];
  for (const kind of ['success', 'unknown', 'source-conflict', 'cancel-before-end', 'cancel-after-end', 'late-selection', 'restart-source'] as const) results.push(await scenario(kind));
  const report = { binary, results, caveat: 'Default Tauri JS invoke and real command macro/ACL dispatcher using MockRuntime + SQLite; bounded test-only base64 pipe carrier. No OS webview, Windows, real provider or resource-peak claim.' };
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
