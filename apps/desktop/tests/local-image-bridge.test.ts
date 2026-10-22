import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LocalImageAssetSchema } from '@mahoshojo/contracts/local-image-assets';
import { LocalImageRejectedError } from '@mahoshojo/local-library/image-assets';
import { createDesktopImageHost, DesktopImageRepository } from '../src/platform/local-image-bridge';

const fixture = JSON.parse(readFileSync(path.resolve(process.cwd(), '../../packages/contracts/fixtures/local-image-assets.json'), 'utf8'));
const asset = LocalImageAssetSchema.parse(fixture.asset);
const png = () => new Uint8Array(Buffer.from(fixture.payload.data, 'base64'));
describe('Desktop image IPC bridge', () => {
  it('区分预检和原生明确拒绝与未知IPC结果', async () => {
    const call = vi.fn();
    const repo = new DesktopImageRepository(call);
    await expect(repo.save('bad', new Uint8Array([1]))).rejects.toBeInstanceOf(LocalImageRejectedError);
    expect(call).not.toHaveBeenCalled();
    call.mockRejectedValue({ code: 'image-decode-failed', message: 'private detail' });
    await expect(repo.save('bad', png())).rejects.toBeInstanceOf(LocalImageRejectedError);
    call.mockRejectedValue(new Error('transport lost'));
    await expect(repo.save('unknown', png())).rejects.not.toBeInstanceOf(LocalImageRejectedError);
  });
  it('实际保存只派发有界字节与名称，校验Native自算身份', async () => {
    const call = vi.fn().mockResolvedValue({ asset, outcome: 'stored' });
    const repo = new DesktopImageRepository(call);
    expect(await repo.save(asset.title, png())).toEqual({ asset, outcome: 'stored' });
    expect(call).toHaveBeenCalledExactlyOnceWith('save_local_image_asset', { request: { title: asset.title, payload: fixture.payload } });
    call.mockResolvedValue({ asset: { ...asset, width: 3 }, outcome: 'stored' });
    await expect(repo.save(asset.title, png())).rejects.toThrow('未能确认');
  });
  it('派发前复制字节，迟到调用不采纳调用方改写', async () => {
    const call = vi.fn().mockResolvedValue({ asset, outcome: 'already-present' }); const bytes = png();
    const result = new DesktopImageRepository(call).save(asset.title, bytes); bytes.fill(0);
    await expect(result).resolves.toMatchObject({ asset });
    expect(call.mock.calls[0][1].request.payload.data).toBe(fixture.payload.data);
  });
  it('读取raw字节并校验摘要，拒绝JSON字节与篡改', async () => {
    const bytes = png(); const call = vi.fn().mockResolvedValue(bytes.buffer);
    const repo = new DesktopImageRepository(call);
    expect(await repo.read(asset)).toEqual(bytes);
    expect(call).toHaveBeenCalledWith('read_local_image_asset', { request: { id: asset.id } });
    const bad = png(); bad[45] ^= 1; call.mockResolvedValue(bad.buffer);
    await expect(repo.read(asset)).rejects.toThrow('完整性');
    call.mockResolvedValue([...bytes]); await expect(repo.read(asset)).rejects.toThrow('未能确认');
  });
  it('分页拒绝错误view、重复与不前进cursor，不把非法响应当空库', async () => {
    const call = vi.fn().mockResolvedValue({ items: [asset, asset], nextCursor: asset.id }); const repo = new DesktopImageRepository(call);
    await expect(repo.list({ view: 'active', limit: 10, cursor: null })).rejects.toThrow();
    call.mockResolvedValue({ items: [asset], nextCursor: null });
    await expect(repo.list({ view: 'trash', limit: 10, cursor: null })).rejects.toThrow();
    await expect(repo.list({ view: 'active', limit: 10, cursor: asset.id })).rejects.toThrow();
  });
  it('原图导出只有Native确认路径/长度后成功，删除类请求仅含id', async () => {
    const call = vi.fn().mockResolvedValue({ absolutePath: 'C:\\private-test\\image.png', byteLength: asset.byteLength });
    const host = createDesktopImageHost(call);
    expect(await host.exportImage(asset)).toContain('已保存原图到');
    expect(call).toHaveBeenCalledWith('export_local_image_asset', { request: { id: asset.id } });
    call.mockResolvedValue(null); await host.store.remove(asset.id); await host.store.restore(asset.id); await host.store.purge(asset.id);
    expect(call.mock.calls.slice(1).map(([command]) => command)).toEqual(['delete_local_image_asset', 'restore_local_image_asset', 'purge_local_image_asset']);
    call.mockRejectedValue({ code: 'maintenance-busy', message: 'private diagnostic' });
    await expect(host.store.remove(asset.id)).rejects.toThrow('维护');
    await expect(host.store.remove(asset.id)).rejects.not.toThrow('private diagnostic');
  });
});
