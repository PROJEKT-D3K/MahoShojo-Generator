// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LocalImageAsset } from '@mahoshojo/local-library/image-assets';
import { LocalImagesPanel, useLocalImagesController, type LocalImagesHost } from '../src/local-images';

const row: LocalImageAsset = { schemaVersion: 1, id: `image-${'a'.repeat(64)}`, digest: `sha256:${'a'.repeat(64)}`, title: '已有原图', mimeType: 'image/png', byteLength: 3, width: 1, height: 1, createdAt: '2026-10-22T00:00:00.000Z', deletedAt: null, source: 'uploaded' };
let root: Root; let container: HTMLDivElement;
let records: LocalImageAsset[]; let host: LocalImagesHost;
const purge = vi.fn(async (id: string) => { records = records.filter(item => item.id !== id); });
const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent === text)!;
const click = async (text: string) => act(async () => button(text).click());
function Harness() { const { model, controller } = useLocalImagesController(host); return <LocalImagesPanel model={model} actions={controller.actions} />; }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  records = [row]; purge.mockClear();
  host = { store: {
    list: async request => ({ items: records.filter(asset => (asset.deletedAt !== null) === (request.view === 'trash')), nextCursor: null }),
    save: vi.fn(async (title: string) => { records = [{ ...row, title }]; return { asset: records[0], outcome: 'stored' as const }; }),
    read: async () => new Uint8Array([1, 2, 3]),
    remove: async id => { records = records.map(item => item.id === id ? { ...item, deletedAt: '2026-10-22T01:00:00.000Z' } : item); },
    restore: async id => { records = records.map(item => item.id === id ? { ...item, deletedAt: null } : item); }, purge,
  }, exportImage: async () => '已请求浏览器下载：原图.png' };
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:preview'); static revokeObjectURL = vi.fn(); });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('真实面板上传、预览释放、软删恢复及确认 purge，共享模态不会点击入口就删除', async () => {
  await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
  expect(container.textContent).toContain('已有原图');
  const selected = new File(['abc'], '新原图.png'); Object.defineProperty(selected, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer });
  const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [selected] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await click('保存原图'); expect(host.store.save).toHaveBeenCalledWith('新原图.png', new Uint8Array([1, 2, 3]));
  await click('预览'); expect(document.querySelector('[role=dialog] img')?.getAttribute('src')).toBe('blob:preview');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  await click('导出原图'); expect(container.textContent).toContain('已请求浏览器下载：原图.png');
  await click('移入图片回收站'); await click('图片回收站'); await click('恢复图片'); await click('图片');
  expect(container.textContent).toContain('新原图.png');
  await click('移入图片回收站'); await click('图片回收站'); await click('彻底删除图片…');
  expect(purge).not.toHaveBeenCalled(); expect(document.querySelector('[role=dialog]')?.textContent).toContain('无法在应用内撤销');
  await click('取消'); expect(purge).not.toHaveBeenCalled();
  await click('彻底删除图片…'); await click('确认彻底删除图片');
  expect(purge).toHaveBeenCalledWith(row.id); expect(container.textContent).toContain('图片回收站是空的');
});

it('图片元素载入失败移除失效 src 并保留可修复说明', async () => {
  await act(async () => root.render(<Harness />)); await click('预览');
  await act(async () => document.querySelector('img')!.dispatchEvent(new Event('error')));
  expect(document.querySelector('img')).toBeNull(); expect(container.textContent).toContain('原记录已保留');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
});

it('卸载生产面板销毁最后一次预览 object URL', async () => {
  await act(async () => root.render(<Harness />)); await click('预览');
  await act(async () => root.render(<p>其他页面</p>)); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
});
