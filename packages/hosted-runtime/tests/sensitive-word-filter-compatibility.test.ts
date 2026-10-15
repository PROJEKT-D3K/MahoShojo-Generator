import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('敏感词宿主兼容 facade', () => {
  test('旧工厂、类和默认出口保留 identity、共享实例及 redirect 行为', async () => {
    const legacy = await import('../src/node-runtime/sensitive-word-filter');
    const shared = await import('@mahoshojo/domain/sensitive-word-filter');
    const filter = legacy.createSensitiveWordFilter();
    expect(filter).toBeInstanceOf(legacy.SensitiveWordFilter);
    expect(filter).toBeInstanceOf(shared.SensitiveWordFilter);
    expect(legacy.default).toBe(legacy.SensitiveWordFilter);
    expect(legacy.createSensitiveWordFilter()).toBe(filter);
    const redirect = vi.fn();
    const result = await filter.checkAndRedirect('大陆官方', redirect);
    expect(redirect).toHaveBeenCalledOnce();
    expect(result).toEqual(await shared.strictCheck('大陆官方'));
    const location = { href: '/original' };
    vi.stubGlobal('location', location);
    await filter.checkAndRedirect('大陆官方');
    expect(location.href).toBe('/arrested');
    await filter.checkAndRedirect('普通文本', redirect);
    expect(redirect).toHaveBeenCalledOnce();
  });

  test('真实初始化降级不改变旧 quickCheck 与 quickCheckForServer 策略', async () => {
    vi.spyOn(globalThis, 'atob').mockImplementationOnce(() => { throw new Error('decode canary'); });
    const legacy = await import('../src/node-runtime/sensitive-word-filter');
    await expect(legacy.quickCheck('大陆官方')).resolves.toMatchObject({ hasSensitiveWords: false });
    await expect(legacy.quickCheckForServer('大陆官方')).resolves.toMatchObject({ hasSensitiveWords: false });
    await expect(legacy.createSensitiveWordFilter().checkTextStrict('普通文本')).rejects.toThrow('本地敏感词检查失败');
  });

  test('真实底层扫描失败仍由 quickCheck 兜底，server 透传，strict 脱敏拒绝', async () => {
    const legacy = await import('../src/node-runtime/sensitive-word-filter');
    const filter = legacy.createSensitiveWordFilter();
    await filter.checkText('初始化');
    const failure = new Error('scan-source-canary');
    const internal = filter as unknown as { plainSearch: { FindAll: (_text: string) => unknown } };
    vi.spyOn(internal.plainSearch, 'FindAll').mockImplementation(() => { throw failure; });
    await expect(legacy.quickCheck('大陆官方')).resolves.toEqual({
      hasSensitiveWords: false, detectedWords: [], filteredText: '大陆官方', originalText: '大陆官方',
      shouldRedirectToArrested: false, matchDetails: [],
    });
    await expect(legacy.quickCheckForServer('大陆官方')).rejects.toBe(failure);
    await expect(filter.checkTextStrict('大陆官方')).rejects.toThrow('本地敏感词检查失败');
  });
});
