import {
  createTavernMagicalGirlGenerationConfig,
  createTavernCanshouGenerationConfig,
  projectTavernMagicalGirlResult,
  projectTavernCanshouResult,
  createTavernScenarioGenerationConfig,
  createTavernGeneralGenerationConfig,
  createTavernGeneralScenarioGenerationConfig,
  projectTavernScenarioResult,
  projectTavernGeneralResult,
  projectTavernGeneralScenarioResult,
} from '@mahoshojo/ai-core/tavern-generation';
import { z } from 'zod/v3';
import { UserGenerationOverridesSchema } from '@/lib/ai/generation-settings/schemas';
import { NextRequest } from 'next/server';

import { generateWithAI, LoadBalanceStrategy, type GenerateWithAIOptions } from '@/lib/ai';
import { buildChannelContextFromPayload } from '@/lib/ai/availability';
import { AI_PROVIDER_CATALOG, resolveAIProviderModel } from '@/lib/ai/constants';
import { buildJsonResponseWithOptionalAiMeta } from '@/lib/ai/meta-response';
import type { AIProvider } from '@/lib/config';
import { enforceTextSafety } from '@/lib/content-safety/server';
import { getUtf8ByteLength } from '@/lib/data-card-size';
import { getLogger } from '@/lib/logger';
import { recordUserActivityFromRequest } from '@/lib/user-activity/record';
import { CANSHOU_LORE } from '@/lib/canshou-lore';
import { getRandomFlowers } from '@/lib/random-choose-hana-name';
import { TAVERN_IMPORT_ATTACHMENT_LIMITS } from '@/lib/tavern-card/limits';
import { canshouQuestionnaire, magicalQuestionnaire as questionnaire } from '@/lib/questionnaire-presets';

const log = getLogger('api-tavern-convert');

const MAX_SAFETY_TEXT_CHARS = 50_000;

const CustomProviderSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  apiKey: z.string(),
  maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
  generationOverrides: UserGenerationOverridesSchema.optional(),
});

const AttachmentSchema = z
  .object({
    name: z.string().min(1).max(200),
    type: z.string().optional().default('application/octet-stream'),
    size: z.number().int().nonnegative().optional(),
    content: z.string().max(TAVERN_IMPORT_ATTACHMENT_LIMITS.maxCharsPerFile),
    truncated: z.boolean().optional(),
  })
  .superRefine((item, ctx) => {
    const bytes = getUtf8ByteLength(item.content);
    if (bytes > TAVERN_IMPORT_ATTACHMENT_LIMITS.maxBytesPerFile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `附件内容超过大小上限（单文件 ${Math.round(TAVERN_IMPORT_ATTACHMENT_LIMITS.maxBytesPerFile / 1024)}KB）。`,
      });
    }
  });

const AttachmentsSchema = z
  .array(AttachmentSchema)
  .max(TAVERN_IMPORT_ATTACHMENT_LIMITS.maxCount)
  .optional()
  .default([])
  .superRefine((items, ctx) => {
    const total = items.reduce((sum, item) => sum + getUtf8ByteLength(item.content), 0);
    if (total > TAVERN_IMPORT_ATTACHMENT_LIMITS.maxBytesTotal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `附件内容总大小超出限制（上限 ${Math.round(TAVERN_IMPORT_ATTACHMENT_LIMITS.maxBytesTotal / 1024)}KB）。`,
      });
    }
  });

const TemplateSchema = z.enum(['magical-girl', 'canshou', 'general', 'scenario', 'general-scenario']);

const RequestBodySchema = z.object({
  template: TemplateSchema,
  sourceName: z.string().optional().default(''),
  attachments: AttachmentsSchema,
  language: z.string().optional().default('zh-CN'),
  customProvider: CustomProviderSchema.optional(),
});

type CustomProviderResolveResult =
  | {
      ok: true;
      customProviderOverride: AIProvider | null;
      customProviderId: string | null;
      customModelOverride: string | undefined;
    }
  | {
      ok: false;
      error: string;
      status: number;
    };

