import { invoke } from '@tauri-apps/api/core';
import {
  LocalImageAssetSchema, LocalImageErrorSchema, LocalImageExportResultSchema, LocalImageIdRequestSchema,
  LocalImageListRequestSchema, LocalImagePageSchema, LocalImageSaveRequestSchema, LocalImageSaveResultSchema,
} from '@mahoshojo/contracts/local-image-assets';
import {
  digestLocalImage, inspectLocalImageRaster, verifyLocalImageBytes, LocalImageRejectedError,
  type LocalImageAsset, type LocalImageListRequest, type LocalImageRepository,
} from '@mahoshojo/local-library/image-assets';
import type { LocalImagesHost } from '@mahoshojo/ui-web/local-images';

export type LocalImageInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
const nativeInvoke: LocalImageInvoke = (command, args) => invoke(command, args);
const errorMessages = {
  'image-invalid-input': '图片名称或数据无效。', 'image-too-large': '图片超过 10 MiB 或尺寸上限。',
  'image-unsupported': '仅支持静态 PNG / JPEG / WebP 图片。', 'image-decode-failed': '图片无法解码，请检查原文件。',
  'image-not-found': '找不到这张本地图片，请刷新列表。', 'image-corrupt': '本地图片已损坏，原记录已保留；可重新上传原图修复。',
  'image-not-deleted': '请先将图片移到回收站，再彻底删除。', 'image-unavailable': '本地图片库暂时不可用。',
  'image-failed': '本地图片操作未能完成，请刷新列表核实后重试。',
  'maintenance-busy': '本地库正在维护，请稍后重试。', 'restore-pending': '本地库等待恢复，请退出并重新打开应用。',
} as const;
const explain = (cause: unknown): Error => {
  const parsed = LocalImageErrorSchema.safeParse(cause);
  if (parsed.success && ['image-invalid-input', 'image-too-large', 'image-unsupported', 'image-decode-failed',
    'image-not-found', 'image-corrupt', 'image-not-deleted', 'maintenance-busy', 'restore-pending'].includes(parsed.data.code)) {
    return new LocalImageRejectedError(errorMessages[parsed.data.code]);
  }
  return new Error(parsed.success ? errorMessages[parsed.data.code] : '本地图片操作结果未能确认，请刷新列表核实。');
};

async function prepareImage(title: string, input: Uint8Array) {
  try {
    const bytes = new Uint8Array(input);
    const raster = inspectLocalImageRaster(bytes);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    const request = LocalImageSaveRequestSchema.parse({ title: title.trim(), payload: { encoding: 'base64', data: btoa(binary), byteLength: bytes.length } });
    const digest = await digestLocalImage(bytes);
    return { bytes, raster, request, digest };
  } catch (cause) {
    throw new LocalImageRejectedError(cause instanceof Error ? cause.message : '图片预检未通过。');
  }
}

/** Only asset IDs and bounded bytes cross IPC; no caller-controlled paths or URLs. */
export class DesktopImageRepository implements LocalImageRepository {
  constructor(private readonly call: LocalImageInvoke = nativeInvoke) {}
  async list(input: LocalImageListRequest) {
    const request = LocalImageListRequestSchema.parse(input);
    try {
      const page = LocalImagePageSchema.parse(await this.call('list_local_image_assets', { request }));
      let previous = request.cursor ?? '';
      for (const item of page.items) {
        if (item.id <= previous || (item.deletedAt !== null) !== (request.view === 'trash')) throw new Error('Invalid image page');
        previous = item.id;
      }
      if (page.items.length > request.limit || (page.nextCursor !== null && page.nextCursor !== page.items.at(-1)?.id)) throw new Error('Invalid image cursor');
      return page;
    } catch (cause) { throw explain(cause); }
  }
  async save(title: string, input: Uint8Array) {
    const { bytes, raster, request, digest } = await prepareImage(title, input);
    try {
      const result = LocalImageSaveResultSchema.parse(await this.call('save_local_image_asset', { request }));
      if (result.asset.digest !== digest || result.asset.byteLength !== bytes.length || result.asset.mimeType !== raster.mimeType
        || result.asset.width !== raster.width || result.asset.height !== raster.height) throw new Error('Mismatched image result');
      return result;
    } catch (cause) { throw explain(cause); }
  }
  async read(input: LocalImageAsset): Promise<Uint8Array> {
    const asset = LocalImageAssetSchema.parse(input);
    let bytes: Uint8Array;
    try {
      const raw = await this.call('read_local_image_asset', { request: { id: asset.id } });
      if (!(raw instanceof ArrayBuffer)) throw new Error('Invalid raw image response');
      bytes = new Uint8Array(raw);
    } catch (cause) { throw explain(cause); }
    await verifyLocalImageBytes(asset, bytes);
    return bytes;
  }
  private async transition(command: string, id: string): Promise<void> {
    const request = LocalImageIdRequestSchema.parse({ id });
    try {
      if (await this.call(command, { request }) !== null) throw new Error('Invalid image transition response');
    } catch (cause) { throw explain(cause); }
  }
  remove(id: string) { return this.transition('delete_local_image_asset', id); }
  restore(id: string) { return this.transition('restore_local_image_asset', id); }
  purge(id: string) { return this.transition('purge_local_image_asset', id); }
}

export function createDesktopImageHost(call: LocalImageInvoke = nativeInvoke): LocalImagesHost {
  return {
    store: new DesktopImageRepository(call),
    async exportImage(input) {
      const asset = LocalImageAssetSchema.parse(input);
      try {
        const result = LocalImageExportResultSchema.parse(await call('export_local_image_asset', { request: { id: asset.id } }));
        if (result.byteLength !== asset.byteLength) throw new Error('Mismatched image export');
        return `已保存原图到：${result.absolutePath}`;
      } catch (cause) { throw explain(cause); }
    },
    describeError: cause => cause instanceof Error ? cause.message : '本地图片操作结果未能确认，请刷新列表核实。',
  };
}
