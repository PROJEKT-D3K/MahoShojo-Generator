/** Protocol-shaped IPC fixture for the real routed default owner. It consumes the
 * actual manifest and uploaded bytes; it is not a Native/SQLite acceptance test. */
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { StoryPartKind, StoryRecordDescriptor } from '@mahoshojo/contracts/desktop-arena-story';
import { encodeStoryBranchRequestPreimage, type StoryBranchAnchorRequest, type StoryBranchManifest, type StoryBranchReceipt } from '@mahoshojo/contracts/desktop-arena-story-branch';
import { branchCopyId } from '../../src/platform/arena-story-branch-storage';
import { STORY_BRANCH_IPC } from '../../src/platform/arena-story-branch-native';
import { StoryFixturePort } from './story-fixture';
import { buildDirectBranchFixture, installDirectBranchFixture } from './arena-story-direct-branch-fixture';

const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const stale = () => ({ code: 'story-stale', message: 'source changed', writeEvidence: 'not-written' });
const token = `${'c'.repeat(32)}-${'d'.repeat(32)}`;
export async function branchPageFixture(k = 2, total = 3) {
  const fixture = await buildDirectBranchFixture(k, total), records = new StoryFixturePort();
  await installDirectBranchFixture(records, fixture);
  const read = records.read.getMockImplementation()!;
  records.read.mockImplementation(async (descriptor, offset, length) => {
    const session = records.documents.get(`${descriptor.sessionId}:session`);
    const doc = records.documents.get(`${descriptor.sessionId}:${descriptor.kind === 'session' || descriptor.kind === 'seed' ? descriptor.kind : descriptor.recordId}`);
    if (descriptor.instance !== records.instance || session?.value.revision !== descriptor.revision || !doc
      || descriptor.byteLength !== doc.bytes.byteLength || descriptor.digest !== digest(doc.bytes)) throw stale();
    return read(descriptor, offset, length);
  });
  const manifests: StoryBranchManifest[] = [], receipts = new Map<string, StoryBranchReceipt>();
  let parts = new Map<StoryPartKind, Uint8Array[]>();
  const state = { hideReceipt: false, loseEndReply: false, rollback: false,
    beforeEnd: undefined as (() => Promise<void>) | undefined };
  const put = (sessionId: string, kind: string, value: Record<string, unknown>) => {
    const bytes = Uint8Array.from(Buffer.from(JSON.stringify(value)));
    records.documents.set(`${sessionId}:${kind === 'session' || kind === 'seed' ? kind : value.id}`, { value, bytes });
  };
  const resolveAnchor = vi.fn(async (request: StoryBranchAnchorRequest) => {
    const session = records.documents.get(`${request.sessionId}:session`)?.value;
    if (!session || request.expectedChapterCount !== session.chapterCount || request.expectedLastChapterId !== session.lastChapterId) throw stale();
    const chapters = records.chapterDocuments(request.sessionId), anchor = chapters.find(chapter => chapter.index === request.anchorIndex);
    const checkpoint = [...records.documents.values()].find(doc => doc.value.sessionId === request.sessionId && doc.value.boundaryIndex === request.anchorIndex)?.value;
    if (!anchor || anchor.id !== request.anchorChapterId || !checkpoint) throw stale();
    const describe = (kind: StoryRecordDescriptor['kind'], id: string) => records.describe(request.sessionId, request.revision, kind, id);
    return { source: { session: await describe('session', request.sessionId), seed: await describe('seed', request.sessionId),
      anchor: await describe('chapter', anchor.id), checkpoint: await describe('checkpoint', String(checkpoint.id)),
      anchorIndex: request.anchorIndex, expectedChapterCount: request.expectedChapterCount, expectedLastChapterId: request.expectedLastChapterId },
      recentChapters: await Promise.all(chapters.filter(chapter => chapter.index <= request.anchorIndex).slice(-12).map(chapter => describe('chapter', chapter.id))) };
  });
  const begin = vi.fn(async (manifest: StoryBranchManifest) => {
    manifests.push(structuredClone(manifest)); parts = new Map();
    return { token, totalBytes: manifest.parts.reduce((sum, part) => sum + part.byteLength, 0) };
  });
  const append = vi.fn(async (kind: StoryPartKind, offset: number, bytes: Uint8Array) => {
    const list = parts.get(kind) ?? [];
    if (list.reduce((sum, value) => sum + value.byteLength, 0) !== offset) throw new Error('branch offset');
    list.push(Uint8Array.from(bytes)); parts.set(kind, list);
    return { token, kind, receivedBytes: offset + bytes.byteLength };
  });
  const end = vi.fn(async () => {
    await state.beforeEnd?.();
    const manifest = manifests.at(-1)!, prefix = manifest.source.anchorIndex, sourceId = manifest.source.session.sessionId;
    const requestDigest = digest(encodeStoryBranchRequestPreimage(manifest));
    const prior = receipts.get(`${manifest.sessionId}:${manifest.operationId}`); if (prior) return prior;
    await records.read(manifest.source.session, 0, 1);
    if (state.rollback) throw stale();
    const originals = manifest.parts.map(part => {
      const bytes = Uint8Array.from(Buffer.concat(parts.get(part.kind)!));
      if (bytes.byteLength !== part.byteLength || digest(bytes) !== part.digest) throw new Error('branch part mismatch');
      return { kind: part.kind, value: JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>, bytes };
    });
    for (const { value } of [...records.documents.values()]) {
      if (value.sessionId !== sourceId) continue;
      if (typeof value.index === 'number' && value.index <= prefix) put(manifest.sessionId, 'chapter', { ...value,
        id: branchCopyId(manifest.sessionId, 'c', value.index), sessionId: manifest.sessionId,
        sourceChapterId: value.index === 1 ? null : branchCopyId(manifest.sessionId, 'c', value.index - 1), status: 'active', supersededByChapterId: null });
      if (typeof value.boundaryIndex === 'number' && value.boundaryIndex <= prefix) put(manifest.sessionId, 'checkpoint', { ...value,
        id: branchCopyId(manifest.sessionId, 'p', value.boundaryIndex), sessionId: manifest.sessionId,
        chapterId: value.boundaryIndex === 0 ? null : branchCopyId(manifest.sessionId, 'c', value.boundaryIndex) });
    }
    put(manifest.sessionId, 'seed', structuredClone(records.documents.get(`${sourceId}:seed`)!.value));
    for (const part of originals) records.documents.set(`${manifest.sessionId}:${part.kind === 'session' ? 'session' : part.value.id}`, { value: part.value, bytes: part.bytes });
    const receipt: StoryBranchReceipt = { version: 2, kind: 'branch', operationId: manifest.operationId, sessionId: manifest.sessionId,
      chapterId: manifest.operationId, chapterIndex: prefix + 1, revision: prefix + 1, chapterCount: prefix + 1, prefixEndIndex: prefix,
      anchorChapterId: branchCopyId(manifest.sessionId, 'c', prefix), anchorCheckpointId: branchCopyId(manifest.sessionId, 'p', prefix),
      checkpointId: String(originals[2]!.value.id), requestDigest };
    receipts.set(`${manifest.sessionId}:${manifest.operationId}`, receipt);
    if (state.loseEndReply) { state.hideReceipt = true; throw new Error('lost successful branch reply'); }
    return receipt;
  });
  const receipt = vi.fn(async (sessionId: string, operationId: string, requestDigest: string) => {
    const value = receipts.get(`${sessionId}:${operationId}`) ?? null;
    return state.hideReceipt || value?.requestDigest !== requestDigest ? null : value;
  });
  const handles = (command: string, raw?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }) =>
    Object.values(STORY_BRANCH_IPC).includes(command as typeof STORY_BRANCH_IPC[keyof typeof STORY_BRANCH_IPC])
    || command === 'append_arena_story_part' && options?.headers['x-story-token'] === token
    || command === 'abort_arena_story_commit' && (raw as Record<string, unknown>)?.token === token;
  const invoke = async (command: string, raw?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }) => {
    const args = raw as Record<string, unknown>;
    switch (command) {
      case STORY_BRANCH_IPC.resolveAnchor: return resolveAnchor(args.request as StoryBranchAnchorRequest);
      case STORY_BRANCH_IPC.begin: return begin(args.manifest as StoryBranchManifest);
      case STORY_BRANCH_IPC.end: return end();
      case STORY_BRANCH_IPC.receipt: return receipt(String(args.sessionId), String(args.operationId), String(args.requestDigest));
      case 'append_arena_story_part': return append(options!.headers['x-story-part'] as StoryPartKind, Number(options!.headers['x-story-offset']), raw as Uint8Array);
      case 'abort_arena_story_commit': return;
      default: throw new Error(`unexpected branch command ${command}`);
    }
  };
  records.begin.mockClear(); records.append.mockClear(); records.end.mockClear(); records.read.mockClear();
  return { ...fixture, records, state, put, manifests, resolveAnchor, begin, append, end, receipt, handles, invoke };
}
