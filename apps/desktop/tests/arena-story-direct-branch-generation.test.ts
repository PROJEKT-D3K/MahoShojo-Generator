import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoryExecutionTarget } from '../src/features/arena/story-session';
import { DesktopArenaStorySession } from '../src/features/arena/story-session';
import * as snapshotModule from '../src/features/arena/story-snapshot';
import { branchCopyId } from '../src/platform/arena-story-branch-storage';
import { savePreparedStoryCommit } from '../src/platform/arena-story-storage';
import { deferred, installStoryCrypto, StoryFixturePort } from './helpers/story-fixture';
import { branchFixtureRoles, directBranchExecution, directBranchText } from './helpers/arena-story-direct-branch-fixture';
import { directBranchOwnerFixture } from './helpers/arena-story-direct-branch-owner-fixture';

installStoryCrypto();
const owners: DesktopArenaStorySession[] = [];
const setup = async (k = 2, total = 3) => { const f = await directBranchOwnerFixture(k, total); owners.push(f.owner); return f; };
afterEach(() => { for (const owner of owners.splice(0)) owner.dispose(); vi.restoreAllMocks(); });
const input = (f: Awaited<ReturnType<typeof setup>>) => ({ mode: 'direct' as const, anchor: f.anchor, userGuidance: '在原边界之后向北' });

