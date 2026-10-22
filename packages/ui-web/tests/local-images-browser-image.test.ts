import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateLocalImageDecode } from '../src/local-images/browser-image';

const bytes = () => Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V8AAAAASUVORK5CYII=', 'base64'));
const decode = vi.fn();
const bitmap = (width = 1, height = 1) => ({ width, height, close: vi.fn() });
beforeEach(() => { decode.mockReset(); vi.stubGlobal('createImageBitmap', decode); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('等待像素解码完成并关闭位图', async () => {
  let finish!: (value: ReturnType<typeof bitmap>) => void;
  decode.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const task = validateLocalImageDecode(bytes()); let settled = false; void task.then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false); expect(decode).toHaveBeenCalledOnce();
  const decoded = bitmap(); finish(decoded); await task; expect(decoded.close).toHaveBeenCalledOnce();
});
it('头部合法但像素解码拒绝时不接受损坏图片', async () => {
  decode.mockRejectedValue(new Error('corrupt image data'));
  await expect(validateLocalImageDecode(bytes())).rejects.toThrow('无法解码');
});
it('缺少位图解码 API 时明确拒绝，不退回仅凭 load 接受图片', async () => {
  vi.stubGlobal('createImageBitmap', undefined);
  await expect(validateLocalImageDecode(bytes())).rejects.toThrow('无法解码');
});
it('尺寸不符拒绝保存并关闭位图', async () => {
  const decoded = bitmap(2, 1); decode.mockResolvedValue(decoded);
  await expect(validateLocalImageDecode(bytes())).rejects.toThrow('尺寸与文件头不符');
  expect(decoded.close).toHaveBeenCalledOnce();
});
it('15 秒超时后迟到成功仍释放位图且不读取其尺寸', async () => {
  vi.useFakeTimers(); let finish!: (value: ReturnType<typeof bitmap>) => void;
  decode.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const task = validateLocalImageDecode(bytes()); const rejected = expect(task).rejects.toThrow('超时');
  await vi.advanceTimersByTimeAsync(15_000); await rejected;
  const decoded = bitmap(); const width = vi.fn(() => 1); Object.defineProperty(decoded, 'width', { get: width });
  finish(decoded); await Promise.resolve();
  expect(width).not.toHaveBeenCalled(); expect(decoded.close).toHaveBeenCalledOnce();
});
it('伪装与超限字节在创建位图前拒绝', async () => {
  await expect(validateLocalImageDecode(new TextEncoder().encode('<svg/>'))).rejects.toThrow();
  await expect(validateLocalImageDecode(new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toThrow('10 MiB');
  expect(decode).not.toHaveBeenCalled();
});
