// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { RouterProvider } from '@tanstack/react-router';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), execute: vi.fn(), save: vi.fn(), profiles: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {} }) }));
vi.mock('../src/platform/provider-profile-bridge', () => ({ listProviderProfileIds: async () => ['local'], getProviderProfile: mocks.profiles }));
vi.mock('../src/platform/local-card-bridge', () => ({ IpcLocalCardRepository: class { putIfAbsent = mocks.save; } }));
vi.mock('../src/features/free/generation', async (original) => ({ ...await original<object>(), executeFreeGeneration: mocks.execute }));
vi.mock('../src/features/scenario/generation', async (original) => ({ ...await original<object>(), executeScenarioGeneration: mocks.execute }));
vi.mock('../src/features/sublimation/generation', async (original) => ({ ...await original<object>(), executeSublimationGeneration: mocks.execute }));

import { createDesktopRouter } from '../src/app/router';
import { resetDesktopCloudSessionStoreForTests } from '../src/features/account/use-desktop-cloud-session';
import { resetTopbarAvatarForTests } from '../src/features/account/use-topbar-avatar';
import { resetDesktopAiConfigStoreForTests } from '../src/features/ai-config/use-desktop-ai-config';
import { DESKTOP_AI_CONFIG_STORAGE_KEY } from '../src/features/ai-config/desktop-ai-config-store';
import { resetDesktopAnnouncementsStoreForTests } from '../src/features/announcements/use-desktop-announcements';
import { resetDesktopConfigStoreForTests } from '../src/features/config/use-desktop-config';
import { DesktopGenerationSession } from '../src/features/generation/session';
import { createInitialSublimationDraft } from '../src/features/sublimation/session';

const pages = ['free', 'scenario', 'sublimation'] as const;
type Page = typeof pages[number];
type Confirmation = 'unsaved' | 'uncertain';
const character = { templateId: '通用角色', name: '保留的角色', content: '# 完整角色\n\n原始结果' };
const scenario = { templateId: '通用情景', title: '保留的情景', content: '# 完整情景\n\n原始结果' };
const draftKey = (page: Page) => `mahoshojo.desktop.${page}.draft.v1`;
const draftFor = (page: Page) => {
  if (page === 'free') return { schemaId: 'general', generationMode: 'non-stream', prompt: '生成角色', selectedLanguage: 'zh-CN' };
  if (page === 'scenario') return { answers: { '故事发生的场景是怎样的？': '雨后的天台' }, fieldsToKeepEmpty: [], scenarioTitleHint: '情景', generationMode: 'stream', selectedLanguage: 'zh-CN' };
  return { ...createInitialSublimationDraft(), originalData: character, userGuidance: '保留原有设定' };
};
const regenerationLabel = (page: Page) => page === 'sublimation' ? '重新升华' : '重新生成';
const saveAndRegenerateLabel = (page: Page) => page === 'sublimation' ? '保存后重新升华' : '保存后重新生成';
const menu = () => document.querySelector('[data-testid="escape-menu-root"]');
const confirmationDialog = () => document.querySelector<HTMLDialogElement>('dialog[aria-labelledby="regenerate-title"], dialog[aria-labelledby="sublimation-confirm-title"]')!;
const button = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)!;
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };
const click = async (label: string, scope: ParentNode = document) => {
  const target = button(label, scope);
  expect(target, label).toBeTruthy();
  expect(target.disabled, label).toBe(false);
  await act(async () => target.click());
  await settle();
};
const pressEscape = async (init: KeyboardEventInit = {}, prevented = false) => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
  if (prevented) event.preventDefault();
  await act(async () => { (document.activeElement ?? document).dispatchEvent(event); });
  await settle();
  return event;
};

