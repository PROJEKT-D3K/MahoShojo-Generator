import {
  getModelGenerationCapabilities,
  type ModelGenerationCapabilities,
} from '@mahoshojo/ai-core/generation-settings';
import type { DirectProviderAdapter } from '@mahoshojo/contracts/provider-profile';

/** Native 已实现的自定义 Profile 协议；不据此自动放开项目预设。 */
export const DESKTOP_DIRECT_ADAPTERS: ReadonlySet<DirectProviderAdapter> = new Set([
  'openai-compatible', 'openai-responses', 'anthropic', 'google',
]);

/** 编辑器能完整表达的协议，与 Native 执行支持度独立维护。 */
export const DESKTOP_EDITABLE_PROFILE_ADAPTERS: ReadonlySet<DirectProviderAdapter> = new Set([
  'openai-compatible', 'openai-responses', 'anthropic', 'google',
]);

/** 新协议首片只开放自定义 Profile，预设和本机发现保持原行为。 */
export const DESKTOP_PRESET_DIRECT_ADAPTERS: ReadonlySet<DirectProviderAdapter> = new Set([
  'openai-compatible', 'openai-responses',
]);

export const DESKTOP_ANTHROPIC_POLICY = {
  version: '2026-10-21',
  defaultMaxOutputTokens: 4096,
  endpointHint: '填写 API 根路径，例如 https://api.anthropic.com/v1；请求将追加 /messages。不要填写完整 /messages 地址。',
  temperatureHint: '本协议不发送 temperature。已保存的温度偏好保留，但在此协议下不生效。',
  thinkingHint: '本协议暂不支持 Thinking 开关或 effort 强度设置。已保存的推理偏好保留，但在此协议下不生效。',
  maxOutputTokensHint: '留空时本客户端使用输出上限 4096 Tokens，可手动覆盖；这不是所有模型的最大值，上游不接受时会明确报错。',
} as const;

export const DESKTOP_GOOGLE_POLICY = {
  endpointHint: '填写服务方要求的 API 根路径（含版本路径），例如 https://generativelanguage.googleapis.com/v1beta；请求将追加 /models/{模型 ID}:streamGenerateContent。不要填写完整方法地址、末尾 /models、查询或片段，也不要在 URL 中放 API Key。',
  temperatureHint: 'temperature 在 0–2 范围内原值发送；不同模型可能不支持或忽略它，不自动删参重试。',
  thinkingHint: '本协议暂不发送 Thinking 开关或强度，已保存的推理偏好保留；模型可能自行思考，不能保证关闭或返回摘要。',
  maxOutputTokensHint: '留空时不发送输出上限，跟随上游默认；指定的上限可能同时包含思考和答案 Tokens，过低可能没有答案。',
} as const;

export type DesktopGenerationCapabilities = ModelGenerationCapabilities & {
  temperature: { disabled?: boolean; hint?: string };
  maxOutputTokens: { hint?: string };
  thinking: { hint?: string };
};

/** 统一投影模型与协议能力，不改写持久偏好，也不按自定义模型名称猜测。 */
export const getDesktopGenerationCapabilities = (
  scope: string,
  modelId: string,
  adapter?: DirectProviderAdapter,
): DesktopGenerationCapabilities => adapter === 'anthropic'
  ? {
    temperature: { support: 'unsupported', disabled: true, hint: DESKTOP_ANTHROPIC_POLICY.temperatureHint },
    maxOutputTokens: { support: 'supported', hint: DESKTOP_ANTHROPIC_POLICY.maxOutputTokensHint },
    thinking: { support: 'unsupported', canDisable: false, hint: DESKTOP_ANTHROPIC_POLICY.thinkingHint },
  }
  : adapter === 'google'
    ? {
      // 自定义连接不因与可信预设同名而继承其模型能力或参数策略。
      temperature: { support: 'unknown', min: 0, max: 2, hint: DESKTOP_GOOGLE_POLICY.temperatureHint },
      maxOutputTokens: { support: 'supported', hint: DESKTOP_GOOGLE_POLICY.maxOutputTokensHint },
      thinking: { support: 'unsupported', canDisable: false, hint: DESKTOP_GOOGLE_POLICY.thinkingHint },
    }
    : getModelGenerationCapabilities(scope, modelId);
