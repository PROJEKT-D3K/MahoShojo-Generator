// @vitest-environment jsdom
import { withFixtureStreamReceipt } from './helpers/stream-receipt-fixture';
import { webcrypto } from 'node:crypto';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { TeaReadRequestSchema, TeaWriteRequestSchema, type TeaSessionDocument, type TeaMessageDocument } from '@mahoshojo/contracts/desktop-magic-tea-party';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import * as downloads from '../src/platform/download-text-file';
import { createDesktopRouter } from '../src/app/router';
import { getDesktopAiConfigStore, resetDesktopAiConfigStoreForTests } from '../src/features/ai-config/use-desktop-ai-config';
import { resetDesktopCloudSessionStoreForTests } from '../src/features/account/use-desktop-cloud-session';
import { resetDesktopAnnouncementsStoreForTests } from '../src/features/announcements/use-desktop-announcements';
import { DESKTOP_AI_CONFIG_STORAGE_KEY } from '../src/features/ai-config/desktop-ai-config-store';
const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => true, Channel: class { onmessage?: (_event: unknown) => void; } }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: native.listen }) }));
const profile = { version: 1, id: 'tea-page', name: '合成测试连接', adapter: 'openai-compatible', baseUrl: 'http://127.0.0.1:18080/v1', modelId: 'synthetic', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
let root: Root; let container: HTMLDivElement; let document: TeaSessionDocument | null; let revision: number; let messages: TeaMessageDocument[]; let streams: number;
let streamOutput: string;
const instance = 'a'.repeat(32);
const button = (text: string) => { const node = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === text); expect(node, text).toBeTruthy(); return node!; };
const click = (text: string) => act(async () => button(text).click());
const openSession = (title: string) => act(async () => { const node = [...container.querySelectorAll('button')].find(item => item.querySelector('.line-clamp-1')?.textContent === title); expect(node).toBeTruthy(); node!.click(); });
const change = async (selector: string, value: string) => {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  expect(input, selector).toBeTruthy();
  await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); localStorage.clear(); resetDesktopAiConfigStoreForTests(); resetDesktopCloudSessionStoreForTests();
  resetDesktopAnnouncementsStoreForTests();
  vi.stubGlobal('crypto', webcrypto); native.listen.mockResolvedValue(vi.fn());
  document = null; revision = 1; messages = []; streams = 0;
  streamOutput = '{"type":"narration","text":"共源茶会正文😀"}\n';
  localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 5, selection: { executionPreference: 'client', clientTarget: { kind: 'custom', profileId: profile.id }, serverTarget: { kind: 'system' }, systemModelId: 'default' }, hiddenPresetIds: [], modelsByProfileId: {}, presetsByProviderId: {} }));
  native.invoke.mockImplementation(withFixtureStreamReceipt(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === 'list_provider_profile_ids') return [profile.id];
    if (command === 'get_provider_profile') return JSON.stringify(profile);
    if (command === 'has_provider_secret') return true;
    if (command === 'cloud_cached_account') return null;
    if (command === 'cloud_auth_status') return { state: 'signed-out' };
    if (command === 'list_local_cards' || command === 'list_web_packages') return { documents: [] };
    if (command === 'read_magic_tea_party') {
      const request = TeaReadRequestSchema.parse(args.request).request;
      if (request.action === 'list') return { version: 1, result: { action: 'list', catalogRevision: revision, rows: document ? [{ id: document.id, instance, revision, title: document.title, titleTruncated: false, createdAt: document.createdAt, updatedAt: document.updatedAt, messageCount: messages.length, roleNames: document.roles.map(role => role.name), roleCount: document.roles.length, scenarioTitle: null }] : [], nextCursor: null } };
      if (request.action === 'session') return { version: 1, result: { action: 'session', catalogRevision: revision, record: document ? { session: document, instance, revision } : null } };
      if (request.action === 'messages') return { version: 1, result: { action: 'messages', catalogRevision: revision, sessionId: document!.id, instance, revision, rows: messages.map((message, index) => ({ ordinal: index + 1, message })), nextCursor: null } };
      throw new Error('unconfigured read');
    }
    if (command === 'mutate_magic_tea_party') {
      const request = TeaWriteRequestSchema.parse(args.request).request;
      if (request.action === 'import') throw new Error('not used by page fixture');
      revision = request.action === 'create' ? 1 : request.expectedRevision + (request.action === 'delete' ? 0 : 1);
      const sessionId = request.action === 'create' ? request.session.id : request.sessionId;
      if (request.action === 'delete') { document = null; messages = []; } else document = request.session;
      if (request.action === 'begin-generation') { if (request.userMessage) messages.push(request.userMessage); messages.push(request.assistantMessage); }
      if (request.action === 'finish-generation') messages = messages.map(message => message.id === request.assistantMessage.id ? request.assistantMessage : message);
      return { version: 1, result: { action: request.action, sessionId, instance, revision,
        ...('operationId' in request ? { operationId: request.operationId, assistantMessageId: request.assistantMessage.id } : {}) } };
    }
    if (command === 'stream_target_ai') {
      streams += 1; const request = args.request as { requestId: string; contractVersion: 1; mode: 'direct-local' };
      const channel = args.onEvent as { onmessage: (_event: AiStreamEvent) => void };
      const identity = { requestId: request.requestId, contractVersion: request.contractVersion, mode: request.mode };
      const text = streamOutput;
      channel.onmessage({ ...identity, sequence: 0, type: 'started' }); channel.onmessage({ ...identity, sequence: 1, type: 'text-delta', delta: text });
      channel.onmessage({ ...identity, sequence: 2, type: 'result', result: { ...identity, status: 'completed', output: { text }, finishReason: 'stop' } }); return;
    }
    throw new Error(`Unconfigured native boundary ${command}`);
  }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === '/announcements.json' && init?.credentials === 'omit' && init.redirect === 'error') return new Response('[]', { status: 200 });
    throw new Error('Tea must not use renderer network');
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); HTMLElement.prototype.scrollIntoView = vi.fn(); HTMLElement.prototype.scrollTo = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; }; HTMLDialogElement.prototype.close = function () { this.open = false; };
  container = window.document.createElement('div'); window.document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const mount = async (href = '#/magic-tea-party') => {
  window.location.hash = href; const router = createDesktopRouter(); await router.load();
  await act(async () => root.render(<StrictMode><RouterProvider router={router} /></StrictMode>));
  await act(async () => getDesktopAiConfigStore().refreshProfiles());
  return router;
};
it('opens a legacy deep link in the existing tea page without creating a session or changing provider state', async () => {
  // 先完成既有配置归一化，再单独检查旧深链导航的副作用。
  getDesktopAiConfigStore().init();
  await getDesktopAiConfigStore().refreshProfiles();
  const preference = localStorage.getItem(DESKTOP_AI_CONFIG_STORAGE_KEY);
  const router = await mount('#/magic-tavern?session=%E6%98%9F%E8%A6%8B#%E8%8C%B6%E4%BC%9A');
  expect(router.state.location.pathname).toBe('/magic-tea-party');
  expect(container.textContent).toContain('本地文本茶会');
  expect(container.querySelector('[data-testid="page-tavern"]')).toBeNull();
  expect(document).toBeNull(); expect(messages).toEqual([]); expect(streams).toBe(0);
  expect(native.invoke.mock.calls.some(([command]) => command === 'mutate_magic_tea_party')).toBe(false);
  expect(native.invoke.mock.calls.some(([command]) => command === 'open_external_url')).toBe(false);
  expect(native.invoke.mock.calls.some(([command]) => /^(save|delete|set)_provider_/.test(command))).toBe(false);
  expect(localStorage.getItem(DESKTOP_AI_CONFIG_STORAGE_KEY)).toBe(preference);
  expect(vi.mocked(fetch).mock.calls).toEqual([['/announcements.json', { credentials: 'omit', redirect: 'error' }]]);
});
it('runs the delivered route with shared layout, real owner/IPC/Direct adapters and unchanged ordinary provider preference', async () => {
  await mount(); const preference = localStorage.getItem(DESKTOP_AI_CONFIG_STORAGE_KEY);
  expect(container.querySelector('.container')?.className).toBe('container !max-w-[1200px]');
  expect(container.textContent).toContain('本地文本茶会'); expect(button('生成选项').title).toContain('当前模型');
  await click('新建会话');
  await change('textarea[placeholder^="粘贴角色"]', JSON.stringify({ templateId: '通用角色', name: '星見', content: '完整设定' }));
  await click('导入'); expect(document?.roles[0]?.name).toBe('星見');
  const composer = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="输入你的行动"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, '喝茶'); composer.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('发送');
  expect(streams).toBe(1); expect(container.textContent).toContain('共源茶会正文😀');
  expect(messages.at(-1)).toMatchObject({ status: 'done', meta: { completion: 'provider' } });
  expect(localStorage.getItem(DESKTOP_AI_CONFIG_STORAGE_KEY)).toBe(preference);
  expect(vi.mocked(fetch).mock.calls).toEqual([['/announcements.json', { credentials: 'omit', redirect: 'error' }]]);
  expect(container.querySelector('img[src^="http"]')).toBeNull();
});
it.each(['Markdown', 'JSONL'])('runs manual choices → one-click send → continue with unchanged %s preference and retained draft', async format => {
  await mount(); await click('新建会话'); await click(format);
  await change('textarea[placeholder^="输入你的行动"]', '保留未发送草稿');
  streamOutput = '{"type":"choices","items":[{"id":"c1","text":"端起热茶"},{"id":"c2","text":"走向窗边"}]}';
  await act(async () => { button('生成选项').click(); button('生成选项').click(); });
  expect(streams).toBe(1); expect(messages.filter(message => message.role === 'user')).toHaveLength(0);
  expect(document).toMatchObject({ settings: { outputFormat: format === 'Markdown' ? 'markdown' : 'jsonl' }, draft: '保留未发送草稿', lastChoices: [{ id: 'c1', text: '端起热茶' }, { id: 'c2', text: '走向窗边' }] });
  expect(button('端起热茶').title).toBe('选择该行动'); streamOutput = format === 'Markdown' ? '接着讲故事' : '{"type":"narration","text":"接着讲故事"}';
  await act(async () => { button('端起热茶').click(); button('走向窗边').click(); });
  expect(streams).toBe(2); expect(messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['端起热茶']);
  expect(container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="输入你的行动"]')!.value).toBe('保留未发送草稿');
  await click('继续生成'); expect(streams).toBe(3); expect(messages.filter(message => message.role === 'user')).toHaveLength(1);
  expect(document?.draft).toBe('保留未发送草稿');
});
it('shows invalid choices as preserved text instead of actionable buttons', async () => {
  await mount(); await click('新建会话');
  streamOutput = '{"type":"choices","items":[{"id":"c1","text":"不可执行的前缀"}]}\n{"type":"notice","level":"error","message":"生成要求未满足"}';
  await click('生成选项'); expect(container.textContent).toContain('不可执行的前缀');
  expect([...container.querySelectorAll('button')].some(node => node.textContent?.trim() === '不可执行的前缀')).toBe(false);
  expect(messages.at(-1)).toMatchObject({ status: 'error', meta: { rawOutput: streamOutput, choicesValid: false } });
  expect(streams).toBe(1);
});
it('preserves composer draft across preference updates and keeps null/player selection truthful', async () => {
  await mount(); await click('新建会话');
  await change('textarea[placeholder^="粘贴角色"]', JSON.stringify({ templateId: '通用角色', name: '唯一角色', content: '设定' })); await click('导入');
  const composer = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="输入你的行动"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, '保住草稿'); composer.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('Markdown'); expect(document?.draft).toBe('保住草稿'); expect(composer.value).toBe('保住草稿');
  const select = [...container.querySelectorAll('select')].find(item => [...item.options].some(option => option.textContent === '唯一角色'))!;
  expect(select.value).toBe(''); expect([...select.options].map(option => option.value)).toContain('');
  await act(async () => { select.value = document!.roles[0]!.id; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(document?.playerRoleId).toBe(document!.roles[0]!.id);
  await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(document?.playerRoleId).toBeNull(); expect(composer.value).toBe('保住草稿');
});
it('stages continuous title and display-name typing without per-character writes or disabling the fields', async () => {
  await mount(); await click('新建会话');
  const writes = () => native.invoke.mock.calls.filter(([command]) => command === 'mutate_magic_tea_party').length;
  const before = writes();
  for (const value of ['新', '新的', '新的标题😀']) {
    await change('input[placeholder="输入会话标题"]', value);
    expect(container.querySelector<HTMLInputElement>('input[placeholder="输入会话标题"]')!.matches(':disabled')).toBe(false);
  }
  for (const value of ['小', '小星', '小星😀']) await change('input[placeholder^="例如：旅人"]', value);
  expect(writes()).toBe(before); expect(document?.title).toBe('新茶会');
  await click('保存会话草稿');
  expect(writes()).toBe(before + 1); expect(document).toMatchObject({ title: '新的标题😀', settings: { userDisplayName: '小星😀' } });
});
it.each([false, true])('freezes the click intent while a real preset credential check is deferred (cancel=%s)', async cancel => {
  const router = await mount(); await click('新建会话');
  await act(async () => getDesktopAiConfigStore().selectProviderTarget({ kind: 'preset', providerId: 'deepseek' }));
  const composer = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="输入你的行动"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, '点击时原输入'); composer.dispatchEvent(new Event('input', { bubbles: true })); });
  const original = native.invoke.getMockImplementation()!; let release!: () => void;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'has_provider_secret') await new Promise<void>(resolve => { release = resolve; });
    return original(command, args);
  });
  await click('发送'); expect(release).toBeTypeOf('function'); expect(streams).toBe(0);
  expect(composer.disabled).toBe(true); expect(button('新建').matches(':disabled')).toBe(true);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, '不得替换的新输入'); composer.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { void router.navigate({ to: '/settings' }); });
  expect(container.textContent).toContain('茶会仍有生成');
  if (cancel) await click('停止生成');
  await act(async () => release());
  expect(streams).toBe(cancel ? 0 : 1);
  if (cancel) expect(composer.value).toBe('点击时原输入');
  else expect(messages.find(message => message.role === 'user')?.content).toBe('点击时原输入');
  expect(getDesktopAiConfigStore().getSnapshot().generationActive).toBe(false);
});
it.each([
  ['choices', false], ['choices', true], ['selected-choice', false], ['selected-choice', true],
] as const)('freezes %s and its independent draft during credential preparation (cancel=%s)', async (kind, cancel) => {
  await mount(); await click('新建会话'); await click('Markdown');
  streamOutput = '{"type":"choices","items":[{"id":"c1","text":"冻结点击的行动"}]}';
  if (kind === 'selected-choice') await click('生成选项');
  const before = streams; await change('textarea[placeholder^="输入你的行动"]', '不能替换的草稿');
  await act(async () => getDesktopAiConfigStore().selectProviderTarget({ kind: 'preset', providerId: 'deepseek' }));
  const original = native.invoke.getMockImplementation()!; let release!: () => void;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'has_provider_secret') await new Promise<void>(resolve => { release = resolve; });
    return original(command, args);
  });
  const label = kind === 'choices' ? '生成选项' : '冻结点击的行动';
  await act(async () => { button(label).click(); button(label).click(); });
  expect(streams).toBe(before); expect(release).toBeTypeOf('function');
  const composer = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="输入你的行动"]')!;
  expect(composer.disabled).toBe(true); expect(button('新建').matches(':disabled')).toBe(true);
  await change('textarea[placeholder^="输入你的行动"]', '不可晚到覆盖');
  if (cancel) await click('停止生成');
  await act(async () => release());
  expect(streams).toBe(before + (cancel ? 0 : 1)); expect(composer.value).toBe('不能替换的草稿');
  expect(document?.settings.outputFormat).toBe('markdown');
  expect(messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(kind === 'selected-choice' && !cancel ? ['冻结点击的行动'] : []);
  expect(getDesktopAiConfigStore().getSnapshot().generationActive).toBe(false);
});
it('keeps unsubmitted paste behind the leave guard and allows explicit local clearing after session deletion', async () => {
  const router = await mount(); await click('新建会话');
  await change('textarea[placeholder^="粘贴角色"]', '尚未导入的唯一原文');
  await act(async () => { void router.navigate({ to: '/settings' }); });
  expect(container.textContent).toContain('茶会仍有生成');
  await click('删除'); await click('确认删除');
  const paste = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="粘贴角色"]')!;
  expect(document).toBeNull(); expect(paste.value).toBe('尚未导入的唯一原文');
  const clear = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === '清空' && !item.disabled)!;
  expect(clear).toBeTruthy(); await act(async () => clear.click()); expect(paste.value).toBe('');
  await act(async () => { await router.navigate({ to: '/settings' }); });
  expect(container.querySelector('[data-testid="page-settings"]')).toBeTruthy();
});
it.each(['/settings', '/magic-tavern'] as const)('retains unsaved draft and blocks %s departure until its explicit save', async (to) => {
  const router = await mount(); await click('新建会话');
  const composer = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="输入你的行动"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, '未保存😀'); composer.dispatchEvent(new Event('input', { bubbles: true })); });
  const sessionId = document?.id;
  const preference = localStorage.getItem(DESKTOP_AI_CONFIG_STORAGE_KEY);
  const writesBeforeNavigation = native.invoke.mock.calls.filter(([command]) => command === 'mutate_magic_tea_party').length;
  await act(async () => { void router.navigate({ to }); });
  expect(container.textContent).toContain('茶会仍有生成');
  expect(router.state.location.pathname).toBe('/magic-tea-party');
  expect(window.location.hash).toBe('#/magic-tea-party');
  expect(composer.value).toBe('未保存😀');
  expect(native.invoke.mock.calls.filter(([command]) => command === 'mutate_magic_tea_party')).toHaveLength(writesBeforeNavigation);
  await click('保存会话草稿'); expect(document?.draft).toBe('未保存😀');
  await act(async () => { await router.navigate({ to }); });
  if (to === '/settings') expect(container.querySelector('[data-testid="page-settings"]')).toBeTruthy();
  else {
    expect(router.state.location.pathname).toBe('/magic-tea-party');
    expect(window.location.hash).toBe('#/magic-tea-party');
    expect(container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="输入你的行动"]')!.value).toBe('未保存😀');
  }
  expect(document?.id).toBe(sessionId); expect(streams).toBe(0);
  expect(localStorage.getItem(DESKTOP_AI_CONFIG_STORAGE_KEY)).toBe(preference);
});

