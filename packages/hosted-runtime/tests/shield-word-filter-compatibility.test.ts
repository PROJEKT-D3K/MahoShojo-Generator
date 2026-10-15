import { describe, expect, test } from 'vitest';
import * as shared from '@mahoshojo/domain/shield-word-filter';
import * as legacy from '../src/node-runtime/shield-word-filter';

describe('屏蔽词宿主兼容 facade', () => {
  test('旧入口导出同一函数，复用共享缓存与唯一规则', () => {
    expect(legacy.applyShieldWords).toBe(shared.applyShieldWords);
    expect(legacy.applyShieldWordsStrict).toBe(shared.applyShieldWordsStrict);
    for (const text of ['中国', '中國', '发情', 'fa qing', 'VPN', '普通文本']) {
      expect(legacy.applyShieldWords(text)).toEqual(shared.applyShieldWordsStrict(text));
    }
  });
});
