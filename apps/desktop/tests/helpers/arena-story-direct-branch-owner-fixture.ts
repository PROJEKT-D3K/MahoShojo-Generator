/** Protocol-shaped fake for fast owner races. SQLite correctness belongs to the
 * separate opt-in Rust pipe; this fake deliberately has no SQL authority. */
import { createHash, randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { StoryRecordDescriptor } from '@mahoshojo/contracts/desktop-arena-story';
import type { StoryBranchAnchorRequest, StoryBranchManifest, StoryBranchReceipt } from '@mahoshojo/contracts/desktop-arena-story-branch';
import { DesktopArenaStorySession } from '../../src/features/arena/story-session';
import { branchCopyId, prepareStoryBranchCommit, type PreparedStoryBranchCommit, type StoryBranchNativePort } from '../../src/platform/arena-story-branch-storage';
import { StoryFixturePort } from './story-fixture';
import { buildDirectBranchFixture, installDirectBranchFixture } from './arena-story-direct-branch-fixture';

export async function directBranchOwnerFixture(k = 2, total = 3) {
  const fixture = await buildDirectBranchFixture(k, total), reads = new StoryFixturePort();
  await installDirectBranchFixture(reads, fixture);
  const stale = () => ({ code: 'story-stale', message: 'source changed', writeEvidence: 'not-written' });
  const readOriginal = reads.read.getMockImplementation()!;
  reads.read.mockImplementation(async (descriptor, offset, length) => {
    if (descriptor.instance !== reads.instance || reads.documents.get(`${descriptor.sessionId}:session`)?.value.revision !== descriptor.revision) throw stale();
    const doc = reads.documents.get(`${descriptor.sessionId}:${descriptor.kind === 'session' || descriptor.kind === 'seed' ? descriptor.kind : descriptor.recordId}`);
    if (!doc || descriptor.digest !== `sha256:${createHash('sha256').update(doc.bytes).digest('hex')}`) throw stale();
    return readOriginal(descriptor, offset, length);
  });
  const source = { resolveAnchor: vi.fn(async (request: StoryBranchAnchorRequest) => {
    const describe = (kind: StoryRecordDescriptor['kind'], recordId: string) => reads.describe(request.sessionId, request.revision, kind, recordId) as Promise<StoryRecordDescriptor>;
    const session = reads.documents.get(`${request.sessionId}:session`)!.value;
    if (request.expectedChapterCount !== session.chapterCount || request.expectedLastChapterId !== session.lastChapterId) throw stale();
    const chapters = reads.chapterDocuments(request.sessionId);
    const anchor = chapters.find(chapter => chapter.index === request.anchorIndex)!;
    const checkpoint = [...reads.documents.values()].find(doc => doc.value.sessionId === request.sessionId && doc.value.boundaryIndex === request.anchorIndex)!.value;
    if (anchor.id !== request.anchorChapterId) throw stale();
    return { source: { session: await describe('session', request.sessionId), seed: await describe('seed', request.sessionId),
      anchor: await describe('chapter', anchor.id), checkpoint: await describe('checkpoint', String(checkpoint.id)),
      anchorIndex: request.anchorIndex, expectedChapterCount: request.expectedChapterCount, expectedLastChapterId: request.expectedLastChapterId },
      recentChapters: await Promise.all(chapters.filter(chapter => chapter.index <= request.anchorIndex).slice(-12).map(chapter => describe('chapter', chapter.id))) };
  }) };
  const prepared: PreparedStoryBranchCommit[] = [], receipts = new Map<string, StoryBranchReceipt>();
  let hide: 'none' | 'null' | 'mismatch' | 'io' = 'none', fault: 'none' | 'rollback' | 'lost' = 'none';
  const token = `${'a'.repeat(32)}-${'b'.repeat(32)}`;
  const put = (sessionId: string, kind: string, value: Record<string, unknown>) => {
    const bytes = Buffer.from(JSON.stringify(value)); reads.documents.set(`${sessionId}:${kind === 'session' || kind === 'seed' ? kind : value.id}`, { value, bytes });
  };
  const branch: StoryBranchNativePort = {
    begin: vi.fn(async (manifest: StoryBranchManifest) => ({ token, totalBytes: manifest.parts.reduce((sum, part) => sum + part.byteLength, 0) })),
    append: vi.fn(async (_token, kind, offset, bytes) => ({ token, kind, receivedBytes: offset + bytes.byteLength })),
    abort: vi.fn(async () => {}),
    receipt: vi.fn(async (sessionId, operationId) => {
      if (hide === 'io') throw new Error('synthetic receipt IO');
      const value = receipts.get(`${sessionId}:${operationId}`) ?? null;
      return hide === 'null' ? null : hide === 'mismatch' && value ? { ...value, requestDigest: `sha256:${'f'.repeat(64)}` } : value;
    }),
    end: vi.fn(async () => {
      const commit = prepared.at(-1)!, { manifest } = commit, sourceSession = manifest.source.session;
      await reads.read(sourceSession, 0, 1);
      if (fault === 'rollback') { fault = 'none'; throw stale(); }
      const prefix = manifest.source.anchorIndex, sourceId = sourceSession.sessionId;
      for (const doc of [...reads.documents.values()]) {
        const value = doc.value;
        if (value.sessionId !== sourceId) continue;
        if (typeof value.index === 'number' && value.index <= prefix) put(manifest.sessionId, 'chapter', { ...value,
          id: branchCopyId(manifest.sessionId, 'c', value.index), sessionId: manifest.sessionId,
          sourceChapterId: value.index === 1 ? null : branchCopyId(manifest.sessionId, 'c', value.index - 1), status: 'active', supersededByChapterId: null });
        if (typeof value.boundaryIndex === 'number' && value.boundaryIndex <= prefix) put(manifest.sessionId, 'checkpoint', { ...value,
          id: branchCopyId(manifest.sessionId, 'p', value.boundaryIndex), sessionId: manifest.sessionId,
          chapterId: value.boundaryIndex === 0 ? null : branchCopyId(manifest.sessionId, 'c', value.boundaryIndex) });
      }
      put(manifest.sessionId, 'seed', structuredClone(reads.documents.get(`${sourceId}:seed`)!.value));
      for (const part of commit.parts) put(manifest.sessionId, part.kind, structuredClone(part.prepared.value) as Record<string, unknown>);
      const receipt: StoryBranchReceipt = { version: 2, kind: 'branch', operationId: manifest.operationId, sessionId: manifest.sessionId,
        chapterId: manifest.operationId, chapterIndex: prefix + 1, revision: prefix + 1, chapterCount: prefix + 1, prefixEndIndex: prefix,
        anchorChapterId: branchCopyId(manifest.sessionId, 'c', prefix), anchorCheckpointId: branchCopyId(manifest.sessionId, 'p', prefix),
        checkpointId: (commit.parts[2]!.prepared.value as { id: string }).id, requestDigest: commit.requestDigest };
      receipts.set(`${manifest.sessionId}:${manifest.operationId}`, receipt);
      if (fault === 'lost') { fault = 'none'; hide = 'null'; throw new Error('lost successful outer reply'); }
      return receipt;
    }),
  };
  const prepareCommit = vi.fn((...args: Parameters<typeof prepareStoryBranchCommit>) => { const value = prepareStoryBranchCommit(...args); prepared.push(value); return value; });
  const owner = new DesktopArenaStorySession({ port: reads, branch: { port: branch, source, prepareCommit }, id: randomUUID,
    exportMarkdown: async () => ({ absolutePath: 'fake-unused.md', byteLength: 1 }) });
  owner.setExecutionScope('direct-test'); await owner.initialize();
  reads.listChapters.mockClear(); reads.read.mockClear(); reads.describe.mockClear();
  return { ...fixture, fixture, reads, source, prepared, branch, owner, prepareCommit,
    setFault: (next: typeof fault) => { fault = next; }, setHide: (next: typeof hide) => { hide = next; } };
}
