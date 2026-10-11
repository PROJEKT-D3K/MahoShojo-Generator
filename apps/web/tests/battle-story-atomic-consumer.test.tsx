// @vitest-environment jsdom

import React, { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBattleStorySession } from '@/components/arena/hooks/useBattleStorySession';
import * as storyHook from '@/components/arena/hooks/useBattleStorySession';
import { BattleStorySessionPanel } from '@/components/arena/components/BattleStorySessionPanel';
import { __resetAiSessionDbForTest } from '@/lib/ai-session/storage';
import { AI_SESSION_DB_NAME, AI_SESSION_STORE_NAMES } from '@/lib/ai-session/types';
import * as storage from '@/lib/ai-session/battle-story/storage';
import * as branchProjection from '@mahoshojo/domain/arena-story-branch';
import * as tailRewriteProjection from '@mahoshojo/domain/arena-story-tail-rewrite';
import { createGenerationApiIntentLatch, type GenerationApiIntentDependencies } from '@/lib/hono-api-client';
import { honoApiConfig } from '@/config/hono-api';
import { selectHostedDrPlacement } from '@/lib/hosted-dr/client-preflight';

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  acquire: vi.fn(),
  latchDependencies: null as GenerationApiIntentDependencies | null,
  startCooldown: vi.fn(),
  download: vi.fn(),
  authHeader: vi.fn(),
  activityHeaders: vi.fn(),
  state: {
    combatants: [{ type: 'magical-girl', data: { codename: '测试角色' }, isValid: true }],
    battleMode: 'daily', scenario: { content: null, fileName: '' }, userProviderConfig: null,
    auxScenarios: [], materials: [], selectedQuestionnaires: [], adjudicationEvents: [],
    selectedLanguage: 'zh-CN', storyLength: 'standard',
    settings: { userGuidance: '', writeArenaHistory: false, writeCurrentState: false },
  },
}));

vi.mock('@/components/arena/stores/useBattleStore', () => ({
  useBattleStore: Object.assign((selector: (state: typeof fixture.state) => unknown) => selector(fixture.state), {
    getState: () => fixture.state,
  }),
}));
vi.mock('@/components/arena/hooks/useBattleActions', () => ({
  useBattleActions: () => ({ handleResolveRandomPlaceholders: async () => {} }),
}));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({
  useGenerationApiIntentLatch: (dependencies: GenerationApiIntentDependencies) => { fixture.latchDependencies = dependencies; return { tryAcquire: fixture.acquire }; },
}));
vi.mock('@/lib/auth', () => ({ authStorage: {
  getAuthHeader: fixture.authHeader, getActivityHeaders: fixture.activityHeaders,
} }));
vi.mock('@/components/stream/StreamingBattleReportCard', () => ({ default: (props: { content: string }) => <article>{props.content}</article> }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: fixture.download }));
vi.mock('@/lib/cooldown', () => ({ getProviderCooldownNoticeText: () => null, useProviderModeCooldown: () => ({
  isCooldown: false, remainingTime: 0, otherRemainingTime: 0, startCooldown: fixture.startCooldown,
}) }));

const originalHonoConfig = { ...honoApiConfig };
let session: ReturnType<typeof useBattleStorySession>;
let container: HTMLDivElement;
let root: Root;
let stream: ReadableStreamDefaultController<Uint8Array>;
let requestSignal: AbortSignal;
const scroll = vi.fn();
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const send = (events: string) => stream.enqueue(new TextEncoder().encode(events));

// Match the Panel's live/selected content branch so a stale notification would
// visibly target the old chapter (or the empty first-chapter result container).
function Harness() {
  const value = useBattleStorySession();
  useLayoutEffect(() => { session = value; });
  return <div ref={value.resultSectionRef} data-testid="result">
    {value.isGenerating
      ? <article data-testid="live">{value.streamingMarkdown || '等待正文'}</article>
      : <article data-testid="saved">{value.pendingCompletedChapter?.markdown ?? value.selectedChapter?.markdown ?? ''}</article>}
  </div>;
}

async function mount() {
  await act(async () => root.render(<Harness />));
  await vi.waitFor(async () => { await act(async () => {}); expect(session.isReady).toBe(true); });
}

async function start() {
  let pending!: Promise<void>;
  await act(async () => { pending = session.handleStartSession(); });
  expect(fixture.dispatch).toHaveBeenCalled();
  expect(session.isGenerating).toBe(true);
  return { pending };
}

