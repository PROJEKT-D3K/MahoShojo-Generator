import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopArenaStorySession } from '../src/features/arena/story-session';
import { createIpcStoryNativePort } from '../src/platform/arena-story-native';
import { deferred, installStoryCrypto, StoryFixturePort, storyDraft, storyExecution, storyFixtureInvoke } from './helpers/story-fixture';
import { HostedStoryFixture } from './helpers/hosted-story-fixture';

installStoryCrypto();
const owners: DesktopArenaStorySession[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.restoreAllMocks(); });
const setup = async (extra: Partial<ConstructorParameters<typeof DesktopArenaStorySession>[0]> = {}) => {
  const port = new StoryFixturePort(), execution = storyExecution(), native = storyFixtureInvoke(port);
  const exportMarkdown = vi.fn<ConstructorParameters<typeof DesktopArenaStorySession>[0]['exportMarkdown']>(async () => ({ absolutePath: '/fixture/full-story.md', byteLength: 10 }));
  let id = 0, now = 100;
  const owner = new DesktopArenaStorySession({ port: createIpcStoryNativePort(native.invoke), id: () => `delete-${++id}`, now: () => ++now, exportMarkdown, ...extra });
  owners.push(owner); owner.setExecutionScope('account-A');
  await owner.start({ draft: storyDraft(), product: 'battle' }, execution.prepare);
  expect(owner.getSnapshot().resultSaved).toBe(true);
  return { owner, port, execution, exportMarkdown };
};

