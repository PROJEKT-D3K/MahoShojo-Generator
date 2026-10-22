import { LOCAL_IMAGE_MAX_BYTES, LocalImageTitleSchema } from '@mahoshojo/contracts/local-image-assets';
import { LocalImageRejectedError, type LocalImageAsset, type LocalImageRepository } from '@mahoshojo/local-library/image-assets';

export interface LocalImagesHost {
  readonly store: LocalImageRepository;
  /** Desktop 返回实际落盘路径；Web 返回已请求浏览器下载的说明。UI 原样展示。 */
  readonly exportImage: (asset: LocalImageAsset) => Promise<string>;
  readonly describeError?: (cause: unknown) => string;
}
export type LocalImagesView = 'active' | 'trash';
export interface LocalImagesModel {
  readonly view: LocalImagesView;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly items: readonly LocalImageAsset[];
  readonly nextCursor: string | null;
  readonly busy: boolean;
  readonly pending: 'list' | 'save' | 'preview' | 'export' | 'remove' | 'restore' | 'purge' | null;
  readonly loadError: string | null;
  readonly error: string | null;
  readonly notice: string | null;
  readonly preview: { readonly asset: LocalImageAsset; readonly url: string } | null;
}
export type LocalImageUpload = Pick<File, 'size' | 'arrayBuffer'>;
export interface LocalImagesActions {
  reload(): void;
  loadMore(): void;
  setView(view: LocalImagesView): void;
  upload(title: string, file: LocalImageUpload): void;
  preview(asset: LocalImageAsset): void;
  closePreview(): void;
  previewFailed(url: string): void;
  exportImage(asset: LocalImageAsset): void;
  remove(id: string): void;
  restore(id: string): void;
  purge(id: string): void;
}
export interface LocalImagesController {
  readonly model: LocalImagesModel;
  readonly actions: LocalImagesActions;
  readonly isBusy: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  /** 释放进程预览 URL 并使未完成的旧读取失效；不撤回已开始的持久写入。 */
  readonly dispose: () => void;
}