let container: HTMLDivElement;
let root: Root;
let cancelSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  window.localStorage.clear();
  window.location.hash = '';
  resetDesktopCloudSessionStoreForTests();
  resetTopbarAvatarForTests();
  resetDesktopAnnouncementsStoreForTests();
  resetDesktopConfigStoreForTests();
  window.localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 2, selection: { executionPreference: 'client', clientConnectionId: 'local' }, hiddenPresetIds: [] }));
  resetDesktopAiConfigStoreForTests();
  mocks.profiles.mockResolvedValue({ id: 'local', name: '本地模型', adapter: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'model' });
  mocks.save.mockReset().mockResolvedValue({ written: true });
  mocks.execute.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'cloud_cached_account' || command === 'announcements_get_cached') return null;
    if (command === 'desktop_config_read') return { path: 'C:\\cfg\\config.json', directory: 'C:\\cfg', backupPresent: false, invalidPresent: false, file: { status: 'missing' } };
    if (command === 'announcements_refresh') return { status: 'not-modified', snapshot: { fetchedAt: '2026-01-01T00:00:00Z', announcements: [] } };
    return undefined;
  });
  vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, json: async () => String(url).includes('languages') ? [{ code: 'zh-CN', name: '简体中文' }] : { presets: [] } })));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  // jsdom has no native modal top layer. Only shim opening/closing and initial
  // focus; Escape itself must reach the real shared stack and shell fallback.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    this.querySelector<HTMLElement>('[autofocus]')?.focus();
  };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  // Observe the real session without replacing its cancellation implementation.
  cancelSpy = vi.spyOn(DesktopGenerationSession.prototype, 'cancel');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = async (page: Page, kind: Confirmation) => {
  // Restore through the same storage/parser/session path as the actual route;
  // no private Form export, session-state injection, or shell replacement.
  window.localStorage.setItem(draftKey(page), JSON.stringify({
    version: 1,
    ...draftFor(page),
    output: {
      phase: kind === 'unsaved' ? 'completed' : 'uncertain',
      mode: kind === 'unsaved' ? 'direct-local' : 'hosted-json',
      cardKind: page === 'scenario' ? 'general-scenario' : 'general',
      card: kind === 'unsaved' ? page === 'scenario' ? scenario : character : null,
      rawText: kind === 'unsaved' ? '完整原文' : '未确认的原文',
    },
  }));
  window.location.hash = `#/${page}`;
  const router = createDesktopRouter();
  await router.load();
  await act(async () => root.render(<StrictMode><RouterProvider router={router} /></StrictMode>));
  await settle();
  expect(router.state.location.pathname).toBe(`/${page}`);
  expect(mocks.execute).not.toHaveBeenCalled();
  await click(regenerationLabel(page));
  const dialog = confirmationDialog();
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain(kind === 'unsaved' ? '尚未保存到本地卡库' : '无法确认上次请求是否在服务器执行');
  expect(menu()).toBeNull();
  // Autofocus attributes are not reflected consistently by jsdom/React; focus
  // the visible cancel button so the shell's text-input suppression cannot mask a leak.
  button('取消', dialog).focus();
  mocks.invoke.mockClear();
  vi.mocked(fetch).mockClear();
  cancelSpy.mockClear();
  return { router, dialog, originalDraft: window.localStorage.getItem(draftKey(page)) };
};

const expectNoEscapeSideEffects = (page: Page, originalDraft: string | null, saveCount = 0) => {
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(cancelSpy).not.toHaveBeenCalled();
  expect(mocks.save).toHaveBeenCalledTimes(saveCount);
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(window.confirm).not.toHaveBeenCalled();
  expect(window.localStorage.getItem(draftKey(page))).toBe(originalDraft);
};

describe('actual desktop generator confirmations own their Escape layer', () => {
  it.each(pages.flatMap((page) => (['unsaved', 'uncertain'] as const).map((kind) => ({ page, kind }))))('$page $kind dismisses only the confirmation, then releases the shell fallback', async ({ page, kind }) => {
    const { router, dialog, originalDraft } = await mount(page, kind);

    for (const init of [{ repeat: true }, { isComposing: true }]) {
      expect((await pressEscape(init)).defaultPrevented).toBe(false);
      expect(dialog.open).toBe(true);
      expect(menu()).toBeNull();
    }
    await pressEscape({}, true);
    expect(dialog.open).toBe(true);
    expect(menu()).toBeNull();
    expectNoEscapeSideEffects(page, originalDraft);

    expect((await pressEscape()).defaultPrevented).toBe(true);
    expect({ dialogOpen: dialog.open, menuOpen: menu() !== null }).toEqual({ dialogOpen: false, menuOpen: false });
    expect(router.state.location.pathname).toBe(`/${page}`);
    expectNoEscapeSideEffects(page, originalDraft);

    // A later, distinct Escape can open the real desktop menu after unregister.
    button(regenerationLabel(page)).focus();
    expect((await pressEscape()).defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
    await pressEscape();
    expect(menu()).toBeNull();
    expect(router.state.location.pathname).toBe(`/${page}`);
    expectNoEscapeSideEffects(page, originalDraft);
  });

  it.each(pages)('%s consumes Escape without dismissing or cancelling an in-flight save', async (page) => {
    const { router, dialog, originalDraft } = await mount(page, 'unsaved');
    let rejectSave!: (error: Error) => void;
    mocks.save.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    await click(saveAndRegenerateLabel(page), dialog);
    await act(async () => { await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce()); });
    expect(button('取消', dialog).disabled).toBe(true);

    const escape = await pressEscape();
    expect(escape.defaultPrevented).toBe(true);
    expect({ dialogOpen: dialog.open, menuOpen: menu() !== null }).toEqual({ dialogOpen: true, menuOpen: false });
    expect(button('取消', dialog).disabled).toBe(true);
    expectNoEscapeSideEffects(page, originalDraft, 1);

    // A save failure keeps the old result and confirmation, then permits Esc
    // dismissal. This does not turn Escape into save, retry, or regeneration.
    await act(async () => rejectSave(new Error('local save unavailable')));
    await settle();
    expect(dialog.textContent).toContain('保存到本地卡库失败');
    expect(button('取消', dialog).disabled).toBe(false);
    await pressEscape();
    expect({ dialogOpen: dialog.open, menuOpen: menu() !== null }).toEqual({ dialogOpen: false, menuOpen: false });
    button(regenerationLabel(page)).focus();
    await pressEscape();
    expect(menu()).not.toBeNull();
    expect(router.state.location.pathname).toBe(`/${page}`);
    expectNoEscapeSideEffects(page, originalDraft, 1);
  });
});
