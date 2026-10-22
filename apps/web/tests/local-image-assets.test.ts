import '@/tests/helpers/fake-indexeddb';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOCAL_LIBRARY_DB_NAME,
  LOCAL_LIBRARY_DB_VERSION,
  LOCAL_LIBRARY_STORE_NAMES,
  openLocalLibraryDb,
  resetLocalLibraryDbConnection,
} from '@/lib/local-library/db';
import {
  createWebImageHost,
  IndexedDbLocalImageRepository,
  resetLocalImageRepository,
} from '@/lib/local-library/image-assets';
import type { LocalImageAsset } from '@mahoshojo/contracts/local-image-assets';
import { LocalImageRejectedError } from '@mahoshojo/local-library/image-assets';

const download = vi.hoisted(() => vi.fn());
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: download }));

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nYkAAAAASUVORK5CYII=';
const pngBytes = (): Uint8Array => Uint8Array.from(atob(PNG_BASE64), char => char.charCodeAt(0));
const decoder = vi.fn(async (_bytes: Uint8Array) => undefined);

const deleteDatabase = (name: string): Promise<void> => new Promise((resolve, reject) => {
  const request = indexedDB.deleteDatabase(name);
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'));
  request.onblocked = () => reject(new Error('deleteDatabase blocked'));
});

const saveOne = async (bytes = pngBytes(), title = '测试图片'): Promise<LocalImageAsset> =>
  (await new IndexedDbLocalImageRepository(decoder).save(title, bytes)).asset;

const rawImageBytes = async (id: string): Promise<unknown> => {
  const db = await openLocalLibraryDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(LOCAL_LIBRARY_STORE_NAMES.imageAssetBytes, 'readonly')
      .objectStore(LOCAL_LIBRARY_STORE_NAMES.imageAssetBytes).get(id);
    request.onsuccess = () => resolve(request.result?.bytes);
    request.onerror = () => reject(request.error);
  });
};

