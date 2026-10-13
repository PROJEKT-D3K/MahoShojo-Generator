// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { TeaReadRequestSchema, TeaWriteRequestSchema, type TeaSessionDocument, type TeaMessageDocument } from '@mahoshojo/contracts/desktop-magic-tea-party';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import { createDesktopRouter } from '../src/app/router';
import { getDesktopAiConfigStore, resetDesktopAiConfigStoreForTests } from '../src/features/ai-config/use-desktop-ai-config';
import { resetDesktopCloudSessionStoreForTests } from '../src/features/account/use-desktop-cloud-session';
import { DESKTOP_AI_CONFIG_STORAGE_KEY } from '../src/features/ai-config/desktop-ai-config-store';
const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => true, Channel: class { onmessage?: (_event: unknown) => void; } }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: native.listen }) }));
const profile = { version: 1, id: 'tea-page', name: '合成测试连接', adapter: 'openai-compatible', baseUrl: 'http://127.0.0.1:18080/v1', modelId: 'synthetic', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
let root: Root; let container: HTMLDivElement; let document: TeaSessionDocument | null; let revision: number; let messages: TeaMessageDocument[]; let streams: number;
const instance = 'a'.repeat(32);
const button = (text: string) => { const node = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === text); expect(node, text).toBeTruthy(); return node!; };
const click = (text: string) => act(async () => button(text).click());
const change = async (selector: string, value: string) => {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  expect(input, selector).toBeTruthy();
  await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); localStorage.clear(); resetDesktopAiConfigStoreForTests(); resetDesktopCloudSessionStoreForTests();
  vi.stubGlobal('crypto', webcrypto); native.listen.mockResolvedValue(vi.fn());
  document = null; revision = 1; messages = []; streams = 0;
  localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 5, selection: { executionPreference: 'client', clientTarget: { kind: 'custom', profileId: profile.id }, serverTarget: { kind: 'system' }, systemModelId: 'default' }, hiddenPresetIds: [], modelsByProfileId: {}, presetsByProviderId: {} }));
  native.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
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
      const text = '{"type":"narration","text":"共源茶会正文😀"}\n';
      channel.onmessage({ ...identity, sequence: 0, type: 'started' }); channel.onmessage({ ...identity, sequence: 1, type: 'text-delta', delta: text });
      channel.onmessage({ ...identity, sequence: 2, type: 'result', result: { ...identity, status: 'completed', output: { text }, finishReason: 'stop' } }); return;
    }
    throw new Error(`Unconfigured native boundary ${command}`);
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === '/announcements.json' && init?.credentials === 'omit' && init.redirect === 'error') return new Response('[]', { status: 200 });
    throw new Error('Tea must not use renderer network');
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); HTMLElement.prototype.scrollIntoView = vi.fn(); HTMLElement.prototype.scrollTo = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; }; HTMLDialogElement.prototype.close = function () { this.open = false; };
  container = window.document.createElement('div'); window.document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const mount = async () => {
  window.location.hash = '#/magic-tea-party'; const router = createDesktopRouter(); await router.load();
  await act(async () => root.render(<StrictMode><RouterProvider router={router} /></StrictMode>));
  await act(async () => getDesktopAiConfigStore().refreshProfiles());
  return router;
};
it('runs the delivered route with shared layout, real owner/IPC/Direct adapters and unchanged ordinary provider preference', async () => {
  await mount(); const preference = localStorage.getItem(DESKTOP_AI_CONFIG_STORAGE_KEY);
  expect(container.querySelector('.container')?.className).toBe('container !max-w-[1200px]');
  expect(container.textContent).toContain('本地文本茶会'); expect(container.textContent).not.toContain('生成选项');
  await click('新建会话');
  await change('textarea[placeholder^="粘贴角色"]', JSON.stringify({ templateId: '通用角色', name: '星見', content: '完整设定' }));
  await click('导入'); expect(document?.roles[0]?.name).toBe('星見');
  const composer = [...container.querySelectorAll('textarea')].find(item => !item.placeholder.startsWith('粘贴'))!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, '喝茶'); composer.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('发送');
  expect(streams).toBe(1); expect(container.textContent).toContain('共源茶会正文😀');
  expect(messages.at(-1)).toMatchObject({ status: 'done', meta: { completion: 'provider' } });
  expect(localStorage.getItem(DESKTOP_AI_CONFIG_STORAGE_KEY)).toBe(preference);
  expect(vi.mocked(fetch).mock.calls).toEqual([['/announcements.json', { credentials: 'omit', redirect: 'error' }]]);
  expect(container.querySelector('img[src^="http"]')).toBeNull();
});
it('preserves composer draft across preference updates and keeps null/player selection truthful', async () => {
  await mount(); await click('新建会话');
  await change('textarea[placeholder^="粘贴角色"]', JSON.stringify({ templateId: '通用角色', name: '唯一角色', content: '设定' })); await click('导入');
  const composer = [...container.querySelectorAll('textarea')].find(item => !item.placeholder.startsWith('粘贴'))!;
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
  const composer = [...container.querySelectorAll('textarea')].find(item => !item.placeholder.startsWith('粘贴'))!;
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
it('retains unsaved draft and blocks route departure until its explicit save', async () => {
  const router = await mount(); await click('新建会话');
  const composer = [...container.querySelectorAll('textarea')].find(item => !item.placeholder.startsWith('粘贴'))!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, '未保存😀'); composer.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { void router.navigate({ to: '/settings' }); });
  expect(container.textContent).toContain('茶会仍有生成');
  await click('保存会话草稿'); expect(document?.draft).toBe('未保存😀');
  await act(async () => { await router.navigate({ to: '/settings' }); });
  expect(container.querySelector('[data-testid="page-settings"]')).toBeTruthy();
});