describe('internal Direct branch real producer', () => {
  it('uses one actual adapter request, random IDs, boundary roles and paged sparse summary IDs outside recent12', async () => {
    const f = await setup(53, 55), execution = directBranchExecution();
    const sourceBytes = new Map([...f.reads.documents].map(([key, doc]) => [key, Buffer.from(doc.bytes)]));
    await f.owner.generateBranch(input(f), execution.prepare);
    expect(execution.requests).toHaveLength(1); expect(f.prepareCommit).toHaveBeenCalledTimes(1);
    expect(f.owner.getSnapshot()).toMatchObject({ phase: 'completed', resultSaved: true, pending: null, active: { chapterCount: 54, revision: 54 } });
    const payload = JSON.parse(execution.requests[0]!.arenaInputJson!);
    expect(payload.combatants).toEqual(branchFixtureRoles(53)); expect(payload.userGuidance).toBe('在原边界之后向北');
    expect(payload.internalGuidance).toContain('分支续写第 54 章'); expect(payload.internalGuidance).toContain(f.anchor.anchorChapterId);
    expect(payload.internalGuidance).toContain('仅锚点之前的安全摘要'); expect(payload.internalGuidance).not.toContain('boundary-55');
    expect(execution.requests[0]!.messages.some(message => message.content.includes('分支续写第 54 章'))).toBe(true);
    const commit = f.prepared[0]!, target = commit.manifest.sessionId;
    expect(commit.manifest.source.expectedChapterCount).toBe(55); expect(commit.manifest.source.anchorIndex).toBe(53);
    expect(commit.parts[1]!.prepared.value).toMatchObject({ action: 'branch', index: 54, sourceChapterId: branchCopyId(target, 'c', 53), generationId: execution.requests[0]!.requestId });
    expect(commit.parts[2]!.prepared.value).toMatchObject({ boundaryIndex: 54, combatants: branchFixtureRoles(53) });
    expect((commit.parts[0]!.prepared.value as { summaryMeta: { coveredChapterIds: string[] } }).summaryMeta.coveredChapterIds)
      .toEqual(f.coveredIndices.map(index => branchCopyId(target, 'c', index)));
    const mappingCalls = f.reads.listChapters.mock.calls.filter(([id]) => id === f.sessionId);
    expect(mappingCalls.map(([, , cursor, limit]) => ({ cursor: cursor?.index ?? 0, limit }))).toEqual([{ cursor: 0, limit: 50 }, { cursor: 50, limit: 3 }]);
    const sourceReads = f.reads.read.mock.calls.filter(([descriptor]) => descriptor.sessionId === f.sessionId);
    expect(sourceReads.filter(([descriptor]) => descriptor.kind === 'chapter').map(([descriptor]) => descriptor.recordId))
      .toEqual(f.chapterIds.slice(41, 53));
    expect(sourceReads.at(-1)).toEqual([commit.manifest.source.session, 0, 1]);
    for (const [key, bytes] of sourceBytes) expect(Buffer.from(f.reads.documents.get(key)!.bytes)).toEqual(bytes);
    expect(Object.isFrozen(commit.manifest.source.session)).toBe(true);
  });
  it.each(['empty', 'unknown-only'] as const)('keeps %s summary coverage legal and preserves the shared filtering semantics', async kind => {
    const f = await setup(53, 55), execution = directBranchExecution();
    const stored = f.reads.documents.get(`${f.sessionId}:session`)!;
    (stored.value.summaryMeta as { coveredChapterIds: string[] }).coveredChapterIds = kind === 'empty' ? [] : [f.unknownId, f.chapterIds[54]!];
    stored.bytes = Buffer.from(JSON.stringify(stored.value));
    await f.owner.generateBranch(input(f), execution.prepare);
    expect(f.owner.getSnapshot().resultSaved).toBe(true); expect(execution.requests).toHaveLength(1);
    expect((f.prepared[0]!.parts[0]!.prepared.value as { summaryMeta: { coveredChapterIds: string[] } }).summaryMeta.coveredChapterIds).toEqual([]);
  });
  it('owns the anchor and user guidance before awaiting the source resolver', async () => {
    const f = await setup(), execution = directBranchExecution(), entered = deferred<void>(), release = deferred<void>();
    const original = f.source.resolveAnchor.getMockImplementation()!;
    f.source.resolveAnchor.mockImplementation(async request => { entered.resolve(); await release.promise; return original(request); });
    const request = input(f), run = f.owner.generateBranch(request, execution.prepare); await entered.promise;
    request.userGuidance = 'later draft edit'; request.anchor.anchorIndex = 1; request.anchor.anchorChapterId = f.chapterIds[0]!;
    release.resolve(); await run;
    expect(execution.requests).toHaveLength(1); expect(JSON.parse(execution.requests[0]!.arenaInputJson!).userGuidance).toBe('在原边界之后向北');
    expect(f.prepared[0]!.manifest.source.anchorIndex).toBe(2);
  });
  it('rejects an invalid persisted generation seed before model or target creation', async () => {
    const f = await setup(), execution = directBranchExecution(), stored = f.reads.documents.get(`${f.sessionId}:seed`)!;
    stored.value.settings = {}; stored.bytes = Buffer.from(JSON.stringify(stored.value));
    await f.owner.generateBranch(input(f), execution.prepare);
    expect(execution.requests).toHaveLength(0); expect(f.branch.begin).not.toHaveBeenCalled(); expect(f.owner.isBusy()).toBe(false);
  });
  it('uses canonical unsigned role effects and real transport telemetry without changing the source boundary', async () => {
    const f = await setup(), seed = f.reads.documents.get(`${f.sessionId}:seed`)!, checkpoint = f.reads.documents.get(`${f.sessionId}:${f.checkpointIds[2]}`)!;
    Object.assign(seed.value.settings as object, { writeArenaHistory: true, writeCurrentState: true }); seed.bytes = Buffer.from(JSON.stringify(seed.value));
    const roles = checkpoint.value.combatants as Array<{ data: Record<string, unknown>; isNative: boolean; isPreset: boolean }>;
    Object.assign(roles[0]!.data, { templateId: '通用角色', signature: 'old-authority', extension: { signature: 'nested-user-keep' } });
    roles[0]!.isNative = true; roles[0]!.isPreset = true; checkpoint.bytes = Buffer.from(JSON.stringify(checkpoint.value));
    const original = Buffer.from(checkpoint.bytes), usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    const rawText = '# 新分支状态\n\n完整分支正文\n<!-- MAHOSHOJO_ARENA_META {"version":1,"report":{"headline":"新分支状态","winner":"甲-boundary-2"},"impacts":[{"characterName":"甲-boundary-2","impact":"建立新的信任","currentStateSummary":"已恢复平静"}]} -->\n<!-- MAHOSHOJO_TELEMETRY_META {"aiModel":"untrusted","usage":{"totalTokens":99999}} -->';
    const execution = directBranchExecution({ rawText, reasoning: '独立推理原文', usage });
    await f.owner.generateBranch(input(f), execution.prepare);
    expect(execution.requests).toHaveLength(1); expect(f.owner.getSnapshot().resultSaved).toBe(true);
    const output = (f.prepared[0]!.parts[2]!.prepared.value as { combatants: typeof roles }).combatants[0]!;
    expect(output).toMatchObject({ isNative: false, isPreset: false, data: { current_state: { summary: '已恢复平静' }, extension: { signature: 'nested-user-keep' } } });
    expect(output.data).not.toHaveProperty('signature'); expect(JSON.stringify(output.data.arena_history)).toContain('建立新的信任');
    expect(f.prepared[0]!.parts[1]!.prepared.value).toMatchObject({ cardSnapshot: { aiModel: 'synthetic-branch-model', aiUsage: usage, aiReasoning: { status: 'done', source: 'provider', text: '独立推理原文' } } });
    expect(Buffer.from(f.reads.documents.get(`${f.sessionId}:${f.checkpointIds[2]}`)!.bytes)).toEqual(original);
  });
  it('accepts a copied historical chapter as another branch anchor without treating it as another model receipt', async () => {
    const f = await setup(), execution = directBranchExecution(); await f.owner.generateBranch(input(f), execution.prepare);
    const head = f.owner.getSnapshot().active!, copiedId = branchCopyId(head.id, 'c', 1);
    await f.owner.generateBranch({ mode: 'direct', anchor: { sessionId: head.id, revision: head.revision,
      expectedChapterCount: head.chapterCount, expectedLastChapterId: head.lastChapterId, anchorChapterId: copiedId, anchorIndex: 1 }, userGuidance: '从复制章再分支' }, execution.prepare);
    expect(execution.requests).toHaveLength(2); expect(f.prepared).toHaveLength(2); expect(f.owner.getSnapshot().resultSaved).toBe(true);
    expect(f.prepared[1]!.manifest.source.anchor.recordId).toBe(copiedId);
    expect(JSON.parse(execution.requests[1]!.arenaInputJson!).combatants).toEqual(branchFixtureRoles(1));
  });
  it.each(['mapping', 'prepare'] as const)('selection ABA during %s permanently invalidates pre-model work', async phase => {
    const f = await setup(53, 55), execution = directBranchExecution(), entered = deferred<void>(), release = deferred<void>();
    if (phase === 'mapping') {
      const original = f.reads.listChapters.getMockImplementation()!;
      f.reads.listChapters.mockImplementation(async (...args) => { const result = await original(...args); if (args[2]?.index === 50) { entered.resolve(); await release.promise; } return result; });
    }
    const running = f.owner.generateBranch(input(f), phase === 'prepare' ? async run => { entered.resolve(); await release.promise; await execution.prepare(run); } : execution.prepare);
    await entered.promise;
    await f.owner.selectChapter(f.chapterIds[0]!); await f.owner.selectSession(f.head);
    release.resolve(); await running;
    expect(execution.requests).toHaveLength(0); expect(f.branch.begin).not.toHaveBeenCalled(); expect(f.owner.isBusy()).toBe(false);
  });
  it('rechecks the original descriptor after head mapping and refuses same-content instance ABA before model', async () => {
    const f = await setup(53, 55), execution = directBranchExecution(), original = f.reads.listChapters.getMockImplementation()!;
    f.reads.listChapters.mockImplementation(async (...args) => { const result = await original(...args); if (args[2]?.index === 50) f.reads.instance = 'b'.repeat(32); return result; });
    await f.owner.generateBranch(input(f), execution.prepare);
    expect(execution.requests).toHaveLength(0); expect(f.branch.begin).not.toHaveBeenCalled(); expect(f.owner.isBusy()).toBe(false);
    expect(f.reads.read.mock.calls.at(-1)?.slice(1)).toEqual([0, 1]);
  });
  it.each(['cancel', 'scope', 'detach'] as const)('stops %s during target preparation without creating a model or target', async kind => {
    const f = await setup(), execution = directBranchExecution(), entered = deferred<void>(), release = deferred<void>();
    const running = f.owner.generateBranch(input(f), async run => { entered.resolve(); await release.promise; await execution.prepare(run); });
    await entered.promise;
    if (kind === 'cancel') f.owner.cancel(); else if (kind === 'scope') { f.owner.setExecutionScope('B'); f.owner.setExecutionScope('direct-test'); } else f.owner.detach();
    release.resolve(); await running;
    expect(execution.requests).toHaveLength(0); expect(f.branch.begin).not.toHaveBeenCalled(); expect(f.reads.heads()).toHaveLength(1); expect(f.owner.isBusy()).toBe(false);
  });
  it('does not dispatch twice when a target preparation callback repeats', async () => {
    const f = await setup(), execution = directBranchExecution();
    await f.owner.generateBranch(input(f), async run => { await execution.prepare(run); await execution.prepare(run); });
    expect(execution.requests).toHaveLength(1); expect(f.branch.end).toHaveBeenCalledTimes(1); expect(f.prepared).toHaveLength(1);
  });
  it('keeps a successful in-flight result device-owned while a new manual selection wins', async () => {
    const f = await setup(), gate = deferred<void>(), execution = directBranchExecution({ afterText: () => gate.promise });
    const running = f.owner.generateBranch(input(f), execution.prepare);
    await vi.waitFor(() => expect(execution.requests).toHaveLength(1)); await f.owner.selectChapter(f.chapterIds[0]!);
    gate.resolve(); await running;
    expect(f.owner.getSnapshot()).toMatchObject({ resultSaved: true, pending: null, active: { id: f.sessionId }, selected: { status: 'loaded', chapterId: f.chapterIds[0] } });
    expect(f.owner.getSnapshot().savedUnread?.id).toBe(f.prepared[0]!.manifest.sessionId); expect(execution.requests).toHaveLength(1);
  });
  it.each(['cancel', 'invalid'] as const)('%s output keeps received prose but creates zero targets', async kind => {
    const f = await setup(), gate = deferred<void>(), rawText = kind === 'invalid' ? '<!-- MAHOSHOJO_ARENA_META {invalid -->' : directBranchText;
    const execution = directBranchExecution({ rawText, ...(kind === 'cancel' ? { afterText: () => gate.promise } : {}) });
    const running = f.owner.generateBranch(input(f), execution.prepare);
    if (kind === 'cancel') { await vi.waitFor(() => expect(f.owner.getSnapshot().result?.rawText).toBe(rawText)); f.owner.cancel(); gate.resolve(); }
    await running;
    expect(execution.requests).toHaveLength(1); expect(f.branch.begin).not.toHaveBeenCalled(); expect(f.reads.heads()).toHaveLength(1);
    expect(f.owner.getSnapshot().result?.rawText).toBe(rawText); expect(f.owner.hasUnsavedResult()).toBe(true);
  });
  it('publishes complete prose before a role/domain projection throws and never repeats projection or model', async () => {
    const f = await setup(), execution = directBranchExecution();
    const project = vi.spyOn(snapshotModule, 'completeDesktopBranchRecords').mockImplementation(() => {
      expect(f.owner.getSnapshot().result?.markdown).toBe(directBranchText);
      throw new Error('synthetic role projection failure');
    });
    await f.owner.generateBranch(input(f), execution.prepare); await f.owner.savePending();
    expect(f.owner.getSnapshot()).toMatchObject({ phase: 'completed', resultSaved: false, result: { markdown: directBranchText, rawText: directBranchText }, pending: { retryable: false, evidence: 'not-written' } });
    expect(project).toHaveBeenCalledTimes(1); expect(execution.requests).toHaveLength(1); expect(f.branch.begin).not.toHaveBeenCalled();
  });
  it.each(['rollback', 'source-conflict', 'unknown'] as const)('%s retries only original frozen save evidence and never invokes another model', async kind => {
    const f = await setup(), execution = directBranchExecution({ ...(kind === 'source-conflict' ? { onRequest: async () => { await savePreparedStoryCommit(f.reads, f.next); } } : {}) });
    if (kind === 'rollback') f.setFault('rollback'); if (kind === 'unknown') f.setFault('lost');
    await f.owner.generateBranch(input(f), execution.prepare);
    const commit = f.prepared[0]!, first = vi.mocked(f.branch.begin).mock.calls[0]![0];
    expect(f.owner.getSnapshot().pending?.evidence).toBe(kind === 'unknown' ? 'unknown' : 'not-written');
    if (kind === 'unknown') {
      for (const mode of ['null', 'mismatch', 'io'] as const) { f.setHide(mode); await f.owner.savePending(); expect(f.owner.getSnapshot().pending?.evidence).toBe('unknown'); }
      expect(f.branch.begin).toHaveBeenCalledTimes(1); f.setHide('none'); await f.owner.savePending(); expect(f.owner.getSnapshot().resultSaved).toBe(true);
    } else {
      await f.owner.savePending(); expect(vi.mocked(f.branch.begin).mock.calls[1]![0]).toBe(first);
      expect(f.owner.getSnapshot().resultSaved).toBe(kind === 'rollback');
    }
    expect(f.prepared).toEqual([commit]); expect(execution.requests).toHaveLength(1); expect(f.prepareCommit).toHaveBeenCalledTimes(1);
  });
  it('rejects Hosted at the owner and target seams, and default owner has no injected branch capability', async () => {
    const f = await setup(), execution = directBranchExecution();
    await expect(f.owner.generateBranch({ ...input(f), mode: 'hosted' }, execution.prepare)).rejects.toThrow('Hosted');
    const defaultOwner = new DesktopArenaStorySession({ port: new StoryFixturePort(), exportMarkdown: vi.fn() }); owners.push(defaultOwner); defaultOwner.setExecutionScope('default');
    await expect(defaultOwner.generateBranch(input(f), execution.prepare)).rejects.toThrow();
    await f.owner.generateBranch(input(f), async run => run({ mode: 'hosted' } as StoryExecutionTarget));
    expect(execution.requests).toHaveLength(0); expect(f.branch.begin).not.toHaveBeenCalled(); expect(f.owner.isBusy()).toBe(false);
  });
});