const storeCount = async (name: string): Promise<number> => {
  const db = await openLocalLibraryDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(name, 'readonly').objectStore(name).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

beforeEach(async () => {
  resetLocalImageRepository();
  resetLocalLibraryDbConnection();
  download.mockReset();
  decoder.mockClear();
  await deleteDatabase(LOCAL_LIBRARY_DB_NAME);
});

describe('Web IndexedDB image assets', () => {
  it('upgrades a version-1 local library in place and preserves its stores', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(LOCAL_LIBRARY_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('data-cards', { keyPath: 'id' });
        db.createObjectStore('web-packages', { keyPath: 'id' });
        db.createObjectStore('web-package-archives', { keyPath: 'digest' });
        db.createObjectStore('meta', { keyPath: 'key' });
        request.transaction?.objectStore('data-cards').put({ id: 'old-card', name: '旧卡' });
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error ?? new Error('open database failed'));
    });

    const upgraded = await openLocalLibraryDb();
    expect(upgraded.version).toBe(2);
    expect(LOCAL_LIBRARY_DB_VERSION).toBe(2);
    expect(upgraded.objectStoreNames.contains('data-cards')).toBe(true);
    expect(upgraded.objectStoreNames.contains(LOCAL_LIBRARY_STORE_NAMES.imageAssets)).toBe(true);
    expect(upgraded.objectStoreNames.contains(LOCAL_LIBRARY_STORE_NAMES.imageAssetBytes)).toBe(true);
    const oldCard = await new Promise<unknown>((resolve, reject) => {
      const request = upgraded.transaction('data-cards', 'readonly').objectStore('data-cards').get('old-card');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(oldCard).toEqual({ id: 'old-card', name: '旧卡' });
  });

  it('saves image metadata and bytes atomically and reopens the persisted original', async () => {
    const repository = new IndexedDbLocalImageRepository(decoder);
    const source = pngBytes();
    const saved = await repository.save('原始立绘.png', source);
    source.fill(0);

    resetLocalImageRepository();
    resetLocalLibraryDbConnection();
    const reopened = new IndexedDbLocalImageRepository(decoder);
    await expect(reopened.read(saved.asset)).resolves.toEqual(pngBytes());
    expect(await rawImageBytes(saved.asset.id)).toBeInstanceOf(ArrayBuffer);
    expect(saved.outcome).toBe('stored');
    expect(decoder).toHaveBeenCalledTimes(2);
  });

  it('does not persist an upload that fails actual image decoding', async () => {
    const repository = new IndexedDbLocalImageRepository(async () => { throw new Error('decode failed'); });
    const failure = await repository.save('坏图片', pngBytes()).catch(cause => cause);
    expect(failure).toBeInstanceOf(LocalImageRejectedError);
    expect(failure).toMatchObject({ message: '图片无法解码，未保存到本地库。' });
    expect(await repository.list({ view: 'active', limit: 10, cursor: null })).toEqual({ items: [], nextCursor: null });
    expect(await storeCount(LOCAL_LIBRARY_STORE_NAMES.imageAssets)).toBe(0);
    expect(await storeCount(LOCAL_LIBRARY_STORE_NAMES.imageAssetBytes)).toBe(0);
  });

  it('classifies malformed image headers as rejected before persistence', async () => {
    const repository = new IndexedDbLocalImageRepository(decoder);
    const failure = await repository.save('坏格式', new Uint8Array([1, 2, 3])).catch(cause => cause);
    expect(failure).toBeInstanceOf(LocalImageRejectedError);
    expect(failure).toMatchObject({ message: '请选择有效的静态 PNG / JPEG / WebP 图片。' });
    expect(await storeCount(LOCAL_LIBRARY_STORE_NAMES.imageAssets)).toBe(0);
    expect(await storeCount(LOCAL_LIBRARY_STORE_NAMES.imageAssetBytes)).toBe(0);
  });

  it('keeps the original title, creation time, and tombstone on repeated saves', async () => {
    const repository = new IndexedDbLocalImageRepository(decoder, () => '2026-10-22T10:00:00.000Z');
    const first = await repository.save('原名称', pngBytes());
    expect(await repository.save('新名称', pngBytes())).toEqual({ asset: first.asset, outcome: 'already-present' });

    await repository.remove(first.asset.id);
    const trashed = (await repository.list({ view: 'trash', limit: 10, cursor: null })).items[0];
    expect(trashed).toMatchObject({ id: first.asset.id, title: '原名称', createdAt: first.asset.createdAt });
    expect(trashed?.deletedAt).not.toBeNull();
    expect(await repository.save('再次命名', pngBytes())).toEqual({ asset: trashed, outcome: 'already-present' });
    expect((await repository.list({ view: 'active', limit: 10, cursor: null })).items).toEqual([]);
  });

  it('repairs missing or corrupted bytes with correct uploads without changing metadata', async () => {
    const repository = new IndexedDbLocalImageRepository(decoder);
    const original = await repository.save('保留名称', pngBytes());
    const db = await openLocalLibraryDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(LOCAL_LIBRARY_STORE_NAMES.imageAssetBytes, 'readwrite');
      tx.objectStore(LOCAL_LIBRARY_STORE_NAMES.imageAssetBytes).put({ id: original.asset.id, bytes: new Uint8Array([1, 2, 3]).buffer });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await expect(repository.read(original.asset)).rejects.toThrow('完整性校验失败');
    const repaired = await repository.save('不可覆盖', pngBytes());
    expect(repaired).toEqual({ asset: original.asset, outcome: 'repaired' });
    await expect(repository.read(original.asset)).resolves.toEqual(pngBytes());
  });

  it('paginates active and trash records by exclusive ID cursor', async () => {
    const repository = new IndexedDbLocalImageRepository(decoder);
    const source = pngBytes();
    const assets = await Promise.all([0, 1, 2].map(index => {
      const variant = new Uint8Array(source);
      variant[40] = (variant[40] ?? 0) ^ (index + 1);
      return repository.save(`图片${index}`, variant);
    }));
    const sortedIds = assets.map(item => item.asset.id).sort();
    const first = await repository.list({ view: 'active', limit: 1, cursor: null });
    const second = await repository.list({ view: 'active', limit: 1, cursor: first.nextCursor });
    const third = await repository.list({ view: 'active', limit: 1, cursor: second.nextCursor });
    expect([first.items[0]?.id, second.items[0]?.id, third.items[0]?.id]).toEqual(sortedIds);
    expect(first.nextCursor).toBe(sortedIds[0]);
    expect(third.nextCursor).toBeNull();

    await repository.remove(sortedIds[1]!);
    expect((await repository.list({ view: 'trash', limit: 10, cursor: null })).items.map(item => item.id)).toEqual([sortedIds[1]]);
    expect((await repository.list({ view: 'active', limit: 10, cursor: null })).items.map(item => item.id)).toEqual([sortedIds[0], sortedIds[2]]);
  });

  it('fails a page on malformed metadata instead of reporting an empty library', async () => {
    const asset = await saveOne();
    const db = await openLocalLibraryDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(LOCAL_LIBRARY_STORE_NAMES.imageAssets, 'readwrite');
      tx.objectStore(LOCAL_LIBRARY_STORE_NAMES.imageAssets).put({ ...asset, title: '' });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await expect(new IndexedDbLocalImageRepository(decoder).list({ view: 'active', limit: 10, cursor: null }))
      .rejects.toThrow('元数据损坏');
  });

  it('makes remove, restore, and purge explicit and idempotent', async () => {
    const repository = new IndexedDbLocalImageRepository(decoder);
    const asset = await saveOne();
    await expect(repository.purge(asset.id)).rejects.toThrow('回收站');
    await repository.remove(asset.id);
    await repository.remove(asset.id);
    await repository.restore(asset.id);
    await repository.restore(asset.id);
    await expect(repository.read(asset)).resolves.toEqual(pngBytes());
    await repository.remove(asset.id);
    await repository.purge(asset.id);
    await expect(repository.read(asset)).rejects.toThrow('不存在');
    await expect(repository.remove(asset.id)).rejects.toThrow('不存在');
    await expect(repository.restore(asset.id)).rejects.toThrow('不存在');
    await expect(repository.purge(asset.id)).rejects.toThrow('不存在');
    expect(await rawImageBytes(asset.id)).toBeUndefined();
  });

  it('aborts both writes when byte storage exceeds quota and preserves prior data', async () => {
    const repository = new IndexedDbLocalImageRepository(decoder);
    const original = await repository.save('旧图片', pngBytes());
    const nextBytes = pngBytes();
    nextBytes[40] = (nextBytes[40] ?? 0) ^ 9;
    const originalPut = IDBObjectStore.prototype.put;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === LOCAL_LIBRARY_STORE_NAMES.imageAssetBytes) throw new DOMException('quota', 'QuotaExceededError');
      return originalPut.apply(this, args);
    });

    const failure = await repository.save('新图片', nextBytes).catch(cause => cause);
    expect(failure).toMatchObject({ message: 'quota' });
    expect(failure).not.toBeInstanceOf(LocalImageRejectedError);
    putSpy.mockRestore();
    await expect(repository.read(original.asset)).resolves.toEqual(pngBytes());
    expect((await repository.list({ view: 'active', limit: 10, cursor: null })).items).toEqual([original.asset]);
  });

  it('exports original bytes with the MIME-derived extension and honest browser wording', async () => {
    const repository = new IndexedDbLocalImageRepository(decoder);
    const asset = await saveOne(pngBytes(), '测试图.png');
    const host = createWebImageHost(repository);
    await expect(host.exportImage(asset)).resolves.toBe('已请求浏览器下载：测试图.png');
    expect(download).toHaveBeenCalledOnce();
    const [blob, filename] = download.mock.calls[0] as [Blob, string];
    expect(filename).toBe('测试图.png');
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(pngBytes());
  });
});