beforeEach(async () => {
  await __resetAiSessionDbForTest();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(AI_SESSION_DB_NAME);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
  fixture.dispatch.mockReset(); fixture.download.mockReset();
  fixture.acquire.mockReset().mockImplementation(() => ({ dispatch: fixture.dispatch }));
  fixture.authHeader.mockReset().mockResolvedValue(null); fixture.activityHeaders.mockReset().mockResolvedValue({});
  fixture.state.settings.writeArenaHistory = false; fixture.state.settings.writeCurrentState = false; fixture.state.settings.userGuidance = '';
  fixture.state.combatants = [{ type: 'magical-girl', data: { codename: '测试角色' }, isValid: true }];
  localStorage.clear(); scroll.mockClear();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 2000 } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  fixture.dispatch.mockImplementation(async (_url: string, init: RequestInit) => {
    requestSignal = init.signal as AbortSignal;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      stream = controller;
      requestSignal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  Object.assign(honoApiConfig, originalHonoConfig);
  await __resetAiSessionDbForTest();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});


function installRealLatch(extra: GenerationApiIntentDependencies = {}) {
  honoApiConfig.enabled = false; honoApiConfig.routingMode = 'static-next';
  const onSettled = vi.fn();
  const latch = createGenerationApiIntentLatch({ ...fixture.latchDependencies!, observe: vi.fn(), ...extra, onSettled });
  fixture.acquire.mockImplementation(() => latch.tryAcquire());
  return { onSettled };
}

async function finish(pending: Promise<void>, markdown = '# 完成章\n正文') {
  await act(async () => { send(event('markdown', { chunk: markdown }) + event('done', { ok: true })); stream.close(); await pending; });
}

it('normal first anonymous header initialization still dispatches one generation and saves', async () => {
  expect(localStorage.getItem('mahoshojo_auth')).toBeNull();
  expect(localStorage.getItem('mahoshojo:arena:generation-actor:v1')).toBeNull();
  await mount(); const { pending } = await start(); await finish(pending, '# 匿名首章');
  const headers = new Headers(fixture.dispatch.mock.calls[0]![1].headers);
  expect(headers.has('Authorization')).toBe(false);
  expect(headers.get('X-Mahoshojo-Generation-Actor-Token')).toMatch(/^bootstrap\./u);
  expect(session.selectedChapter?.markdown).toBe('# 匿名首章');
  expect(fixture.dispatch).toHaveBeenCalledTimes(1);
});

describe('real story hook + IndexedDB completed result persistence', () => {
  it('首章事务 abort 后保留全部生成结果，原包本地重试，模型仅调用一次', async () => {
    await mount();
    const original = IDBObjectStore.prototype.add;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args) {
      const request = original.apply(this, args);
      if (this.name === AI_SESSION_STORE_NAMES.battleStoryCheckpoints) request.addEventListener('success', () => { try { this.transaction.abort(); } catch { /* already aborted */ } });
      return request;
    });
    const { pending } = await start(); await finish(pending, '# 完整原文\n角色后果与正文');
    expect(session.pendingCompletedChapter?.markdown).toBe('# 完整原文\n角色后果与正文');
    await act(async () => session.handleExportPendingChapter());
    const blob = fixture.download.mock.calls[0]![0] as Blob;
    const exported = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
    expect(exported).toBe('# 完整原文\n角色后果与正文');
    const chapterId = session.pendingCompletedChapter!.id;
    expect(await storage.listBattleStorySessions()).toHaveLength(0);
    expect(await storage.getBattleStoryChapter(chapterId)).toBeNull();
    await act(async () => { await session.handleStartSession(); await session.handleContinueSession(); });
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    fault.mockRestore();
    await act(async () => session.handleRetrySaveChapter());
    expect(session.pendingCompletedChapter).toBeNull();
    expect(session.selectedChapter?.id).toBe(chapterId);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(await storage.listBattleStoryCheckpointsBySession(session.activeSession!.id)).toHaveLength(2);
  });
  it('事务已提交但调用者丢回执：先查固定 operation，不二次保存或重模型', async () => {
    await mount();
    const original = storage.commitCompletedBattleStoryChapter;
    const save = vi.spyOn(storage, 'commitCompletedBattleStoryChapter').mockImplementationOnce(async (commit) => {
      await original(commit); throw new Error('synthetic lost reply');
    });
    const { pending } = await start(); await finish(pending);
    expect(session.pendingCompletedChapter).not.toBeNull();
    const id = session.pendingCompletedChapter!.id;
    expect(await storage.getBattleStoryOperationReceipt(id)).not.toBeNull();
    await act(async () => session.handleRetrySaveChapter());
    expect(save).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(session.pendingCompletedChapter).toBeNull();
    expect(session.selectedChapter?.id).toBe(id);
  });
  it('continue 与旧 summary 跨 tab 冲突保持旧 head，失败正文能导出或显式丢弃', async () => {
    await mount(); const first = await start(); await finish(first.pending, '# 第一章\n旧正文');
    const originalSession = session.activeSession!;
    let pending!: Promise<void>;
    await act(async () => { pending = session.handleContinueSession(); });
    await storage.updateBattleStorySession(originalSession.id, (current) => ({ ...current, sessionSummary: '另一标签更新的摘要' }));
    await finish(pending, '# 第二章\n保留失败正文');
    expect(session.pendingCompletedChapter?.markdown).toContain('保留失败正文');
    expect((await storage.getBattleStorySession(originalSession.id))?.lastChapterId).toBe(originalSession.lastChapterId);
    expect(await storage.listBattleStoryChaptersBySession(originalSession.id)).toHaveLength(1);
    await act(async () => session.handleRetrySaveChapter());
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    expect(session.pendingCompletedChapter).not.toBeNull();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => session.handleDiscardPendingChapter());
    expect(session.pendingCompletedChapter).not.toBeNull();
    confirm.mockReturnValue(true);
    await act(async () => session.handleDiscardPendingChapter());
    expect(session.pendingCompletedChapter).toBeNull();
    expect((await storage.getBattleStorySession(originalSession.id))?.sessionSummary).toBe('另一标签更新的摘要');
  });
  it('同步双击以及生成结束后的保存窗口均不可重入', async () => {
    await mount();
    let resolveSave!: () => void;
    const gate = new Promise<void>((resolve) => { resolveSave = resolve; });
    const original = storage.commitCompletedBattleStoryChapter;
    vi.spyOn(storage, 'commitCompletedBattleStoryChapter').mockImplementationOnce(async (commit) => { await gate; return original(commit); });
    let pending!: Promise<void>;
    await act(async () => { pending = session.handleStartSession(); void session.handleStartSession(); });
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    await act(async () => { send(event('markdown', { chunk: '# 首章' }) + event('done', { ok: true })); stream.close(); });
    expect(session.isGenerating).toBe(false); expect(session.isSavingChapter).toBe(true);
    await act(async () => { await session.handleStartSession(); await session.handleBranchSession(); await session.handleRewriteLastChapter(); });
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    await act(async () => { resolveSave(); await pending; });
    expect(session.pendingCompletedChapter).toBeNull();
  });
  it('用户取消不会生成 pending 或任何章节记录', async () => {
    await mount(); const { pending } = await start();
    await act(async () => { send(event('markdown', { chunk: '未完成' })); await Promise.resolve(); session.stopGeneration(); await pending; });
    expect(session.pendingCompletedChapter).toBeNull();
    expect(await storage.listBattleStorySessions()).toHaveLength(0);
  });
  it('首章提交结果不明且另一 tab 已删除：重试零复活，只有明确另存才新建身份且零重模型', async () => {
    await mount();
    const original = storage.commitCompletedBattleStoryChapter;
    vi.spyOn(storage, 'commitCompletedBattleStoryChapter').mockImplementationOnce(async (commit) => { await original(commit); throw new Error('lost receipt'); });
    const { pending } = await start(); await finish(pending, '# 保留首章\n全部正文');
    const oldChapter = session.pendingCompletedChapter!;
    await storage.deleteBattleStorySession(oldChapter.sessionId);
    expect(await storage.getBattleStoryOperationReceipt(oldChapter.id)).toBeNull();
    await act(async () => session.handleRetrySaveChapter());
    expect(await storage.listBattleStorySessions()).toEqual([]);
    expect(session.pendingSaveAsNewSession).toBe(true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => session.handleSavePendingAsNewSession());
    expect(await storage.listBattleStorySessions()).toEqual([]);
    confirm.mockReturnValue(true);
    await act(async () => session.handleSavePendingAsNewSession());
    expect(session.pendingCompletedChapter).toBeNull();
    expect(session.activeSession!.id).not.toBe(oldChapter.sessionId);
    expect(session.selectedChapter!.id).not.toBe(oldChapter.id);
    expect(session.selectedChapter!.markdown).toBe(oldChapter.markdown);
    expect(session.selectedChapter!.reportJson).toEqual(oldChapter.reportJson);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(await storage.getBattleStorySession(oldChapter.sessionId)).toBeNull();
  });
  it('冻结的是生成前独立输入，不能冻结或污染 arena 草稿', async () => {
    await mount(); const { pending } = await start();
    fixture.state.combatants[0]!.data.codename = '生成途中新改的名字';
    await finish(pending);
    expect(Object.isFrozen(fixture.state.combatants[0]!.data)).toBe(false);
    expect(Object.isFrozen(fixture.state.materials)).toBe(false);
    expect(Object.isFrozen(fixture.state.adjudicationEvents)).toBe(false);
    expect((session.activeSession!.seed.combatants[0] as { data: { codename: string } }).data.codename).toBe('测试角色');
    fixture.state.combatants[0]!.data.codename = '完成后仍可编辑';
    expect((await storage.getBattleStorySession(session.activeSession!.id))!.seed.combatants).toEqual(session.activeSession!.seed.combatants);
  });
  it('保存成功但随后读取失败准确提示并可只重读，不丢失已存章或重模型', async () => {
    const original = storage.listBattleStorySessions;
    let fail = false;
    vi.spyOn(storage, 'listBattleStorySessions').mockImplementation(async (...args) => { if (fail) throw new Error('read failed'); return original(...args); });
    await mount(); const { pending } = await start(); fail = true; await finish(pending);
    expect(await original()).toHaveLength(1);
    expect(session.pendingCompletedChapter).toBeNull();
    expect(session.actionError).toContain('本章已保存');
    expect(session.hasUnreadSavedChapter).toBe(true);
    fail = false;
    await act(async () => session.handleReloadSavedChapter());
    expect(session.selectedChapter?.markdown).toBe('# 完成章\n正文');
    expect(session.hasUnreadSavedChapter).toBe(false);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });
  it('summary 迟到只更新匹配会话，不把用户从第一章跳回最新章', async () => {
    let resolveSummary!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveSummary = resolve; });
    const fetch = vi.fn(() => response); vi.stubGlobal('fetch', fetch);
    await mount(); const first = await start(); await finish(first.pending, '# 第1章');
    const firstChapter = session.selectedChapter!.id;
    for (const index of [2, 3]) {
      let pending!: Promise<void>;
      await act(async () => { pending = session.handleContinueSession(); });
      await finish(pending, `# 第${index}章`);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => session.setSelectedChapterId(firstChapter));
    await act(async () => resolveSummary(new Response(JSON.stringify({ summary: '完整摘要', fallback: true }), { status: 200 })));
    await vi.waitFor(async () => { await act(async () => {}); expect(session.isRefreshingSummary).toBe(false); });
    expect(session.activeSession?.sessionSummary).toBe('完整摘要');
    expect(session.selectedChapter?.id).toBe(firstChapter);
    expect(fixture.dispatch).toHaveBeenCalledTimes(3);
  });
  it('已完成正文的服务端章节位置异常仍可保文导出，不默默重模型', async () => {
    await mount(); const { pending } = await start();
    await act(async () => { send(event('session_meta', { chapterIndex: 9 })); });
    await finish(pending, '# 完整但位置错误\n原文');
    expect(session.pendingCompletedChapter?.markdown).toContain('完整但位置错误');
    expect(await storage.listBattleStorySessions()).toEqual([]);
    await act(async () => session.handleExportPendingChapter());
    expect(fixture.download).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it('已知 abort 后的本地重试若丢回执，必须升级为未知，不能在删除后再次复活', async () => {
    await mount();
    const original = storage.commitCompletedBattleStoryChapter;
    vi.spyOn(storage, 'commitCompletedBattleStoryChapter')
      .mockRejectedValueOnce(new storage.BattleStoryCommitNotSavedError(new Error('known preflight fault')))
      .mockImplementationOnce(async (commit) => { await original(commit); throw new Error('retry lost receipt'); });
    const { pending } = await start(); await finish(pending);
    const old = session.pendingCompletedChapter!;
    await act(async () => session.handleRetrySaveChapter());
    expect(await storage.getBattleStoryOperationReceipt(old.id)).not.toBeNull();
    await storage.deleteBattleStorySession(old.sessionId);
    await act(async () => session.handleRetrySaveChapter());
    expect(await storage.getBattleStorySession(old.sessionId)).toBeNull();
    expect(session.pendingSaveAsNewSession).toBe(true);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it('receipt mismatch 仅查询冲突，不能把历史 unknown 降回可安全重写', async () => {
    await mount();
    const original = storage.commitCompletedBattleStoryChapter;
    const save = vi.spyOn(storage, 'commitCompletedBattleStoryChapter').mockImplementationOnce(async (commit) => { await original(commit); throw new Error('lost reply'); });
    const { pending } = await start(); await finish(pending);
    const chapter = session.pendingCompletedChapter!;
    const stored = await storage.getBattleStoryChapter(chapter.id);
    const receipt = await storage.getBattleStoryOperationReceipt(chapter.id);
    await storage.putBattleStoryChapter({ ...stored!, ...{ commitReceipt: { ...receipt!, contentDigest: 'mismatched' } } });
    await act(async () => session.handleRetrySaveChapter());
    expect(save).toHaveBeenCalledTimes(1);
    expect(session.pendingSaveUnknown).toBe(true);
    await storage.deleteBattleStorySession(chapter.sessionId);
    await act(async () => session.handleRetrySaveChapter());
    expect(await storage.getBattleStorySession(chapter.sessionId)).toBeNull();
    expect(session.pendingSaveAsNewSession).toBe(true);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it('真实 Panel 的失败保文按钮与禁用生成消费同一 hook 状态', async () => {
    const useOriginal = storyHook.useBattleStorySession;
    vi.spyOn(storyHook, 'useBattleStorySession').mockImplementation(function useObservedSession() {
      const value = useOriginal(); useLayoutEffect(() => { session = value; }); return value;
    });
    await act(async () => root.render(<BattleStorySessionPanel />));
    await vi.waitFor(async () => { await act(async () => {}); expect(session.isReady).toBe(true); });
    vi.spyOn(storage, 'commitCompletedBattleStoryChapter').mockRejectedValueOnce(new storage.BattleStoryCommitNotSavedError(new Error('known fault')));
    const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === text)!;
    const { pending } = await start(); await finish(pending, '# UI待保存章\n正文');
    expect(container.textContent).toContain('正文已完成，尚未保存');
    expect(button('新建连续战报').disabled).toBe(true);
    expect(button('重试保存').disabled).toBe(false);
    await act(async () => button('导出本章').click()); expect(fixture.download).toHaveBeenCalledTimes(1);
    await act(async () => button('重试保存').click());
    await vi.waitFor(async () => { await act(async () => {}); expect(session.pendingCompletedChapter).toBeNull(); });
    expect(container.textContent).not.toContain('正文已完成，尚未保存');
    expect(container.textContent).toContain('UI待保存章');
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

});

const roleSuccess = () => Response.json({ success: true, updatedCombatants: [
  { combatantIndex: 0, data: { codename: '同步后的角色', signature: 'opaque-server-field' }, isNative: false },
], warnings: [] });
async function completeForRoles(markdown = '# 保留正文\n完整结尾') {
  await act(async () => {
    send(event('session_meta', { generationId: 'generation-original-1' })
      + event('markdown', { chunk: markdown }) + event('done', { ok: true })); stream.close();
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(session.isGenerating).toBe(false);
    expect(session.pendingRoleOutcome?.roleBusy).not.toBe(true);
  });
}

describe('completed story body survives unresolved headerless Web roles', () => {
  it('network failure retains body before role, retries only frozen generation/input and preserves current draft', async () => {
    fixture.state.settings.writeCurrentState = true;
    const roles = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(roleSuccess);
    vi.stubGlobal('fetch', roles);
    await mount(); const { pending } = await start();
    fixture.state.combatants[0]!.data.codename = '编辑态新名字';
    await completeForRoles();
    expect(session.isGenerating).toBe(false);
    expect(session.pendingRoleOutcome?.role.status).toBe('unresolved');
    expect(session.pendingRoleOutcome?.output.markdown).toBe('# 保留正文\n完整结尾');
    expect(await storage.listBattleStorySessions()).toEqual([]);
    await act(async () => session.handleExportCompletedOutput());
    expect(fixture.download).toHaveBeenCalledTimes(1);
    const firstBody = roles.mock.calls[0]![1].body;
    expect(JSON.parse(firstBody)).toMatchObject({ generationId: 'generation-original-1', combatants: [{ data: { codename: '测试角色' } }] });
    await act(async () => { await session.handleStartSession(); await session.handleBranchSession(); });
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    await act(async () => { await session.handleRetryStoryRoles(); await pending; });
    expect(roles).toHaveBeenCalledTimes(2);
    expect(roles.mock.calls[1]![1].body).toBe(firstBody);
    expect(new Headers(roles.mock.calls[1]![1].headers).has('X-Mahoshojo-Arena-Reconciliation-Protocol')).toBe(false);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(session.pendingRoleOutcome).toBeNull();
    expect(session.activeSession!.workingCombatants[0]).toMatchObject({ data: { codename: '同步后的角色' }, isNative: false });
    expect(fixture.state.combatants[0]!.data.codename).toBe('编辑态新名字');
    await act(async () => session.handleRetryStoryRoles()); expect(roles).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['invalid JSON', () => new Response('{')],
    ['missing success and updates', () => Response.json({})],
    ['bad update', () => Response.json({ success: true, updatedCombatants: [{ combatantIndex: 0, data: null, isNative: true }] })],
    ['duplicate update', () => Response.json({ success: true, updatedCombatants: [0, 0].map((combatantIndex) => ({ combatantIndex, data: {}, isNative: false })) })],
  ])('%s stays unresolved; explicit original-role choice saves once without another model or role call', async (_label, response) => {
    fixture.state.settings.writeCurrentState = true;
    const roles = vi.fn().mockImplementation(response); vi.stubGlobal('fetch', roles);
    await mount(); const { pending } = await start(); await completeForRoles();
    expect(session.pendingRoleOutcome?.role.status).toBe('unresolved');
    expect(await storage.listBattleStorySessions()).toHaveLength(0);
    await act(async () => { session.handleKeepOriginalStoryRoles(); session.handleKeepOriginalStoryRoles(); await pending; });
    expect(session.selectedChapter?.markdown).toContain('完整结尾');
    expect(session.activeSession!.workingCombatants[0]).toMatchObject({ data: { codename: '测试角色' } });
    expect(session.notice).toContain('保留原角色');
    expect(roles).toHaveBeenCalledTimes(1); expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it('explicit HTTP failure and missing generationId retain legacy old-role auto-save behavior', async () => {
    fixture.state.settings.writeArenaHistory = true;
    const roles = vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 })); vi.stubGlobal('fetch', roles);
    await mount(); const first = await start(); await completeForRoles(); await act(async () => first.pending);
    expect(session.pendingRoleOutcome).toBeNull(); expect(session.chapters).toHaveLength(1);
    expect(session.notice).toContain('同步失败');
    const second = await start(); await finish(second.pending);
    expect(session.pendingRoleOutcome).toBeNull(); expect(session.notice).toContain('generationId');
    expect(roles).toHaveBeenCalledTimes(1);
  });

  it('role retry double click is single flight; accepted frozen save failure never permits another role POST', async () => {
    fixture.state.settings.writeCurrentState = true;
    let resolveRole!: (response: Response) => void;
    const roles = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRole = resolve; }));
    vi.stubGlobal('fetch', roles);
    await mount(); const { pending } = await start(); await completeForRoles();
    let retry!: Promise<void>;
    await act(async () => { retry = session.handleRetryStoryRoles(); void session.handleRetryStoryRoles(); session.handleKeepOriginalStoryRoles(); });
    expect(roles).toHaveBeenCalledTimes(2);
    vi.spyOn(storage, 'commitCompletedBattleStoryChapter').mockRejectedValueOnce(new storage.BattleStoryCommitNotSavedError('local write refused'));
    await act(async () => { resolveRole(roleSuccess()); await retry; await pending; });
    expect(session.pendingCompletedChapter?.markdown).toContain('完整结尾'); expect(session.pendingRoleOutcome).toBeNull();
    await act(async () => { await session.handleRetryStoryRoles(); session.handleKeepOriginalStoryRoles(); });
    expect(roles).toHaveBeenCalledTimes(2);
    await act(async () => session.handleRetrySaveChapter()); expect(session.pendingCompletedChapter).toBeNull();
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['before retry', 'during retry'])('actor changes %s make completed output read-only and ignore late success', async (when) => {
    fixture.state.settings.writeCurrentState = true;
    let resolveRole!: (response: Response) => void;
    const roles = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRole = resolve; }));
    vi.stubGlobal('fetch', roles);
    await mount(); const { pending } = await start(); await completeForRoles();
    let retry!: Promise<void>;
    if (when === 'before retry') localStorage.setItem('mahoshojo_auth', 'new-account-generation');
    await act(async () => { retry = session.handleRetryStoryRoles(); });
    if (when === 'during retry') {
      localStorage.setItem('mahoshojo_auth', 'new-account-generation');
      await act(async () => { resolveRole(roleSuccess()); await retry; });
    } else await act(async () => retry);
    expect(session.pendingRoleOutcome?.canResolveRoles).toBe(false);
    await act(async () => { session.handleKeepOriginalStoryRoles(); await session.handleRetryStoryRoles(); });
    expect(await storage.listBattleStorySessions()).toHaveLength(0);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => { session.handleDiscardCompletedOutput(); await pending; });
    expect(session.pendingRoleOutcome).toBeNull(); expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['continue', 'branch', 'rewrite'] as const)('%s recovers the original action without regenerating or using later draft', async (action) => {
    fixture.state.settings.writeCurrentState = true;
    const roles = vi.fn().mockRejectedValueOnce(new Error('offline')); vi.stubGlobal('fetch', roles);
    await mount(); const first = await start(); await finish(first.pending, '# 原首章'); // legacy missing generation
    const originalId = session.activeSession!.id;
    let pending!: Promise<void>;
    await act(async () => { pending = action === 'continue' ? session.handleContinueSession() : action === 'branch' ? session.handleBranchSession() : session.handleRewriteLastChapter(); });
    await act(async () => { await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledTimes(2)); });
    await completeForRoles(`# ${action}完整正文`);
    expect(session.pendingRoleOutcome?.action).toBe(action);
    fixture.state.settings.userGuidance = '之后才修改的草稿';
    await act(async () => { session.handleKeepOriginalStoryRoles(); await pending; });
    expect(session.actionError).toBeNull();
    expect(session.selectedChapter?.action).toBe(action);
    expect(session.selectedChapter?.markdown).toContain(`${action}完整正文`);
    expect(session.activeSession!.id === originalId).toBe(action !== 'branch');
    expect(fixture.dispatch).toHaveBeenCalledTimes(2); expect(roles).toHaveBeenCalledTimes(1);
    fixture.state.settings.userGuidance = '';
  });

  it('navigation while roles are pending does not let a late save reselect the old result', async () => {
    fixture.state.settings.writeCurrentState = true;
    const roles = vi.fn().mockRejectedValueOnce(new Error('offline')); vi.stubGlobal('fetch', roles);
    await mount(); const first = await start(); await finish(first.pending, '# 原会话');
    const originalId = session.activeSession!.id;
    const second = await start(); await completeForRoles('# 新会话完成正文');
    await act(async () => session.handleSelectSession(originalId));
    await act(async () => { session.handleKeepOriginalStoryRoles(); await second.pending; });
    expect(session.activeSession!.id).toBe(originalId);
    expect(session.selectedChapter?.markdown).toBe('# 原会话');
    expect(session.hasUnreadSavedChapter).toBe(true);
  });

  it('discard cancel preserves body; unmount fences a late role response from every storage write', async () => {
    fixture.state.settings.writeCurrentState = true;
    let resolveRole!: (response: Response) => void;
    const roles = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRole = resolve; }));
    vi.stubGlobal('fetch', roles);
    await mount(); const { pending } = await start(); await completeForRoles();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => session.handleDiscardCompletedOutput()); expect(session.pendingRoleOutcome).not.toBeNull();
    let retry!: Promise<void>; await act(async () => { retry = session.handleRetryStoryRoles(); });
    await act(async () => { root.render(null); });
    await act(async () => pending);
    await act(async () => { resolveRole(roleSuccess()); await retry; });
    expect(await storage.listBattleStorySessions()).toHaveLength(0);
  });
});

