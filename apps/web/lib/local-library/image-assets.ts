import {
  digestLocalImage,
  inspectLocalImageRaster,
  localImageExtension,
  localImageId,
  verifyLocalImageBytes,
} from '@mahoshojo/local-library/image-assets';
import {
  LocalImageAssetSchema,
  LocalImageIdSchema,
  LocalImageListRequestSchema,
  LocalImagePageSchema,
  type LocalImageAsset,
  type LocalImageListRequest,
  type LocalImagePage,
  type LocalImageSaveResult,
} from '@mahoshojo/contracts/local-image-assets';
import { LocalImageRejectedError, type LocalImageRepository } from '@mahoshojo/local-library/image-assets';
import { validateLocalImageDecode } from '@mahoshojo/ui-web/local-images/browser-image';
import type { LocalImagesHost } from '@mahoshojo/ui-web/local-images';

import { buildSafeFileName } from '@/lib/client/fileName';
import { downloadBlob } from '@/lib/client/blobUrl';

import {
  LOCAL_LIBRARY_STORE_NAMES,
  deleteLocalLibraryRecord,
  getLocalLibraryRecord,
  putLocalLibraryRecord,
  runLocalLibraryTransaction,
  toDetachedArrayBuffer,
  toStoredBytes,
} from './db';

type ImageDecoder = (bytes: Uint8Array) => Promise<void>;
type StoredImageBytes = { id: string; bytes: unknown };

const imageDecodeFailed = (): Error => new Error('图片无法解码，未保存到本地库。');

const asRejectedSaveError = (cause: unknown): LocalImageRejectedError => {
  if (cause instanceof LocalImageRejectedError) return cause;
  const message = cause instanceof Error ? cause.message : '本地图片保存输入无效。';
  return new LocalImageRejectedError(message);
};

const decodeImage = async (bytes: Uint8Array, decoder: ImageDecoder): Promise<void> => {
  try {
    await decoder(bytes);
  } catch (cause) {
    throw imageDecodeFailed();
  }
};

const verifyStoredImage = async (asset: LocalImageAsset, bytes: Uint8Array): Promise<void> => {
  try {
    await verifyLocalImageBytes(asset, bytes);
  } catch {
    throw new Error('本地图片完整性校验失败，原记录已保留。');
  }
};

const parseAsset = (value: unknown): LocalImageAsset => {
  try {
    return LocalImageAssetSchema.parse(value);
  } catch {
    throw new Error('本地图片元数据损坏，原记录已保留。');
  }
};

const parseImageId = (value: string): string => LocalImageIdSchema.parse(value);

const sameAsset = (left: LocalImageAsset, right: LocalImageAsset): boolean =>
  left.schemaVersion === right.schemaVersion
  && left.id === right.id
  && left.digest === right.digest
  && left.title === right.title
  && left.mimeType === right.mimeType
  && left.byteLength === right.byteLength
  && left.width === right.width
  && left.height === right.height
  && left.createdAt === right.createdAt
  && left.deletedAt === right.deletedAt
  && left.source === right.source;

const listPage = (
  request: LocalImageListRequest,
): Promise<LocalImagePage> => runLocalLibraryTransaction(
  LOCAL_LIBRARY_STORE_NAMES.imageAssets,
  'readonly',
  (transaction) => new Promise((resolve, reject) => {
    const store = transaction.objectStore(LOCAL_LIBRARY_STORE_NAMES.imageAssets);
    const range = request.cursor === null ? undefined : IDBKeyRange.lowerBound(request.cursor, true);
    const cursorRequest = store.openCursor(range);
    const items: LocalImageAsset[] = [];
    let nextCursor: string | null = null;

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor === null) {
        resolve(LocalImagePageSchema.parse({ items, nextCursor }));
        return;
      }
      try {
        const asset = parseAsset(cursor.value);
        const matches = request.view === 'trash' ? asset.deletedAt !== null : asset.deletedAt === null;
        if (matches && items.length === request.limit) {
          nextCursor = items[items.length - 1]?.id ?? null;
          resolve(LocalImagePageSchema.parse({ items, nextCursor }));
          return;
        }
        if (matches) items.push(asset);
        cursor.continue();
      } catch (cause) {
        reject(cause);
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('本地图片列表读取失败。'));
  }),
);

