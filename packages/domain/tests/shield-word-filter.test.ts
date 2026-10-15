import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const failure = new Error('private-shield-source-canary');
const safeError = '本地屏蔽词处理失败';

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.doUnmock('pinyin-pro');
  vi.doUnmock('../src/word-filter-utils');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('共源屏蔽词与严格 opt-in', () => {
  test('空串先完整初始化，正常单汉字/ASCII和注释跳过不视为故障，后续共享缓存', async () => {
    const decode = vi.spyOn(globalThis, 'atob');
    const { applyShieldWords, applyShieldWordsStrict } = await import('../src/shield-word-filter');
    expect(applyShieldWordsStrict('')).toEqual({ hasShieldWords: false, detectedWords: [], filteredText: '', originalText: '' });
    expect(decode).toHaveBeenCalledTimes(100);
    expect(applyShieldWordsStrict('VPN')).toMatchObject({ filteredText: '❀❀❀' });
    expect(applyShieldWordsStrict('艹')).toMatchObject({ filteredText: '❀' });
    expect(applyShieldWordsStrict('寄生')).toMatchObject({ hasShieldWords: false });
    expect(applyShieldWords('中国')).toEqual(applyShieldWordsStrict('中国'));
    expect(decode).toHaveBeenCalledTimes(100);
  });

  test.each(['普通文本', '中国', '中國', '中华人民共和国中国', 'ＶＰＮ', 'V.P.N', '发情', 'fa qing', 'zhong guo', 'zhōng guó', 'setUniversalProc', '😀中国色情 zhong guo。'])('严格与兼容完整结果一致：%s', async (text) => {
    const { applyShieldWords, applyShieldWordsStrict } = await import('../src/shield-word-filter');
    expect(JSON.stringify(applyShieldWordsStrict(text))).toBe(JSON.stringify(applyShieldWords(text)));
  });

  test.each([
    ['5Y+R5oOF', '发情', '发情'],
    ['5Lit5Zu9', '中国', '❀❀'],
  ])('词表/替换项真实解码失败被记住：%s', async (encoded, text, legacyOutput) => {
    const decode = atob;
    let failed = false;
    vi.spyOn(globalThis, 'atob').mockImplementation((input) => {
      if (input === encoded && !failed) { failed = true; throw failure; }
      return decode(input);
    });
    const { applyShieldWords, applyShieldWordsStrict } = await import('../src/shield-word-filter');
    expect(applyShieldWords(text).filteredText).toBe(legacyOutput);
    expect(() => applyShieldWordsStrict(text)).toThrow(safeError);
    expect(() => applyShieldWordsStrict('')).toThrow(safeError);
  });

  test.each(['throw', 'empty'])('拼音生成失败 %s：旧入口仍跳过，严格入口拒绝空串', async (kind) => {
    vi.doMock('pinyin-pro', async (importOriginal) => {
      const actual = await importOriginal<typeof import('pinyin-pro')>();
      return { ...actual, pinyin: vi.fn(actual.pinyin).mockImplementationOnce(() => {
        if (kind === 'throw') throw failure;
        return [];
      }) };
    });
    const { applyShieldWords, applyShieldWordsStrict } = await import('../src/shield-word-filter');
    expect(applyShieldWords('发情').filteredText).toBe('❀❀');
    expect(applyShieldWords('fa qing').hasShieldWords).toBe(false);
    expect(() => applyShieldWordsStrict('')).toThrow(safeError);
  });

  test.each([1, 2])('第 %i 个索引真实初始化失败被记住，旧入口仍透传并允许后续重试', async (failedCall) => {
    vi.doMock('../src/word-filter-utils', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/word-filter-utils')>();
      let calls = 0;
      return { ...actual, createWordsSearch: (keywords: string[]) => {
        if (++calls === failedCall) throw failure;
        return actual.createWordsSearch(keywords);
      } };
    });
    const { applyShieldWords, applyShieldWordsStrict } = await import('../src/shield-word-filter');
    expect(() => applyShieldWords('中国')).toThrow(failure);
    expect(applyShieldWords('中国').filteredText).toBe('【国度】');
    expect(() => applyShieldWordsStrict('')).toThrow(safeError);
  });

  test.each([0, 1])('第 %i 个底层扫描异常：旧入口透传，严格入口脱敏', async (engine) => {
    const searches: Array<{ FindAll: (text: string) => unknown }> = [];
    vi.doMock('../src/word-filter-utils', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/word-filter-utils')>();
      return { ...actual, createWordsSearch: (keywords: string[]) => {
        const search = actual.createWordsSearch(keywords); searches.push(search); return search;
      } };
    });
    const { applyShieldWords, applyShieldWordsStrict } = await import('../src/shield-word-filter');
    applyShieldWordsStrict('');
    vi.spyOn(searches[engine], 'FindAll').mockImplementation(() => { throw failure; });
    expect(() => applyShieldWords('ordinary text')).toThrow(failure);
    let caught: unknown;
    try { applyShieldWordsStrict('ordinary text'); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ message: safeError });
    expect(caught).not.toHaveProperty('cause');
    expect(String(caught)).not.toContain('canary');
  });

  test('保留旧环境可选 Buffer 回退；无解码能力时严格拒绝', async () => {
    const first = await import('../src/shield-word-filter');
    let fallbackResult: unknown;
    vi.stubGlobal('atob', undefined);
    try { fallbackResult = first.applyShieldWordsStrict('中国'); } finally { vi.unstubAllGlobals(); }
    expect(fallbackResult).toMatchObject({ filteredText: '【国度】' });

    vi.resetModules();
    const second = await import('../src/shield-word-filter');
    let legacyResult: unknown;
    let strictFailure: unknown;
    vi.stubGlobal('atob', undefined);
    vi.stubGlobal('Buffer', undefined);
    try {
      legacyResult = second.applyShieldWords('中国');
      try { second.applyShieldWordsStrict(''); } catch (error) { strictFailure = error; }
    } finally { vi.unstubAllGlobals(); }
    expect(legacyResult).toMatchObject({ hasShieldWords: false, filteredText: '中国' });
    expect(strictFailure).toMatchObject({ message: safeError });
  });
});
