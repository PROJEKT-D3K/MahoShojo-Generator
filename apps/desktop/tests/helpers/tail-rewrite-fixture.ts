import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { encodeStoryTailRewriteRequestPreimage, type StoryTailRewriteManifest, type StoryTailRewriteReceipt } from '@mahoshojo/contracts/desktop-arena-story-tail-rewrite';
import type { StoryRecordDescriptor } from '@mahoshojo/contracts/desktop-arena-story';
import { DesktopArenaStorySession } from '../../src/features/arena/story-session';
import type { executeArenaDirect } from '../../src/features/arena/direct';
import { prepareStoryTailRewriteCommit, type StoryTailRewriteNativePort } from '../../src/platform/arena-story-tail-rewrite-storage';
import type { StoryTailRewriteSourcePort } from '../../src/platform/arena-story-tail-rewrite-source';
import { StoryFixturePort, storyDraft, storyExecution, installStoryCrypto } from './story-fixture';
installStoryCrypto();
const token = `${'c'.repeat(32)}-${'d'.repeat(32)}`;
const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export async function tailRewriteFixture(count = 1) {
  const reads = new StoryFixturePort(); let id = 0, now = 100;
  const chapters = reads.chapterDocuments.bind(reads);
  reads.chapterDocuments = sessionId => chapters(sessionId).filter(chapter => chapter.status === 'active');
  const put = (key: string, value: Record<string, unknown>) => reads.documents.set(key, { value, bytes: Buffer.from(JSON.stringify(value)) });
  const seedOwner = new DesktopArenaStorySession({ port: reads, id: () => `seed-${++id}`, now: () => ++now, exportMarkdown: vi.fn() });
  seedOwner.setExecutionScope('A'); const execution = storyExecution();
  await seedOwner.start({ draft: storyDraft(), product: 'battle' }, execution.prepare);
  for (let i = 1; i < count; i++) await seedOwner.continue('', execution.prepare);
  const sourceId = seedOwner.getSnapshot().active!.id; seedOwner.dispose();
  const source: StoryTailRewriteSourcePort = { resolveSource: vi.fn(async request => {
    const doc = reads.documents.get(`${request.sessionId}:session`)!;
    if (doc.value.revision !== request.expectedRevision || doc.value.chapterCount !== request.expectedChapterCount || doc.value.lastChapterId !== request.targetChapterId) throw new Error('source changed');
    const proof = (key: string) => { const item = reads.documents.get(`${sourceId}:${key}`)!; return { byteLength: item.bytes.length, digest: sha(item.bytes) }; };
    const descriptor = (kind: StoryRecordDescriptor['kind'], recordId: string): StoryRecordDescriptor => ({ instance: reads.instance,
      sessionId: sourceId, revision: request.expectedRevision, kind, recordId, ...proof(kind === 'seed' ? 'seed' : recordId) });
    const inputCheckpointId = String(doc.value.lastInputCheckpointId);
    return { source: { expectedInstance: reads.instance, expectedRevision: request.expectedRevision, expectedChapterCount: request.expectedChapterCount,
      targetChapterId: request.targetChapterId, inputCheckpointId, session: proof('session'), chapter: proof(request.targetChapterId), inputCheckpoint: proof(inputCheckpointId) },
      seed: descriptor('seed', sourceId), recentChapters: reads.chapterDocuments(sourceId).slice(-12).map(chapter => descriptor('chapter', chapter.id)) };
  }) };
  let manifest: StoryTailRewriteManifest, receipt: StoryTailRewriteReceipt | null = null;
  const buffers = new Map<string, Uint8Array[]>();
  const behavior = { rollback: false, lose: false, hide: 'none' as 'none' | 'absent' | 'mismatch' | 'io' };
  const tail: StoryTailRewriteNativePort = {
    begin: vi.fn(async (value: StoryTailRewriteManifest) => { manifest = value; buffers.clear(); return { token, totalBytes: value.parts.reduce((n, p) => n + p.byteLength, 0) }; }),
    append: vi.fn(async (_token, kind, offset, bytes) => { const chunks = buffers.get(kind) ?? []; chunks.push(Uint8Array.from(bytes)); buffers.set(kind, chunks); return { token, kind, receivedBytes: offset + bytes.byteLength }; }),
    end: vi.fn(async () => {
      if (behavior.rollback) throw { code: 'story-conflict', message: 'rollback', writeEvidence: 'not-written' };
      const session = reads.documents.get(`${sourceId}:session`)!;
      if (session.value.revision !== manifest.source.expectedRevision) throw { code: 'story-conflict', message: 'stale', writeEvidence: 'not-written' };
      const old = reads.documents.get(`${sourceId}:${manifest.source.targetChapterId}`)!;
      put(`${sourceId}:${manifest.source.targetChapterId}`, { ...old.value, status: 'superseded', supersededByChapterId: manifest.operationId });
      let checkpointId = '';
      for (const [kind, chunks] of buffers) {
        const bytes = Buffer.concat(chunks), value = JSON.parse(bytes.toString('utf8'));
        reads.documents.set(`${sourceId}:${kind === 'session' ? 'session' : value.id}`, { value, bytes });
        if (kind === 'checkpoint1') checkpointId = value.id;
      }
      receipt = { version: 3, kind: 'tail-rewrite', operationId: manifest.operationId, sessionId: sourceId, chapterId: manifest.operationId,
        chapterIndex: manifest.source.expectedChapterCount, revision: manifest.source.expectedRevision + 1, chapterCount: manifest.source.expectedChapterCount,
        targetChapterId: manifest.source.targetChapterId, inputCheckpointId: manifest.source.inputCheckpointId, checkpointId,
        requestDigest: sha(encodeStoryTailRewriteRequestPreimage(manifest)) };
      if (behavior.lose) { behavior.hide = 'absent'; throw new Error('lost after commit'); }
      return receipt;
    }), abort: vi.fn(async () => {}), receipt: vi.fn(async (_sessionId, operationId) => {
      if (receipt?.operationId !== operationId) return null;
      if (behavior.hide === 'io') throw new Error('query IO');
      if (behavior.hide === 'absent') return null;
      if (behavior.hide === 'mismatch' && receipt) return { ...receipt, requestDigest: `sha256:${'f'.repeat(64)}` };
      return receipt;
    }),
  };
  const execute = vi.fn<typeof executeArenaDirect>(async (_options, _draft, intent, host, _signal, onPartial) => {
    onPartial?.({ rawText: '流式原文', markdown: '流式原文', reasoning: '流式推理' });
    return { status: 'completed', requestId: intent.requestId, scopeKey: host.scopeKey, mode: intent.mode, terminal: null,
      rawText: '完整原文', markdown: '# 完整改写\n保留全部正文 😀', reasoning: '完整推理', metaStatus: 'valid',
      report: { headline: '完整改写', mode: 'classic', officialReport: { winner: '甲' } },
      impacts: [{ characterName: '甲', impact: '成长', currentStateSummary: '平静' }] } as Awaited<ReturnType<typeof executeArenaDirect>>;
  });
  const prepareCommit = vi.fn(prepareStoryTailRewriteCommit);
  const owner = new DesktopArenaStorySession({ port: reads, tailRewrite: { port: tail, source, prepareCommit }, execute,
    id: () => `tail-${++id}`, now: () => ++now, exportMarkdown: vi.fn() });
  owner.setExecutionScope('A'); await owner.initialize();
  const request = () => { const head = owner.getSnapshot().active!; return { sessionId: head.id, expectedRevision: head.revision, expectedChapterCount: head.chapterCount, targetChapterId: head.lastChapterId }; };
  const rewrite = () => owner.generateTailRewrite({ mode: 'direct', target: request(), userGuidance: '改写引导' }, execution.prepare);
  return { owner, reads, source, tail, execute, prepareCommit, behavior, sourceId, put, request, rewrite, execution };
}
