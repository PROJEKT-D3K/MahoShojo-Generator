import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoryBranchManifest, StoryBranchReceipt } from '@mahoshojo/contracts/desktop-arena-story-branch';
import { createIpcStoryBranchNativePort, createIpcStoryBranchSourcePort, STORY_BRANCH_IPC } from '../src/platform/arena-story-branch-native';
import { STORY_IPC, type StoryInvoke } from '../src/platform/arena-story-native';
import { freezeStoryBranchIdentity, prepareStoryBranchCommit, savePreparedStoryBranchCommit, type CompletedStoryBranchRecords } from '../src/platform/arena-story-branch-storage';

const golden = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/desktop-story-branch-storage.json', import.meta.url), 'utf8')) as {
  cases: Array<{ manifest: StoryBranchManifest; receipt: StoryBranchReceipt; expected: CompletedStoryBranchRecords }>;
};
const token = `${'a'.repeat(32)}-${'b'.repeat(32)}`;
const fixture = () => structuredClone(golden.cases[0]!);
afterEach(() => vi.unstubAllGlobals());

/** Keep the actual @tauri-apps/api/core invoke and default factory arguments.
 * This narrow fake replaces the host transport only; SQLite is verified separately. */
function transport() {
  const f = fixture(), identity = freezeStoryBranchIdentity(f.manifest);
  const commit = prepareStoryBranchCommit(identity, f.expected);
  let saved: StoryBranchReceipt | null = null;
  let loseAck = false, rollback = false, hide: 'none' | 'null' | 'mismatch' | 'io' = 'none';
  const invoke = vi.fn<StoryInvoke>(async (command, args, options) => {
    if (command === STORY_BRANCH_IPC.begin) return { token, totalBytes: commit.byteLength };
    if (command === STORY_IPC.append) {
      expect(args).toBeInstanceOf(Uint8Array);
      const headers = options!.headers;
      expect(Object.keys(headers).sort()).toEqual(['x-story-offset', 'x-story-part', 'x-story-token']);
      expect(headers['x-story-token']).toBe(token);
      return { token, kind: headers['x-story-part'], receivedBytes: Number(headers['x-story-offset']) + (args as Uint8Array).byteLength };
    }
    if (command === STORY_BRANCH_IPC.end) {
      if (rollback) { rollback = false; throw { code: 'story-stale', message: 'explicit rollback', writeEvidence: 'not-written' }; }
      saved = { ...f.receipt, requestDigest: commit.requestDigest };
      if (loseAck) { loseAck = false; hide = 'null'; throw new Error('lost outer ACK'); }
      return saved;
    }
    if (command === STORY_BRANCH_IPC.receipt) {
      expect(args).toEqual({ sessionId: commit.manifest.sessionId, operationId: commit.manifest.operationId, requestDigest: commit.requestDigest });
      if (hide === 'io') throw new Error('read failed');
      if (hide === 'null') return null;
      return hide === 'mismatch' && saved ? { ...saved, requestDigest: `sha256:${'f'.repeat(64)}` } : saved;
    }
    if (command === STORY_IPC.abort) return undefined;
    throw new Error(`Unexpected command: ${command}`);
  });
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
  const port = createIpcStoryBranchNativePort();
  return { f, commit, port, invoke, setLost: () => { loseAck = true; }, setRollback: () => { rollback = true; }, setHide: (value: typeof hide) => { hide = value; } };
}

describe('default branch binder through actual Tauri JS invoke', () => {
  it('preserves manifest identity, raw bytes and shared append/abort commands', async () => {
    const { commit, port, invoke } = transport();
    await expect(savePreparedStoryBranchCommit(port, commit)).resolves.toMatchObject({ requestDigest: commit.requestDigest });
    const begin = invoke.mock.calls.find(call => call[0] === STORY_BRANCH_IPC.begin)!;
    expect((begin[1] as { manifest: unknown }).manifest).toBe(commit.manifest);
    expect(invoke.mock.calls.filter(call => call[0] === STORY_IPC.append).map(call => call[2]!.headers['x-story-part'])).toEqual(['session', 'chapter', 'checkpoint1']);
    expect(invoke).toHaveBeenLastCalledWith(STORY_IPC.abort, { token }, undefined);
    expect(invoke.mock.calls.some(call => call[0] === STORY_IPC.describe || call[0] === STORY_IPC.begin || call[0] === STORY_IPC.end)).toBe(false);
  });
  it('uses only the bounded resolver request without describe or eager source refresh', async () => {
    const { invoke, commit } = transport();
    invoke.mockResolvedValueOnce({ marker: 'descriptor response' });
    const s = commit.manifest.source;
    const request = { sessionId: s.session.sessionId, revision: s.session.revision, expectedLastChapterId: s.expectedLastChapterId,
      expectedChapterCount: s.expectedChapterCount, anchorChapterId: s.anchor.recordId, anchorIndex: s.anchorIndex };
    await expect(createIpcStoryBranchSourcePort().resolveAnchor(request)).resolves.toEqual({ marker: 'descriptor response' });
    expect(invoke.mock.calls).toEqual([[STORY_BRANCH_IPC.resolveAnchor, { request }, undefined]]);
  });
  it('rejects empty, oversized and invalid-position frames before dispatch', () => {
    const { port, invoke } = transport();
    for (const bytes of [new Uint8Array(), new Uint8Array(4 * 1024 * 1024 + 1)]) {
      expect(() => port.append(token, 'chapter', 0, bytes as Uint8Array)).toThrow();
    }
    for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => port.append(token, 'chapter', offset, new Uint8Array([1]))).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('lost ACK and absent/mismatched/failed exact queries never resend begin or end', async () => {
    const { commit, port, invoke, setLost, setHide } = transport(); setLost();
    await expect(savePreparedStoryBranchCommit(port, commit)).rejects.toMatchObject({ evidence: 'unknown' });
    for (const mode of ['null', 'mismatch', 'io'] as const) {
      setHide(mode); await expect(savePreparedStoryBranchCommit(port, commit, 'unknown')).rejects.toMatchObject({ evidence: 'unknown' });
    }
    setHide('none'); await expect(savePreparedStoryBranchCommit(port, commit, 'unknown')).resolves.toMatchObject({ requestDigest: commit.requestDigest });
    for (const command of [STORY_BRANCH_IPC.begin, STORY_BRANCH_IPC.end]) expect(invoke.mock.calls.filter(call => call[0] === command)).toHaveLength(1);
  });
  it('only explicit not-written permits retry with the same prepared manifest', async () => {
    const { commit, port, invoke, setRollback } = transport(); setRollback();
    await expect(savePreparedStoryBranchCommit(port, commit)).rejects.toMatchObject({ evidence: 'not-written' });
    await expect(savePreparedStoryBranchCommit(port, commit, 'not-written')).resolves.toMatchObject({ requestDigest: commit.requestDigest });
    const begins = invoke.mock.calls.filter(call => call[0] === STORY_BRANCH_IPC.begin);
    expect(begins).toHaveLength(2);
    for (const begin of begins) expect((begin[1] as { manifest: unknown }).manifest).toBe(commit.manifest);
  });
});
