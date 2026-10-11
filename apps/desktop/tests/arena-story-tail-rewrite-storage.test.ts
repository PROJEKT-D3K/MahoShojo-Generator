import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildCompletedBattleStoryTailRewriteRecords } from '@mahoshojo/domain/arena-story-tail-rewrite';
import { encodeStoryTailRewriteManifest, type StoryTailRewriteManifest, type StoryTailRewriteReceipt } from '@mahoshojo/contracts/desktop-arena-story-tail-rewrite';
import { freezeStoryTailRewriteIdentity, prepareStoryTailRewriteCommit, queryStoryTailRewriteReceipt, savePreparedStoryTailRewriteCommit,
  type CompletedStoryTailRewriteRecords, type StoryTailRewriteNativePort } from '../src/platform/arena-story-tail-rewrite-storage';
const golden = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/desktop-story-tail-rewrite-storage.json', import.meta.url), 'utf8')) as {
  cases: Array<{ name: string; assembly: Parameters<typeof buildCompletedBattleStoryTailRewriteRecords>[0]; expected: CompletedStoryTailRewriteRecords;
    manifest: StoryTailRewriteManifest; manifestJson: string; requestDigest: string; receipt: StoryTailRewriteReceipt; parts: Array<{ kind: string; document: string }> }>;
};
const token = `${'a'.repeat(32)}-${'b'.repeat(32)}`;
function fixture() {
  const f = structuredClone(golden.cases[0]!);
  const prepared = prepareStoryTailRewriteCommit(freezeStoryTailRewriteIdentity(f.manifest), f.expected);
  const port: StoryTailRewriteNativePort = {
    receipt: vi.fn(async () => null), begin: vi.fn(async () => ({ token, totalBytes: prepared.byteLength })),
    append: vi.fn(async (_token, kind, offset, bytes) => ({ token, kind, receivedBytes: offset + bytes.byteLength })),
    end: vi.fn(async () => f.receipt), abort: vi.fn(async () => {}),
  };
  return { f, prepared, port };
}
describe('closed tail rewrite preparation and exact receipts', () => {
  it.each(golden.cases)('matches shared projection and exact UTF-8 golden $name', f => {
    const records = buildCompletedBattleStoryTailRewriteRecords(structuredClone(f.assembly));
    expect(JSON.parse(JSON.stringify(records))).toEqual(f.expected);
    const prepared = prepareStoryTailRewriteCommit(freezeStoryTailRewriteIdentity(f.manifest), records);
    expect(prepared.manifest).toEqual(f.manifest); expect(encodeStoryTailRewriteManifest(prepared.manifest)).toBe(f.manifestJson);
    expect(prepared.requestDigest).toBe(f.requestDigest);
    expect(prepared.parts.map(({ kind, prepared: part }) => ({ kind, document: Buffer.concat([...part.chunks(17)]).toString('utf8') }))).toEqual(f.parts);
  });
  it('consumes identity once, owns proofs, preserves unknown session extensions', () => {
    const f = structuredClone(golden.cases[0]!), identity = freezeStoryTailRewriteIdentity(f.manifest);
    f.manifest.source.expectedInstance = 'f'.repeat(32);
    const prepared = prepareStoryTailRewriteCommit(identity, f.expected);
    expect(prepared.manifest.source.expectedInstance).toBe('0'.repeat(32));
    expect(prepared.parts[0]!.prepared.value).toHaveProperty('opaque', (f.expected.session as unknown as Record<string, unknown>).opaque);
    expect(() => prepareStoryTailRewriteCommit(identity, f.expected)).toThrow('已使用');
    expect(() => prepareStoryTailRewriteCommit({ ...identity }, f.expected)).toThrow('未预先冻结');
  });
  it.each(['target', 'index', 'count', 'checkpoint'] as const)('rejects %s mismatch and cannot prepare again', field => {
    const f = structuredClone(golden.cases[0]!), identity = freezeStoryTailRewriteIdentity(f.manifest);
    if (field === 'target') f.expected.chapter.sourceChapterId = 'other';
    if (field === 'index') f.expected.chapter.index++;
    if (field === 'count') f.expected.session.chapterCount++;
    if (field === 'checkpoint') f.expected.checkpoint.id = f.manifest.source.inputCheckpointId;
    expect(() => prepareStoryTailRewriteCommit(identity, f.expected)).toThrow();
    expect(() => prepareStoryTailRewriteCommit(identity, f.expected)).toThrow('已使用');
  });
  it.each(['absent', 'mismatch', 'io'] as const)('unknown %s never authorizes write', async kind => {
    const { f, port, prepared } = fixture();
    vi.mocked(port.receipt).mockImplementation(async () => { if (kind === 'io') throw new Error('IO'); return kind === 'absent' ? null : { ...f.receipt, requestDigest: `sha256:${'f'.repeat(64)}` }; });
    await expect(savePreparedStoryTailRewriteCommit(port, prepared, 'unknown')).rejects.toMatchObject({ evidence: 'unknown' });
    expect(port.receipt).toHaveBeenCalledWith(prepared.manifest.sessionId, prepared.manifest.operationId, prepared.requestDigest);
    expect(port.begin).not.toHaveBeenCalled(); expect(port.end).not.toHaveBeenCalled();
  });
  it.each(['targetChapterId', 'inputCheckpointId', 'checkpointId', 'revision'] as const)('rejects mismatched %s receipt', async field => {
    const { f, port, prepared } = fixture(); vi.mocked(port.receipt).mockResolvedValue({ ...f.receipt, [field]: field === 'revision' ? 3 : 'other' });
    await expect(queryStoryTailRewriteReceipt(port, prepared)).rejects.toThrow();
  });
  it.each(['before-end', 'after-end', 'known-rollback'] as const)('keeps monotone evidence for %s', async phase => {
    const { port, prepared } = fixture(), controller = new AbortController();
    if (phase === 'before-end') vi.mocked(port.append).mockImplementation(async (_token, kind, offset, bytes) => { controller.abort(); return { token, kind, receivedBytes: offset + bytes.byteLength }; });
    else vi.mocked(port.end).mockRejectedValue(phase === 'known-rollback' ? { code: 'story-conflict', message: 'CAS', writeEvidence: 'not-written' } : new Error('lost end'));
    await expect(savePreparedStoryTailRewriteCommit(port, prepared, 'not-written', controller.signal)).rejects.toMatchObject({ evidence: phase === 'after-end' ? 'unknown' : 'not-written' });
    expect(port.end).toHaveBeenCalledTimes(phase === 'before-end' ? 0 : 1);
  });
  it('exact committed success wins a late cancellation', async () => {
    const { f, port, prepared } = fixture(), controller = new AbortController();
    vi.mocked(port.end).mockImplementation(async () => { controller.abort(); return f.receipt; });
    await expect(savePreparedStoryTailRewriteCommit(port, prepared, 'not-written', controller.signal)).resolves.toEqual(f.receipt);
  });
});
