import { z } from 'zod/v3';
import {
  TAVERN_COMPLETION_HEADER,
  TAVERN_COMPLETION_HEADER_VALUE,
  TAVERN_COMPLETION_PROTOCOL,
} from '@mahoshojo/contracts/tavern-completion';
import { createTavernCompletionPayloadResolver } from '@/lib/tavern-card/stream-completion';
import { UserGenerationOverridesSchema } from '@/lib/ai/generation-settings/schemas';
import { NextRequest } from 'next/server';

import { AI_PROVIDER_CATALOG, resolveAIProviderModel } from '@/lib/ai/constants';
import { buildTavernStreamPrompt, TAVERN_STREAM_TEMPERATURE } from '@mahoshojo/ai-core/tavern-generation';
import type { AIProvider } from '@/lib/config';
import { enforceTextSafety } from '@/lib/content-safety/server';
import { getUtf8ByteLength } from '@/lib/data-card-size';
import { getLogger } from '@/lib/logger';
import { CANSHOU_LORE } from '@/lib/canshou-lore';
import { generateWithStreamAI, LoadBalanceStrategy, type GenerateWithAIOptions } from '@/lib/stream/raw-ai';
import { buildChannelContextFromPayload } from '@/lib/ai/availability';
import { createReasoningSseBridge, shouldUseClientSse } from '@/lib/stream/reasoning-sse';
import { recordUserActivityFromRequest } from '@/lib/user-activity/record';
import { getRandomFlowers } from '@/lib/random-choose-hana-name';
import { TAVERN_IMPORT_ATTACHMENT_LIMITS } from '@/lib/tavern-card/limits';

const log = getLogger('api-tavern-convert-stream');

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

async function handler(req: NextRequest, completionEvidence = false): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const wantsClientSse = completionEvidence || shouldUseClientSse(req);

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
      const parsedResult = CustomProviderSchema.safeParse(customProviderPayload);
      if (!parsedResult.success) {
        log.warn('自定义 AI 供应商配置校验失败', { providerId: (customProviderPayload as any)?.providerId });
        return new Response(JSON.stringify({ error: '自定义 AI 供应商配置无效' }), { status: 400 });
      }

      const parsed = parsedResult.data;
      customProviderId = parsed.providerId;
      const providerConfig = AI_PROVIDER_CATALOG.find((item) => item.id === parsed.providerId);
      if (!providerConfig) {
        return new Response(JSON.stringify({ error: '未知的模型供应商 ID' }), { status: 400 });
      }

      const modelResolution = resolveAIProviderModel(providerConfig, parsed.modelId);
      if (!modelResolution) {
        return new Response(JSON.stringify({ error: '未知的模型 ID' }), { status: 400 });
      }

      const sanitizedApiKey = parsed.apiKey.trim();
      if (!sanitizedApiKey && providerConfig.id !== 'system') {
        return new Response(JSON.stringify({ error: 'API Key 不能为空' }), { status: 400 });
      }

      const sanitizedBaseUrl = providerConfig.baseUrl?.trim() ?? '';
      if (!sanitizedBaseUrl) {
        customModelOverride = modelResolution.modelId === 'default' ? undefined : modelResolution.modelId;
        log.info('检测到 baseUrl 为空的自定义供应商，改用系统默认通道，仅覆盖模型参数', {
          providerId: providerConfig.id,
          model: modelResolution.modelId,
        });
      } else {
        customProviderOverride = {
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
        };
      }
    }

    const prompt = buildTavernStreamPrompt(
      { template, language, sourceName, attachments },
      { getRandomFlowers, lore: CANSHOU_LORE },
    );

    const shouldDisablePolling = customProviderId !== null && customProviderId !== 'system';
    const providerOptions: GenerateWithAIOptions | undefined = (customProviderOverride || shouldDisablePolling)
      ? {
          ...(customProviderOverride ? { providerOverride: customProviderOverride } : {}),
          ...(shouldDisablePolling ? { loadBalanceStrategy: LoadBalanceStrategy.CUSTOM } : { loadBalanceStrategy: LoadBalanceStrategy.SEQUENTIAL }),
        }
      : undefined;
    const reasoningBridge = wantsClientSse ? createReasoningSseBridge('酒馆导入（流式）') : null;
    const aiTelemetry: NonNullable<GenerateWithAIOptions['telemetry']> = {};
    const channelContext = buildChannelContextFromPayload(customProviderPayload, customModelOverride);

    const streamResult = await generateWithStreamAI(
      {
        prompt,
        temperature: TAVERN_STREAM_TEMPERATURE,
        ...(customModelOverride ? { modelOverride: customModelOverride } : {}),
        ...(customProviderPayload ? { generationSettingsContext: { providerId: customProviderPayload.providerId, ...(customProviderPayload.generationOverrides ? { userOverrides: customProviderPayload.generationOverrides } : {}) } } : {}),
      },
      {
        ...(providerOptions ?? {}),
        abortSignal: req.signal,
        telemetry: aiTelemetry,
        channelContext,
        ...(reasoningBridge ? { onReasoningEvent: reasoningBridge.onReasoningEvent } : {}),
      }
    );
    const resolveDonePayload = completionEvidence
      ? createTavernCompletionPayloadResolver(streamResult.finishReasonPromise, req.signal)
      : undefined;
    recordUserActivityFromRequest(req);

    if (wantsClientSse && reasoningBridge) {
      return reasoningBridge.toResponse(streamResult.response, {
        usagePromise: streamResult.usagePromise,
        ...(resolveDonePayload ? { resolveDonePayload, signal: req.signal } : {}),
        aiModel: aiTelemetry.model ?? customModelOverride ?? null,
      });
    }

    return streamResult.response;
  } catch (error) {
    log.error('酒馆导入流式转换失败', { error });
    const errorMessage = error instanceof Error ? error.message : '服务器内部错误';
    return new Response(JSON.stringify({ error: '生成失败', message: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export const appRouteHandler = async (req: NextRequest): Promise<Response> => {
  const version = req.headers.get(TAVERN_COMPLETION_HEADER);
  if (version !== null && version !== TAVERN_COMPLETION_HEADER_VALUE) {
    return Response.json({ error: '不支持的酒馆终态证据版本' }, {
      status: 400, headers: { 'cache-control': 'no-store' },
    });
  }
  const completionEvidence = version === TAVERN_COMPLETION_HEADER_VALUE;
  if (req.method === 'GET' && completionEvidence) {
    return Response.json({ protocol: TAVERN_COMPLETION_PROTOCOL, version: 1 }, {
      headers: { 'cache-control': 'no-store', [TAVERN_COMPLETION_HEADER]: TAVERN_COMPLETION_HEADER_VALUE },
    });
  }
  const response = await handler(req, completionEvidence);
  if (!completionEvidence || req.method !== 'POST') return response;
  const headers = new Headers(response.headers);
  headers.set(TAVERN_COMPLETION_HEADER, TAVERN_COMPLETION_HEADER_VALUE);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
export default appRouteHandler;
