// @vitest-environment jsdom
import '@/tests/helpers/fake-indexeddb';
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalLibraryPage } from '@/components/library/LocalLibraryPage';
import { LOCAL_LIBRARY_DB_NAME, resetLocalLibraryDbConnection } from '@/lib/local-library/db';
import { resetLocalCardRepository } from '@/lib/local-library/card-repository';
import { getLocalImageRepository, resetLocalImageRepository } from '@/lib/local-library/image-assets';

vi.mock('@/components/shared/LocalLibraryStatusNote', () => ({ LocalLibraryStatusNote: () => null }));
const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V8AAAAASUVORK5CYII=', 'base64'));
let root: Root; let container: HTMLDivElement;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
const waitFor = async (predicate: () => boolean) => { for (let count = 0; count < 100; count++) { if (predicate()) return; await settle(); } throw new Error('等待图片状态超时'); };
const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent === text)!;
const click = async (text: string) => act(async () => button(text).click());
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetLocalLibraryDbConnection(); resetLocalCardRepository(); resetLocalImageRepository();
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(LOCAL_LIBRARY_DB_NAME); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:local-image'); static revokeObjectURL = vi.fn(); });
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('本地图片旅程不应触网'); }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); resetLocalLibraryDbConnection(); resetLocalImageRepository(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('Web 真实共享页上传到 IDB，重开读取、预览、原图下载、软删恢复和 purge 全程不触网', async () => {
  await act(async () => root.render(<LocalLibraryPage />));
  await waitFor(() => container.textContent?.includes('还没有本地图片') === true);
  const file = new File([bytes], '原图.png', { type: 'image/png' }); Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer });
  const input = container.querySelector<HTMLInputElement>('[data-testid=local-images-panel] input[type=file]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await click('保存原图');
  await waitFor(() => container.querySelector('[data-testid=local-image-item]') !== null);
  const page = await getLocalImageRepository().list({ view: 'active', limit: 20, cursor: null });
  expect(page.items[0].title).toBe('原图.png'); expect(await getLocalImageRepository().read(page.items[0])).toEqual(bytes);
  await act(async () => root.render(<p>离开页面</p>)); resetLocalLibraryDbConnection(); resetLocalImageRepository();
  await act(async () => root.render(<LocalLibraryPage />)); await waitFor(() => container.querySelector('[data-testid=local-image-item]') !== null);
  await click('预览'); await waitFor(() => document.querySelector('[role=dialog] img') !== null);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-image');
  await click('导出原图'); await waitFor(() => container.textContent?.includes('已请求浏览器下载：原图.png') === true);
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  await click('移入图片回收站'); await waitFor(() => container.querySelector('[data-testid=local-image-item]') === null);
  await click('图片回收站'); await waitFor(() => container.querySelector('[data-testid=local-image-item]') !== null);
  await click('恢复图片'); await waitFor(() => container.querySelector('[data-testid=local-image-item]') === null);
  await click('图片'); await waitFor(() => container.querySelector('[data-testid=local-image-item]') !== null);
  await click('移入图片回收站'); await waitFor(() => container.querySelector('[data-testid=local-image-item]') === null);
  await click('图片回收站'); await waitFor(() => container.querySelector('[data-testid=local-image-item]') !== null);
  await click('彻底删除图片…'); await click('确认彻底删除图片'); await waitFor(() => container.querySelector('[data-testid=local-image-item]') === null);
  expect((await getLocalImageRepository().list({ view: 'trash', limit: 20, cursor: null })).items).toEqual([]);
  expect(fetch).not.toHaveBeenCalled(); expect(container.textContent).toContain('Web 暂无整库快照');
});
