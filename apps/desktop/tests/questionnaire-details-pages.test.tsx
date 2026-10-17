// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { invoke } from '@tauri-apps/api/core';
import { normalizeQuestionnaireDefinition } from '@mahoshojo/domain/questionnaire-definition';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDesktopRouter } from '../src/app/router';
import { DETAILS_DRAFT_KEY } from '../src/features/details/session';
import { CANSHOU_DRAFT_KEY } from '../src/features/canshou/session';
import { CREATOR_DRAFT_KEY } from '../src/features/creator/session';
import { DESKTOP_AI_CONFIG_STORAGE_KEY } from '../src/features/ai-config/desktop-ai-config-store';
import { resetDesktopAiConfigStoreForTests } from '../src/features/ai-config/use-desktop-ai-config';
import { resetDesktopCloudSessionStoreForTests } from '../src/features/account/use-desktop-cloud-session';
import { resetDesktopAnnouncementsStoreForTests } from '../src/features/announcements/use-desktop-announcements';
import { resetDesktopConfigStoreForTests } from '../src/features/config/use-desktop-config';
import { resetTopbarAvatarForTests } from '../src/features/account/use-topbar-avatar';

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: vi.fn(async (command: string) => {
    if (command === 'cloud_cached_account' || command === 'announcements_get_cached') return null;
    if (command === 'desktop_config_read') return {
      path: '/config.json', directory: '/', backupPresent: false, invalidPresent: false,
      file: { status: 'missing' },
    };
    if (command === 'announcements_refresh') return {
      status: 'not-modified', snapshot: { fetchedAt: '2026-10-10T00:00:00Z', announcements: [] },
    };
    return undefined;
  }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => {} }),
}));
vi.mock('../src/platform/provider-profile-bridge', () => ({
  listProviderProfileIds: async () => ['local'],
  getProviderProfile: async () => ({
    id: 'local', name: '详情测试连接', adapter: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'model',
  }),
}));
vi.mock('../src/features/external-links/external-links-provider', async (original) => ({
  ...await original<object>(),
  useExternalLinks: () => ({ openContent: mocks.open, openFixed: vi.fn() }),
}));

let root: Root;
let container: HTMLDivElement;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
const click = async (element: HTMLElement) => { await act(async () => element.click()); await settle(); };
const button = (label: string) => [...container.querySelectorAll('button')]
  .find((element) => element.textContent?.trim() === label)!;
const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); window.localStorage.clear();
  window.localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({
    version: 2, selection: { executionPreference: 'client', clientConnectionId: 'local' }, hiddenPresetIds: [],
  }));
  resetDesktopAiConfigStoreForTests(); resetDesktopCloudSessionStoreForTests();
  resetDesktopAnnouncementsStoreForTests(); resetDesktopConfigStoreForTests(); resetTopbarAvatarForTests();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => ({
    ok: true, json: async () => String(input).includes('languages') ? [] : { presets: [] },
  })));
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  HTMLDialogElement.prototype.showModal = originalShowModal; HTMLDialogElement.prototype.close = originalClose;
});

it.each([
  { path: '/details', draftKey: DETAILS_DRAFT_KEY, kind: 'magical-girl', source: 'upload', selectionId: 'cache:questionnaire', sourceLabel: '公开库缓存快照' },
  { path: '/canshou', draftKey: CANSHOU_DRAFT_KEY, kind: 'canshou', source: 'upload', selectionId: 'local:questionnaire', sourceLabel: '本地上传/本地库' },
  { path: '/creator', draftKey: CREATOR_DRAFT_KEY, kind: 'magical-girl', source: 'database', selectionId: 'cloud:questionnaire', sourceLabel: '云端数据卡' },
])('$path reads the current questionnaire copy without changing its draft or querying its source', async ({ path, draftKey, kind, source, selectionId, sourceLabel }) => {
  window.localStorage.setItem(draftKey, JSON.stringify({
    version: 1, answers: { [`${selectionId}::first`]: '保留回答' }, language: 'zh-CN',
    template: 'magical-girl', generationMode: 'non-stream', freeformBrief: '', selectedRuleIds: [], primaryRuleId: null,
    questionnaireSelections: [{
      source, selectionId, ...(source === 'database' ? { dataCardId: 'questionnaire' } : {}),
      dataCardAuthor: '问卷作者', useLore: false,
      questionnaire: {
        id: 'questionnaire', kind, title: '问卷阅读测试', description: '问卷简介', nativeAllowed: false,
        loreMarkdown: '# 设定标题\n\n**可读设定**\n\n[外链](https://example.com/read) [相对链接](relative.md) ![外图](https://example.com/image.png)',
        questions: [{ id: 'first', question: '**问题内容**', type: 'text', helperText: '回答提示' }],
      },
    }],
  }));
  window.location.hash = `#${path}`;
  const router = createDesktopRouter(); await router.load();
  await act(async () => root.render(<StrictMode><RouterProvider router={router} /></StrictMode>));
  await settle();
  const toggle = [...container.querySelectorAll('button')].find((element) => element.textContent?.includes('问卷设置'))!;
  await click(toggle);
  const storedDraft = window.localStorage.getItem(draftKey)!;
  // 恢复时 session 会归一化内存定义，磁盘原文无需因此重写。
  const currentQuestionnaire = normalizeQuestionnaireDefinition(JSON.parse(storedDraft).questionnaireSelections[0].questionnaire);
  const fetchCount = vi.mocked(fetch).mock.calls.length;
  const invokeCount = vi.mocked(invoke).mock.calls.length;
  for (const closeByEscape of [true, false]) {
    const trigger = button('详情'); trigger.focus(); await click(trigger);
    const modal = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(modal, 'the questionnaire uses the shared readable details modal').not.toBeNull();
    // 产品 .card 有 backdrop-filter，会把 fixed 遮罩约束到卡片而不是视口。
    expect(modal!.closest('.card'), 'the fixed overlay must sit outside the filtered page card').toBeNull();
    expect(modal!.textContent).toContain('当前问卷副本');
    expect(modal!.textContent).toContain(sourceLabel);
    expect([...modal!.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((node) => node.textContent)).toContain('设定标题');
    expect([...modal!.querySelectorAll('strong')].map((node) => node.textContent)).toContain('可读设定');
    expect(modal!.querySelector('img, video, audio, iframe')).toBeNull();
    const raw = [...modal!.querySelectorAll('details')].find((element) => element.querySelector('summary')?.textContent === '当前问卷 JSON（已归一化）')!;
    expect(raw.open).toBe(false);
    expect(raw.querySelector('pre')?.textContent).toBe(JSON.stringify(currentQuestionnaire, null, 2));
    expect(modal!.textContent).not.toContain('存到本地库');
    expect(modal!.textContent).not.toContain('最近严格排位');
    const close = modal!.querySelector<HTMLButtonElement>('button[aria-label="关闭问卷详情"]')!;
    expect(document.activeElement).toBe(close);
    await click(modal!.querySelector<HTMLAnchorElement>('a[href="relative.md"]')!);
    expect(mocks.open).toHaveBeenLastCalledWith('relative.md');
    if (closeByEscape) {
      await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
      await settle();
    } else await click(close);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="escape-menu-root"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  }
  expect(window.localStorage.getItem(draftKey)).toBe(storedDraft);
  expect(vi.mocked(fetch).mock.calls.length).toBe(fetchCount);
  expect(vi.mocked(invoke).mock.calls.length).toBe(invokeCount);
  expect(router.state.location.pathname).toBe(path);
});
