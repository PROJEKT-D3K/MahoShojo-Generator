import { describe, expect, it, vi } from 'vitest';
import { buildBattleStoryBranchChain } from '@mahoshojo/domain/arena-story-branch';
import { STORY_CANDIDATE_FRAME_BYTES } from '@mahoshojo/contracts/desktop-arena-story';
import { DesktopArenaStorySession } from '../src/features/arena/story-session';
import { deferred, installStoryCrypto, StoryFixturePort, storyDraft, storyExecution } from './helpers/story-fixture';

installStoryCrypto();
const patch = (port: StoryFixturePort, id: string, changes: Record<string, unknown>) => {
  const value = { ...port.documents.get(`${id}:session`)!.value, ...changes };
  port.documents.set(`${id}:session`, { value, bytes: new TextEncoder().encode(JSON.stringify(value)) });
};
const setup = async () => {
  const port = new StoryFixturePort(), execution = storyExecution(); let id = 0, now = 0;
  const owner = new DesktopArenaStorySession({ port, id: () => `reader-${++id}`, now: () => ++now,
    exportMarkdown: async () => ({ absolutePath: 'unused', byteLength: 1 }) });
  owner.setExecutionScope('A');
  await owner.start({ draft: storyDraft(), product: 'battle' }, execution.prepare); const parent = owner.getSnapshot().active!;
  await owner.start({ draft: storyDraft(), product: 'arena' }, execution.prepare); const child = owner.getSnapshot().active!;
  patch(port, parent.id, { title: '父会话' });
  patch(port, child.id, { title: '当前分支', branchLabel: '由父故事分支', branchOf: { sessionId: parent.id, chapterId: parent.lastChapterId, chapterIndex: 1, chapterTitle: '锚点' } });
  await owner.refreshSessions();
  port.describe.mockClear(); port.read.mockClear(); port.begin.mockClear(); port.listSessions.mockClear();
  return { owner, port, execution, parent, child, reader: owner.branchReader };
};