const resolveProviderOverride = (payload: unknown): CustomProviderResolveResult => {
  const parsedResult = CustomProviderSchema.safeParse(payload);
  if (!parsedResult.success) {
    return { ok: false, error: '自定义 AI 供应商配置无效', status: 400 };
  }

  const parsed = parsedResult.data;
  const providerConfig = AI_PROVIDER_CATALOG.find((item) => item.id === parsed.providerId);
  if (!providerConfig) {
    return { ok: false, error: '未知的模型供应商 ID', status: 400 };
  }

  const modelResolution = resolveAIProviderModel(providerConfig, parsed.modelId);
  if (!modelResolution) {
    return { ok: false, error: '未知的模型 ID', status: 400 };
  }

  const sanitizedApiKey = parsed.apiKey.trim();
  if (!sanitizedApiKey && providerConfig.id !== 'system') {
    return { ok: false, error: 'API Key 不能为空', status: 400 };
  }

  const sanitizedBaseUrl = providerConfig.baseUrl?.trim() ?? '';
  if (!sanitizedBaseUrl) {
    log.info('检测到 baseUrl 为空的自定义供应商，改用系统默认通道，仅覆盖模型参数', {
      providerId: providerConfig.id,
      model: modelResolution.modelId,
    });
    return {
      ok: true,
      customProviderOverride: null,
      customProviderId: providerConfig.id,
      customModelOverride: modelResolution.modelId === 'default' ? undefined : modelResolution.modelId,
    };
  }

  return {
    ok: true,
    customProviderOverride: {
      name: providerConfig.name,
      apiKey: sanitizedApiKey,
      baseUrl: sanitizedBaseUrl,
      model: modelResolution.modelId,
      type: providerConfig.type,
      mode: providerConfig.mode || 'auto',
      retryCount: 1,
      skipProbability: 0,
      ...(typeof parsed.maxOutputTokens === 'number' ? { defaultMaxOutputTokens: parsed.maxOutputTokens } : {}),
      providerId: parsed.providerId,
      ...(parsed.generationOverrides ? { generationOverrides: parsed.generationOverrides } : {}),
    },
    customProviderId: providerConfig.id,
    customModelOverride: undefined,
  };
};