describe('actual pending outcome panel and legacy write boundaries', () => {
  it('Panel renders unresolved completed body and drives the shared retry/keep/export controls', async () => {
    fixture.state.settings.writeCurrentState = true;
    const roles = vi.fn().mockRejectedValue(new Error('role network unavailable')); vi.stubGlobal('fetch', roles);
    const useOriginal = storyHook.useBattleStorySession;
    vi.spyOn(storyHook, 'useBattleStorySession').mockImplementation(function useObservedSession() {
      const value = useOriginal(); useLayoutEffect(() => { session = value; }); return value;
    });
    await act(async () => root.render(<BattleStorySessionPanel />));
    await vi.waitFor(async () => { await act(async () => {}); expect(session.isReady).toBe(true); });
    const { pending } = await start(); await completeForRoles('# Panel完整正文');
    const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === text)!;
    expect(container.querySelector('[data-story-pending-outcome]')?.textContent).toContain('Panel完整正文');
    expect(container.textContent).toContain('正文已完成，尚未保存');
    expect(button('新建连续战报').disabled).toBe(true);
    expect(button('重试角色同步').disabled).toBe(false);
    await act(async () => button('导出本章').click()); expect(fixture.download).toHaveBeenCalledTimes(1);
    await act(async () => { button('保留旧角色保存本章').click(); await pending; });
    expect(session.selectedChapter?.markdown).toBe('# Panel完整正文');
    expect(fixture.dispatch).toHaveBeenCalledTimes(1); expect(roles).toHaveBeenCalledTimes(1);
  });

  it.each(['rewrite'] as const)('%s partial write failure retains export without replay or another role request', async (action) => {
    fixture.state.settings.writeCurrentState = true;
    const roles = vi.fn().mockImplementation(roleSuccess); vi.stubGlobal('fetch', roles);
    await mount(); const first = await start(); await finish(first.pending, '# 第一章');
    const originalChapterId = session.selectedChapter!.id;
    let next!: Promise<void>; await act(async () => { next = session.handleContinueSession(); }); await finish(next, '# 第二章');
    await act(async () => session.setSelectedChapterId(originalChapterId));
    const selectedAtClick = session.selectedChapter!; const latestAtClick = session.latestActiveChapter!;
    const supersede = vi.spyOn(storage, 'markBattleStoryChapterSuperseded');
    const write = vi.spyOn(storage, 'putBattleStoryChapter').mockRejectedValueOnce(new Error('legacy write failed'));
    let pending!: Promise<void>;
    await act(async () => { pending = session.handleRewriteSelectedChapter(); });
    selectedAtClick.id = 'later-ui-identity'; selectedAtClick.index = 8; latestAtClick.index = 1;
    await completeForRoles('# 已完成但旧保存失败'); await act(async () => pending);
    expect(session.pendingRoleOutcome?.legacySaveState).toBe('unknown');
    expect(session.pendingRoleOutcome?.role.status).toBe('accepted');
    await act(async () => { await session.handleRetryStoryRoles(); session.handleKeepOriginalStoryRoles(); session.handleExportCompletedOutput(); });
    expect(supersede).toHaveBeenCalledWith(expect.objectContaining({ chapterId: originalChapterId }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(roles).toHaveBeenCalledTimes(1); expect(fixture.download).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).toHaveBeenCalledTimes(3);
  });

  it.each(['rewrite-superseded', 'rewrite-checkpoint'] as const)(
    '%s: deletion between real IndexedDB phases cannot recreate orphan children', async (phase) => {
      fixture.state.settings.writeCurrentState = true;
      const roles = vi.fn().mockImplementation(roleSuccess); vi.stubGlobal('fetch', roles);
      await mount(); const first = await start(); await finish(first.pending, '# 保留的原章节');
      const originalChapterId = session.selectedChapter!.id;
      let next!: Promise<void>; await act(async () => { next = session.handleContinueSession(); }); await finish(next, '# 后续章节');
      await act(async () => session.setSelectedChapterId(originalChapterId));
      let deletedId: string | null = null;
      const deleteBetweenPhases = async (id: string) => {
        await storage.deleteBattleStorySession(id);
        deletedId = id;
      };
      if (phase === 'rewrite-superseded') {
        const original = storage.markBattleStoryChapterSuperseded;
        vi.spyOn(storage, 'markBattleStoryChapterSuperseded').mockImplementationOnce(async (input) => {
          const record = await original(input); await deleteBetweenPhases(record.sessionId); return record;
        });
      } else {
        const original = storage.putBattleStoryCheckpoint;
        vi.spyOn(storage, 'putBattleStoryCheckpoint').mockImplementationOnce(async (record) => {
          await deleteBetweenPhases(record.sessionId); await original(record);
        });
      }
      const lateWrites: string[] = [];
      const put = IDBObjectStore.prototype.put;
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
        if (deletedId) lateWrites.push(this.name);
        return put.apply(this, args);
      });
      let pending!: Promise<void>;
      await act(async () => { pending = session.handleRewriteSelectedChapter(); });
      await completeForRoles('# 删除期间仍保留的完整正文'); await act(async () => pending);
      expect(deletedId).not.toBeNull();
      expect(lateWrites).toEqual([]);
      expect(await storage.getBattleStorySession(deletedId!)).toBeNull();
      expect(await storage.listBattleStoryChaptersBySession(deletedId!, { includeSuperseded: true })).toEqual([]);
      expect(await storage.listBattleStoryCheckpointsBySession(deletedId!)).toEqual([]);
      expect(session.pendingRoleOutcome?.legacySaveState).toBe('unknown');
      expect(session.pendingRoleOutcome?.role.status).toBe('accepted');
      expect(session.pendingRoleOutcome?.output.markdown).toBe('# 删除期间仍保留的完整正文');
      expect(session.actionError).toContain('未找到 battle story session');
      await act(async () => {
        await session.handleRetryStoryRoles(); session.handleKeepOriginalStoryRoles();
        await session.handleRetrySaveChapter(); await session.handleBranchSession(); await session.handleRewriteLastChapter();
        session.handleExportCompletedOutput();
      });
      expect(roles).toHaveBeenCalledTimes(1); expect(fixture.dispatch).toHaveBeenCalledTimes(3);
      const blob = fixture.download.mock.calls[0]![0] as Blob;
      const exported = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
      expect(exported).toBe('# 删除期间仍保留的完整正文');

    },
  );
});

