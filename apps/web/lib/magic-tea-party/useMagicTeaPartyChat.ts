import { pickMagicTeaPartyRequestSettings } from '@mahoshojo/domain/magic-tea-party/import-plan';
import { appendMagicTeaPartyAutoSummaryMessage, createMagicTeaPartyAutoSummaryScan, planMagicTeaPartyAutoSummary, projectMagicTeaPartyAutoSummaryInput, resolveMagicTeaPartyAutoSummaryBudget, matchesMagicTeaPartySummaryInput, projectMagicTeaPartySummaryInput } from '@mahoshojo/ai-core/magic-tea-party';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { UserAIProviderConfig } from '@/components/AiProviderSelector';
import type { AppRouterAdapter } from '@/lib/app-router-adapter';
import type { AIReasoningEnvelope } from '@/types/ai-reasoning';
import { persistArrestedBackup } from '@/lib/arrested-backup';
import { authStorage } from '@/lib/auth';
import { useGenerationApiIntentLatch } from '@/lib/use-generation-api-intent-latch';
import { resolveApiErrorMessage } from '@/lib/client/apiError';
import { formatHttpErrorMessage } from '@/lib/client/httpError';
import { getSensitiveWordRedirectTarget } from '@/lib/content-safety/client';
import { randomUUID } from '@/lib/crypto';
import { estimateMagicTeaPartyTokens, resolveMagicTeaPartyTokenBudget } from '@/lib/magic-tea-party/budget';
import {
  buildMagicTeaPartyHistory,
  estimateMagicTeaPartyHistoryTokens,
  trimMagicTeaPartyHistory,
} from '@/lib/magic-tea-party/history';
import { buildMagicTeaPartyJsonlPreview, extractMagicTeaPartySideChannelsFromJsonl, parseMagicTeaPartyJsonl, projectMagicTeaPartyChoices, type MagicTeaPartyChoicesCompletion } from '@/lib/magic-tea-party/jsonl';
import {
  applyMagicTeaPartyMessageLimits,
  clipMagicTeaPartyMessageContent,
  formatMagicTeaPartyTotalOverflowMessage,
  isMagicTeaPartyTotalOverflow,
  resolveMagicTeaPartyMessageCharLimit,
} from '@/lib/magic-tea-party/message-limits';
import { extractMagicTeaPartyNoticesFromMarkdown } from '@/lib/magic-tea-party/notice';
import { buildMagicTeaPartyMainPrompt, buildWorldbookText } from '@/lib/magic-tea-party/prompts';
import { getMagicTeaPartyPreset } from '@/lib/magic-tea-party/presets';
import { createMagicTeaPartyStreamPreview } from '@/lib/magic-tea-party/stream-preview';
import { createMagicTeaPartyStreamSafety, type MagicTeaPartyStreamSafetyResult } from '@/lib/magic-tea-party/stream-safety';
import { appendMagicTeaPartySystemInstruction } from '@/lib/magic-tea-party/system-instruction';
import { captureMagicTeaPartySummarySnapshot, compareAndPatchMagicTeaPartySummary, deleteMagicTeaPartyMessages, getMagicTeaPartySession, putMagicTeaPartyMessage, type MagicTeaPartySummaryPatch } from '@/lib/magic-tea-party/storage';
import { deriveMagicTeaPartyTitle } from '@/lib/magic-tea-party/title';
import type {
  MagicTeaPartyHistoryMessage,
  MagicTeaPartyMessage,
  MagicTeaPartyNotice,
  MagicTeaPartyPreferences,
  MagicTeaPartyOutputSummary,
  MagicTeaPartySession,
  MagicTeaPartyUpdateDraft,
} from '@/lib/magic-tea-party/types';
import { applyShieldWords } from '@/lib/shield-word-filter';
import { readTextAndReasoningStreamFromResponse } from '@/lib/stream/read-text-and-reasoning-stream';

type MagicTeaPartyOutputFormat = NonNullable<MagicTeaPartySession['settings']['outputFormat']>;

const buildMagicTeaPartyRequestHeaders = async (options?: { acceptSse?: boolean }): Promise<Record<string, string>> => ({
  'Content-Type': 'application/json',
  ...(options?.acceptSse ? { Accept: 'text/event-stream' } : {}),
  ...(await authStorage.getActivityHeaders()),
});

const extractUsageFromTelemetry = (payload: Record<string, unknown> | null): Record<string, unknown> | null => {
  if (!payload) return null;
  const usage = payload.usage;
  if (!usage || typeof usage !== 'object') return null;
  return usage as Record<string, unknown>;
};

const extractAiModelFromTelemetry = (payload: Record<string, unknown> | null): string | null => {
  if (!payload) return null;
  const model = typeof payload.aiModel === 'string' ? payload.aiModel.trim() : '';
  return model || null;
};

const mergeAssistantAiMeta = (
  message: MagicTeaPartyMessage,
  patch: {
    reasoning?: AIReasoningEnvelope | null;
    usage?: Record<string, unknown> | null;
    aiModel?: string | null;
  }
): MagicTeaPartyMessage => {
  const currentMeta =
    message.meta && typeof message.meta === 'object'
      ? (message.meta as Record<string, unknown>)
      : {};

  let hasPatch = false;
  const nextMeta: Record<string, unknown> = { ...currentMeta };

  if (patch.reasoning && typeof patch.reasoning === 'object') {
    nextMeta.aiReasoning = patch.reasoning;
    hasPatch = true;
  }

  if (patch.usage && typeof patch.usage === 'object' && Object.keys(patch.usage).length > 0) {
    nextMeta.aiUsage = patch.usage;
    hasPatch = true;
  }

  if (typeof patch.aiModel === 'string' && patch.aiModel.trim()) {
    nextMeta.aiModel = patch.aiModel.trim();
    hasPatch = true;
  }

  if (!hasPatch) return message;
  return { ...message, meta: nextMeta };
};

const buildMagicTeaPartyCustomProviderPayload = (config: UserAIProviderConfig) => ({
  providerId: config.providerId,
  modelId: config.modelId,
  apiKey: config.apiKey,
  ...(typeof config.maxOutputTokens === 'number' ? { maxOutputTokens: config.maxOutputTokens } : {}),
  ...(config.generationOverrides ? { generationOverrides: config.generationOverrides } : {}),
});

export type UseMagicTeaPartyChatOptions = {
  activeSession: MagicTeaPartySession | null;
  activeSessionId: string | null;
  messages: MagicTeaPartyMessage[];
  setMessages: Dispatch<SetStateAction<MagicTeaPartyMessage[]>>;
  persistSession: (session: MagicTeaPartySession, options?: { preserveSummary?: boolean }) => Promise<void>;
  onSummaryCommitted?: (session: MagicTeaPartySession) => void;
  preferences: MagicTeaPartyPreferences;
  userProviderConfig: UserAIProviderConfig | null;
  onGlobalError?: (message: string | null) => void;
  onNotices?: (notices: MagicTeaPartyNotice[]) => void;
  onSideChannels?: (payload: {
    summary: MagicTeaPartyOutputSummary | null;
    updates: MagicTeaPartyUpdateDraft[] | null;
    updatesMeta: Record<string, unknown> | null;
    outputFormat: MagicTeaPartyOutputFormat;
    sourceMessageId: string;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
  }) => boolean | void | Promise<boolean | void>;
  router: Pick<AppRouterAdapter, 'push'>;
};

export type UseMagicTeaPartyChatResult = {
  isGenerating: boolean;
  isSummarizing: boolean;
  summaryError: string | null;
  stopGenerating: () => void;
  sendMessage: (text: string) => Promise<boolean>;
  continueGeneration: () => Promise<void>;
  generateChoices: () => Promise<void>;
  regenerateMessage: (target: MagicTeaPartyMessage) => Promise<void>;
  deleteMessage: (target: MagicTeaPartyMessage) => Promise<void>;
  compactMessageContent: (target: MagicTeaPartyMessage) => Promise<void>;
  getMessageCharLimit: () => number;
  generateSummary: () => Promise<boolean>;
  clearSummary: () => Promise<boolean>;
  saveSummary: (patch: MagicTeaPartySummaryPatch) => Promise<boolean>;
  cancelSummary: () => void;
};

