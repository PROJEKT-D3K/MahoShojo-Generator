import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LocalImageAssetSchema } from '@mahoshojo/contracts/local-image-assets';
import { assertLocalImageDimensions, digestLocalImage, inspectLocalImageRaster, localImageId, verifyLocalImageBytes } from '../src/image-assets';

const fixture = JSON.parse(readFileSync(path.resolve(process.cwd(), '../contracts/fixtures/local-image-assets.json'), 'utf8'));
const png = () => new Uint8Array(Buffer.from(fixture.payload.data, 'base64'));
describe('local image bytes', () => {
  it('WebP 必须包含完整的 chunk 与 padding，不接受容器内尾随碎片', () => {
    const bytes = new Uint8Array(26);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('RIFF'), 0); view.setUint32(4, 18, true);
    bytes.set(new TextEncoder().encode('WEBPVP8L'), 8); view.setUint32(16, 5, true); bytes[20] = 0x2f;
    expect(inspectLocalImageRaster(bytes)).toEqual({ mimeType: 'image/webp', width: 1, height: 1 });
    const malformed = new Uint8Array(27); malformed.set(bytes); new DataView(malformed.buffer).setUint32(4, 19, true);
    expect(() => inspectLocalImageRaster(malformed)).toThrow('WebP 图片数据不完整');
  });
  it('共享原图字节身份，与Native金样一致且不受展示名称影响', async () => {
    const bytes = png();
    expect(inspectLocalImageRaster(bytes)).toEqual({ mimeType: 'image/png', width: 2, height: 3 });
    expect(await digestLocalImage(bytes)).toBe(fixture.asset.digest);
    expect(localImageId(await digestLocalImage(bytes))).toBe(fixture.asset.id);
    await verifyLocalImageBytes(LocalImageAssetSchema.parse(fixture.asset), bytes);
  });
  it('读取校验拒绝等长篡改，长度与像素字段漂移', async () => {
    const corrupt = png(); corrupt[45] ^= 1;
    await expect(verifyLocalImageBytes(LocalImageAssetSchema.parse(fixture.asset), corrupt)).rejects.toThrow('完整性');
    await expect(verifyLocalImageBytes(LocalImageAssetSchema.parse({ ...fixture.asset, width: 3 }), png())).rejects.toThrow('完整性');
    await expect(verifyLocalImageBytes(LocalImageAssetSchema.parse({ ...fixture.asset, byteLength: 76 }), png())).rejects.toThrow('完整性');
  });
  it('拒绝APNG、截断PNG、SVG、空图和无可用尺寸', () => {
    const animated = png(); animated.set(new TextEncoder().encode('acTL'), 37);
    for (const bytes of [animated, png().subarray(0, 60), new TextEncoder().encode('<svg/>'), new Uint8Array()]) {
      expect(() => inspectLocalImageRaster(bytes)).toThrow();
    }
  });
  it('按精确16Mi像素与单边8192约束，不能以窄边规避总量', () => {
    expect(() => assertLocalImageDimensions(8192, 2048)).not.toThrow();
    for (const pair of [[8192, 2049], [8193, 1], [0, 1], [1.5, 2]]) expect(() => assertLocalImageDimensions(...pair as [number, number])).toThrow();
  });
});
