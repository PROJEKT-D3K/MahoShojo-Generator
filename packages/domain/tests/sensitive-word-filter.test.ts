import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const failure = new Error('private-source-canary');
const safeFailure = { message: '本地敏感词检查失败' };

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.doUnmock('pinyin-pro');
  vi.doUnmock('../src/word-filter-utils');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('严格敏感词检查（显式 opt-in）', () => {
  test('全部现有规则正常初始化，注释项和单汉字的正常跳过不影响严格检查', async () => {
    const decode = vi.spyOn(globalThis, 'atob');
    const { SensitiveWordFilter, strictCheck } = await import('../src/sensitive-word-filter');
    const filter = new SensitiveWordFilter();
    await expect(filter.checkTextStrict('普通文本')).resolves.toMatchObject({ hasSensitiveWords: false });
    expect(decode).toHaveBeenCalledTimes(89);
    await expect(filter.checkTextStrict('肏')).resolves.toMatchObject({ hasSensitiveWords: true });
    await expect(filter.checkTextStrict('共产党')).resolves.toMatchObject({ hasSensitiveWords: false });
    await expect(strictCheck('普通文本')).resolves.toEqual(await filter.checkText('普通文本'));
  });

  test.each([
    '', '普通文本', '前文大陆官方后文', '访问 YouPorn', '我来自中華帝國。',
    '我来自中-华-帝-国。', '中亻华亻帝亻国', 'wo lai zi zhong hua di guo',
    'ｄａｌｕｇｕａｎｆａｎｇ', 'Dr. Zhang Xing 是一位 AI 专家。',
    '😀大陆官方 Pornhub zhong hua di guo 中-华-帝-国。',
  ])('完整结果、顺序、索引与兼容入口一致：%s', async (text) => {
    const { SensitiveWordFilter } = await import('../src/sensitive-word-filter');
    const filter = new SensitiveWordFilter();
    expect(JSON.stringify(await filter.checkTextStrict(text))).toBe(JSON.stringify(await filter.checkText(text)));
  });

  test.each([
    {
      text: '😀大陆官方。', filteredText: '😀****。', detectedWords: ['大陆官方', '大陆官方(变体)'],
      matchDetails: [{ word: '大陆官方', matchedText: '大陆官方', matchType: 'exact', startIndex: 2, endIndex: 6, contextBefore: '😀', contextAfter: '。' }],
    },
    {
      text: '访问 YouPorn!', filteredText: '访问 *******!', detectedWords: ['YouPorn', 'Porn', 'porn(变体)'],
      matchDetails: [
        { word: '[Yy]ou[Pp]orn', matchedText: 'YouPorn', matchType: 'regex', startIndex: 3, endIndex: 10, contextBefore: '访问 ', contextAfter: '!' },
        { word: 'porn', matchedText: 'Porn', matchType: 'exact', startIndex: 6, endIndex: 10, contextBefore: '访问 You', contextAfter: '!' },
      ],
    },
    {
      text: '前中-华-帝-国后', filteredText: '前*******后', detectedWords: ['中华帝国(变体)'],
      matchDetails: [{ word: '中华帝国', matchedText: '中-华-帝-国', matchType: 'variant', startIndex: 1, endIndex: 8, contextBefore: '前', contextAfter: '后' }],
    },
    {
      text: 'wo lai zi zhong hua di guo', filteredText: 'wo lai zi ****************', detectedWords: ['中华帝国(拼音)'],
      matchDetails: [{ word: '中华帝国', matchedText: 'zhong hua di guo', matchType: 'variant', startIndex: 10, endIndex: 26, contextBefore: 'wo lai zi ', contextAfter: '' }],
    },
  ])('四类匹配保持已知完整输出与 UTF-16 索引：$text', async ({ text, ...expected }) => {
    const { strictCheck } = await import('../src/sensitive-word-filter');
    await expect(strictCheck(text)).resolves.toEqual({
      ...expected, originalText: text, hasSensitiveWords: true, shouldRedirectToArrested: true,
    });
  });

  test('严格入口使用完整检查，不替换为语义不同的布尔捷径', async () => {
    const { SensitiveWordFilter } = await import('../src/sensitive-word-filter');
    const filter = new SensitiveWordFilter();
    const text = 'Dr. Zhang Xing 是一位 AI 专家。';
    await expect(filter.containsSensitiveWord(text)).resolves.toBe(true);
    await expect(filter.checkTextStrict(text)).resolves.toMatchObject({ hasSensitiveWords: false });
  });

  test('真实 Base64 解码失败被记住；旧检查仍保留跳过该词条的行为', async () => {
    vi.spyOn(globalThis, 'atob').mockImplementationOnce(() => { throw failure; });
    const { SensitiveWordFilter } = await import('../src/sensitive-word-filter');
    const filter = new SensitiveWordFilter();
    await expect(filter.checkText('大陆官方')).resolves.toMatchObject({ hasSensitiveWords: false });
    await expect(filter.checkTextStrict('普通文本')).rejects.toMatchObject(safeFailure);
    await expect(filter.checkTextStrict('')).rejects.toMatchObject(safeFailure);
  });

  test.each(['throw', 'empty'])('拼音生成异常 %s 使严格检查拒绝，旧路径仍返回结果', async (kind) => {
    vi.doMock('pinyin-pro', async (importOriginal) => {
      const actual = await importOriginal<typeof import('pinyin-pro')>();
      return { ...actual, pinyin: vi.fn(actual.pinyin).mockImplementationOnce(() => {
        if (kind === 'throw') throw failure;
        return [];
      }) };
    });
    const { SensitiveWordFilter } = await import('../src/sensitive-word-filter');
    const filter = new SensitiveWordFilter();
    await expect(filter.checkText('大陆官方')).resolves.toMatchObject({ hasSensitiveWords: true });
    await expect(filter.checkText('daluguanfang')).resolves.toMatchObject({ hasSensitiveWords: false });
    await expect(filter.checkTextStrict('普通文本')).rejects.toMatchObject(safeFailure);
  });

  test('初始化期间真实 regex 编译异常被记录，恢复后兼容检查仍正常', async () => {
    const OriginalRegExp = RegExp;
    vi.stubGlobal('RegExp', new Proxy(OriginalRegExp, {
      construct(target, args) {
        if (args[1] === 'gi') throw failure;
        return Reflect.construct(target, args);
      },
    }));
    const { SensitiveWordFilter } = await import('../src/sensitive-word-filter');
    const filter = new SensitiveWordFilter();
    vi.unstubAllGlobals();
    await expect(filter.checkText('YouPorn')).resolves.toMatchObject({ hasSensitiveWords: true });
    await expect(filter.checkTextStrict('普通文本')).rejects.toMatchObject(safeFailure);
  });

  test('底层索引初始化失败：严格错误脱敏，兼容检查保留原异常', async () => {
    vi.doMock('../src/word-filter-utils', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/word-filter-utils')>();
      return { ...actual, createWordsSearch: () => { throw failure; } };
    });
    const { SensitiveWordFilter } = await import('../src/sensitive-word-filter');
    const filter = new SensitiveWordFilter();
    await expect(filter.checkTextStrict('普通文本')).rejects.toMatchObject(safeFailure);
    await expect(filter.checkTextStrict('普通文本')).rejects.not.toHaveProperty('cause');
    await expect(filter.checkText('普通文本')).rejects.toBe(failure);
  });

  test('扫描 regex 异常：严格拒绝，兼容路径仍使用字面量回退', async () => {
    const { SensitiveWordFilter } = await import('../src/sensitive-word-filter');
    const filter = new SensitiveWordFilter();
    await filter.checkText('初始化');
    const exec = RegExp.prototype.exec;
    vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, text) {
      if (this.source === '[Yy]ou[Pp]orn') throw failure;
      return exec.call(this, text);
    });
    await expect(filter.checkTextStrict('普通文本')).rejects.toMatchObject(safeFailure);
    await expect(filter.checkText('普通文本')).resolves.toMatchObject({ hasSensitiveWords: false });
  });

  test.each(['plainSearch', 'pinyinSearch'])('底层扫描 %s 异常不得返回伪 safe', async (engine) => {
    const { SensitiveWordFilter } = await import('../src/sensitive-word-filter');
    const filter = new SensitiveWordFilter();
    await filter.checkText('初始化');
    const internal = filter as unknown as Record<string, { FindAll: (text: string) => unknown }>;
    vi.spyOn(internal[engine], 'FindAll').mockImplementation(() => { throw failure; });
    await expect(filter.checkTextStrict('ordinary text')).rejects.toMatchObject(safeFailure);
    await expect(filter.checkText('ordinary text')).rejects.toBe(failure);
  });
});