describe('device story explicit whole-session deletion', () => {
  it('captures the clicked target before fresh describe, does not hydrate records, and cancel performs no deletion', async () => {
    const { owner, port, execution } = await setup();
    const first = owner.getSnapshot().active!;
    await owner.start({ draft: storyDraft(), product: 'battle' }, execution.prepare);
    const second = owner.getSnapshot().active!;
    await owner.selectSession(first);
    const gate = deferred<void>(); port.beforeDescribe = async (_sessionId, kind) => { if (kind === 'session') await gate.promise; };
    port.describe.mockClear(); port.read.mockClear();
    const request = owner.requestDeleteSession();
    expect(owner.getSnapshot().deletion?.phase).toBe('preparing');
    await owner.requestDeleteSession();
    await owner.selectSession(second);
    port.read.mockClear(); gate.resolve(); await request;
    expect(owner.getSnapshot().deletion).toMatchObject({ phase: 'confirm', target: { sessionId: first.id, chapterCount: 1 } });
    expect(port.describe.mock.calls.filter(call => call[2] === 'session')).toHaveLength(1);
    expect(port.read).not.toHaveBeenCalled();
    owner.cancelDeleteSession(); await owner.confirmDeleteSession();
    expect(owner.getSnapshot()).toMatchObject({ active: { id: second.id }, deletion: null });
    expect(port.deleteSession).not.toHaveBeenCalled(); expect(execution.requests).toHaveLength(2);
  });
  it('single-flights deletion of A and never clears or steals a later B selection', async () => {
    const { owner, port, execution } = await setup(); const first = owner.getSnapshot().active!;
    await owner.start({ draft: storyDraft(), product: 'battle' }, execution.prepare); const second = owner.getSnapshot().active!;
    await owner.selectSession(first); await owner.requestDeleteSession();
    const gate = deferred<void>(); port.beforeDelete = () => gate.promise;
    const deleting = owner.confirmDeleteSession(); await owner.confirmDeleteSession();
    owner.cancelDeleteSession(); expect(owner.getSnapshot().deletion?.phase).toBe('deleting');
    await owner.selectSession(second); gate.resolve(); await deleting;
    expect(port.deleteSession).toHaveBeenCalledTimes(1);
    expect(owner.getSnapshot()).toMatchObject({ active: { id: second.id }, selected: { sessionId: second.id }, deletion: null });
    expect(port.heads().map(head => head.id)).toEqual([second.id]); expect(execution.requests).toHaveLength(2);
  });
  it('exports the frozen A target, preserves B, and requires a fresh confirmation afterward', async () => {
    const { owner, port, execution, exportMarkdown } = await setup(); const first = owner.getSnapshot().active!;
    await owner.start({ draft: storyDraft(), product: 'battle' }, execution.prepare); const second = owner.getSnapshot().active!;
    await owner.selectSession(first); await owner.requestDeleteSession(); await owner.selectSession(second);
    await owner.exportDeleteTarget();
    expect(exportMarkdown.mock.calls[0]?.[0]).toEqual(first);
    expect(owner.getSnapshot()).toMatchObject({ active: { id: second.id }, deletion: null, exportResult: { absolutePath: '/fixture/full-story.md' } });
    await owner.confirmDeleteSession(); expect(port.deleteSession).not.toHaveBeenCalled();
  });
  it('deletes beyond the visible page, clears only the deleted selection and refresh failure cannot replay mutation', async () => {
    const { owner, port, execution } = await setup();
    for (let index = 1; index < 27; index++) await owner.continue('', execution.prepare);
    expect(owner.getSnapshot().chapters).toHaveLength(25);
    await owner.requestDeleteSession(); expect(owner.getSnapshot().deletion?.target.chapterCount).toBe(27);
    port.listSessions.mockRejectedValueOnce(new Error('fixture directory unavailable'));
    await owner.confirmDeleteSession();
    expect(owner.getSnapshot()).toMatchObject({ active: null, chapters: [], selected: { status: 'unloaded' }, deletion: null });
    expect(owner.getSnapshot().deletionNotice).toContain('已删除'); expect(owner.getSnapshot().deletionNotice).toContain('目录刷新失败');
    expect(port.documents.size).toBe(0); expect(port.receipts.size).toBe(0);
    await owner.refreshSessions(); await owner.confirmDeleteSession();
    expect(port.deleteSession).toHaveBeenCalledTimes(1); expect(execution.requests).toHaveLength(27);
  });
  it('lost ACK stays unknown until explicit read confirms current absence, with zero automatic delete/save/model replay', async () => {
    const { owner, port, execution } = await setup(); await owner.requestDeleteSession(); port.loseDeleteReply = true;
    port.describe.mockClear(); await owner.confirmDeleteSession();
    expect(owner.getSnapshot().deletion?.phase).toBe('unknown'); expect(port.describe).not.toHaveBeenCalled();
    await owner.confirmDeleteSession(); await owner.savePending(); await owner.continue('', execution.prepare);
    expect(port.deleteSession).toHaveBeenCalledTimes(1); expect(port.begin).toHaveBeenCalledTimes(1); expect(execution.requests).toHaveLength(1);
    await owner.observeDeleteSession();
    expect(owner.getSnapshot()).toMatchObject({ deletion: null, active: null });
    expect(owner.getSnapshot().deletionNotice).toContain('目前已确认'); expect(owner.getSnapshot().deletionNotice).toContain('不证明');
    expect(port.describe).toHaveBeenCalledTimes(1); expect(port.deleteSession).toHaveBeenCalledTimes(1);
  });
  it.each(['unchanged', 'changed', 'unreadable', 'malformed'] as const)('unknown observation handles %s without retry authority', async state => {
    const { owner, port, execution } = await setup(); const head = owner.getSnapshot().active!;
    await owner.requestDeleteSession(); port.deleteSession.mockRejectedValueOnce(new Error('transport unknown'));
    await owner.confirmDeleteSession();
    if (state === 'changed') port.instance = 'b'.repeat(32);
    if (state === 'unreadable') port.describe.mockRejectedValueOnce({ code: 'story-io', message: 'unreadable', writeEvidence: 'not-written' });
    if (state === 'malformed') port.describe.mockResolvedValueOnce({ unrelated: true } as never);
    await owner.observeDeleteSession();
    expect(owner.getSnapshot().active?.id).toBe(head.id);
    if (state === 'unchanged' || state === 'changed') {
      expect(owner.getSnapshot().deletion).toBeNull();
      expect(owner.getSnapshot().deletionNotice).toContain(state === 'unchanged' ? '原会话目前仍在' : '身份或版本已变化');
    } else expect(owner.getSnapshot().deletion?.phase).toBe('unknown');
    await owner.confirmDeleteSession(); expect(port.deleteSession).toHaveBeenCalledTimes(1); expect(execution.requests).toHaveLength(1);
  });
  it('a stale/restore descriptor rejection is known not-written and requires a new read and confirmation', async () => {
    const { owner, port } = await setup(); await owner.requestDeleteSession(); port.instance = 'b'.repeat(32);
    await owner.confirmDeleteSession(); expect(port.heads()).toHaveLength(1);
    expect(owner.getSnapshot().deletion).toBeNull(); expect(owner.getSnapshot().deletionNotice).toContain('本次未删除');
    await owner.confirmDeleteSession(); expect(port.deleteSession).toHaveBeenCalledTimes(1);
    await owner.requestDeleteSession(); await owner.confirmDeleteSession(); expect(port.heads()).toHaveLength(0);
  });
  it('unreadable or stale prepare never turns a partial directory into absence or dispatches deletion', async () => {
    const { owner, port } = await setup();
    port.describe.mockRejectedValueOnce({ code: 'story-stale', message: 'changed', writeEvidence: 'not-written' });
    await owner.requestDeleteSession(); expect(owner.getSnapshot().deletion).toBeNull();
    expect(owner.getSnapshot().deletionNotice).toContain('尚未执行删除'); expect(port.deleteSession).not.toHaveBeenCalled();
  });
  it('export, generation, save and unsaved prose each block deletion at the owner', async () => {
    const exportGate = deferred<{ absolutePath: string; byteLength: number }>();
    const { owner, port, execution } = await setup({ exportMarkdown: () => exportGate.promise });
    const exporting = owner.exportSelectedStory(); await owner.requestDeleteSession();
    expect(owner.getSnapshot().deletion).toBeNull(); exportGate.resolve({ absolutePath: '/fixture/file.md', byteLength: 1 }); await exporting;
    const prepareGate = deferred<void>(), savingGate = deferred<void>(); port.beforeEnd = () => savingGate.promise;
    const generating = owner.continue('', async run => { await prepareGate.promise; await execution.prepare(run); });
    await owner.requestDeleteSession(); expect(owner.getSnapshot().deletion).toBeNull();
    prepareGate.resolve(); await vi.waitFor(() => expect(owner.getSnapshot().saving).toBe(true));
    await owner.requestDeleteSession(); expect(owner.getSnapshot().deletion).toBeNull();
    savingGate.resolve(); await generating;
    port.beforeEnd = undefined; port.failBegin = true; await owner.continue('', execution.prepare);
    expect(owner.getSnapshot().pending).not.toBeNull(); await owner.requestDeleteSession();
    expect(owner.getSnapshot().deletion).toBeNull(); expect(port.deleteSession).not.toHaveBeenCalled();
  });
  it('changing account does not remove device deletion authority or rebind the frozen target', async () => {
    const { owner, port, execution } = await setup(); const head = owner.getSnapshot().active!;
    await owner.requestDeleteSession(); owner.setExecutionScope('signed-out'); await owner.confirmDeleteSession();
    expect(port.deleteSession.mock.calls[0]?.[0].session.sessionId).toBe(head.id);
    expect(owner.getSnapshot().active).toBeNull(); expect(execution.requests).toHaveLength(1);
  });
  it('leaving during descriptor read invalidates only the in-memory confirmation and cannot dispatch a late delete', async () => {
    const { owner, port } = await setup(); const gate = deferred<void>();
    port.beforeDescribe = async (_id, kind) => { if (kind === 'session') await gate.promise; };
    const preparing = owner.requestDeleteSession(); owner.detach(); gate.resolve(); await preparing;
    expect(owner.getSnapshot().deletion).toBeNull(); await owner.confirmDeleteSession(); expect(port.deleteSession).not.toHaveBeenCalled();
  });
  it('detaching cannot release an in-flight deletion or authorize a second dispatch', async () => {
    const { owner, port, execution } = await setup(); await owner.requestDeleteSession();
    const gate = deferred<void>(); port.beforeDelete = () => gate.promise;
    const deleting = owner.confirmDeleteSession(); owner.detach();
    await owner.requestDeleteSession(); await owner.confirmDeleteSession(); await owner.continue('', execution.prepare);
    expect(port.deleteSession).toHaveBeenCalledTimes(1); expect(owner.isBusy()).toBe(true); expect(execution.requests).toHaveLength(1);
    gate.resolve(); await deleting; expect(owner.getSnapshot().deletion).toBeNull(); expect(owner.isBusy()).toBe(false);
  });
  it('closing and detaching unknown retain A observation and block A before reading or consuming another model', async () => {
    const { owner, port, execution } = await setup(); const first = owner.getSnapshot().active!;
    await owner.requestDeleteSession(); port.deleteSession.mockRejectedValueOnce(new Error('transport unknown')); await owner.confirmDeleteSession();
    owner.cancelDeleteSession(); owner.detach();
    expect(owner.getSnapshot().deletion).toMatchObject({ phase: 'unknown', dialogOpen: false, target: { sessionId: first.id } });
    expect(owner.isBusy()).toBe(false);
    await owner.selectSession(first); port.continueState.mockClear(); const prepare = vi.fn(execution.prepare);
    await owner.continue('', prepare); await owner.requestDeleteSession(); await owner.confirmDeleteSession();
    expect(prepare).not.toHaveBeenCalled(); expect(port.continueState).not.toHaveBeenCalled(); expect(execution.requests).toHaveLength(1);
    expect(port.deleteSession).toHaveBeenCalledTimes(1); expect(owner.deleteSessionDisabledReason()).toContain('只读核对上一个删除');
    await owner.observeDeleteSession(); expect(owner.getSnapshot().deletion).toBeNull();
    await owner.continue('', prepare); expect(execution.requests).toHaveLength(2);
  });
  it('unknown A allows B continuation, save, export and a new story while fencing a second deletion', async () => {
    const { owner, port, execution, exportMarkdown } = await setup(); const first = owner.getSnapshot().active!;
    await owner.start({ draft: storyDraft(), product: 'battle' }, execution.prepare); const second = owner.getSnapshot().active!;
    await owner.selectSession(first); await owner.requestDeleteSession(); port.loseDeleteReply = true; await owner.confirmDeleteSession(); owner.cancelDeleteSession();
    await owner.selectSession(second); expect(owner.hasUnconfirmedDeletion()).toBe(false); expect(owner.isBusy()).toBe(false);
    await owner.continue('B is independent', execution.prepare);
    expect(owner.getSnapshot()).toMatchObject({ resultSaved: true, active: { id: second.id, chapterCount: 2 }, deletion: { phase: 'unknown', dialogOpen: false, target: { sessionId: first.id } } });
    await owner.exportSelectedStory(); expect(exportMarkdown.mock.calls.at(-1)?.[0].id).toBe(second.id);
    await owner.requestDeleteSession(); expect(owner.getSnapshot().deletionNotice).toContain('先只读核对上一个删除'); expect(port.deleteSession).toHaveBeenCalledTimes(1);
    await owner.start({ draft: storyDraft(), product: 'battle' }, execution.prepare);
    expect(owner.getSnapshot().resultSaved).toBe(true); expect(owner.getSnapshot().active?.id).not.toBe(second.id);
    expect(owner.getSnapshot().deletion?.target.sessionId).toBe(first.id); expect(execution.requests).toHaveLength(4);
  });
  it('late A absence observation neither clears B selection nor overwrites its current save message', async () => {
    const { owner, port, execution } = await setup(); const first = owner.getSnapshot().active!;
    await owner.start({ draft: storyDraft(), product: 'battle' }, execution.prepare); const second = owner.getSnapshot().active!;
    await owner.selectSession(first); await owner.requestDeleteSession(); port.loseDeleteReply = true; await owner.confirmDeleteSession(); owner.cancelDeleteSession();
    const observedGate = deferred<void>(); port.beforeDescribe = async (sessionId, kind) => { if (sessionId === first.id && kind === 'session') await observedGate.promise; };
    const observing = owner.observeDeleteSession(); await owner.observeDeleteSession();
    await owner.selectSession(second); const saveGate = deferred<void>(); port.beforeEnd = () => saveGate.promise;
    const generating = owner.continue('', execution.prepare); await vi.waitFor(() => expect(owner.getSnapshot().saving).toBe(true));
    const message = owner.getSnapshot().message, prose = owner.getSnapshot().result;
    observedGate.resolve(); await observing;
    expect(owner.getSnapshot()).toMatchObject({ active: { id: second.id }, saving: true, message, result: prose, deletion: null });
    expect(owner.getSnapshot().deletionNotice).toContain('目前已确认');
    saveGate.resolve(); await generating; expect(owner.getSnapshot()).toMatchObject({ resultSaved: true, active: { id: second.id, chapterCount: 2 } });
    expect(port.deleteSession).toHaveBeenCalledTimes(1); expect(execution.requests).toHaveLength(3);
  });
  it('A observation cannot invalidate a newer start waiting to select its newly saved story', async () => {
    const { owner, port, execution } = await setup(); const first = owner.getSnapshot().active!;
    await owner.requestDeleteSession(); port.loseDeleteReply = true; await owner.confirmDeleteSession(); owner.cancelDeleteSession();
    const observedGate = deferred<void>(); port.beforeDescribe = async (sessionId, kind) => { if (sessionId === first.id && kind === 'session') await observedGate.promise; };
    const observing = owner.observeDeleteSession(); const saveGate = deferred<void>(); port.beforeEnd = () => saveGate.promise;
    const generating = owner.start({ draft: storyDraft(), product: 'battle' }, execution.prepare);
    await vi.waitFor(() => expect(owner.getSnapshot().saving).toBe(true)); observedGate.resolve(); await observing;
    expect(owner.getSnapshot()).toMatchObject({ active: null, chapters: [], selected: { status: 'unloaded' } });
    saveGate.resolve(); await generating;
    expect(owner.getSnapshot().resultSaved).toBe(true); expect(owner.getSnapshot().active?.id).not.toBe(first.id);
    expect(owner.getSnapshot().active).not.toBeNull(); expect(owner.getSnapshot().savedUnread).toBeNull();
    expect(execution.requests).toHaveLength(2); expect(port.deleteSession).toHaveBeenCalledTimes(1);
  });
  it.each(['failed', 'cancelled'] as const)('observed-absent A cannot remain cached when the newer start is %s', async status => {
    const { owner, port } = await setup(); const first = owner.getSnapshot().active!;
    await owner.requestDeleteSession(); port.loseDeleteReply = true; await owner.confirmDeleteSession(); owner.cancelDeleteSession();
    const modelGate = deferred<void>();
    const execution = storyExecution(undefined, async () => { await modelGate.promise; if (status === 'failed') throw new Error('fixture model failed'); });
    const generating = owner.start({ draft: storyDraft(), product: 'battle' }, execution.prepare);
    await vi.waitFor(() => expect(owner.getSnapshot().phase).toBe('generating'));
    await owner.observeDeleteSession();
    expect(owner.getSnapshot()).toMatchObject({ active: null, chapters: [], deletion: null, selected: { status: 'unloaded' } });
    if (status === 'cancelled') owner.cancel();
    modelGate.resolve(); await generating;
    expect(owner.getSnapshot()).toMatchObject({ phase: status, active: null, chapters: [], deletion: null, selected: { status: 'unloaded' } });
    expect(port.heads()).toHaveLength(0); expect(port.deleteSession).toHaveBeenCalledTimes(1);
    expect(execution.requests).toHaveLength(1); expect(owner.getSnapshot().result?.rawText).toContain('甲与乙');
    expect(owner.getSnapshot().deletionNotice).toContain('目前已确认'); expect(owner.getSnapshot().active?.id).not.toBe(first.id);
  });
  it('closing a pending read keeps unknown closed after read failure without releasing its A fence', async () => {
    const { owner, port, execution } = await setup(); const first = owner.getSnapshot().active!;
    await owner.requestDeleteSession(); port.deleteSession.mockRejectedValueOnce(new Error('unknown')); await owner.confirmDeleteSession();
    const gate = deferred<void>(); port.beforeDescribe = async () => { await gate.promise; throw new Error('read unavailable'); };
    const observing = owner.observeDeleteSession(); owner.cancelDeleteSession(); gate.resolve(); await observing;
    expect(owner.getSnapshot().deletion).toMatchObject({ phase: 'unknown', dialogOpen: false, target: { sessionId: first.id } });
    expect(owner.isBusy()).toBe(false); await owner.continue('', execution.prepare); expect(execution.requests).toHaveLength(1);
    owner.dispose(); await owner.observeDeleteSession(); await owner.confirmDeleteSession(); expect(port.deleteSession).toHaveBeenCalledTimes(1);
  });
  it('the other product pending slot fences the same story without consuming or changing the candidate', async () => {
    const fixture = new HostedStoryFixture(); let serial = 0;
    const make = (product: 'battle' | 'arena') => {
      const owner = new DesktopArenaStorySession({ port: createIpcStoryNativePort(fixture.invoke), id: () => `fixture-slot-${++serial}`, now: () => 200,
        exportMarkdown: async () => ({ absolutePath: '/fixture/story.md', byteLength: 1 }),
        hosted: { product, port: fixture.port, sink: fixture.sink, storage: fixture.storage, invoke: fixture.invoke, now: () => 200,
          createChannel: () => ({ onmessage: () => undefined }), wait: async () => undefined, maxReconnectAttempts: 0 } });
      owners.push(owner); owner.setExecutionScope('anonymous', { kind: 'anonymous' }); return owner;
    };
    const battle = make('battle'), arena = make('arena'), draft = storyDraft();
    draft.settings.writeArenaHistory = true; draft.settings.writeCurrentState = true;
    await battle.start({ draft, product: 'battle' }, async run => run(fixture.target()));
    expect(battle.getSnapshot().resultSaved, JSON.stringify(battle.getSnapshot())).toBe(true);
    await arena.initialize(); fixture.roleMode = 'network'; await arena.continue('', async run => run(fixture.target()));
    expect(arena.getSnapshot().hosted?.active?.manifest.sessionId).toBe(battle.getSnapshot().active?.id);
    await battle.hosted!.discover(); const snapshot = structuredClone(fixture.slots.get('arena')!.snapshot), trace = fixture.trace.length;
    await battle.requestDeleteSession();
    expect(battle.getSnapshot().deletion).toBeNull(); expect(battle.getSnapshot().deletionNotice).toContain('另一故事页');
    expect(fixture.records.deleteSession).not.toHaveBeenCalled(); expect(fixture.trace).toHaveLength(trace);
    expect(fixture.slots.get('arena')!.snapshot).toEqual(snapshot);
  });
});
