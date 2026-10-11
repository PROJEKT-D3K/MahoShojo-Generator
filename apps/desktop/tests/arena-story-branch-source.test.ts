import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readStoryBranchSource } from '../src/platform/arena-story-branch-source';
import { DesktopArenaStorySession } from '../src/features/arena/story-session';
import { StoryFixturePort, deferred } from './helpers/story-fixture';
import type { StoryRecordDescriptor } from '@mahoshojo/contracts/desktop-arena-story';
import type { StoryBranchAnchorRequest, StoryBranchSource } from '@mahoshojo/contracts/desktop-arena-story-branch';
import type { StoryBranchNativePort } from '../src/platform/arena-story-branch-storage';
const golden = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/desktop-story-branch-storage.json', import.meta.url), 'utf8')) as {
  sourceCommits: Array<{ parts: Array<{ kind: string; document: string }> }>;
};
function setup(k = 2, total = 3) {
  const records = new Map<string, Record<string, any>>();
  for (const commit of golden.sourceCommits) for (const part of commit.parts) {
    const value = JSON.parse(part.document); records.set(part.kind === 'seed' ? 'seed' : value.id, value);
  }
  for (let i = 4; i <= total; i++) {
    records.set(`source-c${i}`, { ...structuredClone(records.get('source-c3')!), id: `source-c${i}`, index: i, sourceChapterId: `source-c${i - 1}` });
    records.set(`source-p${i}`, { ...structuredClone(records.get('source-p3')!), id: `source-p${i}`, boundaryIndex: i, chapterId: `source-c${i}` });
  }
  Object.assign(records.get('golden-source')!, { revision: total, chapterCount: total, lastChapterId: `source-c${total}`, workingCheckpointId: `source-p${total}` });
  const request = { sessionId: 'golden-source', revision: total, expectedChapterCount: total, expectedLastChapterId: `source-c${total}`, anchorIndex: k, anchorChapterId: `source-c${k}` };
  const descriptor = <K extends StoryRecordDescriptor['kind']>(kind: K, id: string): StoryRecordDescriptor & { kind: K } => {
    const bytes = Buffer.from(JSON.stringify(records.get(kind === 'seed' ? 'seed' : id)));
    return { kind, recordId: id, sessionId: 'golden-source', revision: total, instance: '0'.repeat(32), byteLength: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  };
  const response = () => ({ source: { session: descriptor('session', 'golden-source'), seed: descriptor('seed', 'golden-source'),
    anchor: descriptor('chapter', `source-c${k}`), checkpoint: descriptor('checkpoint', `source-p${k}`), anchorIndex: k, expectedChapterCount: total, expectedLastChapterId: `source-c${total}` } satisfies StoryBranchSource,
    recentChapters: Array.from({ length: Math.min(12, k) }, (_, i) => descriptor('chapter', `source-c${k - Math.min(12, k) + i + 1}`)) });
  const resolver = { resolveAnchor: vi.fn(async (_request: StoryBranchAnchorRequest) => response()) };
  const read = vi.fn(async (d: StoryRecordDescriptor, offset: number, length: number) => new Uint8Array(Buffer.from(JSON.stringify(records.get(d.kind === 'seed' ? 'seed' : d.recordId))).subarray(offset, offset + length)));
  return { request, resolver, read, records, response };
}
describe('internal branch source snapshot', () => {
  it.each([1, 2, 3])('resolves anchor %i, freezes independent records and full source head', async k => {
    const f = setup(k), snapshot = await readStoryBranchSource(f, f.resolver, f.request);
    expect(snapshot.source.expectedChapterCount).toBe(3); expect(snapshot.anchor.index).toBe(k);
    expect(snapshot.checkpoint.boundaryIndex).toBe(k); expect(snapshot.recentWindow).toHaveLength(k);
    expect(snapshot.workingCombatants).toEqual(f.records.get(`source-p${k}`)!.combatants);
    expect(Object.isFrozen(snapshot.workingCombatants[0])).toBe(true);
    f.records.get(`source-p${k}`)!.combatants[0].name = 'mutated'; expect(snapshot.workingCombatants[0]!.name).not.toBe('mutated');
    expect(f.resolver.resolveAnchor).toHaveBeenCalledTimes(1);
  });
  it('takes roles only from the selected boundary, never the latest checkpoint', async () => {
    const f = setup(2); f.records.get('source-p2')!.combatants = [{ name: 'anchor-state' }];
    f.records.get('source-p3')!.combatants = [{ name: 'future-state' }];
    const snapshot = await readStoryBranchSource(f, f.resolver, f.request);
    expect(snapshot.workingCombatants).toEqual([{ name: 'anchor-state' }]);
    expect(f.read.mock.calls.some(([d]) => d.recordId === 'source-p3')).toBe(false);
  });
  it('reads only twelve chapters through a middle anchor, with two full context items', async () => {
    const f = setup(14, 16), snapshot = await readStoryBranchSource(f, f.resolver, f.request);
    expect(snapshot.recentWindow.map(c => c.chapterIndex)).toEqual(Array.from({ length: 12 }, (_, i) => i + 3));
    expect(snapshot.recentWindow.map(c => c.mode)).toEqual([...Array(10).fill('digest'), 'full', 'full']);
    expect(snapshot.source.expectedChapterCount).toBe(16);
    expect(f.read.mock.calls.filter(([d]) => d.kind === 'chapter').map(([d]) => d.recordId)).toEqual(Array.from({ length: 12 }, (_, i) => `source-c${i + 3}`));
  });
  it.each(['missing', 'duplicate', 'reordered'] as const)('rejects %s recent descriptors', async kind => {
    const f = setup(14, 16); f.resolver.resolveAnchor.mockImplementation(async () => { const r = f.response();
      if (kind === 'missing') r.recentChapters.pop();
      if (kind === 'duplicate') r.recentChapters[1] = r.recentChapters[0]!;
      if (kind === 'reordered') [r.recentChapters[0], r.recentChapters[1]] = [r.recentChapters[1]!, r.recentChapters[0]!];
      return r;
    });
    await expect(readStoryBranchSource(f, f.resolver, f.request)).rejects.toThrow();
  });
  it('uses k+1 budget even when full head reaches plan', async () => {
    const f = setup(2); f.records.get('golden-source')!.chapterPlan = { totalChapters: 3, source: 'user', locked: false };
    await expect(readStoryBranchSource(f, f.resolver, f.request)).resolves.toBeDefined();
    const last = setup(3); last.records.get('golden-source')!.chapterPlan = { totalChapters: 3, source: 'user', locked: false };
    await expect(readStoryBranchSource(last, last.resolver, last.request)).rejects.toThrow('计划');
  });
  it.each(['instance', 'revision', 'anchor-hash', 'checkpoint-relation', 'chapter-link', 'empty-roles', 'array-role', 'null-role', 'bytes'] as const)('rejects %s before any save/model', async kind => {
    const f = setup();
    if (kind === 'checkpoint-relation') f.records.get('source-p2')!.chapterId = 'source-c3';
    else if (kind === 'chapter-link') f.records.get('source-c2')!.sourceChapterId = 'source-c3';
    else if (kind === 'array-role') f.records.get('source-p2')!.combatants = [[]];
    else if (kind === 'null-role') f.records.get('source-p2')!.combatants = [null];
    else if (kind === 'empty-roles') f.records.get('source-p2')!.combatants = [];
    else f.resolver.resolveAnchor.mockImplementation(async () => { const r = f.response();
      if (kind === 'instance') r.recentChapters[0]!.instance = 'f'.repeat(32);
      if (kind === 'revision') r.recentChapters[0]!.revision = 2;
      if (kind === 'anchor-hash') r.source.anchor.digest = `sha256:${'f'.repeat(64)}`;
      if (kind === 'bytes') f.records.get('source-c1')!.markdown = 'modified after descriptors';
      return r;
    });
    await expect(readStoryBranchSource(f, f.resolver, f.request)).rejects.toThrow();
  });
  it.each(['missing', 'future', 'safe'] as const)('projects %s summary coverage at anchor', async kind => {
    const f = setup(); const s = f.records.get('golden-source')!; s.sessionSummary = 'summary';
    if (kind !== 'missing') s.summaryMeta = { coveredUntilChapterIndex: kind === 'future' ? 3 : 2, coveredChapterIds: ['source-c1', 'source-c2'] };
    const snapshot = await readStoryBranchSource(f, f.resolver, f.request);
    expect(snapshot.sessionSummary).toBe(kind === 'safe' ? 'summary' : undefined);
    expect(snapshot.session.sessionSummary).toBe(kind === 'safe' ? 'summary' : undefined);
  });
  it('owns the request before await and stops cancelled reads', async () => {
    const f = setup(), gate = deferred<void>(), c = new AbortController();
    f.resolver.resolveAnchor.mockImplementation(async () => { await gate.promise; return f.response(); });
    const pending = readStoryBranchSource(f, f.resolver, f.request, c.signal); f.request.anchorIndex = 1; c.abort(); gate.resolve();
    await expect(pending).rejects.toThrow(); expect(f.read).not.toHaveBeenCalled();
    expect(f.resolver.resolveAnchor.mock.calls[0]?.[0]).toMatchObject({ anchorIndex: 2 });
  });
});
describe('injected owner pre-generation source preparation', () => {
  function ownerSetup() {
    const f = setup(), reads = new StoryFixturePort(); reads.read.mockImplementation(f.read);
    const branch = { begin: vi.fn(), append: vi.fn(), end: vi.fn(), abort: vi.fn(), receipt: vi.fn() } as StoryBranchNativePort;
    const owner = new DesktopArenaStorySession({ port: reads, branch: { port: branch, source: f.resolver }, execute: vi.fn(), exportMarkdown: vi.fn() });
    owner.setExecutionScope('A');
    const input = { mode: 'direct' as const, generationId: 'generation', operationId: 'operation', sessionId: 'target', anchor: f.request };
    return { ...f, owner, input, branch, reads };
  }
  it('prepares no save or model, transfers same run and releases on cancel', async () => {
    const f = ownerSetup(), result = await f.owner.prepareBranchCompletion(f.input);
    expect(f.owner.isBusy()).toBe(true); expect(f.branch.begin).not.toHaveBeenCalled(); expect(f.reads.describe).not.toHaveBeenCalled();
    result.completion.cancel(); expect(f.owner.isBusy()).toBe(false);
    await expect(f.owner.prepareBranchCompletion(f.input)).rejects.toThrow('已消费');
  });
  it.each(['cancel', 'scope', 'selection'] as const)('rejects read-phase %s and cannot resurrect old generation', async kind => {
    const f = ownerSetup(), gate = deferred<void>(); f.resolver.resolveAnchor.mockImplementation(async () => { await gate.promise; return f.response(); });
    const pending = f.owner.prepareBranchCompletion(f.input);
    if (kind === 'scope') f.owner.setExecutionScope('B');
    else if (kind === 'cancel') { f.owner.cancel(); expect(f.owner.isBusy()).toBe(false); }
    else await f.owner.selectSession({ id: 'other', revision: 1, chapterCount: 1, lastChapterId: 'other-c1', titlePreview: 'other', titleTruncated: false, mode: 'classic', createdAt: 1, updatedAt: 1 });
    gate.resolve(); await expect(pending).rejects.toThrow(); expect(f.owner.isBusy()).toBe(false); expect(f.branch.begin).not.toHaveBeenCalled();
    await expect(f.owner.prepareBranchCompletion(f.input)).rejects.toThrow('已消费');
  });
});
