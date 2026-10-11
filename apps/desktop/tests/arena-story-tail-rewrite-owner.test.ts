import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DesktopArenaStorySession } from '../src/features/arena/story-session';
import { prepareStoryTailRewriteCommit } from '../src/platform/arena-story-tail-rewrite-storage';
import { createIpcStoryNativePort } from '../src/platform/arena-story-native';
import { deferred } from './helpers/story-fixture';
import { tailRewriteFixture } from './helpers/tail-rewrite-fixture';

describe('internal owner tail rewrite generation and save', () => {
  it.each([1, 3, 14])('uses old tail narrative and original input roles for %i chapters; continue remains usable', async count => {
    const f = await tailRewriteFixture(count), original = f.request(), session = f.reads.documents.get(`${f.sourceId}:session`)!.value;
    const inputId = String(session.lastInputCheckpointId), input = structuredClone(f.reads.documents.get(`${f.sourceId}:${inputId}`)!.value);
    f.put(`${f.sourceId}:session`, { ...session, opaque: { nested: ['保留\ud800', null], future: true } });
    await f.rewrite();
    expect(f.owner.getSnapshot()).toMatchObject({ resultSaved: true, pending: null, active: { chapterCount: count, revision: count + 1 } });
    const story = f.execute.mock.calls[0]![3].story!;
    expect(story).toMatchObject({ action: 'rewrite', chapterIndex: count, sourceChapterId: original.targetChapterId });
    expect(story.chapterContext.workingCombatants).toEqual(input.combatants);
    expect(story.chapterContext.recentWindow?.map(item => item.chapterIndex)).toEqual(Array.from({ length: Math.min(12, count) }, (_, i) => count - Math.min(12, count) + 1 + i));
    expect(story.chapterContext.recentWindow?.at(-1)?.chapterId).toBe(original.targetChapterId);
    expect(story.chapterContext.sessionSummary).toBeUndefined();
    expect(f.reads.documents.get(`${f.sourceId}:${inputId}`)!.value).toEqual(input);
    expect(f.reads.documents.get(`${f.sourceId}:session`)!.value).toMatchObject({ opaque: { nested: ['保留\ud800', null], future: true } });
    expect(f.prepareCommit).toHaveBeenCalledTimes(1); expect(f.source.resolveSource).toHaveBeenCalledTimes(1);
    await f.owner.continue('续写', f.execution.prepare);
    expect(f.owner.getSnapshot().active).toMatchObject({ chapterCount: count + 1, revision: count + 2 });
    expect(f.execute.mock.calls[1]![3].story?.chapterContext.recentWindow?.at(-1)?.chapterId).toBe(f.prepareCommit.mock.results[0]!.value.manifest.operationId);
  });
  it('repeated rewrites retain original input checkpoint and continue uses latest output', async () => {
    const f = await tailRewriteFixture(3), original = f.request(); await f.rewrite(); await f.rewrite();
    expect(f.owner.getSnapshot().active).toMatchObject({ chapterCount: 3, revision: 5 });
    const first = f.prepareCommit.mock.results[0]!.value.manifest, second = f.prepareCommit.mock.results[1]!.value.manifest;
    expect(second.source.inputCheckpointId).toBe(first.source.inputCheckpointId); expect(second.source.targetChapterId).not.toBe(original.targetChapterId);
    await f.owner.continue('', f.execution.prepare); expect(f.owner.getSnapshot().active).toMatchObject({ chapterCount: 4, revision: 6 });
  });
  it.each([[false, false], [true, false], [false, true], [true, true]])('shares role effects history=%s state=%s and preserves nested extensions', async (history, state) => {
    const f = await tailRewriteFixture(), session = f.reads.documents.get(`${f.sourceId}:session`)!.value;
    const key = `${f.sourceId}:${session.lastInputCheckpointId}`, cp = f.reads.documents.get(key)!.value;
    const combatants = structuredClone(cp.combatants) as Array<{ data: Record<string, unknown> }>;
    Object.assign(combatants[0]!.data, { signature: 'untrusted-signature', sourceDataCardId: 'old-id', custom: { signature: 'ordinary' },
      current_state: { summary: '章前状态', unknown: true }, arena_history: { attributes: { world_line_id: 'world', extra: true }, entries: [{ id: 'legacy', custom: true }] } });
    f.put(key, { ...cp, combatants });
    const seedKey = `${f.sourceId}:seed`, seed = f.reads.documents.get(seedKey)!.value;
    f.put(seedKey, { ...seed, settings: { ...(seed.settings as object), writeArenaHistory: history, writeCurrentState: state } });
    await f.rewrite();
    const output = f.prepareCommit.mock.results[0]!.value.parts[2]!.prepared.value as { combatants: Array<{ data: Record<string, any> }> };
    const data = output.combatants[0]!.data;
    expect(data.current_state.summary).toBe(state ? '平静' : '章前状态'); expect(data.arena_history.entries).toHaveLength(history ? 2 : 1);
    expect(data.custom).toEqual({ signature: 'ordinary' });
    if (history || state) { expect(data).not.toHaveProperty('signature'); expect(data).not.toHaveProperty('sourceDataCardId'); }
    else expect(data.signature).toBe('untrusted-signature');
    expect(f.reads.documents.get(key)!.value.combatants).toEqual(combatants);
  });
  it('keeps safe summary and its extensions without advancing the rewritten tail', async () => {
    const f = await tailRewriteFixture(3), key = `${f.sourceId}:session`, session = f.reads.documents.get(key)!.value, first = f.reads.chapterDocuments(f.sourceId)[0]!;
    f.put(key, { ...session, sessionSummary: '安全摘要', summaryMeta: { coveredUntilChapterIndex: 1, coveredChapterIds: [first.id], mode: 'deterministic-fallback', refreshedAt: 1, opaque: { kept: true } } });
    await f.rewrite(); expect(f.execute.mock.calls[0]![3].story!.chapterContext.sessionSummary).toBe('安全摘要');
    expect(f.reads.documents.get(key)!.value).toMatchObject({ sessionSummary: '安全摘要', summaryMeta: { coveredUntilChapterIndex: 1, opaque: { kept: true } } });
  });
  it('reserves synchronously and blocks same-tick duplicate generation', async () => {
    const f = await tailRewriteFixture(), gate = deferred<void>(), original = vi.mocked(f.source.resolveSource).getMockImplementation()!;
    vi.mocked(f.source.resolveSource).mockImplementation(async request => { await gate.promise; return original(request); });
    const first = f.rewrite(); await f.rewrite(); gate.resolve(); await first;
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.tail.begin).toHaveBeenCalledTimes(1);
  });
  it('retains full prose before preflight failure and never repeats preparation', async () => {
    const f = await tailRewriteFixture(); f.prepareCommit.mockImplementation((identity, records) => {
      expect(f.owner.getSnapshot()).toMatchObject({ phase: 'completed', result: { rawText: '完整原文', markdown: '# 完整改写\n保留全部正文 😀', reasoning: '完整推理' } });
      return prepareStoryTailRewriteCommit(identity, records, 1);
    });
    await f.rewrite(); await f.owner.savePending();
    expect(f.owner.getSnapshot()).toMatchObject({ resultSaved: false, pending: { tooLarge: true, retryable: false } });
    expect(f.prepareCommit).toHaveBeenCalledTimes(1); expect(f.tail.begin).not.toHaveBeenCalled(); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('late streaming callback cannot overwrite terminal prose while Native save awaits', async () => {
    const f = await tailRewriteFixture(), gate = deferred<void>(), original = f.execute.getMockImplementation()!;
    let partial: Parameters<typeof original>[5];
    f.execute.mockImplementation(async (...args) => { partial = args[5]; return original(...args); });
    const receipt = vi.mocked(f.tail.receipt).getMockImplementation()!;
    vi.mocked(f.tail.receipt).mockImplementation(async (...args) => { await gate.promise; return receipt(...args); });
    const run = f.rewrite(); await vi.waitFor(() => expect(f.owner.getSnapshot().phase).toBe('completed'));
    partial?.({ rawText: '过时partial', markdown: '过时partial', reasoning: '' });
    expect(f.owner.getSnapshot().result?.rawText).toBe('完整原文');
    gate.resolve(); await run; expect(f.owner.getSnapshot().result?.rawText).toBe('完整原文');
  });
  it('known rollback retries only explicit same frozen package', async () => {
    const f = await tailRewriteFixture(); f.behavior.rollback = true; await f.rewrite();
    expect(f.owner.getSnapshot().pending?.evidence).toBe('not-written'); expect(f.tail.begin).toHaveBeenCalledTimes(1);
    const bytes = vi.mocked(f.tail.append).mock.calls.map(([, kind, offset, data]) => ({ kind, offset, bytes: Array.from(data) }));
    vi.mocked(f.tail.append).mockClear(); f.behavior.rollback = false; await f.owner.savePending();
    expect(vi.mocked(f.tail.begin).mock.calls[1]![0]).toBe(vi.mocked(f.tail.begin).mock.calls[0]![0]);
    expect(vi.mocked(f.tail.append).mock.calls.map(([, kind, offset, data]) => ({ kind, offset, bytes: Array.from(data) }))).toEqual(bytes);
    expect(f.prepareCommit).toHaveBeenCalledTimes(1); expect(f.execute).toHaveBeenCalledTimes(1); expect(f.owner.getSnapshot().resultSaved).toBe(true);
  });
  it('unknown remains lookup-only across absent/mismatch/IO and account ABA; known saved survives read failure', async () => {
    const f = await tailRewriteFixture(); f.behavior.lose = true; await f.rewrite(); expect(f.owner.getSnapshot().pending?.evidence).toBe('unknown');
    for (const mode of ['absent', 'mismatch', 'io'] as const) { f.behavior.hide = mode; await f.owner.savePending(); expect(f.owner.getSnapshot().pending?.evidence).toBe('unknown'); }
    f.owner.setExecutionScope('B'); f.owner.setExecutionScope('A'); f.behavior.hide = 'none';
    f.reads.listSessions.mockRejectedValue(new Error('directory IO')); await f.owner.savePending();
    expect(f.owner.getSnapshot()).toMatchObject({ resultSaved: true, pending: null, savedUnread: { id: f.sourceId } });
    await f.owner.savePending(); expect(f.tail.begin).toHaveBeenCalledTimes(1); expect(f.tail.end).toHaveBeenCalledTimes(1); expect(f.source.resolveSource).toHaveBeenCalledTimes(1); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it.each(['cancel', 'scope-aba', 'detach'] as const)('%s keeps accepted partial and rejects late generation', async kind => {
    const f = await tailRewriteFixture(), gate = deferred<void>(), original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (...args) => { const result = await original(...args); await gate.promise; return result; });
    const run = f.rewrite(); await vi.waitFor(() => expect(f.owner.getSnapshot().result?.rawText).toBe('流式原文'));
    if (kind === 'scope-aba') { f.owner.setExecutionScope('B'); f.owner.setExecutionScope('A'); } else if (kind === 'detach') f.owner.detach(); else f.owner.cancel();
    gate.resolve(); await run; expect(f.owner.getSnapshot().result?.rawText).toBe('流式原文'); expect(f.tail.begin).not.toHaveBeenCalled(); expect(f.owner.isBusy()).toBe(false);
  });
  it.each(['cancel', 'selection-aba', 'scope-aba'] as const)('late receipt after %s cannot steal selection', async kind => {
    const f = await tailRewriteFixture(3), gate = deferred<void>(), original = vi.mocked(f.tail.end).getMockImplementation()!;
    let selected = f.owner.getSnapshot().selected;
    vi.mocked(f.tail.end).mockImplementation(async token => { const result = await original(token); await gate.promise; return result; });
    const run = f.rewrite(); await vi.waitFor(() => expect(f.tail.end).toHaveBeenCalled());
    if (kind === 'selection-aba') { await f.owner.selectSession(f.owner.getSnapshot().active!); selected = f.owner.getSnapshot().selected; }
    else if (kind === 'scope-aba') { f.owner.setExecutionScope('B'); f.owner.setExecutionScope('A'); } else f.owner.cancel();
    gate.resolve(); await run; expect(f.owner.getSnapshot()).toMatchObject({ resultSaved: true, pending: null, savedUnread: { id: f.sourceId } });
    expect(f.owner.getSnapshot().selected).toEqual(selected);
  });
  it.each(['absent', 'mismatch', 'io', 'none'] as const)('a fresh owner recovers only the original receipt: %s', async mode => {
    const f = await tailRewriteFixture(); f.behavior.lose = true; await f.rewrite();
    const prepared = f.prepareCommit.mock.results[0]!.value, result = f.owner.getSnapshot().result!;
    f.owner.dispose(); f.behavior.hide = mode;
    const recovered = new DesktopArenaStorySession({ port: f.reads, tailRewrite: { port: f.tail, source: f.source }, execute: f.execute, exportMarkdown: vi.fn() });
    await recovered.recoverTailRewriteReceipt(prepared, result);
    expect(recovered.getSnapshot().resultSaved).toBe(mode === 'none');
    if (mode !== 'none') { expect(recovered.getSnapshot().pending?.evidence).toBe('unknown'); await recovered.savePending(); }
    expect(f.tail.begin).toHaveBeenCalledTimes(1); expect(f.execute).toHaveBeenCalledTimes(1); expect(f.source.resolveSource).toHaveBeenCalledTimes(1);
    await expect(recovered.recoverTailRewriteReceipt(prepared, result)).rejects.toThrow('已消费');
  });
  it('default owner and binder do not activate the internal capability', async () => {
    const f = await tailRewriteFixture(), owner = new DesktopArenaStorySession({ port: f.reads, exportMarkdown: vi.fn() });
    await expect(owner.generateTailRewrite({ mode: 'direct', target: f.request(), userGuidance: '' }, f.execution.prepare)).rejects.toThrow('未开放');
    expect(Object.keys(createIpcStoryNativePort(vi.fn())).some(k => /tail|rewrite/i.test(k))).toBe(false);
    for (const file of ['../src/app/battle-page.tsx', '../src-tauri/build.rs', '../src-tauri/capabilities/main-ui.json']) expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toMatch(/tailRewrite|tail_rewrite|tail-rewrite/);
  });
});
