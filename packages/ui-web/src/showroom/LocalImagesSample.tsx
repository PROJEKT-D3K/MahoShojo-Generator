import { useState } from 'react';
import { digestLocalImage, inspectLocalImageRaster, localImageId, type LocalImageAsset } from '@mahoshojo/local-library/image-assets';
import { LocalImagesPanel, useLocalImagesController, type LocalImagesHost } from '../local-images';
import { validateLocalImageDecode } from '../local-images/browser-image';

const SAMPLE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFElEQVR4nGP4z8Dwn+E/QwMDBgMAj5oKeCEtq6AAAAAASUVORK5CYII=";
const initialAsset: LocalImageAsset = {
  schemaVersion: 1, id: "image-df5bb0d08a710f8e7ef96409c1f44b148f73680ea7a741a8b80bfdb03a80abd9", digest: "sha256:df5bb0d08a710f8e7ef96409c1f44b148f73680ea7a741a8b80bfdb03a80abd9", title: '本地原图样板',
  mimeType: 'image/png', byteLength: 77, width: 2, height: 3, createdAt: '2026-10-22T00:00:00.000Z', deletedAt: null, source: 'uploaded',
};

/** 生产面板与控制器；仓储仅在本样板挂载期间留存，避免样板操作污染真实本地库。 */
export function LocalImagesSample() {
  const [host] = useState<LocalImagesHost>(() => {
    const rows = new Map([[initialAsset.id, initialAsset]]);
    const bytes = new Map<string, Uint8Array>([[initialAsset.id, Uint8Array.from(atob(SAMPLE_PNG), value => value.charCodeAt(0))]]);
    return {
      store: {
        list: async request => ({ items: [...rows.values()].filter(asset => Boolean(asset.deletedAt) === (request.view === 'trash')), nextCursor: null }),
        save: async (title, data) => {
          await validateLocalImageDecode(data);
          const digest = await digestLocalImage(data); const id = localImageId(digest);
          const existing = rows.get(id);
          if (existing) return { asset: existing, outcome: 'already-present' };
          const asset: LocalImageAsset = { ...initialAsset, ...inspectLocalImageRaster(data), id, digest, title, byteLength: data.length, createdAt: new Date().toISOString() };
          rows.set(id, asset); bytes.set(id, data); return { asset, outcome: 'stored' };
        },
        read: async asset => bytes.get(asset.id)!,
        remove: async id => { const asset = rows.get(id)!; rows.set(id, { ...asset, deletedAt: new Date().toISOString() }); },
        restore: async id => { const asset = rows.get(id)!; rows.set(id, { ...asset, deletedAt: null }); },
        purge: async id => { rows.delete(id); bytes.delete(id); },
      },
      exportImage: async () => '样板导出反馈：此处仅演示反馈，不写入真实下载目录。',
    };
  });
  const { controller, model } = useLocalImagesController(host);
  return <div aria-label="本地图片生产组件样板"><p className="mb-2 text-sm text-(--app-text-muted)">图片库交互样板：临时内存仓储，可预览、移入回收站、恢复与确认彻底删除。</p><LocalImagesPanel model={model} actions={controller.actions} /></div>;
}