it('a late generation response cannot overwrite a newer anonymous actor; completed output remains exportable', async () => {
  fixture.state.settings.writeCurrentState = true;
  const roles = vi.fn(); vi.stubGlobal('fetch', roles);
  let resolveResponse!: (response: Response) => void;
  fixture.dispatch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
  await mount(); const { pending } = await start();
  const actorKey = 'mahoshojo:arena:generation-actor:v1';
  localStorage.setItem(actorKey, 'new-actor-token');
  await act(async () => resolveResponse(new Response(
    event('session_meta', { generationId: 'generation-original-1' }) + event('markdown', { chunk: '# 迟到完整正文' }) + event('done', { ok: true }),
    { headers: { 'content-type': 'text/event-stream', 'X-Mahoshojo-Generation-Actor-Token': 'old-response-token' } },
  )));
  await vi.waitFor(async () => { await act(async () => {}); expect(session.pendingRoleOutcome?.role.status).toBe('unresolved'); });
  expect(localStorage.getItem(actorKey)).toBe('new-actor-token');
  expect(session.pendingRoleOutcome?.canResolveRoles).toBe(false);
  expect(roles).not.toHaveBeenCalled();
  await act(async () => { session.stopGeneration(); session.handleExportCompletedOutput(); });
  expect(session.pendingRoleOutcome?.output.markdown).toBe('# 迟到完整正文');
  expect(fixture.download).toHaveBeenCalledTimes(1);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await act(async () => { session.handleDiscardCompletedOutput(); await pending; });
  expect(await storage.listBattleStorySessions()).toHaveLength(0);
});

it('a changed-then-restored identity generation stays detached rather than reusing old actor headers', async () => {
  fixture.state.settings.writeCurrentState = true;
  const roles = vi.fn().mockRejectedValue(new Error('offline')); vi.stubGlobal('fetch', roles);
  await mount(); const { pending } = await start(); await completeForRoles();
  await act(async () => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'mahoshojo_auth', oldValue: null, newValue: 'different-login' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'mahoshojo_auth', oldValue: 'different-login', newValue: null }));
  });
  expect(session.pendingRoleOutcome?.canResolveRoles).toBe(false);
  await act(async () => { await session.handleRetryStoryRoles(); session.handleKeepOriginalStoryRoles(); });
  expect(roles).toHaveBeenCalledTimes(1);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await act(async () => { session.handleDiscardCompletedOutput(); await pending; });
  expect(await storage.listBattleStorySessions()).toHaveLength(0);
});

