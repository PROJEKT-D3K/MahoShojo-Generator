const AVATAR_SIZE = 128;
const AVATAR_WEBP_QUALITY = 0.82;
export const MAX_AVATAR_BASE64_LENGTH = 350_000;
export const AVATAR_DATA_URL_PREFIX = 'data:image/webp;base64,';

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

function dataUrlToImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('解析图片失败'));
    img.src = dataUrl;
  });
}

function canvasToWebpDataUrl(canvas: HTMLCanvasElement) {
  const out = canvas.toDataURL('image/webp', AVATAR_WEBP_QUALITY);
  if (!out.startsWith('data:image/webp')) {
    throw new Error('当前浏览器不支持生成 WebP 头像，请尝试使用 Chrome/Edge');
  }
  return out;
}

export async function compressAvatarToWebpBase64InBrowser(file: File) {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  const dataUrl = await fileToDataUrl(file);
  const img = await dataUrlToImage(dataUrl);

  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持 Canvas');

  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  const size = Math.min(sw, sh);
  const sx = Math.floor((sw - size) / 2);
  const sy = Math.floor((sh - size) / 2);

  ctx.clearRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  ctx.drawImage(img, sx, sy, size, size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

  const out = canvasToWebpDataUrl(canvas);
  const base64 = out.replace(/^data:image\/webp;base64,/, '');
  if (base64.length > MAX_AVATAR_BASE64_LENGTH) {
    throw new Error('头像体积过大，建议换一张更小的图片');
  }
  return base64;
}
