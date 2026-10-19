// @vitest-environment jsdom
/** Real shared pending/directory views + owners + TS Native binders. The peer is
 * synthetic: this is not Windows/Tauri, a file-dialog or paid-model verification. */
import { TextEncoder as NodeTextEncoder } from 'node:util';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryPendingManifest } from '@mahoshojo/contracts/desktop-arena-story';
import { DesktopArenaStoryControls } from '../src/features/arena/story-controls';
import { DesktopArenaStorySession, type PrepareStoryExecution } from '../src/features/arena/story-session';
import { createIpcStoryNativePort } from '../src/platform/arena-story-native';
import { STORY_PENDING_IPC } from '../src/platform/arena-story-pending-native';
import { ARENA_HOSTED_RECOVERY_KEYS } from '../src/features/arena/hosted-recovery';
import { deferred, installStoryCrypto, storyDraft, storyExecution } from './helpers/story-fixture';
import { HostedStoryFixture, type HostedStoryFixtureProduct } from './helpers/hosted-story-fixture';

installStoryCrypto();
let root: Root, container: HTMLDivElement;
const owners: DesktopArenaStorySession[] = [];
const button = (text: string) => [...container.querySelectorAll('button')].find(node => node.textContent === text);
const click = async (text: string) => { expect(button(text), text).toBeTruthy(); expect(button(text)!.disabled, text).toBe(false); await act(async () => { button(text)!.click(); }); };
const createCount = (fixture: HostedStoryFixture) => fixture.streams.filter(request => request.operation === 'create-story-stream').length;
const roleCount = (fixture: HostedStoryFixture) => fixture.streams.filter(request => request.operation === 'reconcile-story').length;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom uses a different Uint8Array realm from Node's TextEncoder. A browser
  // encoder returns its own realm's bytes, as required by the real IPC guards.
  vi.stubGlobal('TextEncoder', class extends NodeTextEncoder { encode(input?: string) { return Uint8Array.from(super.encode(input)); } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  HTMLElement.prototype.scrollIntoView = vi.fn(); vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('UI fixture must not reach a network'); });
});
afterEach(() => { act(() => root.unmount()); for (const owner of owners.splice(0)) owner.dispose(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const makeOwner = (fixture: HostedStoryFixture, product: HostedStoryFixtureProduct = 'battle') => {
  let id = 0;
  const owner = new DesktopArenaStorySession({ port: createIpcStoryNativePort(fixture.invoke), id: () => `ui-${product}-${++id}`, now: () => 200,
    exportMarkdown: async () => ({ absolutePath: '/fixture/story.md', byteLength: 1 }),
    hosted: { product, port: fixture.port, sink: fixture.sink, storage: fixture.storage, invoke: fixture.invoke,
      createChannel: () => ({ onmessage: () => undefined }), wait: async () => undefined, maxReconnectAttempts: 0 } });
  owner.setExecutionScope('anonymous', { kind: 'anonymous' }); owners.push(owner); return owner;
};
const mount = async (fixture = new HostedStoryFixture(), product: HostedStoryFixtureProduct = 'battle', providedOwner?: DesktopArenaStorySession) => {
  const owner = providedOwner ?? makeOwner(fixture, product), draft = storyDraft(), download = vi.fn(), navigate = vi.fn();
  draft.settings.writeArenaHistory = true; draft.settings.writeCurrentState = true;
  const prepare: PrepareStoryExecution = async run => run(fixture.target());
  let generation = Promise.resolve();
  await act(async () => {
    root.render(<DesktopArenaStoryControls owner={owner} product={product} draft={draft} disabled={false} unavailableReason={null}
      onNavigateStoryProduct={navigate} onStart={chapterPlan => { generation = owner.start({ draft, product, chapterPlan }, prepare); }}
      onContinue={guidance => { generation = owner.continue(guidance, prepare); }} download={download} onNavigateExternal={() => {}} />);
    await owner.initialize();
  });
  return { fixture, owner, draft, download, navigate, settle: () => act(async () => { await generation; }) };
};
const generatePending = async (fixture: HostedStoryFixture, product: HostedStoryFixtureProduct = 'battle') => {
  const owner = makeOwner(fixture, product), draft = storyDraft(); draft.settings.writeArenaHistory = true; draft.settings.writeCurrentState = true;
  await owner.start({ draft, product }, async run => run(fixture.target())); return owner;
};

describe('Hosted story controlled pending surface', () => {
  it('double-click recovery acquires one original-request flight before delayed Native discovery', async () => {
    const fixture = new HostedStoryFixture(); fixture.roleMode = 'network'; await generatePending(fixture);
    const { owner } = await mount(fixture); await click('读取原件（本地）');
    const gate = deferred<void>(), entered = deferred<void>(), original = fixture.port.describe.bind(fixture.port);
    vi.spyOn(fixture.port, 'describe').mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; return original(...args); });
    await act(async () => { button('恢复原请求')!.click(); button('恢复原请求')!.click(); await entered.promise; });
    expect(owner.getSnapshot().hosted?.busy).toBe('reading');
    await act(async () => { gate.resolve(); await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    expect(fixture.controls.filter(request => request.operation === 'lookup-request')).toHaveLength(1);
    expect(fixture.streams.filter(request => request.operation === 'resume')).toHaveLength(1);
    expect(createCount(fixture)).toBe(1); expect(roleCount(fixture)).toBe(1);
  });
  it.each(['account', 'detach'] as const)('recovery discovery invalidated by %s does not start lookup or replay', async change => {
    const fixture = new HostedStoryFixture(); fixture.roleMode = 'network'; await generatePending(fixture);
    const { owner } = await mount(fixture); await click('读取原件（本地）');
    const gate = deferred<void>(), entered = deferred<void>(), original = fixture.port.describe.bind(fixture.port);
    vi.spyOn(fixture.port, 'describe').mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; return original(...args); });
    let run: Promise<void> = Promise.resolve();
    await act(async () => { run = owner.hosted!.recover(); await entered.promise; });
    await act(async () => {
      if (change === 'account') owner.setExecutionScope('account-8', { kind: 'account', expectedUserId: 8 }); else owner.detach();
      gate.resolve(); await run;
    });
    expect(owner.getSnapshot().hosted?.busy).toBe(null);
    expect(fixture.controls.filter(request => request.operation === 'lookup-request')).toHaveLength(0);
    expect(fixture.streams.filter(request => request.operation === 'resume')).toHaveLength(0);
    expect(createCount(fixture)).toBe(1); expect(roleCount(fixture)).toBe(1);
  });

  it('completed original seal retry restores explicit unresolved role controls without an automatic role request', async () => {
    const fixture = new HostedStoryFixture(); fixture.failSeal = manifest => manifest.modelCompleted;
    const { owner, settle } = await mount(fixture); await click('新建连续战报'); await settle();
    expect(owner.getSnapshot().hosted?.outputDurable).toBe(false);
    fixture.failSeal = null; await click('重试原件本地封存');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    expect(owner.getSnapshot().hosted).toMatchObject({ outputDurable: true, hydrated: true, role: { status: 'unresolved' } });
    expect(button('重试角色同步')?.disabled).toBe(false);
    expect(button('保留旧角色保存本章')?.disabled).toBe(false);
    expect(roleCount(fixture)).toBe(0); expect(createCount(fixture)).toBe(1);
    await click('保留旧角色保存本章');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().resultSaved).toBe(true)); });
    expect(roleCount(fixture)).toBe(0); expect(createCount(fixture)).toBe(1);
    expect(fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(1);
    // 本地补封存后的成功提示不可由先前生成 phase 推断成错误。
    const savedMessage = owner.getSnapshot().message;
    expect(savedMessage).toBe('完整章节已保存到本机故事。');
    expect([...container.querySelectorAll('[role=status]')].some(node => node.textContent === savedMessage)).toBe(true);
    expect([...container.querySelectorAll('[role=alert]')].some(node => node.textContent === savedMessage)).toBe(false);
  });

  it.each(['battle', 'arena'] as const)('%s discovers both Native slots, reads locally and navigates the foreign product without recovery', async product => {
    const fixture = new HostedStoryFixture(); fixture.roleMode = 'network';
    await generatePending(fixture, 'battle'); await generatePending(fixture, 'arena');
    const { owner, navigate } = await mount(fixture, product);
    expect(container.querySelector('[aria-label="简洁版 /battle原候选"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="高级版 /arena原候选"]')).toBeTruthy();
    expect(button('恢复原请求')!.disabled).toBe(true); expect(button('新建连续战报')!.disabled).toBe(true);
    const streams = fixture.streams.length, writes = fixture.commands(STORY_PENDING_IPC.seal).length;
    await click('读取原件（本地）');
    expect(owner.getSnapshot().result?.markdown).toBe(fixture.markdown); expect(fixture.streams).toHaveLength(streams);
    expect(fixture.commands(STORY_PENDING_IPC.seal)).toHaveLength(writes); expect(button('恢复原请求')!.disabled).toBe(false);
    const other = product === 'battle' ? 'arena' : 'battle';
    await click(`前往${other === 'battle' ? '简洁版 /battle' : '高级版 /arena'}处理原候选`);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(other); expect(fixture.streams).toHaveLength(streams);
    expect(container.textContent).not.toContain('Hosted、分支、重写和删除暂未开放');
    expect(button('导出完整原始输出')).toBeUndefined(); expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('shows shared role choices after unknown, then retries only the original role request and saves', async () => {
    const fixture = new HostedStoryFixture(); fixture.roleMode = 'network';
    const { owner, settle } = await mount(fixture); await click('新建连续战报'); await settle();
    expect(container.querySelector('[data-story-pending-outcome]')).toBeTruthy();
    expect(owner.getSnapshot().hosted?.role?.status).toBe('unresolved');
    expect(button('重试角色同步')!.disabled).toBe(false); expect(button('保留旧角色保存本章')!.disabled).toBe(false);
    fixture.roleMode = 'accepted'; await click('重试角色同步');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().resultSaved).toBe(true)); });
    expect(createCount(fixture)).toBe(1); expect(roleCount(fixture)).toBe(2); expect(fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(1);
    expect(container.querySelector('[data-story-read-status="loaded"]')?.textContent).toContain('甲与乙保留原设定');
  });

  it('reoffers the explicit keep-original decision after its seal failed without a generic retry', async () => {
    const fixture = new HostedStoryFixture(); fixture.roleMode = 'network';
    const { owner, settle } = await mount(fixture); await click('新建连续战报'); await settle();
    fixture.failSeal = manifest => manifest.roleState === 'old-roles';
    await click('保留旧角色保存本章');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    expect(owner.getSnapshot().hosted?.role?.status).toBe('unresolved');
    expect(button('保留旧角色保存本章')!.disabled).toBe(false); expect(button('重试角色同步')!.disabled).toBe(true);
    expect(button('重试原件本地封存')).toBeUndefined(); expect(fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    fixture.failSeal = null; await click('保留旧角色保存本章');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().resultSaved).toBe(true)); });
    expect(createCount(fixture)).toBe(1); expect(roleCount(fixture)).toBe(1);
  });

  it('accepted response retains zero role affordances when only local commit sealing remains', async () => {
    const fixture = new HostedStoryFixture(); fixture.failSeal = manifest => !!manifest.commitManifest;
    const { owner, settle } = await mount(fixture); await click('新建连续战报'); await settle();
    expect(owner.getSnapshot().hosted?.role?.status).toBe('accepted');
    expect(button('重试角色同步')).toBeUndefined(); expect(button('保留旧角色保存本章')).toBeUndefined();
    fixture.failSeal = null; await click('重试原件本地封存');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().resultSaved).toBe(true)); });
    expect(roleCount(fixture)).toBe(1); expect(createCount(fixture)).toBe(1);
  });

  it('cannot reread away an accepted in-memory role response when its durable seal failed', async () => {
    const fixture = new HostedStoryFixture(); fixture.failSeal = manifest => manifest.roleState === 'accepted';
    const { owner, settle } = await mount(fixture); await click('新建连续战报'); await settle();
    expect(owner.getSnapshot().hosted?.role?.status).toBe('accepted');
    expect(button('读取原件（本地）')!.disabled).toBe(true); expect(button('重试角色同步')).toBeUndefined();
    fixture.failSeal = null; await click('重试原件本地封存');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().resultSaved).toBe(true)); });
    expect(roleCount(fixture)).toBe(1); expect(createCount(fixture)).toBe(1);
  });

  it('queries unknown saves after identity changes without preparing or saving again', async () => {
    const fixture = new HostedStoryFixture(); fixture.loseSaveReply = true; fixture.records.hideReceipts = true;
    const { owner, settle } = await mount(fixture); await click('新建连续战报'); await settle();
    expect(container.textContent).toContain('保存状态待确认'); expect(button('查询原保存回执')).toBeTruthy();
    const pending = container.querySelector('[data-story-pending-outcome]')!;
    expect(pending.querySelector('[role=status][aria-live=polite]')?.textContent).toContain('保存状态待确认');
    expect(pending.querySelector('.error-message[role=alert]')).toBeNull();
    expect(button('重试原本地保存')).toBeUndefined(); expect(button('重试角色同步')).toBeUndefined();
    await act(async () => owner.setExecutionScope('new-account', { kind: 'account', expectedUserId: 9 }));
    await click('查询原保存回执');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    expect(container.textContent).toContain('没有回执不代表未保存');
    fixture.records.hideReceipts = false; await click('查询原保存回执');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().resultSaved).toBe(true)); });
    expect(fixture.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(1); expect(fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(1);
    expect(createCount(fixture)).toBe(1); expect(roleCount(fixture)).toBe(1);
  });

  it('restored candidates are read-only and explicit replay cannot create, reconcile or save', async () => {
    const fixture = new HostedStoryFixture(); fixture.failPrepareSave = true;
    await generatePending(fixture); fixture.slots.get('battle')!.snapshot.restored = true;
    const { owner } = await mount(fixture); const before = fixture.trace.length;
    await click('读取原件（本地）');
    expect(button('请求服务器停止')).toBeUndefined();
    expect(container.textContent).toContain('这是备份恢复作品'); expect(button('查询原保存回执')).toBeTruthy();
    expect(button('重试角色同步')).toBeUndefined(); expect(button('保留旧角色保存本章')).toBeUndefined();
    expect(button('重试原本地保存')).toBeUndefined();
    await click('恢复原请求');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    const later = fixture.trace.slice(before);
    expect(later).not.toContain(STORY_PENDING_IPC.seal); expect(later).not.toContain(STORY_PENDING_IPC.prepareSave); expect(later).not.toContain(STORY_PENDING_IPC.save);
    expect(createCount(fixture)).toBe(1); expect(roleCount(fixture)).toBe(1);
    expect(fixture.streams.at(-1)?.operation).toBe('resume');
  });

  it('preserves an unsealed full body, distinguishes window export from input-only Native originals', async () => {
    const fixture = new HostedStoryFixture(); fixture.failSeal = manifest => manifest.modelCompleted;
    const { owner, download, settle } = await mount(fixture); await click('新建连续战报'); await settle();
    expect(owner.getSnapshot().hosted?.outputDurable).toBe(false); expect(owner.getSnapshot().result?.markdown).toBe(fixture.markdown);
    expect(container.textContent).toContain('当前窗口原文，尚未耐久封存');
    expect(button('读取原件（本地）')!.disabled).toBe(true); expect(button('导出已封存完整正文')).toBeUndefined();
    await click('导出当前窗口完整正文'); expect(download).toHaveBeenLastCalledWith('未保存章节.md', fixture.markdown, 'text/markdown;charset=utf-8');
    await click('导出当前窗口推理原文'); expect(download).toHaveBeenLastCalledWith('未封存推理原文.txt', fixture.reasoning, 'text/plain;charset=utf-8');
    await click('导出全部已封存原件');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    expect(fixture.exports).toHaveLength(2); expect(fixture.exports[0]!.source).toMatchObject({ scope: 'pending-part', kind: 'input' });
    expect(container.querySelectorAll('[aria-label="原件导出成功回执"] li')).toHaveLength(2);
    expect(container.textContent).toContain('尚未封存的最新窗口正文需另行导出'); expect(button('导出完整原始输出')).toBeUndefined();
    expect(fixture.commands(STORY_PENDING_IPC.abandon)).toHaveLength(0);
  });

  it.each(['failed', 'cancelled'] as const)('exports complete reasoning-only Hosted output after %s without using Direct JSON', async phase => {
    const fixture = new HostedStoryFixture(), gate = deferred<void>();
    const reasoning = '只有推理，正文为空。\n保留换行与 Unicode：雪𝌆\n';
    fixture.modelStep = async peer => {
      peer.response(); peer.event('1-0', 'reasoning', { chunk: reasoning });
      if (phase === 'cancelled') await gate.promise;
      peer.end();
    };
    const { owner, download, settle } = await mount(fixture); await click('新建连续战报');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().result?.reasoning).toBe(reasoning)); });
    if (phase === 'cancelled') { await click('请求服务器停止'); await act(async () => { gate.resolve(); }); }
    await settle();
    expect(owner.getSnapshot()).toMatchObject({ phase, result: { markdown: '', reasoning } });
    expect(owner.getSnapshot().hosted?.outputDurable).toBe(false);
    expect(container.textContent).toContain('正文与推理仅在当前窗口');
    expect(button('读取原件（本地）')!.disabled).toBe(true); expect(button('导出完整原始输出')).toBeUndefined();
    expect(button('导出当前窗口完整正文')).toBeUndefined();
    await click('导出当前窗口推理原文');
    expect(download).toHaveBeenCalledExactlyOnceWith('未封存推理原文.txt', reasoning, 'text/plain;charset=utf-8');
    await click('导出全部已封存原件');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    expect(fixture.exports).toHaveLength(2); expect(fixture.exports[0]!.source).toMatchObject({ scope: 'pending-part', kind: 'input' });
    expect(fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0); expect(fixture.commands(STORY_PENDING_IPC.abandon)).toHaveLength(0);
    expect(createCount(fixture)).toBe(1); expect(roleCount(fixture)).toBe(0);
  });

  it('keeps abandonment in two explicit stages with keep as the default, never auto-abandons after export', async () => {
    const fixture = new HostedStoryFixture(); fixture.roleMode = 'network';
    const { owner, settle } = await mount(fixture); await click('新建连续战报'); await settle();
    await click('放弃本机候选…');
    expect(document.activeElement).toBe(button('返回保留')); expect(fixture.commands(STORY_PENDING_IPC.abandon)).toHaveLength(0);
    expect(container.textContent).toContain('不会删除已保存章节或回执，也不保证服务器停止或退费');
    await click('返回保留'); expect(button('确认不导出并放弃本机候选')).toBeUndefined();
    await click('放弃本机候选…'); await click('先导出全部原件');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    expect(fixture.commands(STORY_PENDING_IPC.abandon)).toHaveLength(0); expect(button('已导出封存原件，确认放弃本机候选')).toBeTruthy();
    fixture.partialAbandon = true; await click('已导出封存原件，确认放弃本机候选');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    expect(button('继续清理原本机候选')).toBeTruthy(); expect(button('恢复原请求')!.disabled).toBe(true);
    fixture.partialAbandon = false; await click('继续清理原本机候选');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.active).toBe(null)); });
    expect(fixture.commands(STORY_PENDING_IPC.abandon)).toHaveLength(2); expect(fixture.slots.size).toBe(0); expect(fixture.controls).toHaveLength(0);
  });

  it('cancelled partial export shows only final success receipts and never releases the candidate', async () => {
    const fixture = new HostedStoryFixture(); fixture.roleMode = 'network';
    const { owner, settle } = await mount(fixture); await click('新建连续战报'); await settle();
    const gate = deferred<void>(), originalAdvance = fixture.sink.advance;
    vi.spyOn(fixture.sink, 'advance').mockImplementation(async (...args) => { if (fixture.exports.length === 1) await gate.promise; return originalAdvance(...args); });
    await click('导出全部已封存原件');
    await act(async () => { await vi.waitFor(() => expect(fixture.exports).toHaveLength(1)); });
    expect(button('取消原件导出')).toBeTruthy(); await click('取消原件导出');
    await act(async () => { gate.resolve(); await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    expect(container.querySelectorAll('[aria-label="原件导出成功回执"] li')).toHaveLength(1);
    expect(container.textContent).toContain('导出已取消'); expect(fixture.commands(STORY_PENDING_IPC.abandon)).toHaveLength(0); expect(fixture.slots.size).toBe(1);
  });

  it('offers exact local input-seal retry before any candidate is visible without creating a model request', async () => {
    const fixture = new HostedStoryFixture(); fixture.failSeal = manifest => manifest.pendingRevision === 1;
    const { owner, settle } = await mount(fixture); await click('新建连续战报'); await settle();
    expect(owner.getSnapshot().hosted?.active).toBe(null); expect(container.textContent).toContain('原输入封存未证实，尚未调用模型');
    expect(container.querySelector('[data-story-pending-outcome]')).toBeTruthy(); expect(button('新建连续战报')!.disabled).toBe(true);
    const begins = fixture.commands(STORY_PENDING_IPC.begin).length;
    fixture.failSeal = null; await click('查询或恢复原件封存');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    expect(fixture.commands(STORY_PENDING_IPC.begin)).toHaveLength(begins);
    expect(owner.getSnapshot().hosted?.active?.createClaim).toBe(null); expect(fixture.slots.size).toBe(1); expect(fixture.streams).toHaveLength(0);
    expect(button('恢复原请求')!.disabled).toBe(true); expect(button('导出全部已封存原件')!.disabled).toBe(false);
  });

  it('exports exact frozen input after begin lost its token without starting a new upload or model', async () => {
    const fixture = new HostedStoryFixture(), begin = fixture.port.begin;
    vi.spyOn(fixture.port, 'begin').mockImplementation(async manifest => { await begin(manifest); throw new Error('first upload acknowledgement lost'); });
    const { owner, download, settle } = await mount(fixture); await click('新建连续战报'); await settle();
    expect(owner.getSnapshot().hosted?.active).toBe(null); expect(owner.getSnapshot().hosted?.localRetry).toBe('seal');
    expect(container.textContent).toContain('无法安全重传或定位清理暂存上传');
    const begins = fixture.commands(STORY_PENDING_IPC.begin).length, original = await owner.hosted!.readWindowInputOriginal();
    expect(original).toBeTruthy();
    await click('导出当前窗口冻结输入');
    expect(download).toHaveBeenCalledExactlyOnceWith('未封存故事输入.json', original, 'application/json');
    const begun = fixture.commands(STORY_PENDING_IPC.begin)[0]![1] as { manifest: StoryPendingManifest };
    expect(JSON.parse(original!).generationRequestId).toBe(begun.manifest.requestId);
    expect(new TextEncoder().encode(original!).byteLength).toBe(begun.manifest.parts[0]!.byteLength);
    await click('查询或恢复原件封存');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    expect(fixture.commands(STORY_PENDING_IPC.begin)).toHaveLength(begins); expect(fixture.streams).toHaveLength(0);
    expect(fixture.commands(STORY_PENDING_IPC.abandon)).toHaveLength(0); expect(owner.getSnapshot().hosted?.active).toBe(null);
    expect(button('新建连续战报')!.disabled).toBe(true); expect(button('放弃本机候选…')).toBeUndefined();
  });

  it('reports a window input export failure and retains the original recovery actions', async () => {
    const fixture = new HostedStoryFixture(); fixture.failSeal = manifest => manifest.pendingRevision === 1;
    const { owner, download, settle } = await mount(fixture); await click('新建连续战报'); await settle();
    const message = 'original input digest mismatch\n保留原冻结输入';
    vi.spyOn(owner.hosted!, 'readWindowInputOriginal').mockRejectedValueOnce(new Error(message));
    const focused = button('刷新故事目录')!; focused.focus();
    await click('导出当前窗口冻结输入');
    const error = container.querySelector('[data-story-pending-outcome] .error-message[role="alert"]');
    expect(error?.textContent).toBe(message);
    expect(error?.querySelector('.whitespace-pre-wrap')?.textContent).toBe(message);
    expect(document.activeElement).toBe(focused); expect(focused.tabIndex).toBe(0);
    expect(download).not.toHaveBeenCalled(); expect(button('查询或恢复原件封存')!.disabled).toBe(false);
    expect(fixture.commands(STORY_PENDING_IPC.abandon)).toHaveLength(0); expect(fixture.streams).toHaveLength(0);
  });

  it('cold input-only candidates without claim can export locally, never recover or create', async () => {
    const fixture = new HostedStoryFixture(); fixture.failPointerWrite = true;
    await generatePending(fixture); fixture.failPointerWrite = false;
    const { owner } = await mount(fixture); await click('读取原件（本地）');
    expect(container.textContent).toContain('此候选没有创建 claim'); expect(button('恢复原请求')!.disabled).toBe(true);
    expect(button('新建连续战报')!.disabled).toBe(true); expect(button('重试角色同步')).toBeUndefined();
    await click('导出全部已封存原件');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    expect(fixture.exports).toHaveLength(2); expect(fixture.streams).toHaveLength(0);
  });

  it('an account change leaves local reading and exact original export available with role/replay fenced', async () => {
    const fixture = new HostedStoryFixture(); fixture.roleMode = 'network'; await generatePending(fixture);
    const { owner } = await mount(fixture);
    await act(async () => owner.setExecutionScope('account', { kind: 'account', expectedUserId: 9 }));
    await click('读取原件（本地）');
    expect(container.textContent).toContain('当前账号与原请求不一致');
    expect(button('恢复原请求')!.disabled).toBe(true); expect(button('重试角色同步')!.disabled).toBe(true);
    await click('导出已封存完整正文');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    expect(fixture.exports).toHaveLength(1); expect(new TextDecoder().decode(fixture.exports[0]!.bytes)).toBe(fixture.markdown);
    expect(createCount(fixture)).toBe(1); expect(roleCount(fixture)).toBe(1);
  });

  it('a corrupt original pointer is reported without replacing it or creating a new request', async () => {
    const fixture = new HostedStoryFixture(); fixture.roleMode = 'network'; await generatePending(fixture);
    const invalid = '{original unreadable pointer'; fixture.pointers.set(ARENA_HOSTED_RECOVERY_KEYS.battle, invalid);
    const { owner } = await mount(fixture); await click('读取原件（本地）'); const streams = fixture.streams.length;
    await click('恢复原请求');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    expect(owner.getSnapshot().hosted?.pointerError).toBeTruthy();
    expect([...container.querySelectorAll('.error-message[role=alert]')].some(node => node.textContent === `原恢复入口仍保留：${owner.getSnapshot().hosted?.pointerError}`)).toBe(true);
    expect(fixture.pointers.get(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBe(invalid); expect(fixture.streams).toHaveLength(streams);
    expect(button('导出全部已封存原件')!.disabled).toBe(false);
  });

  it('failed export retains the candidate and still requires the explicit no-export confirmation', async () => {
    const fixture = new HostedStoryFixture(); fixture.roleMode = 'network'; fixture.failExport = true;
    const { owner, settle } = await mount(fixture); await click('新建连续战报'); await settle();
    await click('放弃本机候选…'); await click('先导出全部原件');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe(null)); });
    expect(container.textContent).toContain('export disk full'); expect(fixture.commands(STORY_PENDING_IPC.abandon)).toHaveLength(0);
    expect(button('已导出封存原件，确认放弃本机候选')).toBeUndefined();
    await click('确认不导出并放弃本机候选');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.active).toBe(null)); });
    expect(fixture.commands(STORY_PENDING_IPC.abandon)).toHaveLength(1); expect(fixture.exports).toHaveLength(0);
  });

  it('foreign-retained cleanup keeps the original recovery-entry warning after the candidate disappears', async () => {
    const fixture = new HostedStoryFixture(); fixture.roleMode = 'network';
    const { owner, settle } = await mount(fixture); await click('新建连续战报'); await settle();
    const originalAbandon = fixture.port.abandon;
    vi.spyOn(fixture.port, 'abandon').mockImplementation(async request => ({ ...await originalAbandon(request) as object, flight: 'foreign-retained', secret: 'foreign-retained' }));
    await click('放弃本机候选…'); await click('确认不导出并放弃本机候选');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.active).toBe(null)); });
    expect(container.textContent).toContain('原单次恢复入口'); expect(container.textContent).toContain('不能保证本产品已可新建');
    expect(fixture.controls).toHaveLength(0);
  });

  it('model-time stop explicitly requests the server even after Channel end and before invoke settles', async () => {
    const fixture = new HostedStoryFixture(), gate = deferred<void>(); fixture.beforeModelSettles = () => gate.promise;
    const { owner, settle } = await mount(fixture); await click('新建连续战报');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe('model')); });
    expect(button('请求服务器停止')).toBeTruthy(); expect(button('停止章节生成')).toBeUndefined();
    expect(container.textContent).toContain('只会脱离本机订阅，不代表服务器停止');
    await click('请求服务器停止');
    await act(async () => { gate.resolve(); }); await settle();
    expect(fixture.controls.some(request => request.operation === 'stop')).toBe(true); expect(fixture.slots.size).toBe(1);
    expect(fixture.commands(STORY_PENDING_IPC.save)).toHaveLength(0); expect(fixture.commands(STORY_PENDING_IPC.abandon)).toHaveLength(0);
  });

  it('detaching during model work never asks the server to stop or discards the candidate', async () => {
    const fixture = new HostedStoryFixture(), gate = deferred<void>(); fixture.beforeModelSettles = () => gate.promise;
    const { owner, settle } = await mount(fixture); await click('新建连续战报');
    await act(async () => { await vi.waitFor(() => expect(owner.getSnapshot().hosted?.busy).toBe('model')); });
    await act(async () => owner.detach()); await act(async () => { gate.resolve(); }); await settle();
    expect(fixture.controls.filter(request => request.operation === 'stop')).toHaveLength(0);
    expect(fixture.slots.size).toBe(1); expect(fixture.commands(STORY_PENDING_IPC.abandon)).toHaveLength(0);
    expect(container.textContent).toContain('服务器可能仍在运行');
  });

  it('keeps Direct raw exports when a Hosted-capable owner executes Direct', async () => {
    const fixture = new HostedStoryFixture(), execution = storyExecution();
    const { owner, draft, download } = await mount(fixture);
    await act(async () => { await owner.start({ draft, product: 'battle' }, execution.prepare); });
    expect(owner.getSnapshot().resultSource).toBe('direct'); await click('导出完整原始输出');
    expect(JSON.parse(download.mock.calls.at(-1)![1]).rawText).toContain('甲与乙'); expect(fixture.streams).toHaveLength(0);
  });
});