it.each(['session', 'chapter', 'no-later-navigation'] as const)('explicit save-as-new captures its own selection epoch: %s', async (navigation) => {
  await mount();
  const original = storage.commitCompletedBattleStoryChapter;
  const save = vi.spyOn(storage, 'commitCompletedBattleStoryChapter').mockImplementationOnce(async (commit) => {
    await original(commit); throw new Error('lost receipt');
  });
  const first = await start(); await finish(first.pending, '# 待另存的原正文');
  const originalId = session.pendingCompletedChapter!.sessionId;
  await storage.deleteBattleStorySession(originalId);
  await act(async () => session.handleRetrySaveChapter());
  expect(session.pendingSaveAsNewSession).toBe(true);

  const addHistory = async (title: string) => {
    const record = storage.createBattleStorySessionRecord({
      title, source: { mode: 'daily', language: 'zh-CN', storyLength: 'standard', generationMode: 'stream' },
      seed: { combatants: [], settings: { readArenaHistory: false, writeArenaHistory: false, readCurrentState: false, writeCurrentState: false, readNarrativeHistory: false, writeNarrativeHistory: false } },
      workingCombatants: [],
    });
    const chapters = [1, 2].map((index) => storage.createBattleStoryChapterRecord({
      sessionId: record.id, index, action: index === 1 ? 'start' : 'continue', title: `${title}-${index}`,
      markdown: `${title}正文${index}`, reportJson: {}, deterministicDigest: { chapterTitle: `${title}-${index}`, bodyExcerpt: '' },
    }));
    record.chapterCount = 2; record.lastChapterId = chapters[1]!.id;
    await storage.putBattleStorySession(record);
    for (const chapter of chapters) await storage.putBattleStoryChapter(chapter);
    return { record, chapters };
  };
  const history = await addHistory('历史会话');
  const other = await addHistory('另一会话');
  // Navigation before the explicit save is allowed; the save intent gets a fresh epoch.
  await act(async () => session.handleSelectSession(history.record.id));
  let releaseSave!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  save.mockImplementationOnce(async (commit) => { await writeGate; return original(commit); });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  let saving!: Promise<void>;
  await act(async () => { saving = session.handleSavePendingAsNewSession(); });
  expect(session.isSavingChapter).toBe(true);
  const savedSessionId = session.pendingCompletedChapter!.sessionId;
  if (navigation === 'session') await act(async () => session.handleSelectSession(other.record.id));
  if (navigation === 'chapter') await act(async () => session.setSelectedChapterId(history.chapters[0]!.id));
  await act(async () => { releaseSave(); await saving; });
  expect(session.pendingCompletedChapter).toBeNull();
  expect(session.activeSession!.id).toBe(navigation === 'session' ? other.record.id : navigation === 'chapter' ? history.record.id : savedSessionId);
  if (navigation === 'chapter') expect(session.selectedChapter?.id).toBe(history.chapters[0]!.id);
  expect(session.hasUnreadSavedChapter).toBe(navigation !== 'no-later-navigation');
  expect((await storage.listBattleStoryChaptersBySession(savedSessionId))[0]?.markdown).toBe('# 待另存的原正文');
  expect(fixture.dispatch).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledTimes(2);
});

it.each(['session', 'chapter'] as const)('reload-saved action respects later %s selection while its list read is pending', async (navigation) => {
  const realList = storage.listBattleStorySessions;
  const list = vi.spyOn(storage, 'listBattleStorySessions').mockImplementation(realList);
  await mount(); const first = await start(); await finish(first.pending, '# 已存在的会话');
  const historyId = session.activeSession!.id;
  const historyChapterId = session.selectedChapter!.id;
  list.mockRejectedValueOnce(new Error('readback failed after commit'));
  const second = await start(); await finish(second.pending, '# 保存成功等待读取');
  expect(session.hasUnreadSavedChapter).toBe(true);
  let releaseList!: () => void;
  const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
  list.mockImplementationOnce(async (options) => { await listGate; return realList(options); });
  let reload!: Promise<void>;
  await act(async () => { reload = session.handleReloadSavedChapter(); });
  if (navigation === 'session') await act(async () => session.handleSelectSession(historyId));
  else await act(async () => session.setSelectedChapterId(historyChapterId));
  await act(async () => { releaseList(); await reload; });
  expect(session.activeSession!.id).toBe(historyId);
  expect(session.selectedChapter?.id).toBe(historyChapterId);
  expect(session.hasUnreadSavedChapter).toBe(true);
  expect(fixture.dispatch).toHaveBeenCalledTimes(2);
});

it.each(['switch-to-B', 'logout-then-same-A'] as const)('identity change during asynchronous auth-header preparation blocks dispatch: %s', async (change) => {
  localStorage.setItem('mahoshojo_auth', 'stored-A');
  fixture.authHeader.mockResolvedValue('Bearer credential-A');
  let releaseActivity!: (headers: Record<string, string>) => void;
  fixture.activityHeaders.mockImplementationOnce(() => new Promise<Record<string, string>>((resolve) => { releaseActivity = resolve; }));
  const roles = vi.fn();
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => url.includes('generate-next') ? fixture.dispatch(url, init) : roles(url, init));
  await mount();
  const { onSettled } = installRealLatch();
  let pending!: Promise<void>;
  await act(async () => { pending = session.handleStartSession(); });
  expect(fixture.authHeader).toHaveBeenCalledTimes(1);
  expect(fixture.activityHeaders).toHaveBeenCalledTimes(1);
  expect(fixture.dispatch).not.toHaveBeenCalled();
  await act(async () => { void session.handleStartSession(); });
  expect(fixture.activityHeaders).toHaveBeenCalledTimes(1);
  await act(async () => {
    localStorage.removeItem('mahoshojo_auth');
    window.dispatchEvent(new StorageEvent('storage', { key: 'mahoshojo_auth', oldValue: 'stored-A', newValue: null }));
    localStorage.setItem('mahoshojo_auth', change === 'switch-to-B' ? 'stored-B' : 'stored-A');
    window.dispatchEvent(new StorageEvent('storage', { key: 'mahoshojo_auth', oldValue: null, newValue: change === 'switch-to-B' ? 'stored-B' : 'stored-A' }));
    releaseActivity({ 'x-mahoshojo-user-id': change === 'switch-to-B' ? '2' : '1' });
    await pending;
  });
  expect(fixture.dispatch).not.toHaveBeenCalled(); expect(roles).not.toHaveBeenCalled();
  expect(session.actionError).toContain('本次未发起生成');
  expect(fixture.acquire).not.toHaveBeenCalled();
  expect(onSettled).not.toHaveBeenCalled();
  expect(fixture.state.combatants[0]!.data.codename).toBe('测试角色');
  expect(await storage.listBattleStorySessions()).toHaveLength(0);
  fixture.authHeader.mockResolvedValue(change === 'switch-to-B' ? 'Bearer credential-B' : 'Bearer credential-A');
  const retry = await start(); await finish(retry.pending, '# 明确重试的新请求');
  expect(fixture.acquire).toHaveBeenCalledTimes(1);
  expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  expect(session.selectedChapter?.markdown).toBe('# 明确重试的新请求');
  expect(onSettled).toHaveBeenCalledTimes(1);
});

it('real latch rejects an actor change during internal placement await before any model network call, then settles for retry', async () => {
  localStorage.setItem('mahoshojo_auth', 'stored-A');
  fixture.authHeader.mockResolvedValue('Bearer credential-A');
  fixture.activityHeaders.mockResolvedValue({ 'x-mahoshojo-user-id': '1', 'x-mahoshojo-activity-token': 'activity-A' });
  const network = vi.fn((url: string, init: RequestInit) => fixture.dispatch(url, init)); vi.stubGlobal('fetch', network);
  await mount();
  let releasePlacement!: () => void;
  const placementGate = new Promise<void>((resolve) => { releasePlacement = resolve; });
  const selectPlacement = vi.fn(async (input: Parameters<typeof selectHostedDrPlacement>[0]) => {
    await placementGate; return selectHostedDrPlacement(input);
  });
  const { onSettled } = installRealLatch({ selectPlacement });
  honoApiConfig.enabled = true; honoApiConfig.routingMode = 'client-preflight'; honoApiConfig.origin = 'https://homura.colanns.me';
  let pending!: Promise<void>;
  await act(async () => { pending = session.handleStartSession(); });
  expect(selectPlacement).toHaveBeenCalledTimes(1); expect(fixture.acquire).toHaveBeenCalledTimes(1);
  await act(async () => {
    localStorage.setItem('mahoshojo_auth', 'stored-B');
    window.dispatchEvent(new StorageEvent('storage', { key: 'mahoshojo_auth', oldValue: 'stored-A', newValue: 'stored-B' }));
    releasePlacement(); await pending;
  });
  expect(network).not.toHaveBeenCalled(); expect(onSettled).toHaveBeenCalledTimes(1);
  expect(session.actionError).toContain('本次未发起生成');
  fixture.authHeader.mockResolvedValue('Bearer credential-B');
  fixture.activityHeaders.mockResolvedValue({ 'x-mahoshojo-user-id': '2', 'x-mahoshojo-activity-token': 'activity-B' });
  const retry = await start(); await finish(retry.pending, '# 已重新确认身份');
  expect(onSettled).toHaveBeenCalledTimes(2); expect(network).toHaveBeenCalledTimes(1);
  const headers = new Headers(network.mock.calls[0]![1].headers);
  expect(headers.get('Authorization')).toBe('Bearer credential-B');
  expect(headers.get('x-mahoshojo-user-id')).toBe('2');
  expect(headers.get('x-mahoshojo-activity-token')).toBe('activity-B');
  expect(headers.get('Accept')).toBe('text/event-stream');
  expect(headers.has('X-Mahoshojo-Arena-Story-Protocol')).toBe(false);
  expect(JSON.parse(String(network.mock.calls[0]![1].body))).toMatchObject({
    action: 'start', chapterIndex: 1, chapterContext: { recentChapters: [] },
    seed: { mode: 'daily', language: 'zh-CN' },
  });
  expect(fixture.authHeader).toHaveBeenCalledTimes(2); expect(fixture.activityHeaders).toHaveBeenCalledTimes(2);
});