it('runs the real page manual summary controls, preserves draft and persists full edited text before clearing', async () => {
  await mount(); await click('新建会话'); await change('textarea[placeholder^="输入你的行动"]', '先前剧情'); await click('发送');
  await change('textarea[placeholder^="输入你的行动"]', '不能发出的草稿');
  await change('textarea[aria-label="会话摘要正文"]', '  手工摘要原件  ');
  expect(document?.summary).toBeUndefined(); expect(button('保存摘要').disabled).toBe(false);
  await click('保存摘要'); expect(document?.summary).toBe('  手工摘要原件  ');
  streamOutput = '  成功的摘要正文😀  ';
  await act(async () => { button('生成/更新摘要').click(); button('生成/更新摘要').click(); });
  expect(streams).toBe(2); expect(document?.summary).toBe('成功的摘要正文😀');
  expect(document?.draft).toBe('不能发出的草稿'); expect(messages.at(-1)).toMatchObject({ meta: { kind: 'summary', rawOutput: streamOutput } });
  expect(container.textContent).toContain('魔法茶会 · 摘要操作');
  const calls = native.invoke.mock.calls.filter(([command]) => command === 'stream_target_ai');
  const summaryRequest = calls.at(-1)![1]!.request as { messages: Array<{ content: string }> };
  expect(summaryRequest.messages[0]!.content).toContain('【任务】生成会话摘要'); expect(summaryRequest.messages[0]!.content).not.toContain('不能发出的草稿');
  await act(async () => root.unmount()); root = createRoot(container); await mount(); await openSession('新茶会');
  expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="会话摘要正文"]')!.value).toBe('成功的摘要正文😀');
  const panel = container.querySelector('textarea[aria-label="会话摘要正文"]')!.closest('.rounded-xl')!;
  await act(async () => [...panel.querySelectorAll('button')].find(node => node.textContent === '清空')!.click());
  expect(document?.summary).toBeUndefined(); expect(document?.summaryMeta).toBeUndefined();
  expect(streams).toBe(2);
});
it('protects summary drafts on departure and does not write one session document for each keystroke', async () => {
  const router = await mount(); await click('新建会话');
  const before = native.invoke.mock.calls.filter(([command]) => command === 'mutate_magic_tea_party').length;
  await change('textarea[aria-label="会话摘要正文"]', '一'); await change('textarea[aria-label="会话摘要正文"]', '完整编辑中的摘要');
  expect(native.invoke.mock.calls.filter(([command]) => command === 'mutate_magic_tea_party')).toHaveLength(before);
  await act(async () => { void router.navigate({ to: '/settings' }); }); expect(container.textContent).toContain('茶会仍有生成');
  await click('保存摘要'); expect(document?.summary).toBe('完整编辑中的摘要');
  await act(async () => { await router.navigate({ to: '/settings' }); }); expect(container.querySelector('[data-testid="page-settings"]')).toBeTruthy();
});
it.each([false, true])('freezes manual summary and composer edits during credential preparation (cancel=%s)', async cancel => {
  await mount(); await click('新建会话'); await change('textarea[placeholder^="输入你的行动"]', '已有历史'); await click('发送');
  const before = streams; await change('textarea[placeholder^="输入你的行动"]', '冻结草稿'); await change('textarea[aria-label="会话摘要正文"]', '冻结摘要编辑');
  await act(async () => getDesktopAiConfigStore().selectProviderTarget({ kind: 'preset', providerId: 'deepseek' }));
  const original = native.invoke.getMockImplementation()!; let release!: () => void;
  native.invoke.mockImplementation(async (command, args) => { if (command === 'has_provider_secret') await new Promise<void>(resolve => { release = resolve; }); return original(command, args); });
  await act(async () => { button('生成/更新摘要').click(); button('生成/更新摘要').click(); });
  expect(streams).toBe(before); expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="会话摘要正文"]')!.disabled).toBe(true);
  await change('textarea[aria-label="会话摘要正文"]', '不得迟到替换'); await change('textarea[placeholder^="输入你的行动"]', '不得迟到发出');
  if (cancel) await click('停止生成'); streamOutput = '摘要完成'; await act(async () => release());
  expect(streams).toBe(before + (cancel ? 0 : 1)); expect(container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="输入你的行动"]')!.value).toBe('冻结草稿');
  expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="会话摘要正文"]')!.value).toBe(cancel ? '冻结摘要编辑' : '摘要完成');
  expect(getDesktopAiConfigStore().getSnapshot().generationActive).toBe(false);
});

