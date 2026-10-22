import { assertLocalImageDimensions, inspectLocalImageRaster } from '@mahoshojo/local-library/image-assets';

/** Decode pixels, not just HTMLImageElement metadata; never transcode the original bytes. */
export async function validateLocalImageDecode(bytes: Uint8Array): Promise<void> {
  const raster = inspectLocalImageRaster(bytes);
  const blob = new Blob([new Uint8Array(bytes)], { type: raster.mimeType });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (error) reject(error); else resolve();
    };
    const failure = () => finish(new Error('图片无法解码，请选择完整的静态 PNG / JPEG / WebP 原图。'));
    const timeout = setTimeout(() => finish(new Error('图片解码超时，请检查原图后重试。')), 15_000);
    try {
      void createImageBitmap(blob).then(bitmap => {
        try {
          if (settled) return;
          assertLocalImageDimensions(bitmap.width, bitmap.height);
          // JPEG EXIF can swap display axes without changing the source bytes or pixel budget.
          if (!((bitmap.width === raster.width && bitmap.height === raster.height)
            || (raster.mimeType === 'image/jpeg' && bitmap.width === raster.height && bitmap.height === raster.width))) {
            throw new Error('图片解码尺寸与文件头不符。');
          }
          finish();
        } catch (cause) { finish(cause instanceof Error ? cause : new Error('图片解码失败。')); }
        finally { bitmap.close(); }
      }, failure);
    } catch { failure(); }
  });
}
