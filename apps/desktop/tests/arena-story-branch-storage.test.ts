import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { StoryBranchManifest, StoryBranchReceipt } from '@mahoshojo/contracts/desktop-arena-story-branch';
import { freezeStoryBranchIdentity, prepareStoryBranchCommit, savePreparedStoryBranchCommit, queryStoryBranchReceipt,
  type CompletedStoryBranchRecords, type StoryBranchNativePort } from '../src/platform/arena-story-branch-storage';
import { DesktopArenaStorySession } from '../src/features/arena/story-session';
import { deferred, StoryFixturePort } from './helpers/story-fixture';
const golden = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/desktop-story-branch-storage.json', import.meta.url), 'utf8')) as {
  cases: Array<{ manifest: StoryBranchManifest; receipt: StoryBranchReceipt; expected: CompletedStoryBranchRecords }>;
};
const fixture = () => structuredClone(golden.cases[0]!);
const token = `${'a'.repeat(32)}-${'b'.repeat(32)}`;
function setup(injected = true) {
  const prepare = vi.fn(prepareStoryBranchCommit);
  const f = fixture(), reads = new StoryFixturePort();
  let saved: unknown = null, manifest: StoryBranchManifest;
  const buffers = new Map<string, Uint8Array[]>();
  const branch: StoryBranchNativePort = {
    begin: vi.fn(async (value: StoryBranchManifest) => { manifest = value; buffers.clear(); return { token, totalBytes: value.parts.reduce((sum, part) => sum + part.byteLength, 0) }; }),
    append: vi.fn(async (_token, kind, offset, bytes) => { const chunks = buffers.get(kind) ?? []; chunks.push(bytes); buffers.set(kind, chunks); return { token, kind, receivedBytes: offset + bytes.byteLength }; }),
    end: vi.fn(async () => {
      const prepared = prepareStoryBranchCommit(freezeStoryBranchIdentity(manifest), structuredClone(f.expected));
      saved = { ...f.receipt, requestDigest: prepared.requestDigest };
      for (const [kind, chunks] of buffers) { const bytes = Buffer.concat(chunks), value = JSON.parse(bytes.toString('utf8'));
        reads.documents.set(`${manifest.sessionId}:${kind === 'session' ? kind : value.id}`, { value, bytes }); }
      return saved;
    }),
    abort: vi.fn(async () => {}), receipt: vi.fn(async () => saved),
  };
  const owner = new DesktopArenaStorySession({ port: reads, ...(injected ? { branch: { port: branch, prepareCommit: prepare } } : {}), exportMarkdown: async () => ({ absolutePath: 'fixture.md', byteLength: 1 }) });
  owner.setExecutionScope('A');
  const input = { mode: 'direct' as const, generationId: f.expected.chapter.generationId!, ...f.manifest };
  const result = { markdown: f.expected.chapter.markdown, rawText: f.expected.chapter.markdown, reasoning: '原推理' };
  return { f, reads, branch, owner, input, result, prepare };
}
describe('injected branch frozen preparation and save evidence', () => {
  it('copies pre-generation descriptors and consumes identity once without refreshing source', () => {
    const f = fixture(), identity = freezeStoryBranchIdentity(f.manifest); f.manifest.source.session.instance = 'f'.repeat(32);
    const prepared = prepareStoryBranchCommit(identity, f.expected);
    expect(prepared.manifest.source.session.instance).toBe('0'.repeat(32)); expect(Object.isFrozen(prepared.manifest.source.session)).toBe(true);
    expect(Object.isFrozen(prepared.parts[2]!.prepared.value)).toBe(true);
    expect(() => prepareStoryBranchCommit(identity, f.expected)).toThrow('已使用'); expect(() => prepareStoryBranchCommit({ ...identity }, f.expected)).toThrow('未预先冻结');
  });
  it.each(['target', 'operation', 'anchor', 'checkpoint', 'branchOf'] as const)('rejects completed %s mismatch before any write', field => {
    const f = fixture(), identity = freezeStoryBranchIdentity(f.manifest);
    if (field === 'target') f.expected.session.id = 'other'; if (field === 'operation') f.expected.chapter.id = 'other';
    if (field === 'anchor') f.expected.chapter.sourceChapterId = 'other'; if (field === 'checkpoint') f.expected.checkpoints[0]!.boundaryIndex++;
    if (field === 'branchOf') f.expected.session.branchOf = { sessionId: 'other' };
    expect(() => prepareStoryBranchCommit(identity, f.expected)).toThrow('不一致'); expect(() => prepareStoryBranchCommit(identity, fixture().expected)).toThrow('已使用');
  });
  it('bounds only three new carriers and strips stored source secrets', () => {
    const f = fixture(); Object.assign(f.expected.session.source, { apiKey: 'secret' });
    const p = prepareStoryBranchCommit(freezeStoryBranchIdentity(f.manifest), f.expected);
    expect(p.parts).toHaveLength(3); expect((p.parts[0]!.prepared.value as { source: unknown }).source).not.toHaveProperty('apiKey');
    expect(() => prepareStoryBranchCommit(freezeStoryBranchIdentity(f.manifest), f.expected, 1)).toThrow();
  });
  it.each(['null', 'mismatch', 'io'] as const)('unknown %s never begins or ends a write', async kind => {
    const { f, branch } = setup(), p = prepareStoryBranchCommit(freezeStoryBranchIdentity(f.manifest), f.expected);
    vi.mocked(branch.receipt).mockImplementation(async () => { if (kind === 'io') throw new Error('IO'); return kind === 'null' ? null : { ...f.receipt, requestDigest: `sha256:${'f'.repeat(64)}` }; });
    await expect(savePreparedStoryBranchCommit(branch, p, 'unknown')).rejects.toMatchObject({ evidence: 'unknown' });
    expect(branch.receipt).toHaveBeenCalledWith(p.manifest.sessionId, p.manifest.operationId, p.requestDigest); expect(branch.begin).not.toHaveBeenCalled(); expect(branch.end).not.toHaveBeenCalled();
  });
  it('copy markers and wrong checkpoint receipts do not resolve success', async () => {
    const { f, branch } = setup(), p = prepareStoryBranchCommit(freezeStoryBranchIdentity(f.manifest), f.expected);
    for (const receipt of [{ ...f.receipt, kind: 'branch-copy' }, { ...f.receipt, checkpointId: 'other' }]) { vi.mocked(branch.receipt).mockResolvedValue(receipt); await expect(queryStoryBranchReceipt(branch, p)).rejects.toThrow(); }
  });
  it.each(['before-end', 'after-end'] as const)('cancellation %s keeps correct evidence', async phase => {
    const { f, branch } = setup(), p = prepareStoryBranchCommit(freezeStoryBranchIdentity(f.manifest), f.expected), controller = new AbortController();
    if (phase === 'before-end') vi.mocked(branch.append).mockImplementation(async (_token, kind, offset, bytes) => { controller.abort(); return { token, kind, receivedBytes: offset + bytes.byteLength }; });
    else vi.mocked(branch.end).mockImplementation(async () => { controller.abort(); throw new Error('reply lost'); });
    await expect(savePreparedStoryBranchCommit(branch, p, 'not-written', controller.signal)).rejects.toMatchObject({ evidence: phase === 'before-end' ? 'not-written' : 'unknown' });
    expect(branch.end).toHaveBeenCalledTimes(phase === 'before-end' ? 0 : 1); expect(branch.abort).toHaveBeenCalledTimes(1);
  });
  it('late exact success remains success after cancellation', async () => {
    const { f, branch } = setup(), p = prepareStoryBranchCommit(freezeStoryBranchIdentity(f.manifest), f.expected), controller = new AbortController();
    vi.mocked(branch.end).mockImplementation(async () => { controller.abort(); return { ...f.receipt, requestDigest: p.requestDigest }; });
    await expect(savePreparedStoryBranchCommit(branch, p, 'not-written', controller.signal)).resolves.toMatchObject({ requestDigest: p.requestDigest });
  });
});
describe('existing owner consumes one injected completed branch', () => {
  it('default owner and Hosted reject before reserving state or touching storage', () => {
    const missing = setup(false); expect(() => missing.owner.captureBranchCompletion(missing.input)).toThrow('未开放');
    expect(missing.owner.isBusy()).toBe(false); expect(missing.reads.describe).not.toHaveBeenCalled();
    const hosted = setup(); expect(() => hosted.owner.captureBranchCompletion({ ...hosted.input, mode: 'hosted' })).toThrow('Hosted'); expect(hosted.owner.isBusy()).toBe(false); expect(hosted.branch.begin).not.toHaveBeenCalled();
  });
  it('shares pending/save/selection and reads saved chapter with no source describe refresh', async () => {
    const { owner, input, f, result, branch, reads } = setup(), completion = owner.captureBranchCompletion(input);
    expect(owner.isBusy()).toBe(true); input.source.session.instance = 'e'.repeat(32); await completion.complete(f.expected, result);
    expect(owner.getSnapshot()).toMatchObject({ pending: null, resultSaved: true, selected: { status: 'loaded', chapterId: f.expected.chapter.id } });
    expect(vi.mocked(branch.begin).mock.calls[0]![0].source.session.instance).toBe('0'.repeat(32)); expect(reads.describe.mock.calls.map(call => call[2])).toEqual(['chapter']);
    await completion.complete(f.expected, result); expect(branch.end).toHaveBeenCalledTimes(1); expect(owner.isBusy()).toBe(false);
  });
  it.each(['cancel', 'fail', 'scope', 'detach'] as const)('%s releases capture and permanently invalidates callback', async action => {
    const { owner, input, f, result, branch } = setup(), completion = owner.captureBranchCompletion(input);
    if (action === 'cancel') completion.cancel(); if (action === 'fail') completion.fail(new Error('producer failed'));
    if (action === 'scope') { owner.setExecutionScope('B'); owner.setExecutionScope('A'); } if (action === 'detach') owner.detach();
    expect(owner.isBusy()).toBe(false); await completion.complete(f.expected, result); expect(branch.begin).not.toHaveBeenCalled(); expect(() => owner.captureBranchCompletion(input)).toThrow('已消费');
  });
  it('malformed complete releases capture and keeps delivered prose', async () => {
    const { owner, input, result, branch } = setup(); await owner.captureBranchCompletion(input).complete({} as CompletedStoryBranchRecords, result);
    expect(owner.isBusy()).toBe(false); expect(owner.getSnapshot().result?.markdown).toBe(result.markdown); expect(owner.getSnapshot().pending?.retryable).toBe(false); expect(branch.begin).not.toHaveBeenCalled();
  });
  it('preparation budget failure keeps full output and does not retry preparation or storage', async () => {
    const { f, reads, branch, input, result } = setup();
    const prepare = vi.fn((identity: Parameters<typeof prepareStoryBranchCommit>[0], records: CompletedStoryBranchRecords) => prepareStoryBranchCommit(identity, records, 1));
    const owner = new DesktopArenaStorySession({ port: reads, branch: { port: branch, prepareCommit: prepare }, exportMarkdown: async () => ({ absolutePath: 'x', byteLength: 1 }) });
    owner.setExecutionScope('A'); const completion = owner.captureBranchCompletion(input);
    await completion.complete(f.expected, result); await owner.savePending(); await completion.complete(f.expected, result);
    expect(owner.getSnapshot()).toMatchObject({ phase: 'completed', resultSaved: false, result: { markdown: result.markdown }, pending: { tooLarge: true, retryable: false, evidence: 'not-written' } });
    expect(prepare).toHaveBeenCalledTimes(1); expect(branch.begin).not.toHaveBeenCalled(); expect(owner.isBusy()).toBe(false);
  });
  it('rollback allows only explicit same-package retry, no second preparation', async () => {
    const { owner, input, f, result, branch, prepare } = setup(); vi.mocked(branch.end).mockRejectedValueOnce({ code: 'story-conflict', message: 'rollback', writeEvidence: 'not-written' });
    await owner.captureBranchCompletion(input).complete(f.expected, result); expect(owner.getSnapshot().pending?.evidence).toBe('not-written'); expect(branch.begin).toHaveBeenCalledTimes(1);
    const originals = vi.mocked(branch.append).mock.calls.map(([, kind, offset, bytes]) => ({ kind, offset, bytes: Array.from(bytes) }));
    expect(() => { f.expected.checkpoints[0]!.combatants.push({ altered: true }); }).toThrow();
    vi.mocked(branch.append).mockClear();
    await owner.savePending(); expect(vi.mocked(branch.begin).mock.calls[1]![0]).toBe(vi.mocked(branch.begin).mock.calls[0]![0]); expect(owner.getSnapshot().resultSaved).toBe(true);
    expect(vi.mocked(branch.append).mock.calls.map(([, kind, offset, bytes]) => ({ kind, offset, bytes: Array.from(bytes) }))).toEqual(originals);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it('unknown survives null/mismatch/IO/scope then resolves original receipt without rewriting despite read failure', async () => {
    const { owner, input, f, result, branch } = setup(); vi.mocked(branch.end).mockRejectedValueOnce(new Error('lost after dispatch'));
    await owner.captureBranchCompletion(input).complete(f.expected, result); expect(owner.getSnapshot().pending?.evidence).toBe('unknown');
    for (const reply of [null, { ...f.receipt, operationId: 'wrong' }, new Error('IO')]) {
      vi.mocked(branch.receipt).mockImplementation(async () => { if (reply instanceof Error) throw reply; return reply; }); owner.setExecutionScope('B'); await owner.savePending(); expect(owner.getSnapshot().pending?.evidence).toBe('unknown');
    }
    const manifest = vi.mocked(branch.begin).mock.calls[0]![0], p = prepareStoryBranchCommit(freezeStoryBranchIdentity(manifest), structuredClone(f.expected));
    vi.mocked(branch.receipt).mockResolvedValue({ ...f.receipt, requestDigest: p.requestDigest }); await owner.savePending();
    expect(owner.getSnapshot()).toMatchObject({ pending: null, resultSaved: true, savedUnread: { id: manifest.sessionId } });
    await owner.savePending(); expect(branch.begin).toHaveBeenCalledTimes(1); expect(branch.end).toHaveBeenCalledTimes(1);
  });
  it('late success cannot steal newer selection; directory failure cannot restore pending', async () => {
    const { owner, input, f, result, branch, reads } = setup(), gate = deferred<void>();
    const p = prepareStoryBranchCommit(freezeStoryBranchIdentity(f.manifest), structuredClone(f.expected));
    vi.mocked(branch.end).mockImplementation(async () => { await gate.promise; return { ...f.receipt, requestDigest: p.requestDigest }; });
    const completion = owner.captureBranchCompletion(input), run = completion.complete(f.expected, result); await completion.complete(f.expected, result); await vi.waitFor(() => expect(branch.end).toHaveBeenCalledTimes(1));
    await owner.selectSession({ id: 'new-selection', revision: 1, titlePreview: 'other', titleTruncated: false, mode: 'classic', createdAt: 1, updatedAt: 1, chapterCount: 1, lastChapterId: 'other-chapter' });
    reads.listSessions.mockRejectedValue(new Error('IO')); gate.resolve(); await run;
    expect(owner.getSnapshot()).toMatchObject({ pending: null, resultSaved: true, active: { id: 'new-selection' }, savedUnread: { id: f.manifest.sessionId } }); await owner.savePending(); expect(branch.end).toHaveBeenCalledTimes(1);
  });
  it('explicit retry cancellation before end remains original-package retryable', async () => {
    const { owner, input, f, result, branch } = setup(); vi.mocked(branch.begin).mockRejectedValueOnce({ code: 'story-conflict', message: 'not written', writeEvidence: 'not-written' });
    await owner.captureBranchCompletion(input).complete(f.expected, result); const gate = deferred<void>();
    vi.mocked(branch.append).mockImplementation(async (_token, kind, offset, bytes) => { await gate.promise; return { token, kind, receivedBytes: offset + bytes.byteLength }; });
    const retry = owner.savePending(); await vi.waitFor(() => expect(branch.append).toHaveBeenCalled()); owner.cancel(); gate.resolve(); await retry;
    expect(branch.end).not.toHaveBeenCalled(); expect(owner.getSnapshot().pending?.evidence).toBe('not-written'); expect(owner.isBusy()).toBe(false);
  });
  it('discard cannot refresh the old operation or generation through another capture', async () => {
    const { owner, input, f, result, branch } = setup(); vi.mocked(branch.end).mockRejectedValue(new Error('unknown'));
    await owner.captureBranchCompletion(input).complete(f.expected, result); owner.discardResult();
    expect(() => owner.captureBranchCompletion({ ...input, sessionId: 'new-target' })).toThrow('已消费'); expect(() => owner.captureBranchCompletion({ ...input, operationId: 'new-operation' })).toThrow('已消费');
  });
});
