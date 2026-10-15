import { SensitiveWordFilter as SharedSensitiveWordFilter } from '@mahoshojo/domain/sensitive-word-filter';
import type { FilterResult } from '@mahoshojo/domain/sensitive-word-filter';

export type { FilterResult, SensitiveMatchDetail } from '@mahoshojo/domain/sensitive-word-filter';

/** 保留宿主跳转与旧入口的兼容行为；检测实现由 domain 共享。 */
export class SensitiveWordFilter extends SharedSensitiveWordFilter {
  /**
   * 检查文本并决定是否跳转（异步）
   */
  async checkAndRedirect(text: string, redirectCallback?: () => void): Promise<FilterResult> {
    const result = await this.checkText(text);

    if (result.shouldRedirectToArrested) {
      console.warn('🚨 检测到敏感词，已阻止继续处理。');

      if (redirectCallback) {
        redirectCallback();
      } else {
        // 通过 Web 标准 location 能力兼容浏览器，不让 Node package 引入 DOM 类型依赖。
        const browserLocation = (globalThis as unknown as {
          location?: { href: string };
        }).location;
        if (browserLocation) {
          browserLocation.href = '/arrested';
        } else {
          console.log('🚨 应该跳转到 /arrested 页面');
        }
      }
    }

    return result;
  }
}

/**
 * 创建默认的敏感词过滤器实例
 */
let sharedFilter: SensitiveWordFilter | null = null;

export const createSensitiveWordFilter = (): SensitiveWordFilter => {
  if (!sharedFilter) {
    sharedFilter = new SensitiveWordFilter();
  }
  return sharedFilter;
};

/**
 * 快速检查并跳转函数（异步版本）
 */
export const quickCheck = async (text: string): Promise<FilterResult> => {
  const filter = createSensitiveWordFilter();
  try {
    return await filter.checkText(text);
  } catch {
    console.error('敏感词检测失败，启用安全回退逻辑。');
    return {
      hasSensitiveWords: false,
      detectedWords: [],
      filteredText: text,
      originalText: text,
      shouldRedirectToArrested: false,
      matchDetails: []
    };
  }
};

/**
 * 服务器权威路径使用的检查入口。与客户端兼容 quickCheck 不同，此入口不吞掉
 * 初始化或扫描错误，让上层能够按 fail-closed 503 处理。
 */
export const quickCheckForServer = async (text: string): Promise<FilterResult> =>
  createSensitiveWordFilter().checkText(text);

export const containsSensitiveWord = async (text: string): Promise<boolean> => {
  const filter = createSensitiveWordFilter();
  try {
    return await filter.containsSensitiveWord(text);
  } catch {
    console.error('敏感词布尔检测失败，启用安全回退逻辑。');
    return false;
  }
};

export default SensitiveWordFilter;
