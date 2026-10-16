// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopRouter } from '../src/app/router';
import { DETAILS_DRAFT_KEY } from '../src/features/details/session';
import { CANSHOU_DRAFT_KEY } from '../src/features/canshou/session';
import { DESKTOP_AI_CONFIG_STORAGE_KEY } from '../src/features/ai-config/desktop-ai-config-store';
import { resetDesktopAiConfigStoreForTests } from '../src/features/ai-config/use-desktop-ai-config';
import { resetDesktopCloudSessionStoreForTests } from '../src/features/account/use-desktop-cloud-session';
import { resetDesktopAnnouncementsStoreForTests } from '../src/features/announcements/use-desktop-announcements';
import { resetDesktopConfigStoreForTests } from '../src/features/config/use-desktop-config';
import { resetTopbarAvatarForTests } from '../src/features/account/use-topbar-avatar';

const mocks = vi.hoisted(() => ({
  imageUrl: 'blob:preview-first', revoke: vi.fn(),
  deferExport: false, pendingExport: null as null | (() => void),
  generate: vi.fn(), save: vi.fn(),
}));
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
    id: 'local', name: '预览测试连接', adapter: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'model',
  }),
}));
vi.mock('../src/features/details/generation', async (original) => ({
  ...await original<object>(), executeDetailsGeneration: mocks.generate,
}));
vi.mock('../src/features/canshou/generation', async (original) => ({
  ...await original<object>(), executeCanshouGeneration: mocks.generate,
}));
vi.mock('../src/platform/local-card-bridge', () => ({
  IpcLocalCardRepository: class { putIfAbsent = mocks.save; },
}));
// 截图编码留在共享卡的测试；这里只替换截图出口，路由、草稿 owner、
// ImagePreviewModal、BaseModal 与 ShellEscapeMenu 均走真实实现。
vi.mock('@mahoshojo/ui-web/character-card', async (original) => {
  const actual = await original<object>();
  const ExportImage = ({ onSaveImage, saveButtonLabel }: {
    onSaveImage?: (url: string) => void;
    saveButtonLabel?: string;
  }) => <button onClick={() => {
    const imageUrl = mocks.imageUrl;
    const completeExport = () => onSaveImage?.(imageUrl);
    if (mocks.deferExport) mocks.pendingExport = completeExport;
    else completeExport();
  }}>{saveButtonLabel}</button>;
  return { ...actual, MagicalGirlCard: ExportImage, CanshouCard: ExportImage, GeneralCharacterCard: ExportImage };
});

let root: Root | null;
let container: HTMLDivElement;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
const menu = () => document.querySelector('[data-testid="escape-menu-root"]');
const press = async (key: string, shiftKey = false) => {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  await act(async () => { (document.activeElement ?? document).dispatchEvent(event); });
  await settle();
  return event;
};
const click = async (element: HTMLElement) => {
  await act(async () => { element.click(); });
  await settle();
};
const exportButton = () => [...container.querySelectorAll('button')]
  .find((button) => button.textContent === '📱 打开长按保存弹窗')!;
const openPreview = async (url = 'blob:preview-first') => {
  mocks.imageUrl = url;
  const trigger = exportButton();
  expect(trigger).toBeDefined();
  trigger.focus();
  await click(trigger);
  return trigger;
};
const closeButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!;
const pageButton = (text: string) => [...container.querySelectorAll('button')]
  .find((button) => button.textContent?.trim() === text)!;
const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;
const originalFocus = HTMLElement.prototype.focus;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.deferExport = false;
  mocks.pendingExport = null;
  mocks.generate.mockResolvedValue({ status: 'cancelled', mode: 'direct-local', reason: 'aborted', rawText: '' });
  mocks.save.mockResolvedValue({ written: true });
  // jsdom 不实现 native top layer；按 HTML dialog 语义模拟外部 inert 与 close 焦点恢复，
  // 守住 native.close 先于预览初焦的时序，不替代 WebView 实测或生产 Tab/Escape 处理。
  const nativeReturnFocus = new WeakMap<HTMLDialogElement, HTMLElement>();
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
    const native = document.querySelector<HTMLDialogElement>('dialog[open]');
    if (native && !native.contains(this)) return;
    originalFocus.call(this, options);
  });
  HTMLDialogElement.prototype.showModal = function () {
    if (document.activeElement instanceof HTMLElement) nativeReturnFocus.set(this, document.activeElement);
    this.open = true;
    this.querySelector<HTMLElement>('button')?.focus();
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    const previous = nativeReturnFocus.get(this);
    if (previous?.isConnected) previous.focus();
  };
  window.localStorage.clear();
  window.localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({
    version: 2, selection: { executionPreference: 'client', clientConnectionId: 'local' }, hiddenPresetIds: [],
  }));
  resetDesktopAiConfigStoreForTests();
  resetDesktopCloudSessionStoreForTests();
  resetDesktopAnnouncementsStoreForTests();
  resetDesktopConfigStoreForTests();
  resetTopbarAvatarForTests();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    json: async () => String(input).includes('languages') ? [] : { presets: [] },
  })));
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { revokeObjectURL: mocks.revoke }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

