import {
  LOCAL_IMAGE_MAX_BYTES, LOCAL_IMAGE_MAX_EDGE, LOCAL_IMAGE_MAX_PIXELS, LocalImageAssetSchema,
  type LocalImageAsset, type LocalImageListRequest, type LocalImagePage, type LocalImageSaveResult,
} from '@mahoshojo/contracts/local-image-assets';

export type { LocalImageAsset, LocalImageListRequest, LocalImagePage, LocalImageSaveResult };
/** The host can prove the operation was rejected before any persistent mutation. */
export class LocalImageRejectedError extends Error {
  override readonly name = 'LocalImageRejectedError';
}
export interface LocalImageRepository {
  list(_request: LocalImageListRequest): Promise<LocalImagePage>;
  save(_title: string, _bytes: Uint8Array): Promise<LocalImageSaveResult>;
  read(_asset: LocalImageAsset): Promise<Uint8Array>;
  remove(_id: string): Promise<void>;
  restore(_id: string): Promise<void>;
  purge(_id: string): Promise<void>;
}

export function assertLocalImageDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > LOCAL_IMAGE_MAX_EDGE || height > LOCAL_IMAGE_MAX_EDGE || width * height > LOCAL_IMAGE_MAX_PIXELS) {
    throw new Error('图片超过本地上限（单边 8192 像素、总计 16 MP）。');
  }
}
const ascii = (bytes: Uint8Array, start: number, size: number) => String.fromCharCode(...bytes.subarray(start, start + size));
/** Header preflight only. The host must also decode before saving. */
export function inspectLocalImageRaster(bytes: Uint8Array): { mimeType: LocalImageAsset['mimeType']; width: number; height: number } {
  if (!bytes.length || bytes.length > LOCAL_IMAGE_MAX_BYTES) throw new Error('图片不能为空或超过 10 MiB。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let mimeType: LocalImageAsset['mimeType'] | undefined; let width = 0; let height = 0;
  if (bytes.length >= 33 && bytes[0] === 137 && ascii(bytes, 1, 7) === 'PNG\r\n\x1a\n' && ascii(bytes, 12, 4) === 'IHDR') {
    mimeType = 'image/png'; width = view.getUint32(16); height = view.getUint32(20);
    let ended = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12) throw new Error('PNG 图片数据不完整。');
      const kind = ascii(bytes, offset + 4, 4);
      if (kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT') throw new Error('不支持动画图片。');
      offset += length + 12;
      if (kind === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
    }
    if (!ended) throw new Error('PNG 图片数据不完整。');
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    mimeType = 'image/jpeg';
    for (let offset = 2; offset + 3 < bytes.length;) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += length;
    }
  } else if (bytes.length >= 26 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    mimeType = 'image/webp';
    if (view.getUint32(4, true) + 8 !== bytes.length) throw new Error('WebP 图片长度不符。');
    let offset = 12;
    for (; offset + 8 <= bytes.length;) {
      const kind = ascii(bytes, offset, 4); const length = view.getUint32(offset + 4, true); const body = offset + 8;
      if (length > bytes.length - body) throw new Error('WebP 图片数据不完整。');
      if (kind === 'ANIM' || kind === 'ANMF' || (kind === 'VP8X' && length >= 10 && (bytes[body] & 2))) throw new Error('不支持动画图片。');
      if (kind === 'VP8X' && length >= 10) {
        width = 1 + bytes[body + 4] + (bytes[body + 5] << 8) + (bytes[body + 6] << 16);
        height = 1 + bytes[body + 7] + (bytes[body + 8] << 8) + (bytes[body + 9] << 16);
      } else if (!width && kind === 'VP8 ' && length >= 10 && bytes[body + 3] === 0x9d && bytes[body + 4] === 1 && bytes[body + 5] === 0x2a) {
        width = view.getUint16(body + 6, true) & 0x3fff; height = view.getUint16(body + 8, true) & 0x3fff;
      } else if (!width && kind === 'VP8L' && length >= 5 && bytes[body] === 0x2f) {
        width = 1 + bytes[body + 1] + ((bytes[body + 2] & 0x3f) << 8);
        height = 1 + (bytes[body + 2] >> 6) + (bytes[body + 3] << 2) + ((bytes[body + 4] & 0xf) << 10);
      }
      offset = body + length + length % 2;
    }
    if (offset !== bytes.length) throw new Error('WebP 图片数据不完整。');
  }
  if (!mimeType || !width || !height) throw new Error('请选择有效的静态 PNG / JPEG / WebP 图片。');
  assertLocalImageDimensions(width, height);
  return { mimeType, width, height };
}

export async function digestLocalImage(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return `sha256:${Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('')}`;
}
export const localImageId = (digest: string): string => `image-${digest.slice(7)}`;

/** Read failures never remove the record or silently replace it with empty content. */
export async function verifyLocalImageBytes(asset: LocalImageAsset, bytes: Uint8Array): Promise<void> {
  const record = LocalImageAssetSchema.parse(asset);
  const raster = inspectLocalImageRaster(bytes);
  if (bytes.length !== record.byteLength || raster.mimeType !== record.mimeType || raster.width !== record.width
    || raster.height !== record.height || await digestLocalImage(bytes) !== record.digest) throw new Error('本地图片完整性校验失败，原记录已保留。');
}
export const localImageExtension = (mimeType: LocalImageAsset['mimeType']): string => mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