it.each(['sync-throw', 'async-reject'] as const)('real latch releases after dispatch %s and admits only a later explicit generation', async (failure) => {
  const network = vi.fn((url: string, init: RequestInit) => fixture.dispatch(url, init));
  if (failure === 'sync-throw') network.mockImplementationOnce(() => { throw new Error('transport failure'); });
  else network.mockRejectedValueOnce(new Error('transport failure'));
  vi.stubGlobal('fetch', network);
  await mount(); const { onSettled } = installRealLatch();
  await act(async () => { await session.handleStartSession(); });
  expect(onSettled).toHaveBeenCalledTimes(1); expect(network).toHaveBeenCalledTimes(1);
  expect(session.isGenerating).toBe(false); expect(session.pendingRoleOutcome).toBeNull();
  const retry = await start(); await finish(retry.pending, '# 显式新请求');
  expect(onSettled).toHaveBeenCalledTimes(2); expect(network).toHaveBeenCalledTimes(2);
  expect(fixture.acquire).toHaveBeenCalledTimes(2);
  expect(session.selectedChapter?.markdown).toBe('# 显式新请求');
});

it('real latch remains unused when auth preparation throws and the next explicit attempt is admitted', async () => {
  const network = vi.fn((url: string, init: RequestInit) => fixture.dispatch(url, init)); vi.stubGlobal('fetch', network);
  await mount(); const { onSettled } = installRealLatch();
  fixture.authHeader.mockRejectedValueOnce(new Error('auth preparation failed'));
  await act(async () => session.handleStartSession());
  expect(fixture.acquire).not.toHaveBeenCalled(); expect(onSettled).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  const retry = await start(); await finish(retry.pending, '# 认证准备恢复');
  expect(fixture.acquire).toHaveBeenCalledTimes(1); expect(onSettled).toHaveBeenCalledTimes(1);
  expect(session.selectedChapter?.markdown).toBe('# 认证准备恢复');
});

describe('atomic branch consumes the shared completed-output recovery', () => {
  async function branch() {
    let pending!: Promise<void>;
    const before = fixture.dispatch.mock.calls.length;
    await act(async () => { pending = session.handleBranchSession(); });
    await act(async () => { await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledTimes(before + 1)); });
    return { pending };
  }

  it('rollback preserves one frozen branch package; explicit retry uses no model or legacy put', async () => {
    await mount(); const first = await start(); await finish(first.pending, '# 源章');
    const sourceId = session.activeSession!.id;
    const legacySession = vi.spyOn(storage, 'putBattleStorySession');
    const legacyChapter = vi.spyOn(storage, 'putBattleStoryChapter');
    const legacyCheckpoints = vi.spyOn(storage, 'putBattleStoryCheckpoints');
    const original = IDBObjectStore.prototype.add;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args) {
      const request = original.apply(this, args);
      if (this.name === AI_SESSION_STORE_NAMES.battleStoryCheckpoints) request.addEventListener('success', () => { try { this.transaction.abort(); } catch { /* already aborted */ } });
      return request;
    });
    const { pending } = await branch(); await finish(pending, '# 分支完整正文');
    const chapter = session.pendingCompletedChapter!;
    expect(chapter.action).toBe('branch'); expect(session.pendingSaveUnknown).toBe(false);
    expect(session.pendingRoleOutcome).toBeNull();
    expect(await storage.listBattleStorySessions()).toHaveLength(1);
    expect(await storage.getBattleStoryChapter(chapter.id)).toBeNull();
    await act(async () => { await session.handleBranchSession(); await session.handleContinueSession(); });
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    fault.mockRestore();
    await act(async () => session.handleRetrySaveChapter());
    expect(session.pendingCompletedChapter).toBeNull(); expect(session.selectedChapter?.id).toBe(chapter.id);
    expect(session.activeSession?.id).not.toBe(sourceId);
    expect(await storage.listBattleStorySessions()).toHaveLength(2);
    expect(legacySession).not.toHaveBeenCalled(); expect(legacyChapter).not.toHaveBeenCalled(); expect(legacyCheckpoints).not.toHaveBeenCalled();
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
  });

  it.each(['absence', 'mismatch', 'io'] as const)('unknown branch %s only queries the original target/op/digest', async (result) => {
    await mount(); const first = await start(); await finish(first.pending, '# 源章');
    const writer = vi.spyOn(storage, 'commitCompletedBattleStoryBranch').mockRejectedValueOnce(new Error('lost outcome'));
    const { pending } = await branch(); await finish(pending, '# 未知分支正文');
    const chapter = session.pendingCompletedChapter!;
    const frozen = writer.mock.calls[0]![0];
    const expected = storage.createBattleStoryBranchReceipt(frozen);
    expect(session.pendingSaveUnknown).toBe(true);
    const query = vi.spyOn(storage, 'getBattleStoryBranchOperationReceipt');
    if (result === 'io') query.mockRejectedValue(new Error('read unavailable'));
    else if (result === 'mismatch') query.mockResolvedValue({ ...expected, contentDigest: `sha256:${'a'.repeat(64)}` });
    else query.mockResolvedValue(null);
    await act(async () => { await session.handleRetrySaveChapter(); await session.handleSavePendingAsNewSession(); });
    expect(query).toHaveBeenCalledWith(chapter.sessionId, chapter.id, expected.contentDigest);
    expect(writer).toHaveBeenCalledTimes(1); expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    expect(session.pendingCompletedChapter?.id).toBe(chapter.id); expect(session.pendingSaveUnknown).toBe(true);
    await act(async () => session.handleExportPendingChapter()); expect(fixture.download).toHaveBeenCalledTimes(1);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => session.handleDiscardPendingChapter()); expect(session.pendingCompletedChapter?.id).toBe(chapter.id);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => session.handleDiscardPendingChapter()); expect(session.pendingCompletedChapter).toBeNull();
  });

  it('lost successful branch reply is resolved after source deletion without a second write', async () => {
    await mount(); const first = await start(); await finish(first.pending, '# 源章');
    const sourceId = session.activeSession!.id;
    const original = storage.commitCompletedBattleStoryBranch;
    const writer = vi.spyOn(storage, 'commitCompletedBattleStoryBranch').mockImplementationOnce(async (commit) => {
      await original(commit); throw new Error('lost reply');
    });
    const { pending } = await branch(); await finish(pending, '# 已存分支正文');
    const chapter = session.pendingCompletedChapter!;
    await storage.deleteBattleStorySession(sourceId);
    await act(async () => session.handleRetrySaveChapter());
    expect(session.pendingCompletedChapter).toBeNull(); expect(session.selectedChapter?.id).toBe(chapter.id);
    expect(writer).toHaveBeenCalledTimes(1); expect(fixture.dispatch).toHaveBeenCalledTimes(2);
  });

  it('changed persisted source conflicts although stale page still shows original body', async () => {
    await mount(); const first = await start(); await finish(first.pending, '# 源章');
    const source = session.activeSession!;
    const { pending } = await branch();
    await storage.putBattleStorySession({ ...source, sessionSummary: '生成期间另一页修改' });
    await finish(pending, '# 应保留的分支正文');
    expect(session.pendingCompletedChapter?.markdown).toBe('# 应保留的分支正文');
    expect(session.pendingSaveUnknown).toBe(false); expect(await storage.listBattleStorySessions()).toHaveLength(1);
    await act(async () => session.handleRetrySaveChapter());
    expect(session.pendingCompletedChapter?.markdown).toBe('# 应保留的分支正文'); expect(fixture.dispatch).toHaveBeenCalledTimes(2);
  });

  it('uses the real shared three-record projection and an independent source snapshot', async () => {
    await mount(); const first = await start(); await finish(first.pending, '# 原源章');
    const originalRoles = structuredClone(session.activeSession!.workingCombatants);
    const projection = vi.spyOn(branchProjection, 'buildCompletedBattleStoryBranchRecords');
    const { pending } = await branch();
    session.activeSession!.seed.combatants.push({ unrelatedDraft: true });
    session.activeSession!.workingCombatants.push({ unrelatedDraft: true });
    await act(async () => { await session.handleBranchSession(); });
    await finish(pending, '# 冻结分支正文');
    expect(session.actionError).toBeNull();
    expect(projection).toHaveBeenCalledTimes(1);
    expect(session.activeSession!.lastChapterInputCombatants).toEqual(originalRoles);
    expect(session.activeSession!.seed.combatants).toHaveLength(1);
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    const copied = (await storage.listBattleStoryChaptersBySession(session.activeSession!.id))[0]!;
    expect(copied).not.toHaveProperty('commitReceipt');
    expect(await storage.getBattleStoryOperationReceipt(copied.id)).toBeNull();
  });

  it('late successful branch save does not steal a newer selection', async () => {
    await mount(); const first = await start(); await finish(first.pending, '# 仍然选中的源章');
    const sourceId = session.activeSession!.id;
    const original = storage.commitCompletedBattleStoryBranch;
    let resume!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(storage, 'commitCompletedBattleStoryBranch').mockImplementationOnce(async (commit) => {
      started(); await new Promise<void>((resolve) => { resume = resolve; }); return original(commit);
    });
    const { pending } = await branch();
    let finishing!: Promise<void>;
    await act(async () => {
      send(event('markdown', { chunk: '# 晚保存分支' }) + event('done', { ok: true })); stream.close();
      finishing = pending; await waiting;
    });
    await act(async () => session.handleSelectSession(sourceId));
    await act(async () => { resume(); await finishing; });
    expect(session.activeSession?.id).toBe(sourceId);
    expect(session.hasUnreadSavedChapter).toBe(true);
    expect(session.pendingCompletedChapter).toBeNull();
  });

  it('a successful save followed by failed list read stays saved and cannot repeat the write', async () => {
    const list = storage.listBattleStorySessions;
    let failRead = false;
    vi.spyOn(storage, 'listBattleStorySessions').mockImplementation(async (...args) => {
      if (failRead) { failRead = false; throw new Error('read failure'); }
      return list(...args);
    });
    await mount(); const first = await start(); await finish(first.pending, '# 原章');
    const original = storage.commitCompletedBattleStoryBranch;
    const writer = vi.spyOn(storage, 'commitCompletedBattleStoryBranch').mockImplementationOnce(async (commit) => {
      const receipt = await original(commit); failRead = true; return receipt;
    });
    const { pending } = await branch(); await finish(pending, '# 已存待读分支');
    expect(session.pendingCompletedChapter).toBeNull();
    expect(session.hasUnreadSavedChapter).toBe(true);
    expect(session.actionError).toContain('已保存');
    await act(async () => session.handleRetrySaveChapter());
    expect(writer).toHaveBeenCalledTimes(1);
    await act(async () => session.handleReloadSavedChapter());
    expect(session.selectedChapter?.markdown).toBe('# 已存待读分支');
    expect(writer).toHaveBeenCalledTimes(1); expect(fixture.dispatch).toHaveBeenCalledTimes(2);
  });

});

