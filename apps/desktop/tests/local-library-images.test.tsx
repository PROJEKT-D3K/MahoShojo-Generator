// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { digestLocalImage, localImageId, type LocalImageAsset } from '@mahoshojo/local-library/image-assets';
import { createDesktopRouter } from '../src/app/router';
import { LIST_LOCAL_BACKUPS_COMMAND } from '../src/platform/local-backup-bridge';
import { LIST_LOCAL_CARDS_COMMAND } from '../src/platform/local-card-bridge';

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
const archive = vi.hoisted(() => ({ probeStorage: vi.fn(async () => null), runExport: vi.fn(), pickArchiveBytes: vi.fn(), inspectArchive: vi.fn(), applyArchive: vi.fn(), describeError: () => '归档未完成' }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: native.invoke }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: native.listen }) }));
vi.mock('../src/platform/desktop-archive-host', () => ({ createDesktopArchiveHost: () => archive, DESKTOP_LIBRARY_ARCHIVE_LIMITS: { fileBytes: 1024 } }));
const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V8AAAAASUVORK5CYII=', 'base64'));
let asset: LocalImageAsset; let rows: LocalImageAsset[]; let root: Root; let container: HTMLDivElement;
let closeRequested: (event: { preventDefault: () => void }) => void;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
const waitFor = async (predicate: () => boolean) => { for (let count = 0; count < 200; count++) { if (predicate()) return; await settle(); } throw new Error('等待图片状态超时'); };
const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent === text)!;
const click = async (text: string) => act(async () => button(text).click());
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto); rows = [];
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:native-image'); static revokeObjectURL = vi.fn(); });
  const digest = await digestLocalImage(bytes);
  asset = { schemaVersion: 1, id: localImageId(digest), digest, title: '桌面原图.png', mimeType: 'image/png', byteLength: bytes.length, width: 1, height: 1, createdAt: '2026-10-22T00:00:00.000Z', deletedAt: null, source: 'uploaded' };
  native.listen.mockImplementation(async callback => { closeRequested = callback; return vi.fn(); });
  native.invoke.mockImplementation(async (command: string, args?: { request?: Record<string, unknown> }) => {
    if (command === LIST_LOCAL_CARDS_COMMAND) return { documents: [] };
    if (command === LIST_LOCAL_BACKUPS_COMMAND) return { backups: [], invalidCount: 0 };
    if (command === 'list_local_image_assets') return { items: rows.filter(item => Boolean(item.deletedAt) === (args?.request?.view === 'trash')), nextCursor: null };
    if (command === 'save_local_image_asset') { rows = [{ ...asset, title: args?.request?.title as string }]; return { asset: rows[0], outcome: 'stored' }; }
    if (command === 'read_local_image_asset') return bytes.slice().buffer;
    if (command === 'export_local_image_asset') return { absolutePath: 'C:\\AppData\\exports\\images\\native.png', byteLength: bytes.length };
    if (command === 'delete_local_image_asset') { rows = rows.map(item => ({ ...item, deletedAt: '2026-10-22T01:00:00.000Z' })); return null; }
    if (command === 'restore_local_image_asset') { rows = rows.map(item => ({ ...item, deletedAt: null })); return null; }
    if (command === 'purge_local_image_asset') { rows = []; return null; }
    return undefined;
  });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  window.location.hash = '#/local-library'; container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const mount = async () => {
  const router = createDesktopRouter(); await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
  await waitFor(() => !!button('刷新图片') && !button('刷新图片').disabled);
  return router;
};
const chooseFile = async () => {
  const file = new File([bytes], '桌面原图.png', { type: 'image/png' }); Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer });
  const input = container.querySelector<HTMLInputElement>('[data-testid=local-images-panel] input[type=file]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
};

it('Desktop 真实共享页通过 bridge 完成上传、重开读取、预览、确定路径导出和回收站旅程（IPC mock）', async () => {
  await mount(); await chooseFile(); await click('保存原图'); await waitFor(() => container.querySelector('[data-testid=local-image-item]') !== null && !button('预览').disabled);
  expect(native.invoke).toHaveBeenCalledWith('save_local_image_asset', { request: { title: '桌面原图.png', payload: { encoding: 'base64', data: Buffer.from(bytes).toString('base64'), byteLength: bytes.length } } });
  await act(async () => root.render(<p>离开页面</p>)); await mount();
  await waitFor(() => container.querySelector('[data-testid=local-image-item]') !== null && !button('预览').disabled);
  expect(container.textContent).toContain('桌面原图.png');
  await click('预览'); await waitFor(() => document.querySelector('[role=dialog] img') !== null);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:native-image');
  await click('导出原图'); await waitFor(() => container.textContent?.includes('已保存原图到：C:\\AppData\\exports\\images\\native.png') === true);
  await click('移入图片回收站'); await waitFor(() => container.querySelector('[data-testid=local-image-item]') === null && !button('图片回收站').disabled);
  await click('图片回收站'); await waitFor(() => !!button('恢复图片') && !button('恢复图片').disabled); await click('恢复图片');
  await waitFor(() => container.querySelector('[data-testid=local-image-item]') === null && !button('图片').disabled); await click('图片');
  await waitFor(() => !!button('移入图片回收站') && !button('移入图片回收站').disabled); await click('移入图片回收站');
  await waitFor(() => container.querySelector('[data-testid=local-image-item]') === null && !button('图片回收站').disabled); await click('图片回收站');
  await waitFor(() => !!button('彻底删除图片…') && !button('彻底删除图片…').disabled); await click('彻底删除图片…');
  expect(rows).toHaveLength(1); await click('确认彻底删除图片'); await waitFor(() => rows.length === 0);
  expect(container.textContent).toContain('独立图片（含图片回收站）由整库备份覆盖');
});

it('文件读取即同步取得维护锁，整个持久保存期间禁止归档、备份与原生关闭', async () => {
  await mount();
  let finishRead!: (value: ArrayBuffer) => void;
  const file = new File([bytes], '桌面原图.png'); Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>(resolve => { finishRead = resolve; }) });
  const input = container.querySelector<HTMLInputElement>('[data-testid=local-images-panel] input[type=file]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await click('保存原图');
  expect(button('导出卡片与 Web 包归档').matches(':disabled')).toBe(true); expect(button('检查完整性').matches(':disabled')).toBe(true);
  const preventDefault = vi.fn(); await act(async () => closeRequested({ preventDefault })); expect(preventDefault).toHaveBeenCalledOnce();
  expect(native.invoke.mock.calls.filter(([command]) => command === 'save_local_image_asset')).toHaveLength(0);
  await act(async () => finishRead(bytes.slice().buffer));
  await waitFor(() => !button('刷新图片').disabled); expect(button('导出卡片与 Web 包归档').matches(':disabled')).toBe(false);
});