async function handler(req: NextRequest): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const parsedBody = RequestBodySchema.safeParse(await req.json().catch(() => null));
    if (!parsedBody.success) {
      return new Response(JSON.stringify({ error: '请求参数无效' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { template, sourceName, attachments, language, customProvider: customProviderPayload } = parsedBody.data;

    const combinedForSafety = [sourceName, ...attachments.map((item) => item.content)].filter((t) => t.trim()).join('\n\n');
    const safetyText = combinedForSafety.length > MAX_SAFETY_TEXT_CHARS ? combinedForSafety.slice(0, MAX_SAFETY_TEXT_CHARS) : combinedForSafety;
    const safetyResponse = await enforceTextSafety({
      text: safetyText,
      log,
      logMeta: { template, attachmentsCount: attachments.length, attachmentsChars: combinedForSafety.length },
      sensitiveWordReason: '使用危险符文',
      aiPromptTemplate: 'free',
    });
    if (safetyResponse) return safetyResponse;

    let customProviderOverride: AIProvider | null = null;
    let customProviderId: string | null = null;
    let customModelOverride: string | undefined;

    if (customProviderPayload) {
      const resolved = resolveProviderOverride(customProviderPayload);
      if (!resolved.ok) {
        return new Response(JSON.stringify({ error: resolved.error }), {
          status: resolved.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      customProviderOverride = resolved.customProviderOverride;
      customProviderId = resolved.customProviderId;
      customModelOverride = resolved.customModelOverride;
    }

    const shouldDisablePolling = customProviderId !== null && customProviderId !== 'system';
    const providerOptions: GenerateWithAIOptions | undefined =
      customProviderOverride || shouldDisablePolling
        ? {
            ...(customProviderOverride ? { providerOverride: customProviderOverride } : {}),
            ...(shouldDisablePolling ? { loadBalanceStrategy: LoadBalanceStrategy.CUSTOM } : { loadBalanceStrategy: LoadBalanceStrategy.SEQUENTIAL }),
          }
        : undefined;
    const aiTelemetry: NonNullable<GenerateWithAIOptions['telemetry']> = {};
    const channelContext = buildChannelContextFromPayload(customProviderPayload, customModelOverride);
    const aiOptions: GenerateWithAIOptions = providerOptions
      ? { ...providerOptions, channelContext, telemetry: aiTelemetry }
      : { channelContext, telemetry: aiTelemetry };

    const toSuccessResponse = (data: unknown) =>
      buildJsonResponseWithOptionalAiMeta({
        requestHeaders: req.headers,
        data,
        telemetry: aiTelemetry,
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    if (template === 'magical-girl') {
      const generationConfig = {
        ...createTavernMagicalGirlGenerationConfig({ questionnaire, getRandomFlowers }),
        ...(customModelOverride ? { modelOverride: customModelOverride } : {}),
        ...(customProviderPayload ? { generationSettingsContext: { providerId: customProviderPayload.providerId, ...(customProviderPayload.generationOverrides ? { userOverrides: customProviderPayload.generationOverrides } : {}) } } : {}),
      };

      const generated = await generateWithAI({ language, sourceName, attachments }, generationConfig, aiOptions);
      recordUserActivityFromRequest(req);
      return toSuccessResponse(projectTavernMagicalGirlResult(generated, questionnaire));
    }

    if (template === 'canshou') {
      const generationConfig = {
        ...createTavernCanshouGenerationConfig({ questionnaire: canshouQuestionnaire, lore: CANSHOU_LORE }),
        ...(customModelOverride ? { modelOverride: customModelOverride } : {}),
        ...(customProviderPayload ? { generationSettingsContext: { providerId: customProviderPayload.providerId, ...(customProviderPayload.generationOverrides ? { userOverrides: customProviderPayload.generationOverrides } : {}) } } : {}),
      };

      const generated = await generateWithAI({ language, sourceName, attachments }, generationConfig, aiOptions);
      recordUserActivityFromRequest(req);
      return toSuccessResponse(projectTavernCanshouResult(generated, canshouQuestionnaire));
    }

    if (template === 'scenario') {
      const generationConfig = {
        ...createTavernScenarioGenerationConfig(),
        ...(customModelOverride ? { modelOverride: customModelOverride } : {}),
        ...(customProviderPayload ? { generationSettingsContext: { providerId: customProviderPayload.providerId, ...(customProviderPayload.generationOverrides ? { userOverrides: customProviderPayload.generationOverrides } : {}) } } : {}),
      };

      const generated = await generateWithAI({ language, sourceName, attachments }, generationConfig, aiOptions);
      recordUserActivityFromRequest(req);
      return toSuccessResponse(projectTavernScenarioResult(generated));
    }

    if (template === 'general-scenario') {
      const generationConfig = {
        ...createTavernGeneralScenarioGenerationConfig(),
        ...(customModelOverride ? { modelOverride: customModelOverride } : {}),
        ...(customProviderPayload ? { generationSettingsContext: { providerId: customProviderPayload.providerId, ...(customProviderPayload.generationOverrides ? { userOverrides: customProviderPayload.generationOverrides } : {}) } } : {}),
      };

      const generated = await generateWithAI({ language, sourceName, attachments }, generationConfig, aiOptions);
      recordUserActivityFromRequest(req);
      return toSuccessResponse(projectTavernGeneralScenarioResult(generated));
    }

    const generationConfig = {
      ...createTavernGeneralGenerationConfig(),
      ...(customModelOverride ? { modelOverride: customModelOverride } : {}),
      ...(customProviderPayload ? { generationSettingsContext: { providerId: customProviderPayload.providerId, ...(customProviderPayload.generationOverrides ? { userOverrides: customProviderPayload.generationOverrides } : {}) } } : {}),
    };

    const generated = await generateWithAI({ language, sourceName, attachments }, generationConfig, aiOptions);
    recordUserActivityFromRequest(req);
    return toSuccessResponse(projectTavernGeneralResult(generated));
  } catch (error) {
    log.error('酒馆导入 AI 转换失败', { error });
    const errorMessage = error instanceof Error ? error.message : '未知错误';
    return new Response(JSON.stringify({ error: '生成失败', message: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export const appRouteHandler = handler;
export default appRouteHandler;
