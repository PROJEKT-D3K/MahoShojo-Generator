import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeStoryTailRewriteManifest, encodeStoryTailRewriteReceipt, decodeStoryTailRewriteManifest, type StoryTailRewriteManifest, type StoryTailRewriteReceipt } from '@mahoshojo/contracts/desktop-arena-story-tail-rewrite';
import { createIpcStoryTailRewriteNativePort, createIpcStoryTailRewriteSourcePort, STORY_TAIL_REWRITE_IPC } from '../src/platform/arena-story-tail-rewrite-native';
import { STORY_IPC, type StoryInvoke } from '../src/platform/arena-story-native';
import { freezeStoryTailRewriteIdentity, prepareStoryTailRewriteCommit, savePreparedStoryTailRewriteCommit, type CompletedStoryTailRewriteRecords } from '../src/platform/arena-story-tail-rewrite-storage';
import { DesktopArenaStorySession } from '../src/features/arena/story-session';
import { tailRewriteFixture } from './helpers/tail-rewrite-fixture';
const golden = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/desktop-story-tail-rewrite-storage.json', import.meta.url), 'utf8')) as {
  cases: Array<{ manifest: StoryTailRewriteManifest; receipt: StoryTailRewriteReceipt; expected: CompletedStoryTailRewriteRecords }>;
};
const token = `${'a'.repeat(32)}-${'b'.repeat(32)}`;
afterEach(() => vi.unstubAllGlobals());

/** Actual Tauri JS invoke and default factory arguments, replacing only host transport. */
function transport() {
  const f = structuredClone(golden.cases[0]!);
  const commit = prepareStoryTailRewriteCommit(freezeStoryTailRewriteIdentity(f.manifest), f.expected);
  let saved: StoryTailRewriteReceipt | null = null, rollback = false, malformedEnd = false;
  let hide: 'none' | 'null' | 'mismatch' | 'io' | 'malformed' = 'none';
  const invoke = vi.fn<StoryInvoke>(async (command, args, options) => {
    if (command === STORY_TAIL_REWRITE_IPC.begin) return { token, totalBytes: commit.byteLength };
    if (command === STORY_IPC.append) {
      expect(args).toBeInstanceOf(Uint8Array);
      const headers = options!.headers;
      expect(Object.keys(headers).sort()).toEqual(['x-story-offset', 'x-story-part', 'x-story-token']);
      expect(headers['x-story-token']).toBe(token);
      return { token, kind: headers['x-story-part'], receivedBytes: Number(headers['x-story-offset']) + (args as Uint8Array).byteLength };
    }
    if (command === STORY_TAIL_REWRITE_IPC.end) {
      if (rollback) { rollback = false; throw { code: 'story-stale', message: 'explicit rollback', writeEvidence: 'not-written' }; }
      saved = { ...f.receipt, requestDigest: commit.requestDigest };
      if (malformedEnd) { hide = 'malformed'; return '{"version":3,"version":3}'; }
      return encodeStoryTailRewriteReceipt(saved);
    }
    if (command === STORY_TAIL_REWRITE_IPC.receipt) {
      expect(args).toEqual({ sessionId: commit.manifest.sessionId, operationId: commit.manifest.operationId, requestDigest: commit.requestDigest });
      if (hide === 'io') throw new Error('read failed');
      if (hide === 'null') return null;
      if (hide === 'malformed') return saved ? encodeStoryTailRewriteReceipt(saved).replace('"version":3', '"version":3,"version":3') : null;
      return saved ? encodeStoryTailRewriteReceipt(hide === 'mismatch' ? { ...saved, requestDigest: `sha256:${'f'.repeat(64)}` } : saved) : null;
    }
    if (command === STORY_IPC.abort) return undefined;
    throw new Error(`Unexpected command: ${command}`);
  });
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
  return { commit, port: createIpcStoryTailRewriteNativePort(), invoke,
    rollback: () => { rollback = true; }, malformedEnd: () => { malformedEnd = true; }, setHide: (value: typeof hide) => { hide = value; } };
}

