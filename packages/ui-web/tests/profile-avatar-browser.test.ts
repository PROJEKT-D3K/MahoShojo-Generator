// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AVATAR_DATA_URL_PREFIX, MAX_AVATAR_BASE64_LENGTH, compressAvatarToWebpBase64InBrowser } from '../src/settings';

let width: number; let height: number; let readFails: boolean; let imageFails: boolean;
const read = vi.fn(); const imageSource = vi.fn(); const clearRect = vi.fn(); const drawImage = vi.fn();
const file = () => new File(['image'], 'avatar.png', { type: 'image/png' });

beforeEach(() => {
  width = 257; height = 128; readFails = false; imageFails = false;
  vi.stubGlobal('FileReader', class {
    result = 'data:image/png;base64,aW1hZ2U=';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(value: File) { read(value); queueMicrotask(() => readFails ? this.onerror?.() : this.onload?.()); }
  });
  vi.stubGlobal('Image', class {
    naturalWidth = width; naturalHeight = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) { imageSource(value); queueMicrotask(() => imageFails ? this.onerror?.() : this.onload?.()); }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect, drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(`${AVATAR_DATA_URL_PREFIX}bmV3`);
});
afterEach(() => vi.unstubAllGlobals());

describe('shared browser avatar compression', () => {
  it.each([[257, 128, 64, 0, 128], [128, 257, 0, 64, 128], [128, 128, 0, 0, 128]])(
    'center-crops %s×%s into 128×128 WebP at the existing quality', async (w, h, sx, sy, size) => {
      width = w; height = h; const image = file();
      expect(await compressAvatarToWebpBase64InBrowser(image)).toBe('bmV3');
      expect(read).toHaveBeenCalledExactlyOnceWith(image);
      expect(imageSource).toHaveBeenCalledExactlyOnceWith('data:image/png;base64,aW1hZ2U=');
      expect(clearRect).toHaveBeenCalledExactlyOnceWith(0, 0, 128, 128);
      expect(drawImage).toHaveBeenCalledExactlyOnceWith(expect.anything(), sx, sy, size, size, 0, 0, 128, 128);
      expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledExactlyOnceWith('image/webp', 0.82);
      const canvas = vi.mocked(HTMLCanvasElement.prototype.toDataURL).mock.contexts[0] as HTMLCanvasElement;
      expect([canvas.width, canvas.height]).toEqual([128, 128]);
    },
  );

  it('rejects non-image files before reading', async () => {
    await expect(compressAvatarToWebpBase64InBrowser(new File(['text'], 'text.txt', { type: 'text/plain' }))).rejects.toThrow('请选择图片文件');
    expect(read).not.toHaveBeenCalled(); expect(drawImage).not.toHaveBeenCalled();
  });

  it('does not impose the server multipart original-file limit on the browser JSON path', async () => {
    const image = file(); Object.defineProperty(image, 'size', { value: 7 * 1024 * 1024 });
    expect(await compressAvatarToWebpBase64InBrowser(image)).toBe('bmV3');
    expect(read).toHaveBeenCalledExactlyOnceWith(image);
  });

  it('reports file reading errors without decoding', async () => {
    readFails = true;
    await expect(compressAvatarToWebpBase64InBrowser(file())).rejects.toThrow('读取图片失败');
    expect(imageSource).not.toHaveBeenCalled();
  });

  it('reports image decoding errors without drawing', async () => {
    imageFails = true;
    await expect(compressAvatarToWebpBase64InBrowser(file())).rejects.toThrow('解析图片失败');
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('reports missing Canvas support', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    await expect(compressAvatarToWebpBase64InBrowser(file())).rejects.toThrow('浏览器不支持 Canvas');
    expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
  });

  it('rejects a browser PNG fallback instead of uploading it as WebP', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue('data:image/png;base64,bmV3');
    await expect(compressAvatarToWebpBase64InBrowser(file())).rejects.toThrow('当前浏览器不支持生成 WebP 头像');
  });

  it('propagates encoder failures', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(() => { throw new Error('编码失败'); });
    await expect(compressAvatarToWebpBase64InBrowser(file())).rejects.toThrow('编码失败');
  });

  it('applies the existing length limit to pure base64, excluding the data URL prefix', async () => {
    expect(MAX_AVATAR_BASE64_LENGTH).toBe(350_000);
    const base64 = 'a'.repeat(MAX_AVATAR_BASE64_LENGTH);
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue(`${AVATAR_DATA_URL_PREFIX}${base64}`);
    expect(await compressAvatarToWebpBase64InBrowser(file())).toBe(base64);
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue(`${AVATAR_DATA_URL_PREFIX}${base64}a`);
    await expect(compressAvatarToWebpBase64InBrowser(file())).rejects.toThrow('头像体积过大');
  });
});