describe('atomic tail rewrite consumes the shared projection and recovery', () => {
  async function rewrite() {
    let pending!: Promise<void>;
    const before = fixture.dispatch.mock.calls.length;
    await act(async () => { pending = session.handleRewriteLastChapter(); });
    await act(async () => { await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledTimes(before + 1)); });
    return { pending };
  }

  it('rollback retains the same frozen rewrite package and retries without a model or legacy writer', async () => {
    await mount(); const first = await start(); await finish(first.pending, '# 原尾章');
    const before = await storage.readBattleStoryTailRewriteSource(session.activeSession!.id);
    const legacyChapter = vi.spyOn(storage, 'putBattleStoryChapter');
    const legacySupersede = vi.spyOn(storage, 'markBattleStoryChapterSuperseded');
    const writer = vi.spyOn(storage, 'commitCompletedBattleStoryTailRewrite');
    const add = IDBObjectStore.prototype.add;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args) {
      const request = add.apply(this, args);
      if (this.name === AI_SESSION_STORE_NAMES.battleStoryCheckpoints) request.addEventListener('success', () => { try { this.transaction.abort(); } catch { /* already aborted */ } });
      return request;
    });
    const { pending } = await rewrite(); await finish(pending, '# 完整重写正文');
    const chapter = session.pendingCompletedChapter!;
    expect(chapter.action).toBe('rewrite'); expect(session.pendingSaveUnknown).toBe(false);
    expect(session.pendingRoleOutcome).toBeNull();
    expect(await storage.readBattleStoryTailRewriteSource(before.session!.id)).toEqual(before);
    const frozen = writer.mock.calls[0]![0];
    expect(Object.isFrozen(frozen)).toBe(true); expect(Object.isFrozen(frozen.chapter.reportJson)).toBe(true);
    fixture.state.settings.userGuidance = '新草稿不得混入';
    await act(async () => { await session.handleRewriteLastChapter(); await session.handleContinueSession(); });
    fault.mockRestore();
    await act(async () => session.handleRetrySaveChapter());
    expect(writer).toHaveBeenCalledTimes(2); expect(writer.mock.calls[1]![0]).toBe(frozen);
    expect(session.pendingCompletedChapter).toBeNull(); expect(session.selectedChapter?.id).toBe(chapter.id);
    expect(session.activeSession?.chapterCount).toBe(1); expect(session.activeSession?.id).toBe(before.session!.id);
    expect((await storage.getBattleStoryChapter(before.session!.lastChapterId!))?.status).toBe('superseded');
    expect(legacyChapter).not.toHaveBeenCalled(); expect(legacySupersede).not.toHaveBeenCalled();
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
  });

  it('an invalid generated index retains the complete body before save validation', async () => {
    await mount(); const first = await start(); await finish(first.pending, '# 原尾章');
    const before = await storage.readBattleStoryTailRewriteSource(session.activeSession!.id);
    const writer = vi.spyOn(storage, 'commitCompletedBattleStoryTailRewrite');
    const { pending } = await rewrite();
    await act(async () => send(event('session_meta', { chapterIndex: 9 })));
    await finish(pending, '# 错位但完整的正文');
    expect(session.pendingCompletedChapter?.markdown).toBe('# 错位但完整的正文');
    expect(session.pendingCompletedChapter?.index).toBe(9); expect(session.pendingSaveUnknown).toBe(false);
    expect(writer).not.toHaveBeenCalled(); expect(await storage.readBattleStoryTailRewriteSource(before.session!.id)).toEqual(before);
    await act(async () => { session.handleExportPendingChapter(); await session.handleRetrySaveChapter(); });
    expect(fixture.download).toHaveBeenCalledTimes(1); expect(writer).not.toHaveBeenCalled(); expect(fixture.dispatch).toHaveBeenCalledTimes(2);
  });

  it.each(['absence', 'mismatch', 'io'] as const)('unknown tail rewrite %s only queries its original receipt and never writes', async (result) => {
    await mount(); const first = await start(); await finish(first.pending, '# 原章');
    const writer = vi.spyOn(storage, 'commitCompletedBattleStoryTailRewrite').mockRejectedValueOnce(new Error('lost outcome'));
    const { pending } = await rewrite(); await finish(pending, '# 未知重写正文');
    const frozen = writer.mock.calls[0]![0];
    const expected = storage.createBattleStoryTailRewriteReceipt(frozen);
    const query = vi.spyOn(storage, 'getBattleStoryTailRewriteOperationReceipt');
    if (result === 'io') query.mockRejectedValue(new Error('read unavailable'));
    else if (result === 'mismatch') query.mockResolvedValue({ ...expected, contentDigest: `sha256:${'a'.repeat(64)}` });
    else query.mockResolvedValue(null);
    const add = vi.spyOn(IDBObjectStore.prototype, 'add'); const put = vi.spyOn(IDBObjectStore.prototype, 'put'); const remove = vi.spyOn(IDBObjectStore.prototype, 'delete');
    await act(async () => { await session.handleRetrySaveChapter(); await session.handleSavePendingAsNewSession(); });
    expect(query).toHaveBeenCalledWith(frozen.session.id, frozen.operationId, expected.contentDigest);
    expect(writer).toHaveBeenCalledTimes(1); expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    expect(add).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(session.pendingSaveUnknown).toBe(true); expect(session.pendingCompletedChapter?.markdown).toBe('# 未知重写正文');
    await act(async () => session.handleExportPendingChapter()); expect(fixture.download).toHaveBeenCalledTimes(1);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => session.handleDiscardPendingChapter()); expect(session.pendingCompletedChapter).not.toBeNull();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => session.handleDiscardPendingChapter()); expect(session.pendingCompletedChapter).toBeNull();
  });

  it.each(['superseded', 'deleted'] as const)('lost successful response remains receipt-only after the new chapter is %s', async (change) => {
    await mount(); const first = await start(); await finish(first.pending, '# 原章');
    const original = storage.commitCompletedBattleStoryTailRewrite;
    const writer = vi.spyOn(storage, 'commitCompletedBattleStoryTailRewrite').mockImplementationOnce(async (commit) => {
      await original(commit); throw new Error('lost reply');
    });
    const { pending } = await rewrite(); await finish(pending, '# 已保存重写');
    const chapter = session.pendingCompletedChapter!;
    if (change === 'deleted') await storage.deleteBattleStorySession(chapter.sessionId);
    else await storage.markBattleStoryChapterSuperseded({ chapterId: chapter.id, supersededByChapterId: 'later-rewrite' });
    const add = vi.spyOn(IDBObjectStore.prototype, 'add'); const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    await act(async () => session.handleRetrySaveChapter());
    expect(writer).toHaveBeenCalledTimes(1); expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    expect(add).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    if (change === 'deleted') {
      expect(session.pendingCompletedChapter?.id).toBe(chapter.id); expect(session.pendingSaveUnknown).toBe(true);
      expect(await storage.getBattleStorySession(chapter.sessionId)).toBeNull();
    } else expect(session.pendingCompletedChapter).toBeNull();
  });

  it('freezes the clicked tail identity before reading and rejects it if it became a middle chapter', async () => {
    await mount(); const first = await start(); await finish(first.pending, '# 点击时的尾章');
    const source = session.activeSession!;
    const read = storage.readBattleStoryTailRewriteSource;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(storage, 'readBattleStoryTailRewriteSource').mockImplementationOnce(async (id) => { await gate; return read(id); });
    const legacy = vi.spyOn(storage, 'markBattleStoryChapterSuperseded');
    let pending!: Promise<void>;
    await act(async () => { pending = session.handleRewriteLastChapter(); });
    const next = storage.createBattleStoryChapterRecord({ sessionId: source.id, index: 2, action: 'continue', sourceChapterId: source.lastChapterId, title: '另一页续章', markdown: '# 另一页续章', reportJson: {}, deterministicDigest: { chapterTitle: '另一页续章' } });
    await storage.putBattleStoryChapter(next);
    await storage.putBattleStoryCheckpoint(storage.createBattleStoryCheckpointRecord({ sessionId: source.id, boundaryIndex: 2, chapterId: next.id, combatants: source.workingCombatants }));
    await storage.putBattleStorySession({ ...source, chapterCount: 2, lastChapterId: next.id });
    const before = await read(source.id);
    await act(async () => { release(); await pending; });
    expect(session.actionError).not.toBeNull(); expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled(); expect(await read(source.id)).toEqual(before);
  });

  it('fresh source read is fenced by selection epoch, including same-session ABA', async () => {
    await mount(); const first = await start(); await finish(first.pending, '# 原章');
    const sourceId = session.activeSession!.id;
    const read = storage.readBattleStoryTailRewriteSource;
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(storage, 'readBattleStoryTailRewriteSource').mockImplementationOnce(async (id) => { await gate; return read(id); });
    let pending!: Promise<void>; await act(async () => { pending = session.handleRewriteLastChapter(); });
    await act(async () => session.handleSelectSession(sourceId));
    await act(async () => { release(); await pending; });
    expect(fixture.dispatch).toHaveBeenCalledTimes(1); expect(session.pendingCompletedChapter).toBeNull();
  });

  it('consumes real shared projection with a fresh independent snapshot and unchanged rewrite request', async () => {
    await mount(); const first = await start(); await finish(first.pending, '# 原尾章');
    const source = session.activeSession!; const oldTailId = source.lastChapterId!;
    await storage.putBattleStorySession({ ...source, title: '保留标题', chapterPlan: { totalChapters: 1, source: 'user', locked: true }, sessionSummary: '覆盖原章需清除', summaryMeta: { coveredUntilChapterIndex: 1, coveredChapterIds: [oldTailId], refreshedAt: 1, mode: 'ai' } });
    const projection = vi.spyOn(tailRewriteProjection, 'buildCompletedBattleStoryTailRewriteRecords');
    const inputProjection = vi.spyOn(tailRewriteProjection, 'resolveBattleStoryChapterInputCombatants');
    const { pending } = await rewrite();
    const body = JSON.parse(String(fixture.dispatch.mock.calls[1]![1].body));
    expect(body).toMatchObject({ action: 'rewrite', chapterIndex: 1, sourceChapterId: oldTailId });
    expect(body.chapterContext.recentChapters).toHaveLength(1);
    expect(body.chapterContext.recentChapters[0].markdown).toBe('# 原尾章');
    expect(body.chapterContext.sessionSummary).toBeUndefined();
    session.activeSession!.seed.combatants.push({ laterPageDraft: true });
    await finish(pending, '# 纯投影重写');
    expect(session.actionError).toBeNull(); expect(projection).toHaveBeenCalledTimes(2); // hook assembly and writer validation
    expect(inputProjection).toHaveBeenCalled();
    expect(session.activeSession?.title).toBe('保留标题'); expect(session.activeSession?.chapterCount).toBe(1);
    expect(session.activeSession?.seed.combatants).toHaveLength(1); expect(session.activeSession?.sessionSummary).toBeUndefined();
    expect(session.selectedChapter).toMatchObject({ action: 'rewrite', index: 1, sourceChapterId: oldTailId });
  });

  it('repeated tail rewrites keep the chapter index, twelve-chapter window and earlier checkpoints', async () => {
    await mount(); const first = await start(); await finish(first.pending, '# 第一章');
    const source = session.activeSession!;
    let headId = source.lastChapterId!;
    for (let index = 2; index <= 14; index += 1) {
      const chapter = storage.createBattleStoryChapterRecord({
        sessionId: source.id, index, action: 'continue', sourceChapterId: headId,
        title: `第${index}章`, markdown: `# 章${index}`, reportJson: {}, deterministicDigest: { chapterTitle: `第${index}章` },
      });
      await storage.putBattleStoryChapter(chapter);
      await storage.putBattleStoryCheckpoint(storage.createBattleStoryCheckpointRecord({
        sessionId: source.id, boundaryIndex: index, chapterId: chapter.id, combatants: [{ boundary: index }],
      }));
      headId = chapter.id;
    }
    await storage.putBattleStorySession({ ...source, lastChapterId: headId, chapterCount: 14,
      workingCombatants: [{ boundary: 14 }], lastChapterInputCombatants: [{ staleFallback: true }],
      chapterPlan: { totalChapters: 14, source: 'user', locked: true } });
    await act(async () => session.handleSelectSession(source.id));
    const before = await storage.readBattleStoryTailRewriteSource(source.id);
    const earlyCheckpoints = before.checkpoints.filter((checkpoint) => checkpoint.boundaryIndex < 14);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const { pending } = await rewrite();
      const body = JSON.parse(String(fixture.dispatch.mock.calls.at(-1)![1].body));
      expect(body).toMatchObject({ action: 'rewrite', chapterIndex: 14, sourceChapterId: headId });
      expect(body.chapterContext.recentChapters).toHaveLength(12);
      expect(body.chapterContext.recentChapters[0].index).toBe(3);
      expect(body.chapterContext.recentChapters.at(-1).id).toBe(headId);
      expect(body.chapterContext.workingCombatants).toEqual([{ boundary: 13 }]);
      await finish(pending, `# 重写${attempt}`);
      expect(session.actionError).toBeNull();
      expect(session.activeSession?.chapterCount).toBe(14); expect(session.selectedChapter?.index).toBe(14);
      const graph = await storage.readBattleStoryTailRewriteSource(source.id);
      expect(graph.checkpoints.filter((checkpoint) => checkpoint.boundaryIndex < 14)).toEqual(earlyCheckpoints);
      expect(graph.chapters.filter((chapter) => chapter.status === 'superseded')).toHaveLength(attempt);
      expect(graph.chapters.find((chapter) => chapter.id === headId)).toMatchObject({ status: 'superseded', supersededByChapterId: session.selectedChapter!.id });
      headId = session.selectedChapter!.id;
    }
    expect(fixture.dispatch).toHaveBeenCalledTimes(3);
  });

  it('a changed persisted graph during generation retains completed body without replacing the old tail', async () => {
    await mount(); const first = await start(); await finish(first.pending, '# 原尾章');
    const sourceId = session.activeSession!.id;
    const { pending } = await rewrite();
    await storage.updateBattleStorySession(sourceId, (value) => ({ ...value, sessionSummary: '另一页的摘要' }));
    const before = await storage.readBattleStoryTailRewriteSource(sourceId);
    await finish(pending, '# 应保留的重写');
    expect(session.pendingCompletedChapter?.markdown).toBe('# 应保留的重写'); expect(session.pendingSaveUnknown).toBe(false);
    await act(async () => session.handleRetrySaveChapter());
    expect(await storage.readBattleStoryTailRewriteSource(sourceId)).toEqual(before);
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
  });

  it('late successful save does not reselect the old chapter after same-session selection', async () => {
    await mount(); const first = await start(); await finish(first.pending, '# 仍选中的原章');
    const sourceId = session.activeSession!.id; const oldChapterId = session.selectedChapter!.id;
    const original = storage.commitCompletedBattleStoryTailRewrite;
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(storage, 'commitCompletedBattleStoryTailRewrite').mockImplementationOnce(async (commit) => {
      started(); await new Promise<void>((resolve) => { release = resolve; }); return original(commit);
    });
    const { pending } = await rewrite();
    await act(async () => { send(event('markdown', { chunk: '# 晚保存尾章' }) + event('done', { ok: true })); stream.close(); await gate; });
    await act(async () => session.handleSelectSession(sourceId));
    await act(async () => { release(); await pending; });
    expect(session.selectedChapter?.id).toBe(oldChapterId); expect(session.hasUnreadSavedChapter).toBe(true);
    expect(session.pendingCompletedChapter).toBeNull();
  });

  it('successful save followed by read failure is saved-unread, with no second write', async () => {
    const list = storage.listBattleStorySessions; let failRead = false;
    vi.spyOn(storage, 'listBattleStorySessions').mockImplementation(async (...args) => {
      if (failRead) { failRead = false; throw new Error('read failure'); } return list(...args);
    });
    await mount(); const first = await start(); await finish(first.pending, '# 原章');
    const original = storage.commitCompletedBattleStoryTailRewrite;
    const writer = vi.spyOn(storage, 'commitCompletedBattleStoryTailRewrite').mockImplementationOnce(async (commit) => {
      const receipt = await original(commit); failRead = true; return receipt;
    });
    const { pending } = await rewrite(); await finish(pending, '# 已存待读尾章');
    expect(session.pendingCompletedChapter).toBeNull(); expect(session.hasUnreadSavedChapter).toBe(true);
    expect(session.actionError).toContain('已保存');
    await act(async () => { await session.handleRetrySaveChapter(); await session.handleReloadSavedChapter(); });
    expect(session.selectedChapter?.markdown).toBe('# 已存待读尾章');
    expect(writer).toHaveBeenCalledTimes(1); expect(fixture.dispatch).toHaveBeenCalledTimes(2);
  });
});
