import { afterEach, expect, it, vi } from 'vitest';
import { LocalImageRejectedError, type LocalImageAsset, type LocalImagePage } from '@mahoshojo/local-library/image-assets';
import { createLocalImagesController, type LocalImagesHost } from '../src/local-images/controller';

const asset = (digit = 'a', deletedAt: string | null = null): LocalImageAsset => ({
  schemaVersion: 1, id: `image-${digit.repeat(64)}`, digest: `sha256:${digit.repeat(64)}`, title: '原图', mimeType: 'image/png',
  byteLength: 3, width: 1, height: 1, createdAt: '2026-10-22T00:00:00.000Z', deletedAt, source: 'uploaded',
});
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const makeHost = () => ({
  store: {
    list: vi.fn(async (): Promise<LocalImagePage> => ({ items: [asset()], nextCursor: null })),
    save: vi.fn(async () => ({ asset: asset(), outcome: 'stored' as const })),
    read: vi.fn(async (): Promise<Uint8Array> => new Uint8Array([1, 2, 3])), remove: vi.fn(async () => {}), restore: vi.fn(async () => {}), purge: vi.fn(async () => {}),
  },
  exportImage: vi.fn(async () => '已请求浏览器下载，无法确认文件落盘。'),
}) satisfies LocalImagesHost;
const file = () => ({ size: 3, arrayBuffer: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer) });
afterEach(() => { vi.restoreAllMocks(); });

it('保存前同步单飞，重复点击只读取和保存一次，完成后刷新持久列表', async () => {
  const host = makeHost(); const pending = deferred<ArrayBuffer>(); const input = { size: 3, arrayBuffer: vi.fn(() => pending.promise) };
  const controller = createLocalImagesController(host);
  controller.actions.upload(' 原名 ', input); controller.actions.upload('第二份', input);
  expect(controller.isBusy()).toBe(true); expect(input.arrayBuffer).toHaveBeenCalledTimes(1);
  pending.resolve(new Uint8Array([1, 2, 3]).buffer); await flush();
  expect(host.store.save).toHaveBeenCalledOnce(); expect(host.store.save).toHaveBeenCalledWith('原名', new Uint8Array([1, 2, 3]));
  expect(controller.model.items).toHaveLength(1); expect(controller.isBusy()).toBe(false);
});

it('超限与非法名称不会读取文件或静默截断名称', () => {
  const host = makeHost(); const controller = createLocalImagesController(host); const input = file();
  controller.actions.upload('图'.repeat(81), input);
  expect(controller.model.error).toContain('240 UTF-8');
  controller.actions.upload('a\nb', input); expect(controller.model.error).toContain('控制字符');
  controller.actions.upload('正常', { ...input, size: 10 * 1024 * 1024 + 1 });
  expect(controller.model.error).toContain('10 MiB'); expect(input.arrayBuffer).not.toHaveBeenCalled(); expect(host.store.save).not.toHaveBeenCalled();
});

it('保存响应丢失保持结果未知并刷新，不擅自删除可能已保存的记录', async () => {
  const host = makeHost(); host.store.save.mockRejectedValueOnce(new Error('响应丢失'));
  const controller = createLocalImagesController(host); controller.actions.upload('原图', file()); await flush();
  expect(controller.model.error).toContain('保存结果尚未确认'); expect(controller.model.items).toHaveLength(1);
  expect(host.store.remove).not.toHaveBeenCalled(); expect(host.store.purge).not.toHaveBeenCalled();
});

it('宿主确定拒绝保存或变更时直接说明原因，不显示未知结果', async () => {
  const host = makeHost(); host.store.save.mockRejectedValueOnce(new LocalImageRejectedError('图片无法解码，未保存。'));
  host.store.remove.mockRejectedValueOnce(new LocalImageRejectedError('本地库正在维护，未执行操作。'));
  const controller = createLocalImagesController(host); controller.actions.upload('原图', file()); await flush();
  expect(controller.model.error).toBe('图片无法解码，未保存。');
  controller.actions.remove(asset().id); await flush(); expect(controller.model.error).toBe('本地库正在维护，未执行操作。');
});

it('重复软删图片不会自动恢复，界面给出回收站恢复提示', async () => {
  const host = makeHost();
  const controller = createLocalImagesController({ ...host, store: { ...host.store, save: async () => ({ asset: asset('a', '2026-10-22T01:00:00.000Z'), outcome: 'already-present' }) } });
  controller.actions.upload('新名字', file()); await flush();
  expect(controller.model.notice).toContain('保留原名称'); expect(controller.model.notice).toContain('回收站恢复'); expect(host.store.restore).not.toHaveBeenCalled();
});