it('offers an actual export after staged summary admission fails, with no Native write or model call', async () => {
  await mount(); await click('新建会话'); document!.future = 'x'.repeat(8 * 1024 * 1024 - 4000); await openSession('新茶会');
  const text = '原件'.repeat(3000); await change('textarea[aria-label="会话摘要正文"]', text);
  const before = native.invoke.mock.calls.filter(([command]) => command === 'mutate_magic_tea_party').length;
  await click('保存摘要'); expect(streams).toBe(0); expect(document?.summary).toBeUndefined();
  expect(native.invoke.mock.calls.filter(([command]) => command === 'mutate_magic_tea_party')).toHaveLength(before);
  expect(container.textContent).toContain('内容超过桌面文本存储边界');
  const download = vi.spyOn(downloads, 'downloadTextFile').mockImplementation(() => {});
  await click('导出未保存摘要'); expect(download).toHaveBeenCalledOnce();
  expect(JSON.parse(download.mock.calls[0]![1])).toMatchObject({ summary: text, future: document!.future });
});

it('persists the actual per-session automatic switch without invoking a model, then summarizes one normal turn', async () => {
  document = { id: 'automatic-page', title: '显式自动摘要茶会', createdAt: 1, updatedAt: 1, roles: [],
    settings: { providerId: 'openai', modelId: 'synthetic', outputFormat: 'markdown', maxContextMessages: 2, summaryMinGapMessages: 8 } };
  messages = Array.from({ length: 8 }, (_, index) => ({ id: `auto-history-${index}`, sessionId: document!.id,
    role: 'user' as const, content: `原始剧情${index}`, createdAt: index, status: 'done' as const }));
  const before = JSON.stringify(messages);
  await mount(); await openSession('显式自动摘要茶会');
  const checkbox = [...container.querySelectorAll('label')].find(label => label.textContent?.includes('自动更新会话摘要'))!.querySelector<HTMLInputElement>('input')!;
  expect(checkbox.checked).toBe(false); expect(streams).toBe(0);
  await act(async () => checkbox.click());
  expect(document?.settings.autoSummaryEnabled).toBe(true); expect(streams).toBe(0);
  streamOutput = '正常剧情和摘要'; await click('继续生成');
  expect(streams).toBe(2); expect(document?.summary).toBe('正常剧情和摘要');
  expect(JSON.stringify(messages.slice(0, 8))).toBe(before);
  expect(messages.at(-1)?.meta?.kind).toBe('summary');
});

it('restores sidebar folding and persists toggles without mutating tea sessions', async () => {
  const key = 'magic-tea-party:session-sidebar-v1';
  localStorage.setItem(key, JSON.stringify({ pinnedCollapsed: true, recentCollapsed: true }));
  await mount(); await click('新建会话');
  native.invoke.mockClear();
  const recent = () => [...container.querySelectorAll('button')].find(b => b.textContent?.includes('最近会话（'));
  expect(recent()?.textContent).toContain('展开');
  await act(async () => recent()!.click());
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ pinnedCollapsed: true, recentCollapsed: false });
  await act(async () => root.unmount()); root = createRoot(container); await mount();
  expect(recent()?.textContent).toContain('收起');
  expect(native.invoke.mock.calls.some(([command]) => command === 'mutate_magic_tea_party')).toBe(false);
});
