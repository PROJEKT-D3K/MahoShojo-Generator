import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/local-image-assets.json';
import { LOCAL_IMAGE_MAX_BYTES, LocalImageAssetSchema, LocalImageIdRequestSchema, LocalImageListRequestSchema,
  LocalImagePayloadSchema, LocalImageSaveRequestSchema } from '../src/local-image-assets';
import { DesktopLocalLibraryAuditFindingSchema, DesktopLocalLibraryAuditReportSchema } from '../src/desktop-ipc';

describe('local image assets v1', () => {
  it('接受跨运行时PNG金样，绑定不可变内容身份', () => {
    expect(LocalImageAssetSchema.parse(fixture.asset)).toEqual(fixture.asset);
    expect(LocalImageSaveRequestSchema.parse({ title: fixture.asset.title, payload: fixture.payload }).payload).toEqual(fixture.payload);
    expect(LocalImageAssetSchema.safeParse({ ...fixture.asset, id: `image-${'0'.repeat(64)}` }).success).toBe(false);
  });
  it.each([
    { width: 8193 }, { width: 8192, height: 2049 }, { byteLength: LOCAL_IMAGE_MAX_BYTES + 1 },
    { mimeType: 'image/svg+xml' }, { title: '私'.repeat(81) }, { title: 'x\ny' }, { title: ' x' },
    { source: 'generated' }, { schemaVersion: 2 }, { secret: 'never' },
  ])('拒绝未支持或越界元数据 %o', change => {
    expect(LocalImageAssetSchema.safeParse({ ...fixture.asset, ...change }).success).toBe(false);
  });
  it('IPC只接受身份/有界信封，拒绝任意路径URL或错误长度', () => {
    expect(LocalImageIdRequestSchema.safeParse({ id: fixture.asset.id, path: '../x' }).success).toBe(false);
    for (const payload of [{ ...fixture.payload, byteLength: 1 }, { ...fixture.payload, data: 'AAA' },
      { ...fixture.payload, encoding: 'url', data: 'https://example.test/p.png' }, { ...fixture.payload, data: 'AA=A' }]) {
      expect(LocalImagePayloadSchema.safeParse(payload).success).toBe(false);
    }
    expect(LocalImageListRequestSchema.safeParse({ view: 'active', cursor: null, limit: 101 }).success).toBe(false);
  });
  it('10 MiB信封边界可线性校验，不因长Base64耗尽正则调用栈', () => {
    const data = Buffer.alloc(LOCAL_IMAGE_MAX_BYTES).toString('base64');
    expect(LocalImagePayloadSchema.parse({ encoding: 'base64', data, byteLength: LOCAL_IMAGE_MAX_BYTES }).byteLength).toBe(LOCAL_IMAGE_MAX_BYTES);
  });
  it('图片审计作为用户可见损坏并携带规模分母', () => {
    expect(DesktopLocalLibraryAuditFindingSchema.safeParse({ kind: 'image-record-invalid', imageId: '' }).success).toBe(true);
    const finding = { kind: 'image-reference-file-missing', imageId: fixture.asset.id, digest: fixture.asset.digest };
    expect(DesktopLocalLibraryAuditFindingSchema.parse(finding)).toEqual(finding);
    expect(DesktopLocalLibraryAuditReportSchema.safeParse({ findings: [finding], schemaVersion: 12, referencedBlobCount: 1,
      blobMetadataCount: 1, webPackageCount: 0, imageAssetCount: 1 }).success).toBe(true);
  });
});
