import { afterEach, expect, test, vi } from 'vitest';
import { createDeferredModuleLoader, isDeferredChunkError } from '@/lib/client/loadDeferredModule';

const chunkError = () => Object.assign(new Error('Loading chunk 42 failed.\n(error: /_next/static/chunks/42.oldhash.js)'), { name: 'ChunkLoadError' });

afterEach(() => vi.useRealTimers());

test('瞬时chunk失败有界退避重试；并发消费者共享请求和成功结果', async () => {
  vi.useFakeTimers();
  const loadedModule = { default: 'loaded' };
  const load = vi.fn().mockRejectedValueOnce(chunkError()).mockResolvedValue(loadedModule);
  const retryable = createDeferredModuleLoader(load);
  const first = retryable();
  expect(retryable()).toBe(first);
  await vi.advanceTimersByTimeAsync(299);
  expect(load).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await expect(first).resolves.toBe(loadedModule);
  await expect(retryable()).resolves.toBe(loadedModule);
  expect(load).toHaveBeenCalledTimes(2);
});

test('旧URL持续404只尝试三次；失败后新的显式尝试可以恢复', async () => {
  vi.useFakeTimers();
  const error = chunkError();
  const load = vi.fn().mockRejectedValue(error);
  const retryable = createDeferredModuleLoader(load);
  const result = retryable().catch((reason) => reason);
  await vi.runAllTimersAsync();
  expect(await result).toBe(error);
  expect(load).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
  load.mockResolvedValue({ default: 'available again' });
  await expect(retryable()).resolves.toEqual({ default: 'available again' });
  expect(load).toHaveBeenCalledTimes(4);
});

test.each([new SyntaxError('Unexpected token'), new Error('renderer unavailable'), new TypeError('undefined is not a function')])(
  '模块求值错误不自动重试：%s', async (error) => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValue(error);
    await expect(createDeferredModuleLoader(load)()).rejects.toBe(error);
    expect(load).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each([
  'Failed to fetch dynamically imported module: /module.js',
  'Importing a module script failed.',
  'error loading dynamically imported module: /module.js',
  'Loading CSS chunk 42 failed.',
])('识别浏览器模块传输失败：%s', (message) => {
  expect(isDeferredChunkError(new TypeError(message))).toBe(true);
});