export function useMagicTeaPartyChat(options: UseMagicTeaPartyChatOptions): UseMagicTeaPartyChatResult {
  const generationApiIntentLatch = useGenerationApiIntentLatch();
  const {
    activeSession,
    activeSessionId,
    messages,
    setMessages,
    persistSession,
    onSummaryCommitted,
    preferences,
    userProviderConfig,
    onGlobalError,
    onNotices,
    onSideChannels,
    router,
  } = options;

  const [isGenerating, setIsGenerating] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const generationEntryRef = useRef<AbortController | null>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  const activeSessionEpochRef = useRef(0);
  if (activeSessionIdRef.current !== activeSessionId) {
    activeSessionIdRef.current = activeSessionId;
    activeSessionEpochRef.current += 1;
  }
  const activeSessionEpoch = activeSessionEpochRef.current;
  const providerIdentity = JSON.stringify(userProviderConfig);
  const providerIdentityRef = useRef(providerIdentity);
  const providerEpochRef = useRef(0);
  if (providerIdentityRef.current !== providerIdentity) {
    providerIdentityRef.current = providerIdentity;
    providerEpochRef.current += 1;
  }
  const providerEpoch = providerEpochRef.current;
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const mountedRef = useRef(true);
  const summaryIntentRef = useRef(0);
  const summarizeAbortControllerRef = useRef<AbortController | null>(null);
  const autoSummaryRunningRef = useRef(false);
  const messagesRef = useRef<MagicTeaPartyMessage[]>(messages);
  const dropTrackerRef = useRef<Record<string, { consecutive: number; lastRatio: number }>>({});

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const summaryController = summarizeAbortControllerRef.current;
    summaryController?.abort('session-switch');
    if (summaryController && generationEntryRef.current === summaryController) {
      generationEntryRef.current = null;
      setIsGenerating(false);
      if (abortControllerRef.current === summaryController) abortControllerRef.current = null;
    }
    summarizeAbortControllerRef.current = null;
    autoSummaryRunningRef.current = false;
    dropTrackerRef.current = {};
    setIsSummarizing(false);
    setSummaryError(null);
  }, [activeSessionId]);

  useEffect(() => {
    const controller = summarizeAbortControllerRef.current;
    controller?.abort('provider-change');
    if (controller && generationEntryRef.current === controller) {
      generationEntryRef.current = null;
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
      setIsGenerating(false);
    }
    summarizeAbortControllerRef.current = null;
    autoSummaryRunningRef.current = false;
    setIsSummarizing(false);
  }, [providerEpoch]);

  useEffect(() => {
    if (activeSession?.settings.autoSummaryEnabled !== true && autoSummaryRunningRef.current) {
      summarizeAbortControllerRef.current?.abort('auto-summary-disabled');
    }
  }, [activeSession?.settings.autoSummaryEnabled]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; summarizeAbortControllerRef.current?.abort('unmount'); };
  }, []);

  useEffect(() => () => {
    generationEntryRef.current?.abort('session-switch');
    abortControllerRef.current?.abort('session-switch');
  }, [activeSessionId]);

  const isGenerationCurrent = useCallback((controller: AbortController, sessionId: string) =>
    generationEntryRef.current === controller && activeSessionIdRef.current === sessionId && !controller.signal.aborted, []);

  const assertGenerationActive = useCallback((controller: AbortController, sessionId: string) => {
    if (activeSessionIdRef.current !== sessionId || generationEntryRef.current !== controller) controller.abort('session-switch');
    controller.signal.throwIfAborted();
  }, []);

  const stopGenerating = useCallback(() => {
    abortControllerRef.current?.abort('user');
    summarizeAbortControllerRef.current?.abort('user');
  }, []);

  const ensureProviderReady = useCallback((): { ok: true } | { ok: false; message: string } => {
    if (!userProviderConfig) return { ok: false, message: '请先配置模型与 API Key。' };
    if (userProviderConfig.providerId === 'system') return { ok: false, message: '魔法茶会已禁用 system，请使用自备 Key。' };
    if (!userProviderConfig.apiKey?.trim()) return { ok: false, message: 'API Key 不能为空。' };
    if (!userProviderConfig.modelId?.trim()) return { ok: false, message: '请先选择模型。' };
    return { ok: true };
  }, [userProviderConfig]);

  const buildRequestSettings = useCallback(
    (session: MagicTeaPartySession) => ({
      ...pickMagicTeaPartyRequestSettings(session.settings),
      providerId: session.settings.providerId,
      modelId: session.settings.modelId,
      readArenaHistory:
        typeof session.settings.readArenaHistory === 'boolean' ? session.settings.readArenaHistory : preferences.readArenaHistory,
      readArenaHistoryLimit:
        typeof session.settings.readArenaHistoryLimit === 'number'
          ? session.settings.readArenaHistoryLimit
          : preferences.readArenaHistoryLimit,
      isArenaHistoryUnlimited:
        typeof session.settings.isArenaHistoryUnlimited === 'boolean'
          ? session.settings.isArenaHistoryUnlimited
          : preferences.isArenaHistoryUnlimited,
      readCurrentState:
        typeof session.settings.readCurrentState === 'boolean' ? session.settings.readCurrentState : preferences.readCurrentState,
      writeArenaHistory:
        typeof session.settings.writeArenaHistory === 'boolean' ? session.settings.writeArenaHistory : preferences.writeArenaHistory,
      writeCurrentState:
        typeof session.settings.writeCurrentState === 'boolean' ? session.settings.writeCurrentState : preferences.writeCurrentState,
      enableSummary:
        typeof session.settings.enableSummary === 'boolean' ? session.settings.enableSummary : preferences.enableSummary,
      outputPlan: pickMagicTeaPartyRequestSettings(session.settings).outputPlan ?? preferences.outputPlan,
      updateApplyMode: session.settings.updateApplyMode ?? preferences.updateApplyMode,
    }),
    [preferences]
  );

  const resolvePromptSettings = useCallback(
    (session: MagicTeaPartySession, outputFormatOverride?: MagicTeaPartyOutputFormat) => {
      const outputFormat =
        outputFormatOverride ?? ((session.settings.outputFormat ?? preferences.outputFormat) as MagicTeaPartyOutputFormat);
      const language = session.settings.language ?? preferences.language;
      const enableChoices =
        typeof session.settings.enableChoices === 'boolean' ? session.settings.enableChoices : preferences.enableChoices;
      const choiceCount = session.settings.choiceCount ?? preferences.choiceCount;
      const displayName = typeof session.settings.userDisplayName === 'string' ? session.settings.userDisplayName.trim() : '';
      let nameEnd = 20;
      if (displayName.charCodeAt(19) >= 0xd800 && displayName.charCodeAt(19) <= 0xdbff
        && displayName.charCodeAt(20) >= 0xdc00 && displayName.charCodeAt(20) <= 0xdfff) nameEnd -= 1;
      const sessionDisplayName = displayName.slice(0, nameEnd);
      const userDisplayName = sessionDisplayName || preferences.userDisplayName || '旅人';

      return {
        ...buildRequestSettings(session),
        outputFormat,
        language,
        enableChoices,
        choiceCount,
        userDisplayName,
      };
    },
    [buildRequestSettings, preferences]
  );

  const resolveOutputPlanForRequest = useCallback(
    (session: MagicTeaPartySession) => {
      const settings = buildRequestSettings(session);
      const basePlan = settings.outputPlan ?? preferences.outputPlan;
      const enableChoices = settings.enableChoices !== false;
      const summaryPlan = settings.enableSummary ? basePlan.summary : 'off';
      const updatesPlan = settings.writeArenaHistory || settings.writeCurrentState ? basePlan.updates : 'off';
      return {
        choices: enableChoices ? basePlan.choices : 'off',
        summary: summaryPlan,
        updates: updatesPlan,
      } as const;
    },
    [buildRequestSettings, preferences.outputPlan]
  );

  const emitNotices = useCallback(
    (notices: MagicTeaPartyNotice[]) => {
      if (!onNotices || notices.length === 0) return;
      const sanitized = notices.map((notice) => ({
        ...notice,
        message: applyShieldWords(notice.message).filteredText,
      }));
      onNotices(sanitized);
    },
    [onNotices]
  );

  const buildHistoryForRequest = useCallback(
    (params: { session: MagicTeaPartySession; messages: MagicTeaPartyMessage[]; outputFormat?: MagicTeaPartyOutputFormat }) => {
      const outputFormat =
        params.outputFormat ??
        ((params.session.settings.outputFormat ?? preferences.outputFormat) as MagicTeaPartyOutputFormat);
      const promptSettings = resolvePromptSettings(params.session, outputFormat);
      const rawHistory = buildMagicTeaPartyHistory(params.messages, { includeEmptyContent: false });
      if (rawHistory.length === 0) {
        return {
          history: [],
          trimStats: { rawCount: 0, trimmedCount: 0, droppedCount: 0, droppedRatio: 0 },
          clipStats: { limit: 0, clippedCount: 0, omittedChars: 0, totalChars: 0 },
        };
      }

      const providerId = userProviderConfig?.providerId ?? params.session.settings.providerId;
      const tokenBudget = resolveMagicTeaPartyTokenBudget(params.session.settings, providerId);
      const messageCharLimit = resolveMagicTeaPartyMessageCharLimit(tokenBudget.contextWindowTokens);
      const preset = getMagicTeaPartyPreset(params.session.settings.presetId ?? null);
      const worldbookText = preset ? buildWorldbookText(preset.worldbook) : '';
      const stylePrompt = preset ? preset.systemPrompt : '';

      const basePrompt = buildMagicTeaPartyMainPrompt({
        session: {
          playerRoleId: params.session.playerRoleId ?? null,
          summary: params.session.summary,
          protocolShadow: params.session.protocolShadow,
          settings: promptSettings,
        },
        roles: params.session.roles ?? [],
        scenario: params.session.scenario,
        auxScenarios: params.session.auxScenarios ?? [],
        worldbookText,
        messages: [],
        requestChoices: false,
        stylePrompt,
      });

      const baseTokens = estimateMagicTeaPartyTokens(basePrompt, providerId);
      const availableTokens = Math.max(0, tokenBudget.historyBudgetTokens - baseTokens);

      const trimmed = trimMagicTeaPartyHistory(rawHistory, {
        maxMessages: tokenBudget.maxContextMessages,
        tokenBudget: availableTokens,
        providerId,
        userDisplayName: promptSettings.userDisplayName,
        minKeep: 2,
      });
      const limited = applyMagicTeaPartyMessageLimits(trimmed, messageCharLimit);
      const rawCount = rawHistory.length;
      const trimmedCount = trimmed.length;
      const droppedCount = Math.max(0, rawCount - trimmedCount);
      const droppedRatio = rawCount > 0 ? droppedCount / rawCount : 0;

      if (limited.clippedMessages.length > 0) {
        emitNotices([
          {
            type: 'notice',
            level: 'warning',
            code: 'message_content_clipped',
            message: `有 ${limited.clippedMessages.length} 条消息超过单条 ${messageCharLimit} 字预算，已自动省略中段（共 ${limited.totalOmittedChars} 字）。如需保留完整内容，请编辑或精简对应消息。`,
          },
        ]);
      }

      return {
        history: limited.messages,
        trimStats: { rawCount, trimmedCount, droppedCount, droppedRatio },
        clipStats: {
          limit: messageCharLimit,
          clippedCount: limited.clippedMessages.length,
          omittedChars: limited.totalOmittedChars,
          totalChars: limited.totalChars,
        },
      };
    },
    [emitNotices, preferences.outputFormat, resolvePromptSettings, userProviderConfig?.providerId]
  );

  const recordDropStats = useCallback((sessionId: string, droppedRatio: number) => {
    if (!sessionId) return;
    const prev = dropTrackerRef.current[sessionId];
    const overLimit = droppedRatio > 0.3;
    const consecutive = overLimit ? (prev?.consecutive ?? 0) + 1 : 0;
    dropTrackerRef.current = { [sessionId]: { consecutive, lastRatio: droppedRatio } };
  }, []);

  const buildChoiceNotices = useCallback(
    (params: {
      choices: { id: string; text: string }[] | undefined;
      expectedCount?: number | null;
      enableChoices: boolean;
      stage: string;
    }): MagicTeaPartyNotice[] => {
      const { choices, expectedCount, enableChoices, stage } = params;
      if (!choices || choices.length === 0) return [];
      const notices: MagicTeaPartyNotice[] = [];
      if (!enableChoices) {
        notices.push({
          type: 'notice',
          level: 'warning',
          code: 'choices_forced',
          message: '协议要求选项已临时输出，可在设置中开启选项功能。',
          meta: { stage },
        });
      }
      if (typeof expectedCount === 'number' && Number.isFinite(expectedCount) && choices.length !== expectedCount) {
        notices.push({
          type: 'notice',
          level: 'info',
          code: 'choices_count_adjusted',
          message: `选项数量已调整为 ${choices.length} 条（原设置 ${expectedCount} 条）。`,
          meta: { stage },
        });
      }
      return notices;
    },
    []
  );

  const normalizeFallbackHistory = useCallback(
    (history: MagicTeaPartyHistoryMessage[], contextWindowTokens?: number | null) => {
      const MAX_MESSAGES = 200;
      const limit = resolveMagicTeaPartyMessageCharLimit(contextWindowTokens);
      const clipped = applyMagicTeaPartyMessageLimits(history.slice(-MAX_MESSAGES), limit);
      return clipped.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
      }));
    },
    []
  );

  const requestChoicesFallback = useCallback(
    async (params: { session: MagicTeaPartySession; normalizedHistory: MagicTeaPartyHistoryMessage[] }) => {
      if (!userProviderConfig || userProviderConfig.providerId === 'system') return;
      if (!userProviderConfig.apiKey?.trim() || !userProviderConfig.modelId?.trim()) return;
      if (!params.normalizedHistory || params.normalizedHistory.length === 0) return;

      const now = Date.now();
      const assistantMessageId = randomUUID();
      const lastUserMessageId = [...params.normalizedHistory].reverse().find((message) => message.role === 'user')?.id;
      const assistantMessage: MagicTeaPartyMessage = {
        id: assistantMessageId,
        sessionId: params.session.id,
        role: 'assistant',
        content: '',
        createdAt: now,
        status: 'streaming',
        ...(lastUserMessageId ? { sourceMessageId: lastUserMessageId } : {}),
        meta: { kind: 'choices', outputFormat: 'jsonl', source: 'output-plan' },
      };

      setMessages((prev) => [...prev, assistantMessage]);
      await putMagicTeaPartyMessage(assistantMessage);

      const controller = new AbortController();
      const previousController = abortControllerRef.current;
      abortControllerRef.current = controller;

      const preview = createMagicTeaPartyStreamPreview({
        outputFormat: 'jsonl',
        onUpdate: (update) => {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantMessageId) return m;
              const patch: Partial<MagicTeaPartyMessage> = {
                content: update.content,
                ...(typeof update.status === 'string' ? { status: update.status } : {}),
                ...(update.includeJsonl ? { segments: update.segments, choices: update.choices } : {}),
              };
              return { ...m, ...patch };
            })
          );
          if (update.notices && update.notices.length > 0) {
            emitNotices(update.notices);
          }
        },
      });

      const safety = createMagicTeaPartyStreamSafety({
        outputFormat: 'jsonl',
        onSafePreview: (safeText) => {
          preview.applySafeText(safeText);
        },
        onBlocked: (safeText) => {
          preview.applySafeText(safeText, 'blocked');
          controller.abort('output-safety');
        },
      });
      let latestReasoning: AIReasoningEnvelope | null = null;
      let latestUsage: Record<string, unknown> | null = null;
      let latestAiModel: string | null = null;

      const applyAssistantMetaPatch = () => {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantMessageId
              ? mergeAssistantAiMeta(message, {
                  reasoning: latestReasoning,
                  usage: latestUsage,
                  aiModel: latestAiModel,
                })
              : message
          )
        );
      };

      try {
        const generationIntent = generationApiIntentLatch.tryAcquire();
        if (!generationIntent) return;
        const response = await generationIntent.dispatch('/api/magic-tea-party/generate-choices?format=sse', {
          method: 'POST',
          headers: await buildMagicTeaPartyRequestHeaders({ acceptSse: true }),
          signal: controller.signal,
          body: JSON.stringify({
            sessionId: params.session.id,
            summary: params.session.summary,
            messages: params.normalizedHistory,
            roles: params.session.roles ?? [],
            scenario: params.session.scenario ?? null,
            auxScenarios: params.session.auxScenarios ?? [],
            protocolShadow: params.session.protocolShadow,
            playerRoleId: params.session.playerRoleId ?? null,
            settings: {
              ...buildRequestSettings(params.session),
              providerId: userProviderConfig.providerId,
              modelId: userProviderConfig.modelId,
              choiceCount: params.session.settings.choiceCount ?? preferences.choiceCount,
              userDisplayName: params.session.settings.userDisplayName,
            },
            customProvider: buildMagicTeaPartyCustomProviderPayload(userProviderConfig),
          }),
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          const shouldRedirect = Boolean(payload?.shouldRedirect);
          if (shouldRedirect) {
            const reason = typeof payload?.reason === 'string' ? payload.reason : '使用危险符文';
            const blockedMessage: MagicTeaPartyMessage = {
              ...assistantMessage,
              status: 'blocked',
              safety: { status: 'blocked', blockedBy: 'server', blockedAt: Date.now(), action: 'redirect' },
              error: { code: `${response.status}`, message: reason },
            };
            setMessages((prev) => prev.map((m) => (m.id === assistantMessageId ? blockedMessage : m)));
            await putMagicTeaPartyMessage(blockedMessage);
            await router.push('/arrested');
            return;
          }

          const errorMessage = resolveApiErrorMessage({ payload, fallback: `请求失败（${response.status}）` });

          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMessageId ? { ...m, status: 'error', error: { code: `${response.status}`, message: errorMessage } } : m))
          );
          await putMagicTeaPartyMessage({
            ...assistantMessage,
            status: 'error',
            error: { code: `${response.status}`, message: errorMessage },
          });
          return;
        }

        const { text: streamedText } = await readTextAndReasoningStreamFromResponse(response, {
          label: '魔法茶会选项',
          onText: (accumulated) => {
            safety.ingest(accumulated);
          },
          onReasoning: (reasoning) => {
            latestReasoning = reasoning;
            applyAssistantMetaPatch();
          },
          onTelemetry: (telemetry) => {
            latestUsage = extractUsageFromTelemetry(telemetry);
            latestAiModel = extractAiModelFromTelemetry(telemetry);
            applyAssistantMetaPatch();
          },
        });

        const { safeText, status, blockedAt, truncatedAt } = await safety.finalize(streamedText);

        const parsed = parseMagicTeaPartyJsonl(safeText);
        const sideChannelBundle = extractMagicTeaPartySideChannelsFromJsonl(safeText);
        const expectedCount = params.session.settings.choiceCount ?? preferences.choiceCount;
        const extraNotices = buildChoiceNotices({
          choices: parsed.choices ?? undefined,
          expectedCount,
          enableChoices: true,
          stage: 'choices',
        });
        const allNotices = [...sideChannelBundle.notices, ...extraNotices];
        emitNotices(allNotices);
        const hasErrorNotice = allNotices.some((notice) => notice.level === 'error');
        const hasChoices = Boolean(parsed.choices && parsed.choices.length > 0);
        const previewText = buildMagicTeaPartyJsonlPreview(safeText);
        const finalAssistant: MagicTeaPartyMessage = mergeAssistantAiMeta({
          ...assistantMessage,
          content: previewText,
          status,
          ...(parsed.segments ? { segments: parsed.segments, choices: parsed.choices ?? undefined } : {}),
          ...(status === 'blocked'
            ? { safety: { status: 'blocked', blockedBy: 'output', blockedAt: blockedAt ?? Date.now(), action: 'soft-block' } }
            : { safety: { status: 'ok' } }),
          ...(status === 'blocked' && typeof truncatedAt === 'number' ? { truncatedAt } : {}),
        }, {
          reasoning: latestReasoning,
          usage: latestUsage,
          aiModel: latestAiModel,
        });

        setMessages((prev) => prev.map((m) => (m.id === assistantMessageId ? finalAssistant : m)));
        await putMagicTeaPartyMessage(finalAssistant);
        if (hasChoices && !hasErrorNotice && status !== 'blocked') {
          emitNotices([
            {
              type: 'notice',
              level: 'warning',
              code: 'output_plan_fallback_choices',
              message: 'Markdown 模式已按合并输出计划补生成选项。',
            },
          ]);
        }
      } catch (error) {
        safety.clearTimer();
        if (error instanceof Error && error.name === 'AbortError') {
          const { safeText, status, blockedAt, truncatedAt } = await safety.finalizeAfterAbort(controller.signal.reason);
          const parsed = parseMagicTeaPartyJsonl(safeText);
          const sideChannelBundle = extractMagicTeaPartySideChannelsFromJsonl(safeText);
          const expectedCount = params.session.settings.choiceCount ?? preferences.choiceCount;
          const extraNotices = buildChoiceNotices({
            choices: parsed.choices ?? undefined,
            expectedCount,
            enableChoices: true,
            stage: 'choices',
          });
          const allNotices = [...sideChannelBundle.notices, ...extraNotices];
          emitNotices(allNotices);
          const previewText = buildMagicTeaPartyJsonlPreview(safeText);
          const finalAssistant: MagicTeaPartyMessage = mergeAssistantAiMeta({
            ...assistantMessage,
            content: previewText,
            status,
            ...(parsed.segments ? { segments: parsed.segments, choices: parsed.choices ?? undefined } : {}),
            ...(status === 'blocked'
              ? { safety: { status: 'blocked', blockedBy: 'output', blockedAt: blockedAt ?? Date.now(), action: 'soft-block' } }
              : { safety: { status: 'ok' } }),
            ...(status === 'blocked' && typeof truncatedAt === 'number' ? { truncatedAt } : {}),
          }, {
            reasoning: latestReasoning,
            usage: latestUsage,
            aiModel: latestAiModel,
          });
          setMessages((prev) => prev.map((m) => (m.id === assistantMessageId ? finalAssistant : m)));
          await putMagicTeaPartyMessage(finalAssistant);
          return;
        }

        const message = error instanceof Error ? error.message : '生成失败';
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMessageId ? { ...m, status: 'error', error: { code: 'exception', message } } : m))
        );
        await putMagicTeaPartyMessage({ ...assistantMessage, status: 'error', error: { code: 'exception', message } });
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = previousController;
        }
      }
    },
    [buildChoiceNotices, buildRequestSettings, emitNotices, generationApiIntentLatch, preferences.choiceCount, router, setMessages, userProviderConfig]
  );

  const requestOutputPlanFallbacks = useCallback(
    async (params: {
      session: MagicTeaPartySession;
      outputFormat: MagicTeaPartyOutputFormat;
      historyForRequest: MagicTeaPartyHistoryMessage[];
      assistantMessageId: string;
      assistantContent: string;
      summary: MagicTeaPartyOutputSummary | null;
      updates: MagicTeaPartyUpdateDraft[] | null;
      signal: AbortSignal;
      isCurrent: () => boolean;
    }): Promise<boolean> => {
      let summaryAttempted = false;
      const hasSideChannelHandler = Boolean(onSideChannels);
      const effectivePlan = resolveOutputPlanForRequest(params.session);
      const isJsonl = params.outputFormat === 'jsonl';
      const hasSummary = Boolean(params.summary?.text?.trim());
      const hasUpdates = Array.isArray(params.updates) && params.updates.length > 0;
      const wantsSummary = effectivePlan.summary === 'on' && !hasSummary;
      const wantsUpdates = effectivePlan.updates === 'on' && !hasUpdates;
      const wantsChoices = !isJsonl && effectivePlan.choices === 'on';
      const needsSummary = wantsSummary && hasSideChannelHandler;
      const needsUpdates = wantsUpdates && hasSideChannelHandler;
      if (!needsSummary && !needsUpdates && !wantsChoices) return false;

      if (!userProviderConfig || userProviderConfig.providerId === 'system') return false;
      if (!userProviderConfig.apiKey?.trim() || !userProviderConfig.modelId?.trim()) return false;

      const assistantText = params.assistantContent?.trim();
      const assistantHistory: MagicTeaPartyHistoryMessage | null = assistantText
        ? { id: params.assistantMessageId, role: 'assistant', content: assistantText }
        : null;
      const baseHistory: MagicTeaPartyHistoryMessage[] = assistantHistory
        ? [...params.historyForRequest, assistantHistory]
        : params.historyForRequest;
      const fallbackTokenBudget = resolveMagicTeaPartyTokenBudget(
        params.session.settings,
        userProviderConfig.providerId
      );
      const normalizedHistory = normalizeFallbackHistory(baseHistory, fallbackTokenBudget.contextWindowTokens);
      if (normalizedHistory.length === 0) return false;

      const mergedSettings = buildRequestSettings(params.session);
      const language = params.session.settings.language ?? preferences.language;
      const userDisplayName = params.session.settings.userDisplayName || preferences.userDisplayName || '旅人';
      const contextWindowTokens = fallbackTokenBudget.contextWindowTokens;

      if (needsSummary && !summarizeAbortControllerRef.current) {
        summaryAttempted = true;
        try {
          const headers = await buildMagicTeaPartyRequestHeaders();
          if (!params.isCurrent() || params.signal.aborted) return summaryAttempted;
          const response = await fetch('/api/magic-tea-party/summarize', {
            method: 'POST',
            headers,
            signal: params.signal,
            body: JSON.stringify({
              sessionId: params.session.id,
              mode: 'summary',
              language,
              userDisplayName,
              contextWindowTokens,
              messages: normalizedHistory,
              customProvider: buildMagicTeaPartyCustomProviderPayload(userProviderConfig),
            }),
          });

          const payload = await response.json().catch(() => null);
          if (!params.isCurrent() || params.signal.aborted) return summaryAttempted;
          if (!response.ok) {
            const errorMessage = resolveApiErrorMessage({ payload, fallback: `请求失败（${response.status}）` });
            emitNotices([
              {
                type: 'notice',
                level: 'error',
                code: 'output_plan_fallback_summary_failed',
                message: `摘要补生成失败：${errorMessage}`,
              },
            ]);
          } else {
            const summaryRaw = typeof payload?.summary === 'string' ? payload.summary.trim() : '';
            if (!summaryRaw) {
              emitNotices([
                {
                  type: 'notice',
                  level: 'error',
                  code: 'output_plan_fallback_summary_failed',
                  message: '摘要补生成失败：模型返回空摘要。',
                },
              ]);
            } else {
              await onSideChannels?.({
                summary: { text: summaryRaw },
                updates: null,
                updatesMeta: null,
                outputFormat: params.outputFormat,
                sourceMessageId: params.assistantMessageId,
                signal: params.signal, isCurrent: params.isCurrent,
              });
              emitNotices([
                {
                  type: 'notice',
                  level: 'warning',
                  code: 'output_plan_fallback_summary',
                  message: isJsonl
                    ? '模型未按合并输出计划返回摘要，已使用摘要接口补生成。'
                    : 'Markdown 模式已按合并输出计划补生成摘要。',
                },
              ]);
            }
          }
        } catch (error) {
          if (!params.isCurrent() || params.signal.aborted) return summaryAttempted;
          const message = error instanceof Error ? error.message : '未知错误';
          emitNotices([
            {
              type: 'notice',
              level: 'error',
              code: 'output_plan_fallback_summary_failed',
              message: `摘要补生成失败：${message}`,
            },
          ]);
        }
      }

      if (needsUpdates) {
        try {
          const fromMessageId = normalizedHistory[0]?.id;
          const toMessageId = normalizedHistory[normalizedHistory.length - 1]?.id;
          const messageRange =
            fromMessageId && toMessageId
              ? { fromMessageId, toMessageId, count: normalizedHistory.length }
              : undefined;
          const headers = await buildMagicTeaPartyRequestHeaders();
          if (!params.isCurrent() || params.signal.aborted) return summaryAttempted;
          const generationIntent = generationApiIntentLatch.tryAcquire();
          if (!generationIntent) return summaryAttempted;
          const response = await generationIntent.dispatch('/api/magic-tea-party/generate-updates', {
            method: 'POST',
            headers,
            signal: params.signal,
            body: JSON.stringify({
              sessionId: params.session.id,
              sessionTitle: params.session.title,
              messages: normalizedHistory,
              summary: params.session.summary,
              roles: params.session.roles ?? [],
              scenario: params.session.scenario ?? null,
              auxScenarios: params.session.auxScenarios ?? [],
              lastChoices: params.session.lastChoices ?? undefined,
              ...(messageRange ? { messageRange } : {}),
              settings: {
                writeArenaHistory: mergedSettings.writeArenaHistory,
                writeCurrentState: mergedSettings.writeCurrentState,
                language,
                userDisplayName,
                contextWindowTokens,
              },
              customProvider: buildMagicTeaPartyCustomProviderPayload(userProviderConfig),
            }),
          });

          const payload = await response.json().catch(() => null);
          if (!params.isCurrent() || params.signal.aborted) return summaryAttempted;
          if (!response.ok) {
            const errorMessage = resolveApiErrorMessage({ payload, fallback: `请求失败（${response.status}）` });
            emitNotices([
              {
                type: 'notice',
                level: 'error',
                code: 'output_plan_fallback_updates_failed',
                message: `更新草案补生成失败：${errorMessage}`,
              },
            ]);
          } else {
            const drafts = Array.isArray(payload?.drafts) ? (payload.drafts as MagicTeaPartyUpdateDraft[]) : [];
            if (!drafts || drafts.length === 0) {
              emitNotices([
                {
                  type: 'notice',
                  level: 'error',
                  code: 'output_plan_fallback_updates_failed',
                  message: '更新草案补生成失败：模型未返回草案。',
                },
              ]);
            } else {
              await onSideChannels?.({
                summary: null,
                updates: drafts,
                updatesMeta: payload?.meta ?? null,
                outputFormat: params.outputFormat,
                sourceMessageId: params.assistantMessageId,
                signal: params.signal, isCurrent: params.isCurrent,
              });
              emitNotices([
                {
                  type: 'notice',
                  level: 'warning',
                  code: 'output_plan_fallback_updates',
                  message: isJsonl
                    ? '模型未按合并输出计划返回更新草案，已使用更新接口补生成。'
                    : 'Markdown 模式已按合并输出计划补生成更新草案。',
                },
              ]);
            }
          }
        } catch (error) {
          if (!params.isCurrent() || params.signal.aborted) return summaryAttempted;
          const message = error instanceof Error ? error.message : '未知错误';
          emitNotices([
            {
              type: 'notice',
              level: 'error',
              code: 'output_plan_fallback_updates_failed',
              message: `更新草案补生成失败：${message}`,
            },
          ]);
        }
      }

      if (wantsChoices) {
        await requestChoicesFallback({ session: params.session, normalizedHistory });
      }
      return summaryAttempted;
    },
    [
      buildRequestSettings,
      emitNotices,
      generationApiIntentLatch,
      normalizeFallbackHistory,
      onSideChannels,
      preferences.language,
      preferences.userDisplayName,
      requestChoicesFallback,
      resolveOutputPlanForRequest,
      userProviderConfig,
    ]
  );

  const runGenerateStream = useCallback(
    async (params: {
      session: MagicTeaPartySession;
      historyForRequest: MagicTeaPartyHistoryMessage[];
      outputFormat: MagicTeaPartyOutputFormat;
      assistantMessageId: string;
      assistantMessage: MagicTeaPartyMessage;
      arrestedBackupInput?: string;
      controller: AbortController;
    }): Promise<{ session: MagicTeaPartySession; assistant: MagicTeaPartyMessage; autoSummaryEligible: boolean } | null> => {
      const totalChars = params.historyForRequest.reduce(
        (sum, message) => sum + (typeof message.content === 'string' ? message.content.length : 0),
        0
      );
      if (isMagicTeaPartyTotalOverflow(totalChars)) {
        emitNotices([
          {
            type: 'notice',
            level: 'error',
            code: 'history_total_overflow',
            message: formatMagicTeaPartyTotalOverflowMessage(totalChars),
          },
        ]);
        return null;
      }

      let finalSession: MagicTeaPartySession | null = null;
      let completedAssistant: MagicTeaPartyMessage | null = null;
      let autoSummaryEligible = false;
      let completionEvidenceCount = 0;
      let normalStopEvidence = false;
      let terminalOutputReady = false;
      const summaryIntentAtStart = summaryIntentRef.current;
      const controller = params.controller;
      abortControllerRef.current = controller;
      setIsGenerating(true);
      let previewOpen = true;
      const ownsCurrentSession = () => generationEntryRef.current === controller && activeSessionIdRef.current === params.session.id;
      const canPreview = () => previewOpen && isGenerationCurrent(controller, params.session.id);

      const preview = createMagicTeaPartyStreamPreview({
        outputFormat: params.outputFormat,
        onUpdate: (update) => {
          if (!canPreview()) return;
          setMessages((prev) => !canPreview() ? prev :
            prev.map((m) => {
              if (m.id !== params.assistantMessageId) return m;
              const patch: Partial<MagicTeaPartyMessage> = {
                content: update.content,
                ...(typeof update.status === 'string' ? { status: update.status } : {}),
                ...(update.includeJsonl ? { segments: update.segments, choices: update.choices } : {}),
              };
              return { ...m, ...patch };
            })
          );
          if (update.notices && update.notices.length > 0) {
            emitNotices(update.notices);
          }
        },
      });

      const safety = createMagicTeaPartyStreamSafety({
        outputFormat: params.outputFormat,
        onSafePreview: (safeText) => {
          if (!canPreview()) return;
          preview.applySafeText(safeText);
        },
        onBlocked: (safeText) => {
          if (!canPreview()) return;
          preview.applySafeText(safeText, 'blocked');
          controller.abort('output-safety');
        },
      });
      let latestReasoning: AIReasoningEnvelope | null = null;
      let latestUsage: Record<string, unknown> | null = null;
      let latestAiModel: string | null = null;

      const applyAssistantMetaPatch = () => {
        if (!canPreview()) return;
        setMessages((prev) => !canPreview() ? prev :
          prev.map((message) =>
            message.id === params.assistantMessageId
              ? mergeAssistantAiMeta(message, {
                  reasoning: latestReasoning,
                  usage: latestUsage,
                  aiModel: latestAiModel,
                })
              : message
          )
        );
      };

      const persistTerminalMessage = async (message: MagicTeaPartyMessage): Promise<boolean> => {
        try {
          await putMagicTeaPartyMessage(message);
          return true;
        } catch (error) {
          if (ownsCurrentSession()) {
            const detail = error instanceof Error ? error.message : '本地存储不可用';
            onGlobalError?.(`生成结果尚未完整保存：${detail}。内容仍保留在当前窗口。`);
          }
          return false;
        }
      };

      try {
        assertGenerationActive(controller, params.session.id);
        const headers = await buildMagicTeaPartyRequestHeaders({ acceptSse: true });
        assertGenerationActive(controller, params.session.id);
        const generationIntent = generationApiIntentLatch.tryAcquire();
        if (!generationIntent) return null;
        const response = await generationIntent.dispatch('/api/magic-tea-party/generate-stream?format=sse', {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            sessionId: params.session.id,
            summary: params.session.summary,
            messages: params.historyForRequest,
            roles: params.session.roles ?? [],
            scenario: params.session.scenario ?? null,
            auxScenarios: params.session.auxScenarios ?? [],
            protocolShadow: params.session.protocolShadow,
            playerRoleId: params.session.playerRoleId ?? null,
            settings: {
              ...buildRequestSettings(params.session),
              providerId: userProviderConfig?.providerId,
              modelId: userProviderConfig?.modelId,
              userDisplayName: params.session.settings.userDisplayName,
            },
            customProvider: buildMagicTeaPartyCustomProviderPayload(userProviderConfig!),
          }),
        });

        if (!response.ok) {
          previewOpen = false;
          const payload = await response.json().catch(() => null);
          const shouldRedirect = Boolean(payload?.shouldRedirect);
          terminalOutputReady = true;
          if (shouldRedirect) {
            const reason = typeof payload?.reason === 'string' ? payload.reason : '使用危险符文';

            if (params.arrestedBackupInput) {
              persistArrestedBackup({
                triggerSource: 'input',
                reason,
                origin: '/magic-tea-party',
                items: [
                  {
                    label: '魔法茶会输入',
                    filename: 'magic-tea-party-input.txt',
                    mimeType: 'text/plain',
                    content: params.arrestedBackupInput,
                  },
                ],
              });
            }

            const blockedMessage: MagicTeaPartyMessage = {
              ...params.assistantMessage,
              status: 'blocked',
              safety: { status: 'blocked', blockedBy: 'server', blockedAt: Date.now(), action: 'redirect' },
              error: { code: `${response.status}`, message: reason },
            };

            setMessages((prev) => prev.map((m) => (m.id === params.assistantMessageId ? blockedMessage : m)));
            if (!await persistTerminalMessage(blockedMessage)) return null;

            if (isGenerationCurrent(controller, params.session.id)) await router.push('/arrested');
            return null;
          }

          const errorMessage = resolveApiErrorMessage({ payload, fallback: `请求失败（${response.status}）` });

          const errorMessageRecord: MagicTeaPartyMessage = {
            ...params.assistantMessage,
            status: 'error',
            error: { code: `${response.status}`, message: errorMessage },
          };

          setMessages((prev) => prev.map((m) => (m.id === params.assistantMessageId ? errorMessageRecord : m)));
          await persistTerminalMessage(errorMessageRecord);
          return null;
        }

        setMessages((prev) => prev.map((m) => (m.id === params.assistantMessageId ? { ...m, content: '', status: 'streaming' } : m)));

        const { text: streamedText } = await readTextAndReasoningStreamFromResponse(response, {
          label: '魔法茶会',
          onEvent: (event, payload) => {
            if (event !== 'tea_completion') return;
            completionEvidenceCount += 1;
            normalStopEvidence = Boolean(payload && typeof payload === 'object' && 'finishReason' in payload && payload.finishReason === 'stop');
          },
          onText: (accumulated) => {
            safety.ingest(accumulated);
          },
          onReasoning: (reasoning) => {
            latestReasoning = reasoning;
            applyAssistantMetaPatch();
          },
          onTelemetry: (telemetry) => {
            latestUsage = extractUsageFromTelemetry(telemetry);
            latestAiModel = extractAiModelFromTelemetry(telemetry);
            applyAssistantMetaPatch();
          },
        });

        const { safeText, status, blockedAt, truncatedAt } = await safety.finalize(streamedText);
        previewOpen = false;
        safety.clearTimer();

        const isJsonl = params.outputFormat === 'jsonl';
        const completion = status === 'blocked' ? 'blocked' : controller.signal.aborted ? 'stopped' : 'completed';
        const projectedChoices = isJsonl ? projectMagicTeaPartyChoices({ rawText: safeText, completion }).lastChoices : null;
        const parsed = isJsonl
          ? parseMagicTeaPartyJsonl(safeText)
          : { segments: undefined, choices: null, notices: [], summary: null, updates: null, updatesMeta: null };
        const sideChannelBundle = isJsonl
          ? extractMagicTeaPartySideChannelsFromJsonl(safeText)
          : { cleanedText: safeText, notices: [], summary: null, updates: null, updatesMeta: null };
        const noticeBundle = isJsonl ? sideChannelBundle : extractMagicTeaPartyNoticesFromMarkdown(safeText);
        const promptSettings = resolvePromptSettings(params.session, params.outputFormat);
        const extraNotices = isJsonl
          ? buildChoiceNotices({
              choices: parsed.choices ?? undefined,
              expectedCount: promptSettings.enableChoices ? promptSettings.choiceCount : undefined,
              enableChoices: promptSettings.enableChoices,
              stage: String(params.assistantMessage.meta?.kind ?? 'narration'),
            })
          : [];
        const allNotices = [...noticeBundle.notices, ...extraNotices];
        if (ownsCurrentSession()) emitNotices(allNotices);

        const hasErrorNotice = allNotices.some((notice) => notice.level === 'error');
        const previewText = isJsonl ? buildMagicTeaPartyJsonlPreview(safeText) : (noticeBundle.cleanedText ?? safeText);
        const finalContent = previewText;
        const finalAssistant: MagicTeaPartyMessage = mergeAssistantAiMeta({
          ...params.assistantMessage,
          content: finalContent,
          status,
          ...(isJsonl && parsed.segments ? { segments: parsed.segments, choices: projectedChoices ?? [] } : {}),
          meta: { ...params.assistantMessage.meta, rawOutput: safeText, completion, choicesValid: projectedChoices !== null, notices: allNotices },
          ...(status === 'blocked'
            ? { safety: { status: 'blocked', blockedBy: 'output', blockedAt: blockedAt ?? Date.now(), action: 'soft-block' } }
            : { safety: { status: 'ok' } }),
          ...(status === 'blocked' && typeof truncatedAt === 'number' ? { truncatedAt } : {}),
        }, {
          reasoning: latestReasoning,
          usage: latestUsage,
          aiModel: latestAiModel,
        });

        terminalOutputReady = true;
        setMessages((prev) => prev.map((m) => (m.id === params.assistantMessageId ? finalAssistant : m)));
        if (!await persistTerminalMessage(finalAssistant)) return null;
        if (!isGenerationCurrent(controller, params.session.id)) return null;

        const shouldAutoTitle = !params.session.titleMeta || params.session.titleMeta.source === 'auto';
        const hasChoices = projectedChoices !== null;
        if (shouldAutoTitle && !hasErrorNotice && (params.session.title === '新会话' || params.session.title === '未命名会话')) {
          const nextTitle = deriveMagicTeaPartyTitle({
            outputFormat: params.outputFormat,
            content: finalContent,
            segments: isJsonl ? parsed.segments : undefined,
            scenarioTitle: params.session.scenario?.title,
            roleNames: (params.session.roles ?? []).map((r) => r.name),
          });
          const titleFiltered = applyShieldWords(nextTitle).filteredText;

          const nextSession: MagicTeaPartySession = {
            ...params.session,
            title: titleFiltered,
            ...(hasChoices ? { lastChoices: projectedChoices ?? undefined } : {}),
            titleMeta: {
              source: 'auto',
              generatedAt: Date.now(),
              providerId: userProviderConfig?.providerId,
              modelId: userProviderConfig?.modelId,
              reason: 'first-message',
            },
          };
          await persistSession(nextSession, { preserveSummary: true });
          if (!isGenerationCurrent(controller, params.session.id)) return null;
          finalSession = nextSession;
        } else {
          const nextSession: MagicTeaPartySession = {
            ...params.session,
            ...(hasChoices ? { lastChoices: projectedChoices ?? undefined } : {}),
            updatedAt: Date.now(),
          };
          await persistSession(nextSession, { preserveSummary: true });
          if (!isGenerationCurrent(controller, params.session.id)) return null;
          finalSession = nextSession;
        }

        if (!hasErrorNotice && status !== 'blocked') {
          const summary = isJsonl ? sideChannelBundle.summary ?? null : null;
          const updates = isJsonl ? sideChannelBundle.updates ?? null : null;
          const updatesMeta = isJsonl ? sideChannelBundle.updatesMeta ?? null : null;
          let summaryAccepted = false;
          if (onSideChannels && isJsonl && (summary || updates)) {
            summaryAccepted = (await onSideChannels({
              summary,
              updates,
              updatesMeta,
              outputFormat: params.outputFormat,
              sourceMessageId: params.assistantMessageId,
              signal: controller.signal, isCurrent: () => isGenerationCurrent(controller, params.session.id),
            })) === true;
          }
          if (!isGenerationCurrent(controller, params.session.id)) return null;
          const summaryFallbackAttempted = await requestOutputPlanFallbacks({
            session: params.session,
            outputFormat: params.outputFormat,
            historyForRequest: params.historyForRequest,
            assistantMessageId: params.assistantMessageId,
            assistantContent: finalContent,
            summary,
            updates,
            signal: controller.signal, isCurrent: () => isGenerationCurrent(controller, params.session.id),
          });
          if (!isGenerationCurrent(controller, params.session.id)) return null;
          completedAssistant = finalAssistant;
          autoSummaryEligible = summaryIntentRef.current === summaryIntentAtStart
            && completionEvidenceCount === 1 && normalStopEvidence && status === 'done'
            && Boolean(finalContent.trim()) && !summaryAccepted && !summaryFallbackAttempted;
        }
      } catch (error) {
        previewOpen = false;
        safety.clearTimer();
        if (terminalOutputReady) {
          if (ownsCurrentSession()) {
            const detail = error instanceof Error ? error.message : '本地处理失败';
            onGlobalError?.(`生成已结束，但保存或后续处理未完成：${detail}。内容仍保留在当前窗口。`);
          }
          return null;
        }
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          const { safeText, status, blockedAt, truncatedAt } = await safety.finalizeAfterAbort(controller.signal.reason);
          const isJsonl = params.outputFormat === 'jsonl';
          const completion = status === 'blocked' ? 'blocked' : 'stopped';
          const projectedChoices = isJsonl ? projectMagicTeaPartyChoices({ rawText: safeText, completion }).lastChoices : null;
          const parsed = isJsonl
            ? parseMagicTeaPartyJsonl(safeText)
            : { segments: undefined, choices: null, notices: [], summary: null, updates: null, updatesMeta: null };
          const sideChannelBundle = isJsonl
            ? extractMagicTeaPartySideChannelsFromJsonl(safeText)
            : { cleanedText: safeText, notices: [], summary: null, updates: null, updatesMeta: null };
          const noticeBundle = isJsonl ? sideChannelBundle : extractMagicTeaPartyNoticesFromMarkdown(safeText);
          const promptSettings = resolvePromptSettings(params.session, params.outputFormat);
          const extraNotices = isJsonl
            ? buildChoiceNotices({
                choices: parsed.choices ?? undefined,
                expectedCount: promptSettings.enableChoices ? promptSettings.choiceCount : undefined,
                enableChoices: promptSettings.enableChoices,
                stage: String(params.assistantMessage.meta?.kind ?? 'narration'),
              })
            : [];
          const allNotices = [...noticeBundle.notices, ...extraNotices];
          if (ownsCurrentSession()) emitNotices(allNotices);

          const hasErrorNotice = allNotices.some((notice) => notice.level === 'error');
          const previewText = isJsonl ? buildMagicTeaPartyJsonlPreview(safeText) : (noticeBundle.cleanedText ?? safeText);
          const finalContent = previewText;
          const finalAssistant: MagicTeaPartyMessage = mergeAssistantAiMeta({
            ...params.assistantMessage,
            content: finalContent,
            status,
            ...(isJsonl && parsed.segments ? { segments: parsed.segments, choices: projectedChoices ?? [] } : {}),
            meta: { ...params.assistantMessage.meta, rawOutput: safeText, completion, choicesValid: projectedChoices !== null, notices: allNotices },
            ...(status === 'blocked'
              ? { safety: { status: 'blocked', blockedBy: 'output', blockedAt: blockedAt ?? Date.now(), action: 'soft-block' } }
              : { safety: { status: 'ok' } }),
            ...(status === 'blocked' && typeof truncatedAt === 'number' ? { truncatedAt } : {}),
          }, {
            reasoning: latestReasoning,
            usage: latestUsage,
            aiModel: latestAiModel,
          });
          setMessages((prev) => prev.map((m) => (m.id === params.assistantMessageId ? finalAssistant : m)));
          await persistTerminalMessage(finalAssistant);
          if (onSideChannels && isJsonl && !hasErrorNotice && status !== 'blocked' && isGenerationCurrent(controller, params.session.id)) {
            const summary = sideChannelBundle.summary ?? null;
            const updates = sideChannelBundle.updates ?? null;
            const updatesMeta = sideChannelBundle.updatesMeta ?? null;
            if (summary || updates) {
              await onSideChannels({
                summary,
                updates,
                updatesMeta,
                outputFormat: params.outputFormat,
                sourceMessageId: params.assistantMessageId,
              signal: controller.signal, isCurrent: () => isGenerationCurrent(controller, params.session.id),
              });
            }
          }
          return null;
        }

        const message = error instanceof Error ? error.message : '生成失败';
        const failedOutput = await safety.finalizeAfterAbort(controller.signal.reason);
        const completion = failedOutput.status === 'blocked' ? 'blocked' : 'failed';
        const projection = projectMagicTeaPartyChoices({ rawText: failedOutput.safeText, completion });
        const isJsonl = params.outputFormat === 'jsonl';
        const markdown = isJsonl ? null : extractMagicTeaPartyNoticesFromMarkdown(failedOutput.safeText);
        const errorRecord: MagicTeaPartyMessage = mergeAssistantAiMeta({
          ...params.assistantMessage,
          content: isJsonl ? projection.content : markdown?.cleanedText ?? failedOutput.safeText,
          status: failedOutput.status === 'blocked' ? 'blocked' : 'error',
          error: { code: 'exception', message },
          ...(isJsonl ? { segments: projection.segments, choices: [] } : {}),
          meta: { ...params.assistantMessage.meta, rawOutput: failedOutput.safeText, completion, choicesValid: false,
            notices: isJsonl ? projection.notices : markdown?.notices ?? [] },
          ...(failedOutput.status === 'blocked'
            ? { safety: { status: 'blocked', blockedBy: 'output', blockedAt: failedOutput.blockedAt ?? Date.now(), action: 'soft-block' } }
            : { safety: { status: 'ok' } }),
          ...(typeof failedOutput.truncatedAt === 'number' ? { truncatedAt: failedOutput.truncatedAt } : {}),
        }, { reasoning: latestReasoning, usage: latestUsage, aiModel: latestAiModel });
        setMessages((prev) => prev.map((m) => (m.id === params.assistantMessageId ? errorRecord : m)));
        await persistTerminalMessage(errorRecord);
      } finally {
        previewOpen = false;
        safety.clearTimer();
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        if (generationEntryRef.current === controller) setIsGenerating(false);
      }
      return finalSession && completedAssistant ? { session: finalSession, assistant: completedAssistant, autoSummaryEligible } : null;
    },
    [
      assertGenerationActive,
      buildChoiceNotices,
      buildRequestSettings,
      emitNotices,
      generationApiIntentLatch,
      isGenerationCurrent,
      onGlobalError,
      onSideChannels,
      persistSession,
      requestOutputPlanFallbacks,
      resolvePromptSettings,
      router,
      setMessages,
      userProviderConfig,
    ]
  );

  const cancelPendingSummary = useCallback(() => {
    summaryIntentRef.current += 1;
    summarizeAbortControllerRef.current?.abort('new-intent');
    if (autoSummaryRunningRef.current) {
      autoSummaryRunningRef.current = false;
      summarizeAbortControllerRef.current = null;
      setIsSummarizing(false);
    }
  }, []);

  const maybeAutoSummarize = useCallback(async (session: MagicTeaPartySession, sourceMessages: MagicTeaPartyMessage[]) => {
    if (activeSessionEpochRef.current !== activeSessionEpoch || providerEpochRef.current !== providerEpoch
      || activeSessionIdRef.current !== session.id || session.settings.autoSummaryEnabled !== true
      || autoSummaryRunningRef.current || summarizeAbortControllerRef.current || !userProviderConfig
      || !ensureProviderReady().ok) return;
    const providerId = userProviderConfig.providerId;
    const userDisplayName = session.settings.userDisplayName || preferences.userDisplayName || '旅人';
    const history = buildMagicTeaPartyHistory(sourceMessages, { includeEmptyContent: false });
    const scan = history.reduce((current, message) => appendMagicTeaPartyAutoSummaryMessage(current, message, {
      providerId, userDisplayName, summaryThroughMessageId: session.summaryMeta?.toMessageId,
      lastAttemptedThroughMessageId: session.autoSummaryState?.lastAttemptedThroughMessageId,
    }), createMagicTeaPartyAutoSummaryScan());
    const plan = planMagicTeaPartyAutoSummary({ settings: session.settings, providerId, scan,
      consecutiveDroppedTurns: dropTrackerRef.current[session.id]?.consecutive ?? 0 });
    if (!plan) return;
    const budget = resolveMagicTeaPartyAutoSummaryBudget({ settings: session.settings, providerId,
      previousSummary: session.summary, maxOutputTokens: userProviderConfig.generationOverrides?.maxOutputTokens });
    const selected = trimMagicTeaPartyHistory(history, { maxMessages: budget.maxMessages,
      tokenBudget: budget.historyBudgetTokens, providerId, userDisplayName, minKeep: 2 });
    const projection = projectMagicTeaPartyAutoSummaryInput({ messages: selected, sourceMessageCount: history.length,
      contextWindowTokens: budget.contextWindowTokens, language: session.settings.language ?? preferences.language,
      userDisplayName, seedContent: budget.seedContent });
    if (!projection.coverage.selectedMessageIds.length || isMagicTeaPartyTotalOverflow(
      projection.requestMessages.reduce((sum, message) => sum + message.content.length, 0))) return;

    const controller = new AbortController();
    const intent = summaryIntentRef.current;
    summarizeAbortControllerRef.current = controller;
    autoSummaryRunningRef.current = true;
    setIsSummarizing(true);
    setSummaryError(null);
    const isCurrent = () => mountedRef.current && !controller.signal.aborted
      && summarizeAbortControllerRef.current === controller && summaryIntentRef.current === intent
      && activeSessionEpochRef.current === activeSessionEpoch && activeSessionIdRef.current === session.id
      && providerEpochRef.current === providerEpoch && activeSessionRef.current?.settings.autoSummaryEnabled === true;
    const assertCurrent = () => { if (!isCurrent()) controller.abort('superseded'); controller.signal.throwIfAborted(); };
    let frozen = captureMagicTeaPartySummarySnapshot(session);
    try {
      const headers = await buildMagicTeaPartyRequestHeaders();
      assertCurrent();
      const claimed = await compareAndPatchMagicTeaPartySummary({ sessionId: session.id,
        expectedSnapshot: captureMagicTeaPartySummarySnapshot(session),
        patch: { autoSummaryState: { lastAttemptedThroughMessageId: plan.throughMessageId } },
        signal: controller.signal, isCurrent });
      assertCurrent();
      if (!claimed) return;
      onSummaryCommitted?.(claimed);
      frozen = captureMagicTeaPartySummarySnapshot(claimed);
      const response = await fetch('/api/magic-tea-party/summarize', {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ sessionId: session.id, mode: 'summary',
          language: session.settings.language ?? preferences.language, userDisplayName,
          contextWindowTokens: budget.contextWindowTokens, messages: projection.requestMessages,
          customProvider: { ...buildMagicTeaPartyCustomProviderPayload(userProviderConfig), maxOutputTokens: budget.maxOutputTokens },
        }),
      });
      assertCurrent();
      const payload = await response.json().catch(() => null);
      assertCurrent();
      if (!response.ok) throw new Error(formatHttpErrorMessage({
        serverMessage: resolveApiErrorMessage({ payload, fallback: '自动摘要失败' }), status: response.status, fallback: '自动摘要失败' }));
      const raw = typeof payload?.summary === 'string' ? payload.summary.trim() : '';
      const safeText = applyShieldWords(raw).filteredText;
      if (!safeText.trim()) throw new Error('模型返回空摘要。');
      const hasInputCheck = payload?.summaryInput !== undefined;
      if (hasInputCheck && !matchesMagicTeaPartySummaryInput(payload.summaryInput, projection.summaryInput)) {
        throw new Error('服务端摘要输入与本次选择不一致，请重试。');
      }
      const { coverage: _coverage, tokenCount: _tokenCount, ...metadata } = claimed.summaryMeta ?? {};
      const committed = await compareAndPatchMagicTeaPartySummary({ sessionId: session.id, expectedSnapshot: frozen,
        patch: { summary: safeText, summarySections: undefined, summaryMeta: { ...metadata, updatedAt: Date.now(),
          fromMessageId: scan.fromMessageId, toMessageId: scan.toMessageId,
          ...(hasInputCheck ? { coverage: projection.coverage } : {}) } }, signal: controller.signal, isCurrent });
      assertCurrent();
      if (committed) {
        onSummaryCommitted?.(committed);
        dropTrackerRef.current[session.id] = { consecutive: 0, lastRatio: 0 };
      }
    } catch (error) {
      if (isCurrent()) {
        const stored = await getMagicTeaPartySession(session.id).catch(() => null);
        if (isCurrent() && stored && captureMagicTeaPartySummarySnapshot(stored) === frozen) {
          setSummaryError(error instanceof Error ? error.message : '自动摘要失败');
        }
      }
    } finally {
      if (summarizeAbortControllerRef.current === controller) {
        summarizeAbortControllerRef.current = null;
        autoSummaryRunningRef.current = false;
        if (mountedRef.current) setIsSummarizing(false);
      }
    }
  }, [activeSessionEpoch, ensureProviderReady, onSummaryCommitted, preferences.language, preferences.userDisplayName,
    providerEpoch, userProviderConfig]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!activeSession) return false;
      if (isGenerating || generationEntryRef.current) return false;
      cancelPendingSummary();
      const trimmed = text.trim();
      if (!trimmed) return false;

      const providerCheck = ensureProviderReady();
      if (!providerCheck.ok) {
        onGlobalError?.(providerCheck.message);
        return false;
      }

      const controller = new AbortController();
      generationEntryRef.current = controller;
      abortControllerRef.current = controller;
      setIsGenerating(true);
      let preparedAssistant: MagicTeaPartyMessage | null = null;
      try {
        onGlobalError?.(null);

        const redirectTarget = await getSensitiveWordRedirectTarget(trimmed, { reason: '使用危险符文' });
        assertGenerationActive(controller, activeSession.id);
        if (redirectTarget) {
          persistArrestedBackup({
            triggerSource: 'input',
            reason: '使用危险符文',
            origin: '/magic-tea-party',
            items: [
              {
                label: '魔法茶会输入',
                filename: 'magic-tea-party-input.txt',
                mimeType: 'text/plain',
                content: trimmed,
              },
            ],
          });
          await router.push(redirectTarget as any);
          return false;
        }

        const now = Date.now();
        const sessionOutputFormat = (activeSession.settings.outputFormat ?? 'jsonl') as MagicTeaPartyOutputFormat;
        const playerRoleIdAtSend = activeSession.playerRoleId ?? null;
        const userDisplayNameAtSend =
          (activeSession.settings.userDisplayName || preferences.userDisplayName || '旅人').trim() || '旅人';
        const playerRoleNameAtSend = playerRoleIdAtSend
          ? (activeSession.roles ?? []).find((role) => role.id === playerRoleIdAtSend)?.name ?? ''
          : '';
        const userMessage: MagicTeaPartyMessage = {
          id: randomUUID(),
          sessionId: activeSession.id,
          role: 'user',
          content: trimmed,
          createdAt: now,
          status: 'done',
          ...(playerRoleIdAtSend ? { speakerId: playerRoleIdAtSend } : {}),
          meta: { speakerName: playerRoleIdAtSend ? playerRoleNameAtSend || playerRoleIdAtSend : userDisplayNameAtSend },
        };

        const assistantMessageId = randomUUID();
        const assistantMessage: MagicTeaPartyMessage = {
          id: assistantMessageId,
          sessionId: activeSession.id,
          role: 'assistant',
          content: '',
          createdAt: now + 1,
          status: 'streaming',
          sourceMessageId: userMessage.id,
          meta: { kind: 'reply', outputFormat: sessionOutputFormat },
        };

        preparedAssistant = assistantMessage;
        const nextMessages = [...messages, userMessage, assistantMessage];
        setMessages(nextMessages);

        await putMagicTeaPartyMessage(userMessage);
        assertGenerationActive(controller, activeSession.id);
        await putMagicTeaPartyMessage(assistantMessage);
        assertGenerationActive(controller, activeSession.id);

        const updatedSession: MagicTeaPartySession = { ...activeSession, updatedAt: now };
        await persistSession(updatedSession, { preserveSummary: true });
        assertGenerationActive(controller, activeSession.id);

        const { history: historyForRequest, trimStats } = buildHistoryForRequest({
          session: updatedSession,
          messages: [...messages, userMessage],
          outputFormat: sessionOutputFormat,
        });

        const finalSession = await runGenerateStream({
          session: updatedSession,
          controller,
          historyForRequest,
          outputFormat: sessionOutputFormat,
          assistantMessageId,
          assistantMessage,
          arrestedBackupInput: trimmed,
        });
        if (!isGenerationCurrent(controller, activeSession.id)) return false;
        if (finalSession?.autoSummaryEligible) {
          recordDropStats(updatedSession.id, trimStats.droppedRatio);
          void maybeAutoSummarize(finalSession.session, [...messages, userMessage, finalSession.assistant]);
        } else {
          recordDropStats(updatedSession.id, 0);
        }
        return true;
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        if (preparedAssistant) {
          const stopped: MagicTeaPartyMessage = {
            ...preparedAssistant, status: 'error', error: { code: 'cancelled', message: '生成已取消。' },
          };
          if (activeSessionIdRef.current === activeSession.id) {
            setMessages((prev) => prev.map((message) => message.id === stopped.id ? stopped : message));
          }
          await putMagicTeaPartyMessage(stopped);
        }
        return false;
      } finally {
        if (generationEntryRef.current === controller) {
          generationEntryRef.current = null;
          setIsGenerating(false);
        }
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
      }
    },
    [
      activeSession,
      cancelPendingSummary,
      assertGenerationActive,
      buildHistoryForRequest,
      ensureProviderReady,
      isGenerating,
      isGenerationCurrent,
      messages,
      onGlobalError,
      preferences.userDisplayName,
      persistSession,
      router,
      runGenerateStream,
      setMessages,
      maybeAutoSummarize,
      recordDropStats,
    ]
  );

  const continueGeneration = useCallback(async () => {
    if (!activeSession) return;
    if (isGenerating || generationEntryRef.current) return;
    cancelPendingSummary();

    const providerCheck = ensureProviderReady();
    if (!providerCheck.ok) {
      onGlobalError?.(providerCheck.message);
      return;
    }

    const controller = new AbortController();
    generationEntryRef.current = controller;
    abortControllerRef.current = controller;
    setIsGenerating(true);
    let preparedAssistant: MagicTeaPartyMessage | null = null;
    try {
      onGlobalError?.(null);

      const now = Date.now();
      const sessionOutputFormat = (activeSession.settings.outputFormat ?? 'jsonl') as MagicTeaPartyOutputFormat;

      const assistantMessageId = randomUUID();
      const lastUserMessageId = [...messages].reverse().find((message) => message.role === 'user')?.id;
      const kind = messages.length === 0 ? 'opening' : 'continue';

      const assistantMessage: MagicTeaPartyMessage = {
        id: assistantMessageId,
        sessionId: activeSession.id,
        role: 'assistant',
        content: '',
        createdAt: now,
        status: 'streaming',
        ...(lastUserMessageId ? { sourceMessageId: lastUserMessageId } : {}),
        meta: { kind, outputFormat: sessionOutputFormat },
      };

      preparedAssistant = assistantMessage;
      const nextMessages = [...messages, assistantMessage];
      setMessages(nextMessages);
      await putMagicTeaPartyMessage(assistantMessage);
      assertGenerationActive(controller, activeSession.id);

      const updatedSession: MagicTeaPartySession = { ...activeSession, updatedAt: now };
      await persistSession(updatedSession, { preserveSummary: true });
      assertGenerationActive(controller, activeSession.id);

      const { history: baseHistory, trimStats } = buildHistoryForRequest({
        session: updatedSession,
        messages,
        outputFormat: sessionOutputFormat,
      });

      const finalSession = await runGenerateStream({
        session: updatedSession,
        controller,
        historyForRequest: appendMagicTeaPartySystemInstruction(baseHistory, kind, randomUUID()),
        outputFormat: sessionOutputFormat,
        assistantMessageId,
        assistantMessage,
      });
      if (kind === 'continue' && finalSession?.autoSummaryEligible && isGenerationCurrent(controller, activeSession.id)) {
        recordDropStats(updatedSession.id, trimStats.droppedRatio);
        void maybeAutoSummarize(finalSession.session, [...messages, finalSession.assistant]);
      } else {
        recordDropStats(updatedSession.id, 0);
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      if (preparedAssistant) {
        const stopped: MagicTeaPartyMessage = {
          ...preparedAssistant, status: 'error', error: { code: 'cancelled', message: '生成已取消。' },
        };
        if (activeSessionIdRef.current === activeSession.id) {
          setMessages((prev) => prev.map((message) => message.id === stopped.id ? stopped : message));
        }
        await putMagicTeaPartyMessage(stopped);
      }
      return;
    } finally {
      if (generationEntryRef.current === controller) {
        generationEntryRef.current = null;
        setIsGenerating(false);
      }
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
    }
  }, [
    activeSession,
    cancelPendingSummary,
    assertGenerationActive,
    buildHistoryForRequest,
    ensureProviderReady,
    isGenerating,
    isGenerationCurrent,
    messages,
    onGlobalError,
    persistSession,
    runGenerateStream,
    setMessages,
    maybeAutoSummarize,
    recordDropStats,
  ]);

  const generateChoices = useCallback(async () => {
    if (!activeSession || isGenerating || generationEntryRef.current) return;
    cancelPendingSummary();

    const providerCheck = ensureProviderReady();
    if (!providerCheck.ok) {
      onGlobalError?.(providerCheck.message);
      return;
    }

    const controller = new AbortController();
    generationEntryRef.current = controller;
    abortControllerRef.current = controller;
    setIsGenerating(true);
    onGlobalError?.(null);

    const now = Date.now();
    const assistantMessageId = randomUUID();
    const lastUserMessageId = [...messages].reverse().find((message) => message.role === 'user')?.id;
    const assistantMessage: MagicTeaPartyMessage = {
      id: assistantMessageId,
      sessionId: activeSession.id,
      role: 'assistant',
      content: '',
      createdAt: now,
      status: 'streaming',
      ...(lastUserMessageId ? { sourceMessageId: lastUserMessageId } : {}),
      meta: { kind: 'choices', outputFormat: 'jsonl', choicesValid: false, rawOutput: '' },
    };
    const updatedSession: MagicTeaPartySession = { ...activeSession, updatedAt: now };
    let latestReasoning: AIReasoningEnvelope | null = null;
    let latestUsage: Record<string, unknown> | null = null;
    let latestAiModel: string | null = null;
    let previewOpen = true;
    const ownsCurrentSession = () => generationEntryRef.current === controller && activeSessionIdRef.current === activeSession.id;
    const canPreview = () => previewOpen && ownsCurrentSession() && !controller.signal.aborted;

    const preview = createMagicTeaPartyStreamPreview({
      outputFormat: 'jsonl',
      onUpdate: (update) => {
        if (!canPreview()) return;
        setMessages((prev) => !canPreview() ? prev :
          prev.map((m) => {
            if (m.id !== assistantMessageId) return m;
            return {
              ...m,
              content: update.content,
              ...(typeof update.status === 'string' ? { status: update.status } : {}),
              ...(update.includeJsonl ? { segments: update.segments } : {}),
            };
          })
        );
        if (update.notices?.length) emitNotices(update.notices);
      },
    });
    const safety = createMagicTeaPartyStreamSafety({
      outputFormat: 'jsonl',
      onSafePreview: (safeText) => { if (canPreview()) preview.applySafeText(safeText); },
      onBlocked: (safeText) => {
        if (!canPreview()) return;
        preview.applySafeText(safeText, 'blocked');
        controller.abort('output-safety');
      },
    });

    const applyAssistantMetaPatch = () => {
      if (!canPreview()) return;
      setMessages((prev) => !canPreview() ? prev :
        prev.map((message) =>
          message.id === assistantMessageId
            ? mergeAssistantAiMeta(message, { reasoning: latestReasoning, usage: latestUsage, aiModel: latestAiModel })
            : message
        )
      );
    };
    const saveProjection = async (
      result: MagicTeaPartyStreamSafetyResult,
      completion: MagicTeaPartyChoicesCompletion,
      failure?: { code: string; message: string }
    ) => {
      previewOpen = false;
      safety.clearTimer();
      const projection = projectMagicTeaPartyChoices({
        rawText: result.safeText,
        completion: result.status === 'blocked' ? 'blocked' : completion,
      });
      const extraNotices = buildChoiceNotices({
        choices: projection.segments.filter((segment) => segment.type === 'choices').at(-1)?.items,
        expectedCount: activeSession.settings.choiceCount ?? preferences.choiceCount,
        enableChoices: true,
        stage: 'choices',
      });
      const notices = [...projection.notices, ...extraNotices];
      if (ownsCurrentSession()) emitNotices(notices);
      const finalAssistant: MagicTeaPartyMessage = mergeAssistantAiMeta({
        ...assistantMessage,
        content: projection.content,
        segments: projection.segments,
        choices: projection.choices,
        status: projection.status,
        ...(projection.error ? { error: failure && projection.status !== 'blocked' ? failure : projection.error } : {}),
        meta: { ...assistantMessage.meta, rawOutput: result.safeText, completion: result.status === 'blocked' ? 'blocked' : completion, choicesValid: projection.lastChoices !== null, notices },
        ...(projection.status === 'blocked'
          ? { safety: { status: 'blocked', blockedBy: 'output', blockedAt: result.blockedAt ?? Date.now(), action: 'soft-block' } }
          : { safety: { status: 'ok' } }),
        ...(projection.status === 'blocked' && typeof result.truncatedAt === 'number' ? { truncatedAt: result.truncatedAt } : {}),
      }, { reasoning: latestReasoning, usage: latestUsage, aiModel: latestAiModel });
      if (ownsCurrentSession()) {
        setMessages((prev) => prev.map((m) => (m.id === assistantMessageId ? finalAssistant : m)));
      }
      try {
        await putMagicTeaPartyMessage(finalAssistant);
        if (projection.lastChoices && ownsCurrentSession() && !controller.signal.aborted) {
          await persistSession({ ...updatedSession, lastChoices: projection.lastChoices, updatedAt: Date.now() });
        }
      } catch (error) {
        if (ownsCurrentSession()) {
          const message = error instanceof Error ? error.message : '本地存储不可用';
          onGlobalError?.(`选项结果尚未完整保存：${message}。内容仍保留在当前窗口。`);
        }
      }
    };

    try {
      setMessages([...messages, assistantMessage]);
      await putMagicTeaPartyMessage(assistantMessage);
      assertGenerationActive(controller, activeSession.id);
      await persistSession(updatedSession, { preserveSummary: true });
      assertGenerationActive(controller, activeSession.id);
      const { history: historyForRequest } = buildHistoryForRequest({
        session: updatedSession,
        messages,
        outputFormat: 'jsonl',
      });
      assertGenerationActive(controller, activeSession.id);
      const headers = await buildMagicTeaPartyRequestHeaders({ acceptSse: true });
      assertGenerationActive(controller, activeSession.id);
      const generationIntent = generationApiIntentLatch.tryAcquire();
      if (!generationIntent) throw new Error('另一项生成请求仍在处理中。');
      const response = await generationIntent.dispatch('/api/magic-tea-party/generate-choices?format=sse', {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          sessionId: activeSession.id,
          summary: activeSession.summary,
          messages: historyForRequest,
          roles: activeSession.roles ?? [],
          scenario: activeSession.scenario ?? null,
          auxScenarios: activeSession.auxScenarios ?? [],
          protocolShadow: activeSession.protocolShadow,
          playerRoleId: activeSession.playerRoleId ?? null,
          settings: {
            ...buildRequestSettings(activeSession),
            providerId: userProviderConfig?.providerId,
            modelId: userProviderConfig?.modelId,
            choiceCount: activeSession.settings.choiceCount ?? preferences.choiceCount,
            userDisplayName: activeSession.settings.userDisplayName,
          },
          customProvider: buildMagicTeaPartyCustomProviderPayload(userProviderConfig!),
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const shouldRedirect = Boolean(payload?.shouldRedirect);
        const errorMessage = shouldRedirect
          ? (typeof payload?.reason === 'string' ? payload.reason : '使用危险符文')
          : resolveApiErrorMessage({ payload, fallback: `请求失败（${response.status}）` });
        previewOpen = false;
        const failedMessage: MagicTeaPartyMessage = {
          ...assistantMessage,
          status: shouldRedirect ? 'blocked' : 'error',
          ...(shouldRedirect ? { safety: { status: 'blocked', blockedBy: 'server', blockedAt: Date.now(), action: 'redirect' } } : {}),
          error: { code: `${response.status}`, message: errorMessage },
        };
        if (ownsCurrentSession()) {
          setMessages((prev) => prev.map((m) => (m.id === assistantMessageId ? failedMessage : m)));
        }
        await putMagicTeaPartyMessage(failedMessage);
        if (shouldRedirect && ownsCurrentSession() && !controller.signal.aborted) await router.push('/arrested');
        return;
      }

      const { text: streamedText } = await readTextAndReasoningStreamFromResponse(response, {
        label: '魔法茶会选项',
        onText: (accumulated) => {
          safety.ingest(accumulated);
        },
        onReasoning: (reasoning) => {
          latestReasoning = reasoning;
          applyAssistantMetaPatch();
        },
        onTelemetry: (telemetry) => {
          latestUsage = extractUsageFromTelemetry(telemetry);
          latestAiModel = extractAiModelFromTelemetry(telemetry);
          applyAssistantMetaPatch();
        },
      });
      const result = await safety.finalize(streamedText);
      await saveProjection(result, controller.signal.aborted ? 'stopped' : 'completed');
    } catch (error) {
      const stopped = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      const result = await safety.finalizeAfterAbort(controller.signal.reason);
      await saveProjection(result, stopped ? 'stopped' : 'failed', stopped ? undefined : {
        code: 'exception', message: error instanceof Error ? error.message : '生成失败',
      });
    } finally {
      previewOpen = false;
      safety.clearTimer();
      if (generationEntryRef.current === controller) {
        generationEntryRef.current = null;
        setIsGenerating(false);
      }
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
    }
  }, [
    activeSession,
    cancelPendingSummary,
    assertGenerationActive,
    buildChoiceNotices,
    buildHistoryForRequest,
    buildRequestSettings,
    emitNotices,
    ensureProviderReady,
    generationApiIntentLatch,
    isGenerating,
    messages,
    onGlobalError,
    persistSession,
    preferences.choiceCount,
    router,
    setMessages,
    userProviderConfig,
  ]);

  const saveSummary = useCallback(async (patch: MagicTeaPartySummaryPatch) => {
    if (!activeSession || activeSessionIdRef.current !== activeSession.id || activeSessionEpochRef.current !== activeSessionEpoch) return false;
    cancelPendingSummary();
    setSummaryError(null);
    const intent = summaryIntentRef.current;
    const isCurrent = () => mountedRef.current && activeSessionIdRef.current === activeSession.id
      && activeSessionEpochRef.current === activeSessionEpoch && summaryIntentRef.current === intent;
    try {
      const committed = await compareAndPatchMagicTeaPartySummary({ sessionId: activeSession.id,
      expectedSnapshot: captureMagicTeaPartySummarySnapshot(activeSession), patch, isCurrent });
      if (committed && isCurrent()) { onSummaryCommitted?.(committed); return true; }
      if (isCurrent()) setSummaryError('摘要已在其他位置更改，草稿已保留。请重新加载后核对。');
      return false;
    } catch (error) {
      if (isCurrent()) setSummaryError(error instanceof Error ? error.message : '保存摘要失败');
      return false;
    }
  }, [activeSession, activeSessionEpoch, cancelPendingSummary, onSummaryCommitted]);

  const clearSummary = useCallback(async () => {
    const { coverage: _coverage, tokenCount: _tokenCount, fromMessageId: _from, toMessageId: _to,
      ...extensions } = activeSession?.summaryMeta ?? {};
    return await saveSummary({ summary: undefined, summarySections: undefined,
      summaryMeta: Object.keys(extensions).length ? { ...extensions, updatedAt: Date.now() } : undefined });
  }, [activeSession, saveSummary]);

  const generateSummary = useCallback(async () => {
    if (!activeSession || activeSessionIdRef.current !== activeSession.id || activeSessionEpochRef.current !== activeSessionEpoch) return false;
    if (isGenerating || generationEntryRef.current || (summarizeAbortControllerRef.current && !autoSummaryRunningRef.current)) return false;
    cancelPendingSummary();
    const intent = summaryIntentRef.current;
    const frozen = captureMagicTeaPartySummarySnapshot(activeSession);

    const providerCheck = ensureProviderReady();
    if (!providerCheck.ok) {
      onGlobalError?.(providerCheck.message);
      return false;
    }

    if (!userProviderConfig) {
      onGlobalError?.('请先配置模型与 API Key。');
      return false;
    }

    onGlobalError?.(null);
    setSummaryError(null);

    const rawHistoryForSummary = buildMagicTeaPartyHistory(messages, { includeEmptyContent: false });

    if (rawHistoryForSummary.length === 0) {
      setSummaryError('还没有可用于摘要的对话。');
      return false;
    }

    const summaryTokenBudget = resolveMagicTeaPartyTokenBudget(
      activeSession.settings,
      userProviderConfig.providerId
    );
    const trimmedForSummary = trimMagicTeaPartyHistory(rawHistoryForSummary, {
      maxMessages: summaryTokenBudget.maxContextMessages,
      tokenBudget: summaryTokenBudget.historyBudgetTokens,
      providerId: userProviderConfig.providerId,
      userDisplayName:
        activeSession.settings.userDisplayName || preferences.userDisplayName || '旅人',
      minKeep: 2,
    });
    const projection = projectMagicTeaPartySummaryInput({
      messages: trimmedForSummary,
      contextWindowTokens: summaryTokenBudget.contextWindowTokens,
      language: activeSession.settings.language ?? preferences.language,
      userDisplayName: activeSession.settings.userDisplayName || preferences.userDisplayName || '旅人',
      sourceMessageCount: rawHistoryForSummary.length,
    });
    const historyForRequest = projection.requestMessages;

    if (historyForRequest.length === 0) {
      setSummaryError('还没有可用于摘要的对话。');
      return false;
    }

    const requestChars = historyForRequest.reduce((total, message) => total + message.content.length, 0);
    if (isMagicTeaPartyTotalOverflow(requestChars)) {
      setSummaryError(formatMagicTeaPartyTotalOverflowMessage(requestChars));
      return false;
    }

    const controller = new AbortController();
    generationEntryRef.current = controller;
    abortControllerRef.current = controller;
    summarizeAbortControllerRef.current = controller;
    setIsGenerating(true);
    setIsSummarizing(true);
    const assertSummaryActive = () => {
      if (!mountedRef.current || activeSessionEpochRef.current !== activeSessionEpoch
        || providerEpochRef.current !== providerEpoch || summaryIntentRef.current !== intent) controller.abort('superseded');
      assertGenerationActive(controller, activeSession.id);
    };

    try {
      const headers = await buildMagicTeaPartyRequestHeaders();
      assertSummaryActive();
      const response = await fetch('/api/magic-tea-party/summarize', {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          sessionId: activeSession.id,
          mode: 'summary',
          language: activeSession.settings.language ?? preferences.language,
          userDisplayName: activeSession.settings.userDisplayName || preferences.userDisplayName || '旅人',
          contextWindowTokens: summaryTokenBudget.contextWindowTokens,
          messages: historyForRequest,
          customProvider: buildMagicTeaPartyCustomProviderPayload(userProviderConfig),
        }),
      });

      assertSummaryActive();
      const payload = await response.json().catch(() => null);
      assertSummaryActive();

      if (!response.ok) {
        const shouldRedirect = Boolean(payload?.shouldRedirect);
        const reason = typeof payload?.reason === 'string' ? payload.reason : '';
        const serverMessage = resolveApiErrorMessage({ payload, fallback: '摘要生成失败' });
        const errorMessage = formatHttpErrorMessage({ serverMessage, status: response.status, fallback: '摘要生成失败' });
        throw new Error((shouldRedirect ? reason : errorMessage) || errorMessage);
      }

      const summaryRaw = typeof payload?.summary === 'string' ? payload.summary.trim() : '';
      if (!summaryRaw) {
        throw new Error('模型返回空摘要。');
      }

      const hasInputCheck = payload?.summaryInput !== undefined;
      if (hasInputCheck && !matchesMagicTeaPartySummaryInput(payload.summaryInput, projection.summaryInput)) {
        throw new Error('服务端摘要输入与本次选择不一致，请重试。');
      }

      const now = Date.now();
      const safeText = applyShieldWords(summaryRaw).filteredText;
      if (!safeText.trim()) {
        throw new Error('模型返回空摘要。');
      }
      const summaryMeta: MagicTeaPartySession['summaryMeta'] = {
        ...activeSession.summaryMeta,
        updatedAt: now,
        fromMessageId: rawHistoryForSummary[0]?.id,
        toMessageId: rawHistoryForSummary[rawHistoryForSummary.length - 1]?.id,
      };
      delete summaryMeta.tokenCount;
      delete summaryMeta.coverage;
      if (hasInputCheck) summaryMeta.coverage = projection.coverage;

      const nextSession: MagicTeaPartySession = {
        ...activeSession,
        summary: safeText,
        summarySections: undefined,
        summaryMeta,
        updatedAt: now,
      };
      assertSummaryActive();
      const committed = await compareAndPatchMagicTeaPartySummary({ sessionId: activeSession.id, expectedSnapshot: frozen,
        patch: { summary: nextSession.summary, summarySections: undefined, summaryMeta }, signal: controller.signal,
        isCurrent: () => mountedRef.current && activeSessionEpochRef.current === activeSessionEpoch
          && providerEpochRef.current === providerEpoch && summaryIntentRef.current === intent
          && isGenerationCurrent(controller, activeSession.id) });
      assertSummaryActive();
      if (committed) onSummaryCommitted?.(committed);
      return Boolean(committed);
    } catch (error) {
      if (!mountedRef.current || providerEpochRef.current !== providerEpoch || summaryIntentRef.current !== intent
        || activeSessionEpochRef.current !== activeSessionEpoch || !isGenerationCurrent(controller, activeSession.id)
        || (error instanceof Error && error.name === 'AbortError')) return false;
      const message = error instanceof Error ? error.message : '生成摘要失败';
      const stored = await getMagicTeaPartySession(activeSession.id).catch(() => null);
      if (mountedRef.current && providerEpochRef.current === providerEpoch && summaryIntentRef.current === intent
        && activeSessionEpochRef.current === activeSessionEpoch && isGenerationCurrent(controller, activeSession.id)
        && stored && captureMagicTeaPartySummarySnapshot(stored) === frozen) setSummaryError(message);
      return false;
    } finally {
      if (summarizeAbortControllerRef.current === controller) {
        summarizeAbortControllerRef.current = null;
        if (activeSessionEpochRef.current === activeSessionEpoch && activeSessionIdRef.current === activeSession.id) setIsSummarizing(false);
      }
      if (generationEntryRef.current === controller) {
        generationEntryRef.current = null;
        if (activeSessionEpochRef.current === activeSessionEpoch && activeSessionIdRef.current === activeSession.id) setIsGenerating(false);
      }
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
    }
  }, [
    activeSession,
    activeSessionEpoch,
    assertGenerationActive,
    cancelPendingSummary,
    onSummaryCommitted,
    providerEpoch,
    ensureProviderReady,
    isGenerationCurrent,
    isGenerating,
    messages,
    onGlobalError,
    preferences.language,
    preferences.userDisplayName,
    userProviderConfig,
  ]);

  const regenerateMessage = useCallback(
    async (targetMessage: MagicTeaPartyMessage) => {
      if (!activeSession) return;
      if (isGenerating || generationEntryRef.current) return;
      cancelPendingSummary();
      if (targetMessage.role !== 'assistant') return;

      const providerCheck = ensureProviderReady();
      if (!providerCheck.ok) {
        onGlobalError?.(providerCheck.message);
        return;
      }

      onGlobalError?.(null);

      const meta = targetMessage.meta && typeof targetMessage.meta === 'object' ? (targetMessage.meta as Record<string, unknown>) : null;
      const kindRaw = typeof meta?.kind === 'string' ? String(meta.kind) : 'reply';
      if (kindRaw === 'choices') {
        onGlobalError?.('选项消息请使用“生成选项”重新获取。');
        return;
      }
      const kind = kindRaw === 'opening' || kindRaw === 'continue' ? kindRaw : 'reply';

      const targetIndex = messages.findIndex((message) => message.id === targetMessage.id);
      if (targetIndex < 0) return;

      const historyBefore = messages.slice(0, targetIndex);
      const sessionOutputFormat = (activeSession.settings.outputFormat ?? 'jsonl') as MagicTeaPartyOutputFormat;
      const { history: historyForRequestBase } = buildHistoryForRequest({
        session: activeSession,
        messages: historyBefore,
        outputFormat: sessionOutputFormat,
      });

      let arrestedBackupInput: string | undefined;
      let sourceMessageId: string | undefined;
      const lastUserMessage = [...historyBefore].reverse().find((message) => message.role === 'user' && message.content.trim());

      if (kind === 'reply') {
        const sourceMessage =
          (targetMessage.sourceMessageId
            ? historyBefore.find((message) => message.id === targetMessage.sourceMessageId && message.role === 'user')
            : null) || lastUserMessage;
        if (!sourceMessage || !sourceMessage.content?.trim()) {
          onGlobalError?.('找不到关联的用户输入，无法重新生成。');
          return;
        }
        sourceMessageId = sourceMessage.id;
        arrestedBackupInput = sourceMessage.content;
      } else if (lastUserMessage) {
        sourceMessageId = lastUserMessage.id;
      }

      const controller = new AbortController();
      generationEntryRef.current = controller;
      abortControllerRef.current = controller;
      setIsGenerating(true);
      let preparedAssistant: MagicTeaPartyMessage | null = null;
      let retiringTarget = false;
      try {
        const now = Date.now();
        const supersededMessage: MagicTeaPartyMessage = {
          ...targetMessage,
          meta: { ...(targetMessage.meta ?? {}), superseded: true },
        };
        retiringTarget = true;
        setMessages((prev) => prev.map((message) => (message.id === targetMessage.id ? supersededMessage : message)));
        await putMagicTeaPartyMessage(supersededMessage);
        assertGenerationActive(controller, activeSession.id);

        const assistantMessageId = randomUUID();
        const replacementMeta = { ...(targetMessage.meta ?? {}) };
        for (const key of ['rawOutput', 'completion', 'choicesValid', 'notices']) delete replacementMeta[key];
        const assistantMessage: MagicTeaPartyMessage = {
          id: assistantMessageId,
          sessionId: activeSession.id,
          role: 'assistant',
          content: '',
          createdAt: now,
          status: 'streaming',
          ...(sourceMessageId ? { sourceMessageId } : {}),
          revisionOf: targetMessage.id,
          meta: { ...replacementMeta, kind, outputFormat: sessionOutputFormat },
        };

        preparedAssistant = assistantMessage;
        setMessages((prev) => [...prev, assistantMessage]);
        await putMagicTeaPartyMessage(assistantMessage);
        assertGenerationActive(controller, activeSession.id);

        const updatedSession: MagicTeaPartySession = { ...activeSession, updatedAt: now };
        await persistSession(updatedSession, { preserveSummary: true });
        assertGenerationActive(controller, activeSession.id);

        const historyForRequest: MagicTeaPartyHistoryMessage[] =
          kind === 'opening' || kind === 'continue'
            ? appendMagicTeaPartySystemInstruction(historyForRequestBase, kind, randomUUID())
            : historyForRequestBase;

        await runGenerateStream({
          session: updatedSession,
          controller,
          historyForRequest,
          outputFormat: sessionOutputFormat,
          assistantMessageId,
          assistantMessage,
          arrestedBackupInput,
        });

      } catch (error) {
        if (!controller.signal.aborted) throw error;
        if (retiringTarget && !preparedAssistant) {
          try {
            await putMagicTeaPartyMessage(targetMessage);
          } catch (restoreError) {
            if (activeSessionIdRef.current === activeSession.id) {
              onGlobalError?.('生成已取消，但旧回答恢复失败；请先重新读取会话确认原记录。');
            }
            throw restoreError;
          }
          if (activeSessionIdRef.current === activeSession.id) {
            setMessages((prev) => prev.map((message) => message.id === targetMessage.id ? targetMessage : message));
          }
        }
        if (preparedAssistant) {
          const stopped: MagicTeaPartyMessage = {
            ...preparedAssistant, status: 'error', error: { code: 'cancelled', message: '生成已取消。' },
          };
          if (activeSessionIdRef.current === activeSession.id) {
            setMessages((prev) => prev.map((message) => message.id === stopped.id ? stopped : message));
          }
          await putMagicTeaPartyMessage(stopped);
        }
        return;
      } finally {
        if (generationEntryRef.current === controller) {
          generationEntryRef.current = null;
          setIsGenerating(false);
        }
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
      }
    },
    [
      activeSession,
      cancelPendingSummary,
      assertGenerationActive,
      buildHistoryForRequest,
      ensureProviderReady,
      isGenerating,
      messages,
      onGlobalError,
      persistSession,
      runGenerateStream,
      setMessages,
    ]
  );

  const deleteMessage = useCallback(
    async (targetMessage: MagicTeaPartyMessage) => {
      if (!activeSession) return;
      if (targetMessage.status === 'streaming') return;
      cancelPendingSummary();
      const nextMessages = messagesRef.current.filter((message) => message.id !== targetMessage.id);
      setMessages(nextMessages);
      await deleteMagicTeaPartyMessages([targetMessage.id]);
      const now = Date.now();
      await persistSession({ ...activeSession, updatedAt: now }, { preserveSummary: true });
    },
    [activeSession, cancelPendingSummary, persistSession, setMessages]
  );

  /**
   * 就地把一条超长消息压缩到当前单条预算内（保留头尾、显式标记省略中段）。
   * 这是超长消息的非破坏性逃生口：不必删除，也不必创建会话分支。
   */
  const compactMessageContent = useCallback(
    async (targetMessage: MagicTeaPartyMessage) => {
      if (!activeSession) return;
      if (targetMessage.status === 'streaming') return;
      cancelPendingSummary();
      const tokenBudget = resolveMagicTeaPartyTokenBudget(
        activeSession.settings,
        userProviderConfig?.providerId ?? activeSession.settings.providerId
      );
      const limit = resolveMagicTeaPartyMessageCharLimit(tokenBudget.contextWindowTokens);
      const clipped = clipMagicTeaPartyMessageContent(targetMessage.content ?? '', limit);
      if (!clipped.clipped) return;

      const nextMessage: MagicTeaPartyMessage = { ...targetMessage, content: clipped.text };
      setMessages((prev) => prev.map((message) => (message.id === targetMessage.id ? nextMessage : message)));
      await putMagicTeaPartyMessage(nextMessage);
      const now = Date.now();
      await persistSession({ ...activeSession, updatedAt: now }, { preserveSummary: true });
    },
    [activeSession, cancelPendingSummary, persistSession, setMessages, userProviderConfig?.providerId]
  );

  /** 单条消息是否超出当前预算——供 UI 决定是否显示「精简」入口。 */
  const getMessageCharLimit = useCallback((): number => {
    const tokenBudget = resolveMagicTeaPartyTokenBudget(
      activeSession?.settings ?? null,
      userProviderConfig?.providerId
    );
    return resolveMagicTeaPartyMessageCharLimit(tokenBudget.contextWindowTokens);
  }, [activeSession?.settings, userProviderConfig?.providerId]);

  return {
    isGenerating,
    isSummarizing,
    summaryError,
    stopGenerating,
    sendMessage,
    continueGeneration,
    generateChoices,
    regenerateMessage,
    deleteMessage,
    compactMessageContent,
    getMessageCharLimit,
    generateSummary,
    clearSummary,
    saveSummary,
    cancelSummary: cancelPendingSummary,
  };
}