describe('explicit device story branch reader', () => {
  it('reads exactly one session per click, keeps only display fields, then navigates through the original owner', async () => {
    const { owner, port, execution, parent, child, reader } = await setup();
    expect(port.read).not.toHaveBeenCalled();
    await reader.open(child);
    expect(port.describe.mock.calls.map(call => call[2])).toEqual(['session']);
    expect(reader.getSnapshot()).toMatchObject({ open: true, loading: false, activeSession: { id: child.id, title: '当前分支', parent: { kind: 'parent', sessionId: parent.id } } });
    expect(buildBattleStoryBranchChain(reader.getSnapshot()).stop).toEqual({ kind: 'missing', sessionId: parent.id });
    expect(reader.getSnapshot().sessions[0]).not.toHaveProperty('seed');
    expect(reader.getSnapshot().sessions[0]).not.toHaveProperty('sessionSummary');
    expect(reader.getSnapshot().sessions[0]).not.toHaveProperty('source');
    await reader.readParent();
    expect(port.describe.mock.calls.map(call => call[0])).toEqual([child.id, parent.id]);
    expect(buildBattleStoryBranchChain(reader.getSnapshot()).stop).toEqual({ kind: 'root' });
    expect(buildBattleStoryBranchChain(reader.getSnapshot()).chain.map(row => row.id)).toEqual([parent.id, child.id]);
    expect(port.begin).not.toHaveBeenCalled(); expect(port.listSessions).not.toHaveBeenCalled(); expect(execution.requests).toHaveLength(2);
    await reader.select(parent.id);
    expect(owner.getSnapshot().active?.id).toBe(parent.id); expect(reader.getSnapshot().open).toBe(false);
    owner.dispose();
  });

  it('does not scan or hydrate a parent outside the first directory page; explicit more makes one-level read available', async () => {
    const { owner, port, parent, child, reader } = await setup();
    const template = port.documents.get(`${parent.id}:session`)!.value;
    for (let i = 0; i < 30; i++) {
      const value = { ...template, id: `unrelated-${i}`, createdAt: 3, updatedAt: 3 };
      port.documents.set(`${value.id}:session`, { value, bytes: new TextEncoder().encode(JSON.stringify(value)) });
    }
    await owner.refreshSessions(); port.listSessions.mockClear();
    expect(owner.getSnapshot().sessions.some(row => row.id === parent.id)).toBe(false);
    await reader.open(child); await reader.readParent();
    expect(reader.getParentHead()).toBeNull(); expect(port.describe).toHaveBeenCalledTimes(1); expect(port.listSessions).not.toHaveBeenCalled();
    expect(buildBattleStoryBranchChain(reader.getSnapshot()).stop?.kind).toBe('missing');
    await owner.refreshSessions(true); expect(reader.getParentHead()?.id).toBe(parent.id);
    await reader.readParent(); expect(buildBattleStoryBranchChain(reader.getSnapshot()).stop?.kind).toBe('root');
    owner.dispose();
  });

  it.each(['close', 'select', 'scope', 'detach', 'dispose'] as const)('cancels the real chunk loop and suppresses late publication after %s', async action => {
    const { owner, port, parent, child, reader } = await setup();
    patch(port, child.id, { opaque: 'x'.repeat(STORY_CANDIDATE_FRAME_BYTES * 3) });
    const gate = deferred<void>(); port.beforeRead = async descriptor => { if (descriptor.kind === 'session') await gate.promise; };
    const pending = reader.open(child); await vi.waitFor(() => expect(port.read).toHaveBeenCalledTimes(1));
    if (action === 'close') reader.close();
    if (action === 'select') await owner.selectSession(parent);
    if (action === 'scope') owner.setExecutionScope('B');
    if (action === 'detach') owner.detach();
    if (action === 'dispose') owner.dispose();
    gate.resolve(); await pending;
    expect(reader.getSnapshot()).toMatchObject({ open: false, loading: false, activeSession: null, sessions: [], error: null });
    expect(port.read.mock.calls.filter(call => call[0].kind === 'session')).toHaveLength(1);
    owner.dispose();
  });

  it('old A response cannot overwrite a reopened B, even when A finishes last', async () => {
    const { owner, port, parent, child, reader } = await setup();
    const gate = deferred<void>(); port.beforeDescribe = async (id, kind) => { if (id === child.id && kind === 'session') await gate.promise; };
    const old = reader.open(child); await reader.open(parent);
    gate.resolve(); await old;
    expect(reader.getSnapshot().activeSession?.id).toBe(parent.id); expect(reader.getSnapshot().sessions).toHaveLength(1);
    expect(port.read.mock.calls.every(call => call[0].sessionId === parent.id)).toBe(true);
    owner.dispose();
  });

  it('retains the independent child and reports native missing only after an actual parent read fails', async () => {
    const { owner, port, parent, child, reader } = await setup(); await reader.open(child);
    port.documents.delete(`${parent.id}:session`); await reader.readParent();
    expect(reader.getSnapshot()).toMatchObject({ activeSession: { id: child.id }, failedSessionId: parent.id, loading: false });
    expect(reader.getSnapshot().error).toContain('目前不存在');
    expect(buildBattleStoryBranchChain(reader.getSnapshot()).stop?.kind).toBe('missing');
    expect(owner.getSnapshot().selected.status).toBe('loaded'); expect(port.begin).not.toHaveBeenCalled();
    owner.dispose();
  });

  it.each(['stale', 'corrupt', 'io'] as const)('keeps %s distinct from a proven root or missing record and allows read-only retry', async cause => {
    const { owner, port, child, reader } = await setup();
    const read = port.read.getMockImplementation()!;
    if (cause === 'stale') port.describe.mockRejectedValueOnce({ code: 'story-stale', message: 'stale', writeEvidence: 'not-written' });
    if (cause === 'io') port.describe.mockRejectedValueOnce(new Error('transport down'));
    if (cause === 'corrupt') port.read.mockImplementationOnce(async (...args) => { const bytes = await read(...args); bytes[0] ^= 1; return bytes; });
    await reader.open(child);
    expect(reader.getSnapshot().activeSession).toBeNull(); expect(reader.getSnapshot().error).toBeTruthy();
    expect(reader.getSnapshot().error).not.toContain('目前不存在'); expect(buildBattleStoryBranchChain(reader.getSnapshot()).stop).toBeNull();
    await reader.retry(); expect(reader.getSnapshot().activeSession?.id).toBe(child.id); expect(reader.getSnapshot().error).toBeNull();
    expect(port.begin).not.toHaveBeenCalled(); owner.dispose();
  });

  it('stops a two-session cycle without extra IO, preserves source documents, and bounds display titles', async () => {
    const { owner, port, parent, child, reader } = await setup();
    patch(port, parent.id, { branchOf: { sessionId: child.id, chapterId: child.lastChapterId, chapterIndex: 1 } });
    patch(port, child.id, { title: '长'.repeat(100000), branchLabel: '长'.repeat(100000) });
    const original = port.documents.get(`${child.id}:session`)!.bytes;
    await reader.open(child); await reader.readParent(); await reader.readParent();
    expect(buildBattleStoryBranchChain(reader.getSnapshot()).stop).toEqual({ kind: 'cycle', sessionId: child.id });
    expect(reader.getParentHead()).toBeNull(); expect(port.describe).toHaveBeenCalledTimes(2);
    expect(new TextEncoder().encode(reader.getSnapshot().activeSession!.title).byteLength).toBeLessThanOrEqual(192);
    expect(new TextEncoder().encode(reader.getSnapshot().activeSession!.branchLabel).byteLength).toBeLessThanOrEqual(192);
    expect(port.documents.get(`${child.id}:session`)!.bytes).toBe(original); owner.dispose();
  });
});