const routes = [
  { path: '/details', draftKey: DETAILS_DRAFT_KEY, questionnaireKind: 'magical-girl', imageAlt: '魔法少女详细档案' },
  { path: '/canshou', draftKey: CANSHOU_DRAFT_KEY, questionnaireKind: 'canshou', imageAlt: '残兽档案' },
] as const;

describe.each(routes)('Desktop $path image preview through the real route', ({ path, draftKey, questionnaireKind, imageAlt }) => {
  const image = () => document.querySelector<HTMLImageElement>(`img[alt="${imageAlt}"]`);
  const dialog = () => image()?.closest<HTMLElement>('[role="dialog"]') ?? null;
  const mount = async () => {
    const card = { name: '已恢复的角色', content: '保留在原页面 owner 的长图预览结果', templateId: '通用角色' };
    window.localStorage.setItem(draftKey, JSON.stringify({
      version: 1, answers: {}, language: 'zh-CN', imageSaveMode: 'modal',
      questionnaireSelections: [{
        source: 'preset', selectionId: 'preset:preview',
        questionnaire: { id: 'preview', kind: questionnaireKind, title: '预览回归问卷', nativeAllowed: true,
          questions: [{ id: 'first', question: '角色描述？', type: 'text' }] },
      }],
      output: { mode: 'direct-local', phase: 'completed', cardKind: 'general', card, rawText: JSON.stringify(card) },
    }));
    window.location.hash = `#${path}`;
    const router = createDesktopRouter();
    await router.load();
    await act(async () => { root!.render(<StrictMode><RouterProvider router={router} /></StrictMode>); });
    await settle();
    expect(router.state.location.pathname).toBe(path);
    expect(container.querySelector('[aria-label="生成结果"]')?.textContent).toContain(card.name);
    return router;
  };

  it.each(['details', 'regenerate'] as const)('defers a late export behind the native %s dialog without stealing its keys', async (kind) => {
    const router = await mount();
    const originalOutput = JSON.parse(window.localStorage.getItem(draftKey)!).output;
    const imageUrl = `blob:late-${kind}`;
    mocks.deferExport = true;
    await openPreview(imageUrl);
    expect(mocks.pendingExport).toBeTypeOf('function');
    expect(image()).toBeNull();

    let nativeTrigger: HTMLButtonElement;
    if (kind === 'details') {
      if (path === '/canshou') await click(pageButton('返回编辑答案'));
      await click([...container.querySelectorAll('button')].find((button) => button.textContent?.includes('问卷设置'))!);
      nativeTrigger = pageButton('详情');
    } else {
      nativeTrigger = pageButton(path === '/details' ? '重新生成' : '不满意？再来一次');
      expect(nativeTrigger.disabled).toBe(false);
    }
    nativeTrigger.focus();
    await click(nativeTrigger);
    const native = container.querySelector<HTMLDialogElement>(
      `dialog[aria-labelledby="${kind === 'details' ? 'selection-details-title' : 'regenerate-title'}"]`,
    )!;
    expect(native.open).toBe(true);
    const nativeButton = native.querySelector<HTMLButtonElement>('button')!;
    expect(document.activeElement === nativeButton).toBe(true);

    await act(async () => { mocks.pendingExport!(); mocks.pendingExport = null; });
    await settle();
    expect.soft(image(), 'a late export must wait for the native top layer').toBeNull();
    expect.soft(document.activeElement === nativeButton, 'late export must not take native focus').toBe(true);
    nativeButton.focus();
    expect.soft((await press('Tab')).defaultPrevented, 'native Tab must not reach the image focus trap').toBe(false);
    nativeButton.focus();
    expect.soft((await press('Tab', true)).defaultPrevented).toBe(false);
    expect(mocks.revoke).not.toHaveBeenCalled();

    // 第一次 Escape 只关闭 native owner；迟到的同一 URL 随后显示，
    // 不能同一事件再关图片或触发壳菜单/重生成/保存。
    nativeButton.focus();
    await press('Escape');
    expect(native.open).toBe(false);
    expect(image()?.getAttribute('src')).toBe(imageUrl);
    expect(menu()).toBeNull();
    expect(document.activeElement === closeButton()).toBe(true);
    const preview = dialog()!;
    const last = [...preview.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')].at(-1)!;
    expect((await press('Tab', true)).defaultPrevented).toBe(true);
    expect(document.activeElement === last).toBe(true);
    expect((await press('Tab')).defaultPrevented).toBe(true);
    expect(document.activeElement === closeButton()).toBe(true);
    await press('Escape');
    expect(image()).toBeNull();
    expect(menu()).toBeNull();
    expect(document.activeElement === nativeTrigger).toBe(true);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(draftKey)!).output).toEqual(originalOutput);
    expect(router.state.location.pathname).toBe(path);
    expect(mocks.revoke).not.toHaveBeenCalled();
    await act(async () => { root!.unmount(); root = null; });
    expect(mocks.revoke.mock.calls).toEqual([[imageUrl]]);
  });

  it('opens an accessible modal for the restored result image', async () => {
    await mount();
    await openPreview();
    expect(image()?.getAttribute('src')).toBe('blob:preview-first');
    const preview = dialog();
    expect(preview, 'image preview must expose a modal dialog').not.toBeNull();
    expect(preview!.getAttribute('aria-modal')).toBe('true');
    const titleId = preview!.getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    expect(document.getElementById(titleId!)?.textContent).toBeTruthy();
  });

  it('moves initial focus inside and wraps Tab in both directions', async () => {
    await mount();
    const trigger = await openPreview();
    const close = closeButton();
    expect.soft(document.activeElement).toBe(close);
    // 强制从关闭按钮开始，避免旧遮罩保留 opener 焦点而误报 Escape 恢复通过。
    close.focus();
    expect((await press('Tab', true)).defaultPrevented).toBe(true);
    const preview = dialog()!;
    const focusable = [...preview.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')];
    const last = focusable.at(-1)!;
    expect(document.activeElement).toBe(last);
    expect((await press('Tab')).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    // 页面元素误获焦点后，Tab 也必须回到当前图片层。
    trigger.focus();
    expect((await press('Tab')).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
  });

  it('consumes one Escape, restores the opener and leaves the shell fallback usable', async () => {
    const router = await mount();
    for (const url of ['blob:preview-first', 'blob:preview-second']) {
      const trigger = await openPreview(url);
      expect(image()).not.toBeNull();
      expect(menu()).toBeNull();
      closeButton().focus();
      await press('Escape');
      expect(image()).toBeNull();
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(router.state.location.pathname).toBe(path);
      await press('Escape');
      expect(menu()).not.toBeNull();
      await press('Escape');
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(trigger);
    }
  });

  it('ignores backdrop clicks and restores focus on repeated explicit closes', async () => {
    await mount();
    for (const url of ['blob:preview-first', 'blob:preview-second']) {
      const trigger = await openPreview(url);
      const preview = dialog();
      expect(preview, 'backdrop behavior must be owned by the accessible image dialog').not.toBeNull();
      const backdrop = [...preview!.parentElement!.children].find((element) => element !== preview)!;
      expect(backdrop).toBeDefined();
      await click(backdrop as HTMLElement);
      expect(image()?.getAttribute('src')).toBe(url);
      expect(menu()).toBeNull();
      closeButton().focus();
      await click(closeButton());
      expect(image()).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(menu()).toBeNull();
    }
  });

  it('keeps URLs alive across close and revokes only replacement and owner unmount', async () => {
    await mount();
    await openPreview('blob:preview-first');
    expect(image()?.getAttribute('src')).toBe('blob:preview-first');
    expect(mocks.revoke).not.toHaveBeenCalled();
    await click(closeButton());
    expect(image()).toBeNull();
    expect(mocks.revoke).not.toHaveBeenCalled();
    await openPreview('blob:preview-first');
    expect(mocks.revoke).not.toHaveBeenCalled();
    await press('Escape');
    expect(mocks.revoke).not.toHaveBeenCalled();
    await openPreview('blob:preview-second');
    expect(image()?.getAttribute('src')).toBe('blob:preview-second');
    expect(mocks.revoke.mock.calls).toEqual([['blob:preview-first']]);
    await act(async () => { root!.unmount(); root = null; });
    expect(image()).toBeNull();
    expect(mocks.revoke.mock.calls).toEqual([['blob:preview-first'], ['blob:preview-second']]);
  });
});