export class IndexedDbLocalImageRepository implements LocalImageRepository {
  constructor(
    private readonly decode: ImageDecoder = validateLocalImageDecode,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async list(request: LocalImageListRequest) {
    const parsed = LocalImageListRequestSchema.parse(request);
    return listPage(parsed);
  }

  async save(title: string, inputBytes: Uint8Array): Promise<LocalImageSaveResult> {
    let bytes: Uint8Array;
    let raster: ReturnType<typeof inspectLocalImageRaster>;
    let digest: string;
    let id: string;
    let candidate: LocalImageAsset;
    let detached: ArrayBuffer;
    try {
      // Make one owned copy up front: caller mutation while digest/decode run must not produce mixed data.
      bytes = new Uint8Array(inputBytes);
      raster = inspectLocalImageRaster(bytes);
      await decodeImage(bytes, this.decode);
      digest = await digestLocalImage(bytes);
      id = localImageId(digest);
      candidate = parseAsset({
        schemaVersion: 1,
        id,
        digest,
        title,
        mimeType: raster.mimeType,
        byteLength: bytes.byteLength,
        width: raster.width,
        height: raster.height,
        createdAt: this.now(),
        deletedAt: null,
        source: 'uploaded',
      });
      detached = toDetachedArrayBuffer(bytes);
    } catch (cause) {
      throw asRejectedSaveError(cause);
    }

    return runLocalLibraryTransaction(
      [LOCAL_LIBRARY_STORE_NAMES.imageAssets, LOCAL_LIBRARY_STORE_NAMES.imageAssetBytes],
      'readwrite',
      async (transaction) => {
        const assetStore = transaction.objectStore(LOCAL_LIBRARY_STORE_NAMES.imageAssets);
        const bytesStore = transaction.objectStore(LOCAL_LIBRARY_STORE_NAMES.imageAssetBytes);
        const [storedAsset, storedBytes] = await Promise.all([
          getLocalLibraryRecord<unknown>(assetStore, id),
          getLocalLibraryRecord<StoredImageBytes>(bytesStore, id),
        ]);

        if (storedAsset === undefined) {
          // Both writes are atomic with one another. A quota abort cannot leave a visible half-record.
          await putLocalLibraryRecord(bytesStore, { id, bytes: detached });
          await putLocalLibraryRecord(assetStore, candidate);
          return { asset: candidate, outcome: 'stored' };
        }

        const existing = parseAsset(storedAsset);
        if (existing.id !== id || existing.digest !== digest || existing.mimeType !== raster.mimeType
          || existing.byteLength !== bytes.byteLength || existing.width !== raster.width || existing.height !== raster.height) {
          throw new Error('本地图片元数据与原图不符，原记录已保留。');
        }
        const oldBytes = storedBytes === undefined ? null : toStoredBytes(storedBytes.bytes);
        if (oldBytes !== null && oldBytes.byteLength === bytes.byteLength
          && oldBytes.every((byte, index) => byte === bytes[index])) {
          // The submitted bytes have already passed digest, header, and decoder validation outside this
          // transaction. Byte equality proves the existing content is the same without awaiting crypto
          // while an IndexedDB transaction is open.
          return { asset: existing, outcome: 'already-present' };
        }
        // Correct uploaded bytes repair the content-addressed row without changing user metadata.
        await putLocalLibraryRecord(bytesStore, { id, bytes: detached });
        return { asset: existing, outcome: 'repaired' };
      },
    );
  }

  async read(asset: LocalImageAsset): Promise<Uint8Array> {
    const requested = parseAsset(asset);
    const stored = await runLocalLibraryTransaction(
      [LOCAL_LIBRARY_STORE_NAMES.imageAssets, LOCAL_LIBRARY_STORE_NAMES.imageAssetBytes],
      'readonly',
      async (transaction) => {
        const [storedAsset, storedBytes] = await Promise.all([
          getLocalLibraryRecord<unknown>(transaction.objectStore(LOCAL_LIBRARY_STORE_NAMES.imageAssets), requested.id),
          getLocalLibraryRecord<StoredImageBytes>(transaction.objectStore(LOCAL_LIBRARY_STORE_NAMES.imageAssetBytes), requested.id),
        ]);
        if (storedAsset === undefined) throw new Error('本地图片不存在。');
        const current = parseAsset(storedAsset);
        if (!sameAsset(current, requested)) throw new Error('本地图片记录已变化，请刷新后重试。');
        if (storedBytes === undefined) throw new Error('本地图片字节缺失，原记录已保留。');
        const bytes = toStoredBytes(storedBytes.bytes);
        if (bytes === null) throw new Error('本地图片字节损坏，原记录已保留。');
        return { current, bytes: new Uint8Array(bytes) };
      },
    );
    await verifyStoredImage(stored.current, stored.bytes);
    await decodeImage(stored.bytes, this.decode);
    return stored.bytes;
  }

  async remove(id: string): Promise<void> {
    parseImageId(id);
    await runLocalLibraryTransaction(LOCAL_LIBRARY_STORE_NAMES.imageAssets, 'readwrite', async (transaction) => {
      const store = transaction.objectStore(LOCAL_LIBRARY_STORE_NAMES.imageAssets);
      const value = await getLocalLibraryRecord<unknown>(store, id);
      if (value === undefined) throw new Error('本地图片不存在。');
      const existing = parseAsset(value);
      if (existing.deletedAt !== null) return;
      await putLocalLibraryRecord(store, { ...existing, deletedAt: this.now() });
    });
  }

  async restore(id: string): Promise<void> {
    parseImageId(id);
    await runLocalLibraryTransaction(LOCAL_LIBRARY_STORE_NAMES.imageAssets, 'readwrite', async (transaction) => {
      const store = transaction.objectStore(LOCAL_LIBRARY_STORE_NAMES.imageAssets);
      const value = await getLocalLibraryRecord<unknown>(store, id);
      if (value === undefined) throw new Error('本地图片不存在。');
      const existing = parseAsset(value);
      if (existing.deletedAt === null) return;
      await putLocalLibraryRecord(store, { ...existing, deletedAt: null });
    });
  }

  async purge(id: string): Promise<void> {
    parseImageId(id);
    await runLocalLibraryTransaction(
      [LOCAL_LIBRARY_STORE_NAMES.imageAssets, LOCAL_LIBRARY_STORE_NAMES.imageAssetBytes],
      'readwrite',
      async (transaction) => {
        const store = transaction.objectStore(LOCAL_LIBRARY_STORE_NAMES.imageAssets);
        const value = await getLocalLibraryRecord<unknown>(store, id);
        if (value === undefined) throw new Error('本地图片不存在。');
        const existing = parseAsset(value);
        if (existing.deletedAt === null) throw new Error('只有回收站图片可以彻底删除。');
        await Promise.all([
          deleteLocalLibraryRecord(transaction.objectStore(LOCAL_LIBRARY_STORE_NAMES.imageAssets), id),
          deleteLocalLibraryRecord(transaction.objectStore(LOCAL_LIBRARY_STORE_NAMES.imageAssetBytes), id),
        ]);
      },
    );
  }
}

let sharedRepository: IndexedDbLocalImageRepository | null = null;

export const getLocalImageRepository = (): IndexedDbLocalImageRepository => {
  sharedRepository ??= new IndexedDbLocalImageRepository();
  return sharedRepository;
};

export const resetLocalImageRepository = (): void => {
  sharedRepository = null;
};

/** Browser download is only requested; the browser owns whether and where it reaches disk. */
export const createWebImageHost = (
  store: LocalImageRepository = getLocalImageRepository(),
): LocalImagesHost => {
  return {
    store,
    async exportImage(asset) {
      const bytes = await store.read(asset);
      const extension = localImageExtension(asset.mimeType);
      const title = asset.title.replace(/\.(?:png|jpe?g|webp)$/iu, '');
      const filename = buildSafeFileName(title, extension, 'image');
      downloadBlob(new Blob([new Uint8Array(bytes).buffer], { type: asset.mimeType }), filename);
      return `已请求浏览器下载：${filename}`;
    },
  };
};