const PAGE_SIZE = 20;
export function createLocalImagesController(host: LocalImagesHost): LocalImagesController {
  let model: LocalImagesModel = {
    view: 'active', status: 'idle', items: [], nextCursor: null, busy: false, pending: null,
    loadError: null, error: null, notice: null, preview: null,
  };
  let inFlight = 0;
  let listVersion = 0;
  let previewVersion = 0;
  let lifecycle = 0;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<LocalImagesModel>) => {
    model = { ...model, ...patch };
    for (const listener of listeners) listener();
  };
  const describe = (cause: unknown) => host.describeError?.(cause) ?? (cause instanceof Error ? cause.message : '本地图片操作未完成，请重试。');
  const begin = (pending: LocalImagesModel['pending']) => {
    inFlight++;
    update({ busy: true, pending });
  };
  const end = () => {
    inFlight--;
    if (inFlight === 0) update({ busy: false, pending: null });
  };
  const closePreview = () => {
    previewVersion++;
    if (model.preview) URL.revokeObjectURL(model.preview.url);
    update({ preview: null });
  };
  const readList = async (more = false) => {
    const version = ++listVersion;
    const view = model.view;
    const cursor = more ? model.nextCursor : null;
    const previous = more ? model.items : [];
    update({ status: 'loading', loadError: null });
    try {
      const page = await host.store.list({ view, limit: PAGE_SIZE, cursor });
      if (version !== listVersion) return;
      if (page.nextCursor !== null && (page.nextCursor === cursor || (cursor !== null && page.nextCursor < cursor))) {
        throw new Error('图片列表返回了无效分页游标，请刷新后重试。');
      }
      const items = [...previous, ...page.items];
      if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('图片列表返回了重复记录，请刷新后重试。');
      update({ status: 'ready', items, nextCursor: page.nextCursor });
    } catch (cause) {
      if (version !== listVersion) return;
      update({ status: 'error', loadError: describe(cause) });
    }
  };
  const load = async (more = false) => {
    // 切换视图/刷新可替代在途列表读取，写入与其他 IO 始终单飞。
    if (inFlight && model.pending !== 'list') return;
    if (more && (inFlight || model.nextCursor === null)) return;
    begin('list');
    try { await readList(more); } finally { end(); }
  };
  const mutate = async (action: 'remove' | 'restore' | 'purge', id: string) => {
    if (inFlight) return;
    const current = lifecycle;
    begin(action); closePreview(); update({ error: null, notice: null });
    try {
      await host.store[action](id);
      if (current !== lifecycle) return;
      update({ notice: action === 'remove' ? '已移入图片回收站，可在回收站恢复。' : action === 'restore' ? '已恢复图片。' : '已彻底删除图片记录。' });
    } catch (cause) {
      if (current !== lifecycle) return;
      update({ error: cause instanceof LocalImageRejectedError ? describe(cause) : `操作结果尚未确认，请刷新核实。${describe(cause)}` });
    } finally {
      if (current === lifecycle) await readList();
      end();
    }
  };
  const upload = async (title: string, file: LocalImageUpload) => {
    if (inFlight) return;
    const normalized = title.trim();
    if (!LocalImageTitleSchema.safeParse(normalized).success) {
      update({ error: '图片名称不能为空、含控制字符或超过 240 UTF-8 字节；请修改名称后再保存。', notice: null }); return;
    }
    if (file.size < 1 || file.size > LOCAL_IMAGE_MAX_BYTES) {
      update({ error: '图片不能为空或超过 10 MiB。', notice: null }); return;
    }
    const current = lifecycle;
    begin('save'); update({ error: null, notice: null });
    let submitted = false;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (current !== lifecycle) return;
      if (bytes.length !== file.size || bytes.length > LOCAL_IMAGE_MAX_BYTES) throw new Error('图片读取长度不符，请重新选择原图。');
      submitted = true;
      const saved = await host.store.save(normalized, bytes);
      if (current !== lifecycle) return;
      const message = saved.outcome === 'repaired' ? '已使用原图修复本地图片。' : saved.outcome === 'already-present' ? '这张图片已保存在本机，保留原名称和创建时间。' : '图片已保存到本机。';
      update({ notice: `${message}${saved.asset.deletedAt ? '该图片仍在回收站，请切换到图片回收站恢复。' : ''}` });
    } catch (cause) {
      if (current !== lifecycle) return;
      update({ error: submitted && !(cause instanceof LocalImageRejectedError)
        ? `保存结果尚未确认。请刷新核实，或使用同一原图重试；重复内容不会创建第二份资产。${describe(cause)}`
        : describe(cause) });
    } finally {
      if (current === lifecycle && submitted) await readList();
      end();
    }
  };
  const preview = async (asset: LocalImageAsset) => {
    if (inFlight) return;
    closePreview();
    const version = previewVersion;
    begin('preview'); update({ error: null });
    try {
      const bytes = await host.store.read(asset);
      if (version !== previewVersion) return;
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: asset.mimeType }));
      update({ preview: { asset, url } });
    } catch (cause) {
      if (version === previewVersion) update({ error: `图片暂时无法预览，原记录已保留。${describe(cause)}` });
    } finally { end(); }
  };
  const exportImage = async (asset: LocalImageAsset) => {
    if (inFlight) return;
    const current = lifecycle;
    begin('export'); update({ error: null, notice: null });
    try {
      const result = await host.exportImage(asset);
      if (current === lifecycle) update({ notice: result });
    } catch (cause) {
      if (current === lifecycle) update({ error: `导出未获确认。${describe(cause)}` });
    } finally { end(); }
  };
  return {
    get model() { return model; },
    isBusy: () => inFlight > 0,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose: () => {
      lifecycle++; listVersion++; closePreview();
      // StrictMode 重连后，宿主仍可重新安排被清理的首次读取。
      if (model.status === 'loading') update({ status: 'idle' });
    },
    actions: {
      reload: () => { void load(); }, loadMore: () => { void load(true); },
      setView: view => {
        if (view === model.view || (inFlight && model.pending !== 'list')) return;
        closePreview(); update({ view, items: [], nextCursor: null, error: null, notice: null }); void load();
      },
      upload: (title, file) => { void upload(title, file); },
      preview: asset => { void preview(asset); }, closePreview,
      previewFailed: url => {
        if (model.preview?.url !== url) return;
        closePreview(); update({ error: '浏览器无法显示这张图片，原记录已保留；可重新上传正确原图修复。' });
      },
      exportImage: asset => { void exportImage(asset); },
      remove: id => { void mutate('remove', id); }, restore: id => { void mutate('restore', id); }, purge: id => { void mutate('purge', id); },
    },
  };
}
