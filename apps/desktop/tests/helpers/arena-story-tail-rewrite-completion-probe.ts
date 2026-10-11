/** Opt-in actual TS owner -> test-only stdin -> actual Rust/SQLite. Only model
 * responses are synthetic. No Tauri command, UI activation or live account. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { StoryCommitManifest, StoryPartKind, StoryRecordDescriptor, StorySessionHead } from '@mahoshojo/contracts/desktop-arena-story';
import type { BattleStoryArenaRequestInput } from '@mahoshojo/domain/arena-battle-story-request';
import { DesktopArenaStorySession, type PrepareStoryExecution } from '../../src/features/arena/story-session';
import { createInitialArenaDraft } from '../../src/features/arena/session';
import { captureDesktopStorySeed } from '../../src/features/arena/story-snapshot';
import type { executeArenaDirect } from '../../src/features/arena/direct';
import { prepareStoryTailRewriteCommit, type PreparedStoryTailRewriteCommit, type StoryTailRewriteNativePort } from '../../src/platform/arena-story-tail-rewrite-storage';
import { readStoryRecord, type StoryNativePort } from '../../src/platform/arena-story-storage';
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const [binary, outputArg, repoArg, nativeSourceArg] = process.argv.slice(2);
assert.ok(binary && outputArg && repoArg && nativeSourceArg, 'binary evidence-directory source-checkout native-source-snapshot required');
const output = resolve(outputArg), repo = resolve(repoArg); mkdirSync(output, { recursive: true });
const fixture = JSON.parse(readFileSync(join(repo, 'packages/contracts/fixtures/desktop-story-tail-rewrite-storage.json'), 'utf8')) as {
  sourceCommits: Array<{ manifest: StoryCommitManifest; parts: Array<{ kind: StoryPartKind; document: string }> }>;
};
const sha = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const unknownToken = '"opaque":{"duplicate":1,"duplicate":2,"number":1e+02,"lone":"\\ud800","escaped":"\\u4e2d"}';
function launch(root: string) {
  const available = statfsSync(output); assert.ok(available.bavail * available.bsize >= 256 * 1024 * 1024, '256 MiB free-space floor');
  const child = spawn(binary!, ['--ignored', '--exact', 'arena_story::branch::tail_rewrite::completion_pipe::real_store_tail_rewrite_completion_pipe', '--nocapture', '--test-threads=1'], {
    env: { ...process.env, MAHO_TAIL_REWRITE_PIPE_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = [], trace: Array<Record<string, unknown>> = [];
  let stderr = '', terminal = false, bytes = 0;
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    bytes += Buffer.byteLength(line); if (bytes > 8 * 1024 * 1024) { child.kill(); return; }
    const index = line.indexOf('TAIL_REWRITE_PIPE '); if (index < 0) return;
    const result = JSON.parse(line.slice(index + 'TAIL_REWRITE_PIPE '.length)), next = waiting.shift(); assert.ok(next);
    if (result.ok) next.resolve(result.value); else next.reject(result.error);
  });
  const budget = setInterval(() => { const s = statfsSync(output); if (s.bavail * s.bsize < 256 * 1024 * 1024) child.kill(); }, 250);
  const timeout = setTimeout(() => child.kill(), 60_000);
  const closed = new Promise<void>((done, reject) => { child.once('error', reject); child.once('close', code => {
    terminal = true; clearInterval(budget); clearTimeout(timeout); lines.close();
    const error = new Error(`tail pipe exited ${code}: ${stderr}`); for (const item of waiting.splice(0)) item.reject(error);
    if (code === 0) done(); else reject(error);
  }); }); void closed.catch(() => {});
  return { trace, call: (op: string, args: Record<string, unknown> = {}): Promise<unknown> => new Promise((done, reject) => {
    if (terminal) { reject(new Error('pipe closed')); return; }
    const frame = JSON.stringify({ op, ...args }); assert.ok(Buffer.byteLength(frame) < 8 * 1024 * 1024);
    trace.push({ op, ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'bytes')),
      ...(typeof args.bytes === 'string' ? { byteDigest: sha(Buffer.from(args.bytes, 'base64')) } : {}) });
    waiting.push({ resolve: done, reject }); child.stdin.write(frame + '\n');
  }), close: async () => { if (!terminal) child.stdin.end(); await closed; } };
}
type Scenario = 'first' | 'third' | 'long-window' | 'multiple' | 'rollback' | 'commit-failed' | 'cold-unknown' | 'source-restart' | 'saved-unread';
async function scenario(kind: Scenario) {
  const root = mkdtempSync(join(output, `${kind}-`)); let host = launch(root), hide: 'none' | 'absent' | 'mismatch' | 'io' = 'none';
  const receipts: unknown[] = [];
  const traces: Array<Array<Record<string, unknown>>> = [], models: BattleStoryArenaRequestInput[] = [], prepared: PreparedStoryTailRewriteCommit[] = [];
  let fault = kind === 'rollback' ? 'rollback' : kind === 'commit-failed' ? 'commit-failed' : kind === 'cold-unknown' ? 'commit-unknown' : '';
  let id = 0, failRead = false;
  const call = (op: string, args?: Record<string, unknown>) => host.call(op, args);
  const append = (token: string, kind: StoryPartKind, offset: number, bytes: Uint8Array) => call('append', { token, kind, offset, bytes: Buffer.from(bytes).toString('base64') });
  const reads: StoryNativePort = {
    begin: manifest => call('linear-begin', { manifest }), append, end: token => call('linear-end', { token }), abort: async token => { await call('abort', { token }); },
    receipt: (sessionId, operationId) => call('linear-receipt', { sessionId, operationId }),
    listSessions: (cursor, limit) => { if (failRead) throw new Error('synthetic directory read IO after exact receipt'); return call('sessions', { cursor, limit }); },
    listChapters: (sessionId, revision, cursor, limit) => call('chapters', { sessionId, revision, cursor, limit }),
    describe: (sessionId, revision, kind, recordId) => call('describe', { sessionId, revision, kind, recordId }),
    read: async (descriptor, offset, length) => Uint8Array.from(Buffer.from(await call('read', { descriptor, offset, length }) as string, 'base64')),
    continueState: (sessionId, revision, expectedHead) => call('continue', { sessionId, revision, expectedHead }), deleteSession: target => call('delete', { target }),
  };
  const tail: StoryTailRewriteNativePort = {
    begin: manifest => call('tail-begin', { manifest }), append, abort: reads.abort,
    end: async token => {
      const current = fault; fault = '';
      try { const receipt = await call('tail-end', { token, fault: current }); receipts.push(receipt); if (kind === 'saved-unread') failRead = true; return receipt; }
      catch (error) { if (current === 'commit-unknown') hide = 'absent'; throw error; }
    },
    receipt: async (sessionId, operationId, requestDigest) => {
      const value = await call('tail-receipt', { sessionId, operationId, requestDigest });
      if (value) receipts.push(value);
      if (hide === 'absent') return null; if (hide === 'io') throw new Error('synthetic receipt IO');
      if (hide === 'mismatch' && value) return { ...(value as object), requestDigest: `sha256:${'f'.repeat(64)}` };
      return value;
    },
  };
  const execute: typeof executeArenaDirect = async (_options, _draft, intent, context, _signal, partial) => {
    models.push(context.story!); partial?.({ rawText: '流式原文', markdown: '流式原文', reasoning: '流式推理' });
    if (kind === 'source-restart') { traces.push(host.trace); await host.close(); host = launch(root); }
    return { status: 'completed', requestId: intent.requestId, scopeKey: context.scopeKey, mode: intent.mode, terminal: null,
      rawText: '完整原文', markdown: '# 完整新尾章\n星的全新故事 😀', reasoning: '完整推理', metaStatus: 'valid',
      report: { headline: '完整新尾章', mode: 'classic', officialReport: { winner: '星' } },
      impacts: [{ characterName: '星', impact: '成长', currentStateSummary: '新状态' }] } as Awaited<ReturnType<typeof executeArenaDirect>>;
  };
  const createOwner = () => new DesktopArenaStorySession({ port: reads, tailRewrite: { port: tail, source: { resolveSource: request => call('tail-source', { request }) }, prepareCommit: (...args) => {
    const value = prepareStoryTailRewriteCommit(...args); prepared.push(value); return value;
  } }, execute, id: () => `owner-${++id}`, now: () => 1_000 + id, exportMarkdown: async () => { throw new Error('no export'); } });
  let owner = createOwner();
  const prepare: PrepareStoryExecution = async run => run({ options: { invoke: async () => { throw new Error('mock model only'); }, profileId: 'synthetic', createChannel: () => ({}) }, intent: { mode: 'direct-local', modelId: 'synthetic-model' } });
  const count = kind === 'first' ? 1 : kind === 'long-window' ? 14 : 3;
  const initial = createInitialArenaDraft();
  const draft = { ...initial, combatants: ['星', '月'].map(name => ({ type: 'general-character', data: { name, content: '原始完整角色', signature: 'synthetic-card-signature', custom: { signature: 'ordinary' } }, isValid: false, isPreset: false, filename: '' })),
    settings: { ...initial.settings, writeArenaHistory: true, writeCurrentState: true } };
  const seed = captureDesktopStorySeed(draft, 'battle');
  try {
    for (let index = 1; index <= count; index++) {
      const input = structuredClone(fixture.sourceCommits[Math.min(index, 3) - 1]!);
      const documents = input.parts.map(part => {
        const value = JSON.parse(part.document);
        if (part.kind === 'seed') return { kind: part.kind, document: JSON.stringify(seed) };
        if (part.kind === 'session') {
          Object.assign(value, { revision: index, chapterCount: index, lastChapterId: `source-c${index}`, workingCheckpointId: `source-p${index}`,
            lastInputCheckpointId: `source-p${index - 1}`, updatedAt: index, sessionSummary: '安全早期摘要', summaryMeta: {
              coveredUntilChapterIndex: 1, coveredChapterIds: ['source-c1'], refreshedAt: 1, mode: 'deterministic-fallback', extension: { kept: true } } });
          delete value.opaque;
          let document = JSON.stringify(value);
          if (kind === 'third') document = document.replace(JSON.stringify(value.source), JSON.stringify(value.source).slice(0, -1) + ',' + unknownToken + '}');
          return { kind: part.kind, document: document.slice(0, -1) + ',' + unknownToken + '}' };
        }
        if (part.kind === 'chapter') Object.assign(value, { id: `source-c${index}`, index, createdAt: index, sourceChapterId: index > 1 ? `source-c${index - 1}` : null });
        if (part.kind.startsWith('checkpoint')) {
          const boundary = part.kind === 'checkpoint0' ? 0 : index;
          Object.assign(value, { id: `source-p${boundary}`, boundaryIndex: boundary, createdAt: index, chapterId: boundary === 0 ? null : `source-c${boundary}`,
            combatants: seed.combatants.map(role => ({ ...(role as object), data: { ...(role as { data: object }).data,
              current_state: { summary: `boundary-${boundary}`, unknown: true }, arena_history: { attributes: { world_line_id: 'original-world' }, entries: [{ id: `prior-${boundary}`, custom: true }] } } })) });
        }
        return { kind: part.kind, document: JSON.stringify(value) };
      });
      const manifest = { ...input.manifest, operationId: `source-c${index}`, expectedRevision: index - 1, expectedLastChapterId: index > 1 ? `source-c${index - 1}` : null,
        parts: documents.map(part => ({ kind: part.kind, byteLength: Buffer.byteLength(part.document), digest: sha(part.document) })) };
      const begun = await reads.begin(manifest) as { token: string };
      for (const part of documents) await append(begun.token, part.kind, 0, Buffer.from(part.document));
      await reads.end(begun.token);
    }
    owner.setExecutionScope('synthetic-A'); await owner.initialize();
    const rewrite = async () => { const head = owner.getSnapshot().active!; await owner.generateTailRewrite({ mode: 'direct', userGuidance: '完整改写引导',
      target: { sessionId: head.id, expectedRevision: head.revision, expectedChapterCount: head.chapterCount, targetChapterId: head.lastChapterId } }, prepare); };
    await rewrite(); assert.equal(prepared.length, 1); assert.equal(models.length, 1);
    const first = prepared[0]!;
    assert.equal(models[0]!.action, 'rewrite'); assert.equal(models[0]!.sourceChapterId, `source-c${count}`);
    assert.equal(models[0]!.chapterContext.recentWindow!.length, Math.min(12, count)); assert.equal(models[0]!.chapterContext.recentWindow!.at(-1)!.chapterId, `source-c${count}`);
    assert.equal(((models[0]!.chapterContext.workingCombatants[0] as { data: { current_state: { summary: string } } }).data.current_state.summary), `boundary-${count - 1}`);
    assert.equal(models[0]!.chapterContext.sessionSummary, count === 1 ? undefined : '安全早期摘要');
    if (kind === 'rollback') {
      assert.equal(owner.getSnapshot().pending?.evidence, 'not-written'); assert.equal(owner.getSnapshot().resultSaved, false);
      await owner.savePending(); assert.equal(prepared.length, 1); assert.equal(models.length, 1);
      const begins = host.trace.filter(x => x.op === 'tail-begin'); assert.equal(begins.length, 2); assert.deepEqual(begins[0]!.manifest, begins[1]!.manifest);
    }
    if (kind === 'commit-failed') {
      assert.equal(owner.getSnapshot().pending?.evidence, 'unknown');
      await owner.savePending(); await owner.savePending();
      assert.equal(owner.getSnapshot().pending?.evidence, 'unknown');
      assert.equal(host.trace.filter(x => x.op === 'tail-begin').length, 1);
      assert.equal(models.length, 1); assert.equal(prepared.length, 1);
      assert.equal((await reads.listSessions(null, 25) as { rows: StorySessionHead[] }).rows[0]!.revision, count);
    } else if (kind === 'source-restart') {
      assert.equal(owner.getSnapshot().pending?.evidence, 'not-written'); await owner.savePending(); assert.equal(prepared.length, 1); assert.equal(models.length, 1);
      assert.equal(owner.getSnapshot().resultSaved, false); assert.equal((await reads.listSessions(null, 25) as { rows: StorySessionHead[] }).rows[0]!.revision, count);
    } else if (kind === 'cold-unknown') {
      assert.equal(owner.getSnapshot().pending?.evidence, 'unknown'); const result = owner.getSnapshot().result!;
      owner.dispose(); traces.push(host.trace); await host.close(); host = launch(root);
      // Both the Native process and owner are fresh. The only retained recovery
      // input is the original prepared handle; no new source or model is available.
      owner = createOwner();
      for (const mode of ['absent', 'mismatch', 'io'] as const) {
        hide = mode;
        if (mode === 'absent') await owner.recoverTailRewriteReceipt(first, result); else await owner.savePending();
        assert.equal(owner.getSnapshot().pending?.evidence, 'unknown');
      }
      hide = 'none'; await owner.savePending();
      assert.equal(host.trace.filter(x => x.op === 'tail-begin' || x.op === 'tail-source').length, 0);
      assert.equal(prepared.length, 1); assert.equal(models.length, 1);
    }
    if (kind !== 'source-restart' && kind !== 'commit-failed') {
      assert.equal(owner.getSnapshot().resultSaved, true); assert.equal(owner.getSnapshot().pending, null);
      if (kind === 'saved-unread' || kind === 'cold-unknown') assert.ok(owner.getSnapshot().savedUnread);
      failRead = false; await owner.readSavedResult();
      if (kind === 'multiple') { await rewrite(); assert.equal(prepared.length, 2); assert.equal(prepared[1]!.manifest.source.inputCheckpointId, first.manifest.source.inputCheckpointId); }
      const head = (await reads.listSessions(null, 25) as { rows: StorySessionHead[] }).rows[0]!;
      const descriptor = await reads.describe(head.id, head.revision, 'session', head.id) as StoryRecordDescriptor;
      const raw = Buffer.from(await reads.read(descriptor, 0, descriptor.byteLength)).toString('utf8'); assert.ok(raw.includes(unknownToken), 'Native retains exact unknown raw tokens');
      const session = JSON.parse(raw); assert.equal(session.opaque.lone, '\ud800');
      if (kind === 'third') { assert.equal(session.source.opaque.duplicate, 2); assert.equal(raw.split(unknownToken).length - 1, 2); }
      const checkpoint = await readStoryRecord(reads, await reads.describe(head.id, head.revision, 'checkpoint', session.workingCheckpointId) as StoryRecordDescriptor) as { combatants: Array<{ data: Record<string, any> }> };
      assert.equal(checkpoint.combatants[0]!.data.current_state.summary, '新状态'); assert.equal(checkpoint.combatants[0]!.data.arena_history.entries.length, 2);
      assert.equal(checkpoint.combatants[0]!.data.signature, undefined); assert.equal(checkpoint.combatants[0]!.data.custom.signature, 'ordinary');
      if (kind === 'first' || kind === 'multiple' || kind === 'long-window') { await owner.continue('接着写', prepare); assert.equal(owner.getSnapshot().active?.chapterCount, count + 1); }
    }
    traces.push(host.trace);
    const report = { kind, root, passed: true, models: models.length, preparations: prepared.length, manifest: first.manifest, requestDigest: first.requestDigest,
      resultSaved: owner.getSnapshot().resultSaved, evidence: owner.getSnapshot().pending?.evidence ?? null, receipts, traces };
    writeFileSync(join(output, `${kind}.json`), JSON.stringify(report, null, 2) + '\n'); return { kind, passed: true, models: models.length, preparations: prepared.length };
  } catch (error) {
    writeFileSync(join(output, `${kind}-failure.json`), JSON.stringify({ kind, error: error instanceof Error ? { message: error.message, stack: error.stack } : error, state: owner.getSnapshot(), traces: [...traces, host.trace] }, null, 2));
    throw error;
  } finally { owner.dispose(); await host.close(); }
}
function snapshotSources() {
  const files: string[] = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (/\.(ts|tsx|json)$/.test(entry.name)) files.push(path);
    }
  };
  collect(join(repo, 'apps/desktop/src'));
  for (const pkg of readdirSync(join(repo, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const path = join(repo, 'packages', pkg.name);
    if (readdirSync(path).includes('src')) collect(join(path, 'src'));
    files.push(join(path, 'package.json'));
  }
  files.push(join(repo, 'apps/desktop/tests/helpers/arena-story-tail-rewrite-completion-probe.ts'));
  const native = JSON.parse(readFileSync(nativeSourceArg!, 'utf8')) as Record<string, string>;
  for (const [path, expected] of Object.entries(native)) assert.equal(sha(readFileSync(path)).slice(7), expected, `Native source changed: ${path}`);
  return { typescript: Object.fromEntries(files.sort().map(path => [path, sha(readFileSync(path))])), native };
}
async function binaryDigest() { const hash = createHash('sha256'); for await (const chunk of createReadStream(binary!)) hash.update(chunk); return hash.digest('hex'); }
async function main() {
  const sourcesBefore = snapshotSources(), binaryShaBefore = await binaryDigest();
  writeFileSync(join(output, 'sources-before.json'), JSON.stringify({ binaryShaBefore, ...sourcesBefore }, null, 2));
  const results = [];
  try {
  for (const kind of ['first', 'third', 'long-window', 'multiple', 'rollback', 'commit-failed', 'cold-unknown', 'source-restart', 'saved-unread'] as const) results.push(await scenario(kind));
  } finally {
    const sourcesAfter = snapshotSources(), binaryShaAfter = await binaryDigest();
    writeFileSync(join(output, 'sources-after.json'), JSON.stringify({ binaryShaAfter, ...sourcesAfter }, null, 2));
    assert.deepEqual(sourcesAfter, sourcesBefore, 'TS/Native inputs changed during pipe verification');
    assert.equal(binaryShaAfter, binaryShaBefore, 'Native binary changed during pipe verification');
  }
  const sourcesAfter = snapshotSources(), binaryShaAfter = await binaryDigest();
  assert.deepEqual(sourcesAfter, sourcesBefore, 'TS/Native inputs changed during pipe verification');
  assert.equal(binaryShaAfter, binaryShaBefore, 'Native binary changed during pipe verification');
  const report = { sourceCheckout: repo, binary: resolve(binary!), binaryShaBefore, binaryShaAfter, sourceStable: true, sourcesBefore, sourcesAfter, results, caveat: 'Actual internal TS owner and Rust SQLite; only model responses synthetic. No Tauri/Windows/default UI/resource-gate acceptance.' };
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