it('更换视图丢弃迟到列表，同时维护 busy 保留至全部读取完成', async () => {
  const host = makeHost(); const old = deferred<LocalImagePage>();
  host.store.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ items: [asset('b', '2026-10-22T01:00:00.000Z')], nextCursor: null });
  const controller = createLocalImagesController(host); controller.actions.reload(); controller.actions.setView('trash'); await flush();
  expect(controller.model.view).toBe('trash'); expect(controller.model.items[0].id).toBe(asset('b').id); expect(controller.isBusy()).toBe(true);
  old.resolve({ items: [asset()], nextCursor: null }); await flush();
  expect(controller.model.items[0].id).toBe(asset('b').id); expect(controller.isBusy()).toBe(false);
});

it('读取中清理后恢复 idle，迟到结果失效且释放单飞，宿主可再次安排首次读取', async () => {
  const host = makeHost(); const pending = deferred<LocalImagePage>(); host.store.list.mockReturnValueOnce(pending.promise);
  const controller = createLocalImagesController(host); controller.actions.reload(); controller.dispose();
  expect(controller.model.status).toBe('idle'); pending.resolve({ items: [asset('b')], nextCursor: null }); await flush();
  expect(controller.model.items).toEqual([]); expect(controller.isBusy()).toBe(false);
  controller.actions.reload(); await flush(); expect(controller.model.items).toEqual([asset()]);
});

it('按真实 cursor 加载下一页，重复游标报错且不伪造空列表', async () => {
  const host = makeHost(); host.store.list.mockResolvedValueOnce({ items: [asset()], nextCursor: asset().id })
    .mockResolvedValueOnce({ items: [asset('b')], nextCursor: asset().id });
  const controller = createLocalImagesController(host); controller.actions.reload(); await flush(); controller.actions.loadMore(); await flush();
  expect(host.store.list).toHaveBeenLastCalledWith({ view: 'active', limit: 20, cursor: asset().id });
  expect(controller.model.loadError).toContain('无效分页游标'); expect(controller.model.items).toEqual([asset()]);
});

it('正常分页追加，刷新从首页重新读取，读取失败保留已有快照并报错', async () => {
  const host = makeHost(); host.store.list.mockResolvedValueOnce({ items: [asset()], nextCursor: asset().id })
    .mockResolvedValueOnce({ items: [asset('b')], nextCursor: null }).mockRejectedValueOnce(new Error('存储不可用'));
  const controller = createLocalImagesController(host); controller.actions.reload(); await flush(); controller.actions.loadMore(); await flush();
  expect(controller.model.items).toHaveLength(2); controller.actions.reload(); await flush();
  expect(controller.model.status).toBe('error'); expect(controller.model.items).toHaveLength(2); expect(controller.model.loadError).toBe('存储不可用');
});

it('软删、恢复、purge 同步单飞且每次重读真实存储', async () => {
  const host = makeHost(); const pending = deferred<void>(); host.store.remove.mockReturnValueOnce(pending.promise);
  const controller = createLocalImagesController(host); controller.actions.remove(asset().id); controller.actions.purge(asset().id);
  expect(host.store.purge).not.toHaveBeenCalled(); pending.resolve(); await flush();
  controller.actions.restore(asset().id); await flush(); controller.actions.purge(asset().id); await flush();
  expect(host.store.list).toHaveBeenCalledTimes(3); expect(host.store.restore).toHaveBeenCalledOnce(); expect(host.store.purge).toHaveBeenCalledOnce();
});

it('预览关闭/卸载令迟到读取失效，替换和释放只 revoke 不生成空 src', async () => {
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:one'); const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const host = makeHost(); const pending = deferred<Uint8Array>(); host.store.read.mockReturnValueOnce(pending.promise);
  const controller = createLocalImagesController(host); controller.actions.preview(asset()); controller.actions.closePreview(); pending.resolve(new Uint8Array([1])); await flush();
  expect(create).not.toHaveBeenCalled(); expect(controller.model.preview).toBeNull();
  controller.actions.preview(asset()); await flush(); expect(controller.model.preview?.url).toBe('blob:one');
  controller.dispose(); expect(revoke).toHaveBeenCalledWith('blob:one'); expect(controller.model.preview).toBeNull();
});

it('预览读损坏不移除记录，图片解码失败关闭预览并保留原件说明', async () => {
  const host = makeHost(); host.store.read.mockRejectedValueOnce(new Error('摘要不符'));
  const controller = createLocalImagesController(host); controller.actions.preview(asset()); await flush();
  expect(controller.model.error).toContain('原记录已保留'); expect(host.store.remove).not.toHaveBeenCalled();
  controller.actions.previewFailed('blob:stale'); expect(controller.model.preview).toBeNull(); expect(controller.model.error).toContain('原记录已保留');
});

it.each(['C:\\AppData\\exports\\images\\original.png', '已请求浏览器下载，无法确认文件落盘。'])('导出原样展示宿主结果 %s，不统一假称已落盘', async result => {
  const host = makeHost(); host.exportImage.mockResolvedValue(result); const controller = createLocalImagesController(host);
  controller.actions.exportImage(asset()); await flush(); expect(controller.model.notice).toBe(result);
});
