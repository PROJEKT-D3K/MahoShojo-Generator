import { describe, expect, it, vi } from 'vitest';
import { readStoryTailRewriteSource } from '../src/platform/arena-story-tail-rewrite-source';
import type { StoryTailRewriteSourceDescriptors } from '@mahoshojo/contracts/desktop-arena-story-tail-rewrite';
import { deferred } from './helpers/story-fixture';
import { tailRewriteFixture } from './helpers/tail-rewrite-fixture';

describe('frozen tail source and bounded original input', () => {
  it('never describes a refreshed source and reads input CP rather than old output', async () => {
    const f = await tailRewriteFixture(3), session = f.reads.documents.get(`${f.sourceId}:session`)!.value;
    const outputId = String(session.workingCheckpointId);
    f.reads.read.mockClear(); f.reads.describe.mockClear();
    const value = await readStoryTailRewriteSource(f.reads, f.source, f.request());
    expect(value.checkpoint.id).toBe(session.lastInputCheckpointId);
    expect(f.reads.read.mock.calls.some(([d]) => d.recordId === outputId)).toBe(false);
    expect(f.reads.describe).not.toHaveBeenCalled(); expect(Object.isFrozen(value.session)).toBe(true);
  });
  it('validates known source fields without stripping unknown original extensions', async () => {
    const f = await tailRewriteFixture(), key = `${f.sourceId}:session`, session = f.reads.documents.get(key)!.value;
    const extension = { nested: { duplicate: 2, retained: ['中', null] } };
    f.put(key, { ...session, source: { ...(session.source as object), extension } });
    const snapshot = await readStoryTailRewriteSource(f.reads, f.source, f.request());
    expect(snapshot.session.source).toHaveProperty('extension', extension);
    await f.rewrite(); expect(f.owner.getSnapshot().resultSaved).toBe(true);
    expect(f.prepareCommit.mock.calls[0]![1].session.source).toHaveProperty('extension', extension);
  });
  it.each(['mixed-instance', 'mixed-revision', 'missing-tail', 'duplicate', 'reordered', 'wrong-proof'] as const)('rejects %s descriptors before model/save', async kind => {
    const f = await tailRewriteFixture(3), original = vi.mocked(f.source.resolveSource).getMockImplementation()!;
    vi.mocked(f.source.resolveSource).mockImplementation(async request => {
      const value = await original(request) as StoryTailRewriteSourceDescriptors;
      if (kind === 'mixed-instance') value.seed.instance = 'f'.repeat(32);
      if (kind === 'mixed-revision') value.recentChapters[0]!.revision++;
      if (kind === 'missing-tail') value.recentChapters.pop();
      if (kind === 'duplicate') value.recentChapters[0] = value.recentChapters[1]!;
      if (kind === 'reordered') [value.recentChapters[0], value.recentChapters[1]] = [value.recentChapters[1]!, value.recentChapters[0]!];
      if (kind === 'wrong-proof') value.source.chapter.digest = `sha256:${'f'.repeat(64)}`;
      return value;
    });
    await f.rewrite(); expect(f.owner.getSnapshot().phase).toBe('failed'); expect(f.execute).not.toHaveBeenCalled(); expect(f.tail.begin).not.toHaveBeenCalled();
  });
  it.each(['wrong-input-boundary', 'wrong-input-chapter', 'empty-roles', 'array-role', 'null-role', 'bad-summary'] as const)('rejects %s originals before model', async kind => {
    const f = await tailRewriteFixture(3), sessionKey = `${f.sourceId}:session`, session = f.reads.documents.get(sessionKey)!.value;
    const key = `${f.sourceId}:${session.lastInputCheckpointId}`, cp = f.reads.documents.get(key)!.value;
    if (kind === 'wrong-input-boundary') f.put(key, { ...cp, boundaryIndex: 3 });
    if (kind === 'wrong-input-chapter') f.put(key, { ...cp, chapterId: String(session.lastChapterId) });
    if (kind === 'empty-roles') f.put(key, { ...cp, combatants: [] });
    if (kind === 'array-role') f.put(key, { ...cp, combatants: [[]] });
    if (kind === 'null-role') f.put(key, { ...cp, combatants: [null] });
    if (kind === 'bad-summary') f.put(sessionKey, { ...session, summaryMeta: { coveredUntilChapterIndex: 4, coveredChapterIds: [] } });
    await f.rewrite(); expect(f.owner.getSnapshot().phase).toBe('failed'); expect(f.execute).not.toHaveBeenCalled(); expect(f.tail.begin).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'selection', 'scope-aba'] as const)('source-phase %s cannot dispatch a late callback', async kind => {
    const f = await tailRewriteFixture(), gate = deferred<void>(), original = vi.mocked(f.source.resolveSource).getMockImplementation()!;
    vi.mocked(f.source.resolveSource).mockImplementation(async request => { await gate.promise; return original(request); });
    const run = f.rewrite();
    if (kind === 'cancel') f.owner.cancel(); else if (kind === 'selection') await f.owner.selectSession(f.owner.getSnapshot().active!); else { f.owner.setExecutionScope('B'); f.owner.setExecutionScope('A'); }
    gate.resolve(); await run; expect(f.execute).not.toHaveBeenCalled(); expect(f.tail.begin).not.toHaveBeenCalled(); expect(f.owner.isBusy()).toBe(false);
  });
  it('raw original mutation is detected by exact bytes before any model', async () => {
    const f = await tailRewriteFixture(), original = vi.mocked(f.source.resolveSource).getMockImplementation()!;
    vi.mocked(f.source.resolveSource).mockImplementation(async request => { const value = await original(request); const key = `${f.sourceId}:${request.targetChapterId}`;
      f.put(key, { ...f.reads.documents.get(key)!.value, markdown: 'tampered' }); return value; });
    await f.rewrite(); expect(f.execute).not.toHaveBeenCalled(); expect(f.owner.getSnapshot().phase).toBe('failed');
  });
});