describe('default tail rewrite binder through actual Tauri JS invoke', () => {
  it('sends the exact canonical text and raw frames through separate v3 commands', async () => {
    const { commit, port, invoke } = transport();
    await expect(savePreparedStoryTailRewriteCommit(port, commit)).resolves.toMatchObject({ requestDigest: commit.requestDigest });
    expect(invoke.mock.calls.find(call => call[0] === STORY_TAIL_REWRITE_IPC.begin)![1]).toEqual({ manifestJson: encodeStoryTailRewriteManifest(commit.manifest) });
    expect(invoke.mock.calls.filter(call => call[0] === STORY_IPC.append).map(call => call[2]!.headers['x-story-part'])).toEqual(['session', 'chapter', 'checkpoint1']);
    expect(invoke).toHaveBeenLastCalledWith(STORY_IPC.abort, { token }, undefined);
    expect(invoke.mock.calls.some(call => [STORY_IPC.describe, STORY_IPC.begin, STORY_IPC.end].includes(call[0] as typeof STORY_IPC.begin))).toBe(false);
  });
  it('passes only the frozen resolver request without renewing source authority', async () => {
    const { commit, invoke } = transport(); invoke.mockResolvedValueOnce({ marker: 'descriptors' });
    const { source, sessionId } = commit.manifest;
    const request = { sessionId, expectedRevision: source.expectedRevision, expectedChapterCount: source.expectedChapterCount, targetChapterId: source.targetChapterId };
    await expect(createIpcStoryTailRewriteSourcePort().resolveSource(request)).resolves.toEqual({ marker: 'descriptors' });
    expect(invoke.mock.calls).toEqual([[STORY_TAIL_REWRITE_IPC.resolveSource, { request }, undefined]]);
  });
  it('rejects invalid manifests and frames before dispatch', () => {
    const { port, invoke, commit } = transport();
    expect(() => port.begin({ ...commit.manifest, version: 2 } as unknown as StoryTailRewriteManifest)).toThrow();
    for (const bytes of [new Uint8Array(), new Uint8Array(4 * 1024 * 1024 + 1)]) expect(() => port.append(token, 'chapter', 0, bytes)).toThrow();
    for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => port.append(token, 'chapter', offset, new Uint8Array([1]))).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each(['object', 'duplicate', 'oversized', 'unknown', 'fraction'] as const)('rejects %s receipts without losing raw evidence', async kind => {
    const { port, invoke, commit } = transport();
    const value = { ...golden.cases[0]!.receipt, requestDigest: commit.requestDigest }, raw = encodeStoryTailRewriteReceipt(value);
    const malformed: unknown = kind === 'object' ? value : kind === 'duplicate' ? raw.replace('"version":3', '"version":3,"\\u0076ersion":3')
      : kind === 'oversized' ? raw.padEnd(2049, ' ') : kind === 'unknown' ? raw.replace('{', '{"extra":0,') : raw.replace('"revision":2', '"revision":2.0');
    invoke.mockResolvedValue(malformed);
    await expect(port.end(token)).rejects.toThrow();
    await expect(port.receipt(commit.manifest.sessionId, commit.manifest.operationId, commit.requestDigest)).rejects.toThrow();
  });
  it('decode failure after end stays unknown; absent/malformed/mismatched/failed reads never resend', async () => {
    const { commit, port, invoke, malformedEnd, setHide } = transport(); malformedEnd();
    await expect(savePreparedStoryTailRewriteCommit(port, commit)).rejects.toMatchObject({ evidence: 'unknown' });
    for (const mode of ['null', 'malformed', 'mismatch', 'io'] as const) {
      setHide(mode); await expect(savePreparedStoryTailRewriteCommit(port, commit, 'unknown')).rejects.toMatchObject({ evidence: 'unknown' });
    }
    setHide('none'); await expect(savePreparedStoryTailRewriteCommit(port, commit, 'unknown')).resolves.toMatchObject({ requestDigest: commit.requestDigest });
    for (const command of [STORY_TAIL_REWRITE_IPC.begin, STORY_TAIL_REWRITE_IPC.end]) expect(invoke.mock.calls.filter(call => call[0] === command)).toHaveLength(1);
  });
  it('keeps owner unknown queries safe without exposing malformed raw text or unknown field names', async () => {
    const f = await tailRewriteFixture(); f.owner.dispose(); f.behavior.lose = true;
    let badRaw: string | undefined;
    const invoke = vi.fn<StoryInvoke>(async (command, args, options) => {
      const params = args as Record<string, unknown>;
      if (command === STORY_TAIL_REWRITE_IPC.resolveSource) return f.source.resolveSource(params.request as Parameters<typeof f.source.resolveSource>[0]);
      if (command === STORY_TAIL_REWRITE_IPC.begin) return f.tail.begin(decodeStoryTailRewriteManifest(params.manifestJson as string));
      if (command === STORY_IPC.append) return f.tail.append(options!.headers['x-story-token']!, options!.headers['x-story-part'] as 'session', Number(options!.headers['x-story-offset']), args as Uint8Array);
      if (command === STORY_IPC.abort) return f.tail.abort(params.token as string);
      if (command === STORY_TAIL_REWRITE_IPC.end) return encodeStoryTailRewriteReceipt(await f.tail.end(params.token as string));
      if (command === STORY_TAIL_REWRITE_IPC.receipt) {
        if (badRaw !== undefined) return badRaw;
        const value = await f.tail.receipt(params.sessionId as string, params.operationId as string, params.requestDigest as string);
        return value === null ? null : encodeStoryTailRewriteReceipt(value);
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    const owner = new DesktopArenaStorySession({ port: f.reads, tailRewrite: { port: createIpcStoryTailRewriteNativePort(), source: createIpcStoryTailRewriteSourcePort(), prepareCommit: f.prepareCommit }, execute: f.execute, exportMarkdown: vi.fn() });
    owner.setExecutionScope('A'); await owner.initialize();
    await owner.generateTailRewrite({ mode: 'direct', target: f.request(), userGuidance: '' }, f.execution.prepare);
    expect(owner.getSnapshot().pending?.evidence).toBe('unknown');
    const commit = f.prepareCommit.mock.results[0]!.value;
    for (const raw of ['PRIVATE_SENTINEL_response', '{"PRIVATE_SENTINEL_field":true}']) {
      badRaw = raw; await owner.savePending();
      expect(owner.getSnapshot().pending?.evidence).toBe('unknown');
      expect(owner.getSnapshot().message).toContain('回执格式无效');
      expect(owner.getSnapshot().message).not.toContain('PRIVATE_SENTINEL');
    }
    const queries = invoke.mock.calls.filter(call => call[0] === STORY_TAIL_REWRITE_IPC.receipt);
    for (const query of queries) expect(query[1]).toEqual({ sessionId: commit.manifest.sessionId, operationId: commit.manifest.operationId, requestDigest: commit.requestDigest });
    expect(f.tail.begin).toHaveBeenCalledTimes(1); expect(f.tail.end).toHaveBeenCalledTimes(1); expect(f.tail.append).toHaveBeenCalledTimes(3);
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.prepareCommit).toHaveBeenCalledTimes(1);
    badRaw = undefined; f.behavior.hide = 'none'; await owner.savePending();
    expect(owner.getSnapshot().resultSaved).toBe(true); expect(owner.getSnapshot().pending).toBeNull(); owner.dispose();
  });
  it('only explicit not-written retries the identical frozen wire package', async () => {
    const { commit, port, invoke, rollback } = transport(); rollback();
    await expect(savePreparedStoryTailRewriteCommit(port, commit)).rejects.toMatchObject({ evidence: 'not-written' });
    const frames = invoke.mock.calls.filter(call => call[0] === STORY_IPC.append).map(call => [call[1], call[2]]);
    await expect(savePreparedStoryTailRewriteCommit(port, commit, 'not-written')).resolves.toMatchObject({ requestDigest: commit.requestDigest });
    const begins = invoke.mock.calls.filter(call => call[0] === STORY_TAIL_REWRITE_IPC.begin);
    expect(begins).toHaveLength(2); expect(begins[1]![1]).toEqual(begins[0]![1]);
    expect(invoke.mock.calls.filter(call => call[0] === STORY_IPC.append).slice(frames.length).map(call => [call[1], call[2]])).toEqual(frames);
  });
});
