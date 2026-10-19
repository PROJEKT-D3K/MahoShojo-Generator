import { saveImportedUnsignedCard } from '@mahoshojo/local-library/imported-unsigned-card';
import { getLocalCardRepository } from '@/lib/local-library/card-repository';
import { TavernCloudSaveControls, TavernConversionControls, describeTavernGenerationMode, TavernTemplateSelector, TAVERN_WEB_IMPORT_TEMPLATES, getTavernProjectionTitle, getTavernProjectionCardType, TavernPlaceholderFields, useTavernPlaceholderPreference, TavernFileInput, TavernCandidateSelector, TavernOriginalExport, TavernLocalProjection, TavernLocalSources, useTavernSourceSelection, readTavernFile, type TavernInputFile, type TavernProjection } from '@mahoshojo/ui-web/tavern';
import { applyTavernPlaceholderReplacement, resolveTavernCharReplacement, buildGeneralMarkdown, buildTavernGeneralScenarioCard, buildTavernCanshouCard, buildTavernMagicalGirlCard, projectTavernStreamMarkdown } from '@mahoshojo/domain/tavern-card';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { useGeneratedResultAutoScroll } from '@mahoshojo/ui-web/details-controls';

import AiProviderSelector, { type UserAIProviderConfig } from '@/components/AiProviderSelector';
import AiReasoningPanel from '@/components/ai/AiReasoningPanel';
import CanshouCard from '@/components/CanshouCard';
import { ErrorMessage } from '@/components/ErrorMessage';
import GeneralCharacterCard from '@/components/GeneralCharacterCard';
import GeneralScenarioCard from '@/components/GeneralScenarioCard';
import MagicalGirlCard from '@/components/MagicalGirlCard';
import { MAGICAL_GIRL_CARD_GRADIENT } from '@mahoshojo/ui-web/character-card';
import SaveToCloudButton from '@/components/SaveToCloudButton';
import TachieGenerator from '@/components/TachieGenerator';
import type { GenerationMode } from '@/components/shared/GenerationModeSwitcher';
import { ImagePreviewModal } from '@/components/shared/ImagePreviewModal';
import { JsonSizeIndicator } from '@/components/shared/JsonSizeIndicator';
import { StreamStopButton } from '@/components/shared/StreamStopButton';
import { OFFICIAL_KEY_MAX_AI_COOLDOWN_MS, USER_PROVIDED_KEY_COOLDOWN_MS } from '@/lib/ai/cooldowns';
import { buildCustomProviderRequestPayload, isUsingUserProvidedKey } from '@/lib/ai/custom-provider';
import { authStorage } from '@/lib/auth';
import { buildSafeFileName } from '@/lib/client/fileName';
import { readJsonOrTextFromResponse, resolveApiErrorMessage } from '@/lib/client/apiError';
import { AI_META_REQUEST_HEADER, AI_META_REQUEST_VALUE, readJsonWithAiMeta } from '@/lib/client/read-json-with-ai-meta';
import { formatHttpErrorMessage } from '@/lib/client/httpError';
import { downloadBlob } from '@/lib/client/blobUrl';
import { useCooldown } from '@/lib/cooldown';
import { createBlankDataCard, type DataCardTemplate } from '@/lib/data-card-converter';
import { formatKilobytes, MAX_DATA_CARD_BYTES } from '@/lib/data-card-size';
import { STREAM_ABORT_REASON_USER } from '@/lib/stream/abort';
import { readSafeTextAndReasoningStreamFromResponse } from '@/lib/stream/read-safe-text-and-reasoning-stream';
import { useAppRouterAdapter } from '@/lib/app-router-adapter';
import {
  buildTavernCloudSavePayload,
  buildTavernAiAttachment,
  normalizeTavernCard,
  type TavernCardCandidate,
  type TavernCloudSavePreset,
  type TavernImportMeta,
  type TavernParseResult,
} from '@/lib/tavern-card';
import { buildTavernScenarioFragment } from '@/lib/tavern-card/scenario';
import type { CanshouData, GeneralCharacterData, GeneralScenarioData, MagicalGirlData, ScenarioData } from '@/lib/schemas';
import type { AIReasoningEnvelope } from '@/types/ai-reasoning';
import { useAuth } from '@/lib/useAuth';

import { TavernCardPreview } from './TavernCardPreview';

type ImportStep = 'idle' | 'parsing' | 'parsed' | 'converting' | 'done' | 'error';
type ConvertMode = 'rules' | 'ai';
type ImageSaveMode = 'download' | 'modal';
type JsonSaveMode = 'download' | 'text';
type DeviceType = 'mobile' | 'desktop' | 'unknown';

interface ImportState {
  step: ImportStep;
  error: string | null;
  parseResult: TavernParseResult | null;
  selectedCandidateIndex: number;
  targetTemplate: DataCardTemplate;
  keepRaw: boolean;
  convertMode: ConvertMode;
  outputDataCard: unknown | null;
  outputKey: string | null;
}

type ImportAction =
  | { type: 'reset' }
  | { type: 'parsing' }
  | { type: 'parseError'; message: string }
  | { type: 'setError'; message: string | null }
  | { type: 'parsed'; result: TavernParseResult }
  | { type: 'selectCandidate'; index: number }
  | { type: 'setTemplate'; template: DataCardTemplate }
  | { type: 'setKeepRaw'; value: boolean }
  | { type: 'setConvertMode'; mode: ConvertMode }
  | { type: 'converting' }
  | { type: 'done'; output: unknown; outputKey: string };

const initialState: ImportState = {
  step: 'idle',
  error: null,
  parseResult: null,
  selectedCandidateIndex: 0,
  targetTemplate: 'general',
  keepRaw: false,
  convertMode: 'rules',
  outputDataCard: null,
  outputKey: null,
};

function reducer(state: ImportState, action: ImportAction): ImportState {
  switch (action.type) {
    case 'reset':
      return { ...initialState };
    case 'parsing':
      return { ...state, step: 'parsing', error: null };
    case 'parseError':
      return { ...state, step: state.parseResult ? 'parsed' : 'error', error: action.message };
    case 'setError':
      return { ...state, error: action.message };
    case 'parsed':
      return {
        ...state,
        step: 'parsed',
        error: null,
        parseResult: action.result,
        selectedCandidateIndex: Math.max(0, action.result.candidates.findIndex((c) => c.keyword === action.result.selected.keyword)),
        outputDataCard: null,
        outputKey: null,
      };
    case 'selectCandidate':
      return { ...state, step: 'parsed', selectedCandidateIndex: action.index, outputDataCard: null, outputKey: null };
    case 'setTemplate':
      return { ...state, step: 'parsed', targetTemplate: action.template, outputDataCard: null, outputKey: null };
    case 'setKeepRaw':
      return { ...state, step: 'parsed', keepRaw: action.value, outputDataCard: null, outputKey: null };
    case 'setConvertMode':
      return { ...state, step: 'parsed', convertMode: action.mode, outputDataCard: null, outputKey: null };
    case 'converting':
      return { ...state, step: 'converting', error: null };
    case 'done':
      return { ...state, step: 'done', outputDataCard: action.output, outputKey: action.outputKey };
    default:
      return state;
  }
}

const isRecord = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);

const ensureString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

const normalizeCanshouForCard = (input: unknown): any => {
  const record = isRecord(input) ? input : {};
  return {
    ...record,
    name: ensureString(record.name, ensureString(record.codename, '未命名残兽')),
    coreConcept: ensureString(record.coreConcept),
    coreEmotion: ensureString(record.coreEmotion),
    evolutionStage: ensureString(record.evolutionStage),
    appearance: ensureString(record.appearance),
    materialAndSkin: ensureString(record.materialAndSkin),
    featuresAndAppendages: ensureString(record.featuresAndAppendages),
    attackMethod: ensureString(record.attackMethod),
    specialAbility: ensureString(record.specialAbility),
    origin: ensureString(record.origin),
    birthEnvironment: ensureString(record.birthEnvironment),
    researcherNotes: ensureString(record.researcherNotes),
  };
};

const uniqueStrings = (items: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

const guessTemplate = (result: TavernParseResult): DataCardTemplate => {
  const tags = result.normalized.tags?.join(' ') ?? '';
  const text = `${tags} ${result.normalized.description ?? ''} ${result.normalized.personality ?? ''}`.toLowerCase();
  if (/(残兽|怪物|monster|beast|abomination)/i.test(text)) return 'canshou';
  if (/(魔法少女|mahou|magical girl)/i.test(text)) return 'magical-girl';
  return 'general';
};

const buildStructuredScenarioFromTavern = (normalized: TavernParseResult['normalized']): ScenarioData => {
  const base = createBlankDataCard('scenario') as ScenarioData;
  const title = normalized.name?.trim() || base.title || '未命名情景';
  const scenarioText = normalized.scenario?.trim() || '';
  const description = normalized.description?.trim() || scenarioText;
  const scenarioType = normalized.tags && normalized.tags.length > 0 ? normalized.tags[0] : '';

  const eventsParts: string[] = [];
  if (normalized.firstMes?.trim()) {
    eventsParts.push(`【开场白】\n${normalized.firstMes.trim()}`);
  }
  if (normalized.mesExample?.trim()) {
    eventsParts.push(`【对话样例】\n${normalized.mesExample.trim()}`);
  }

  const events = eventsParts.length > 0 ? eventsParts.join('\n\n') : scenarioText;
  const atmosphere = normalized.personality?.trim() || '';
  const sceneFeatures = scenarioText && scenarioText !== description ? scenarioText : '';

  return {
    ...base,
    title,
    scenario_type: scenarioType,
    description,
    elements: {
      ...base.elements,
      scene: {
        ...(base.elements?.scene ?? {}),
        features: sceneFeatures,
      },
      roles: base.elements?.roles ?? [],
      events: events,
      atmosphere: atmosphere,
      development: base.elements?.development ?? [],
    },
  };
};

const buildTavernMeta = (parseResult: TavernParseResult, candidate: TavernCardCandidate): TavernImportMeta => {
  const normalized = normalizeTavernCard(candidate).normalized;
  const selectionWarnings = normalizeTavernCard(candidate).warnings;
  const baseWarnings = parseResult.meta.warnings ?? [];

  const meta: TavernImportMeta = {
    ...parseResult.meta,
    sourceChunk: candidate.keyword,
    spec: normalized.spec,
    specVersion: normalized.specVersion,
    name: normalized.name,
    description: normalized.description,
    personality: normalized.personality,
    scenario: normalized.scenario,
    firstMes: normalized.firstMes,
    mesExample: normalized.mesExample,
    tags: normalized.tags,
    warnings: uniqueStrings([...baseWarnings, ...selectionWarnings]),
  };

  return meta;
};

type TavernAttachment = { meta: TavernImportMeta; raw?: unknown };
type WithTavern<T> = T & { _tavern: TavernAttachment };

export function TavernImportPanel({ onBusyChange }: { onBusyChange?: (busy: boolean) => void } = {}) {
  const router = useAppRouterAdapter();
  const [state, dispatch] = useReducer(reducer, initialState);
  const { user } = useAuth();
  const [cloudPreset, setCloudPreset] = useState<TavernCloudSavePreset>('standard');
  const [userProviderConfig, setUserProviderConfig] = useState<UserAIProviderConfig | null>(null);
  const [generationMode, setGenerationMode] = useState<GenerationMode>('non-stream');
  const [streamingMarkdown, setStreamingMarkdown] = useState<string | null>(null);
  const [streamedGeneralCard, setStreamedGeneralCard] = useState<any | null>(null);
  const [streamingReasoning, setStreamingReasoning] = useState<AIReasoningEnvelope | null>(null);
  const [nonStreamReasoning, setNonStreamReasoning] = useState<AIReasoningEnvelope | null>(null);
  const [streamNotice, setStreamNotice] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const beginResultNavigation = useGeneratedResultAutoScroll(resultRef);
  const resultNavigationRef = useRef<ReturnType<typeof beginResultNavigation> | null>(null);
  const streamAbortControllerRef = useRef<AbortController | null>(null);
  const isUserCustomKey = isUsingUserProvidedKey(userProviderConfig);
  const tavernAiCooldownMs = isUserCustomKey ? USER_PROVIDED_KEY_COOLDOWN_MS : OFFICIAL_KEY_MAX_AI_COOLDOWN_MS;
  const tavernAiCooldownKey = isUserCustomKey ? 'tavernConvertCooldown:custom' : 'tavernConvertCooldown:system';
  const { isCooldown, startCooldown, remainingTime } = useCooldown(tavernAiCooldownKey, tavernAiCooldownMs);

  const [languages, setLanguages] = useState<{ code: string; name: string }[]>([]);
  const [selectedLanguage, setSelectedLanguage] = useState('zh-CN');
  const [showLanguageSection, setShowLanguageSection] = useState(false);

  const [deviceType, setDeviceType] = useState<DeviceType>('unknown');
  const [imageSaveMode, setImageSaveMode] = useState<ImageSaveMode>('download');
  const [jsonSaveMode, setJsonSaveMode] = useState<JsonSaveMode>('download');
  const [showImageModal, setShowImageModal] = useState(false);
  const [savedImageUrl, setSavedImageUrl] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const copyAttempt = useRef(0);
  useEffect(() => () => { copyAttempt.current += 1; }, []);
  const { preference: placeholderPreference, setPreference: setPlaceholderPreference, isHydrated: placeholderHydrated } = useTavernPlaceholderPreference();
  const { enabled: placeholderEnabled, userReplacement, charReplacementMode, customCharReplacement } = placeholderPreference;

  const recommendedImageMode: ImageSaveMode = deviceType === 'mobile' ? 'modal' : 'download';
  const recommendedJsonMode: JsonSaveMode = deviceType === 'mobile' ? 'text' : 'download';
  const preferenceButtonClass = (active: boolean) =>
    `flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition ${
      active ? 'border-pink-300 bg-pink-50 text-pink-700 shadow-sm' : 'border-slate-200 text-slate-600 hover:border-pink-300 hover:text-pink-700'
    }`;

  useEffect(() => {
    fetch('/languages.json')
      .then((res) => res.json())
      .then((data) => setLanguages(Array.isArray(data) ? data : []))
      .catch((error) => {
        console.warn('加载 languages.json 失败（已忽略）', error);
        setLanguages([]);
      });
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const userAgent = navigator.userAgent.toLowerCase();
    const isMobile = /mobile|android|iphone|ipad|ipod|blackberry|iemobile|opera mini/.test(userAgent);
    const detectedType: DeviceType = isMobile ? 'mobile' : 'desktop';
    setDeviceType(detectedType);
    setImageSaveMode(isMobile ? 'modal' : 'download');
    setJsonSaveMode(isMobile ? 'text' : 'download');
  }, []);

  const selectedCandidate = useMemo(() => {
    if (!state.parseResult) return null;
    return state.parseResult.candidates[state.selectedCandidateIndex] ?? state.parseResult.selected;
  }, [state.parseResult, state.selectedCandidateIndex]);

  const selectedNormalized = useMemo(() => {
    if (!selectedCandidate) return null;
    return normalizeTavernCard(selectedCandidate).normalized;
  }, [selectedCandidate]);

  const resolvedCharReplacement = resolveTavernCharReplacement(selectedNormalized?.name, placeholderPreference);
  const replacement = useMemo(() => {
    if (!selectedNormalized) return { normalized: null, error: null };
    try {
      return { normalized: applyTavernPlaceholderReplacement(selectedNormalized, {
        enabled: placeholderEnabled, userReplacement, charReplacement: resolvedCharReplacement,
      }), error: null };
    } catch (error) {
      return { normalized: null, error: error instanceof Error ? error.message : '占位符替换失败，原件仍保留。' };
    }
  }, [selectedNormalized, placeholderEnabled, userReplacement, resolvedCharReplacement]);
  const normalizedForConvert = replacement.normalized;

  const isScenarioTemplate = state.targetTemplate === 'scenario' || state.targetTemplate === 'general-scenario';
  const targetLabel = isScenarioTemplate ? '情景' : '角色';

  const selectionWarnings = useMemo(() => {
    if (!selectedCandidate) return [];
    return normalizeTavernCard(selectedCandidate).warnings;
  }, [selectedCandidate]);

  const aiAttachmentPreview = useMemo(() => {
    if (!normalizedForConvert) return null;
    if (state.convertMode !== 'ai') return null;
    return buildTavernAiAttachment(normalizedForConvert);
  }, [normalizedForConvert, state.convertMode]);

  const combinedWarnings = useMemo(() => {
    if (!state.parseResult) return selectionWarnings;
    return uniqueStrings([...(state.parseResult.meta.warnings ?? []), ...selectionWarnings, ...(aiAttachmentPreview?.warnings ?? [])]);
  }, [state.parseResult, selectionWarnings, aiAttachmentPreview]);

  const defaultCloudCardName = useMemo(() => {
    const fallback = isScenarioTemplate ? '未命名情景' : '未命名角色';
    return (selectedNormalized?.name ?? '').trim() || fallback;
  }, [selectedNormalized?.name, isScenarioTemplate]);

  const defaultCloudCardDescription = useMemo(() => {
    if (!selectedNormalized) return 'SillyTavern 导入';
    const spec = selectedNormalized.spec ? `${selectedNormalized.spec}${selectedNormalized.specVersion ? `@${selectedNormalized.specVersion}` : ''}` : 'unknown';
    return `SillyTavern 导入（${spec}）`;
  }, [selectedNormalized]);

  const handleSaveImage = (imageUrl: string) => {
    setSavedImageUrl(imageUrl);
    setShowImageModal(true);
  };

  const imageSaveButtonLabel = imageSaveMode === 'download' ? '💾 一键保存长图' : '📱 打开长按保存弹窗';

  const resetGeneratedPreview = () => {
    copyAttempt.current += 1;
    resultNavigationRef.current?.cancel();
    setStreamingMarkdown(null);
    setStreamedGeneralCard(null);
    setStreamingReasoning(null);
    setCopyStatus('idle');
  };

  const handleAiProviderConfigChange = useCallback((config: UserAIProviderConfig | null) => {
    copyAttempt.current += 1;
    resultNavigationRef.current?.cancel();
    setUserProviderConfig(config);
    setStreamingMarkdown(null);
    setStreamedGeneralCard(null);
    setStreamingReasoning(null);
    setCopyStatus('idle');
  }, []);

  const streamedGeneralCardForDisplay = useMemo(() => {
    if (state.convertMode !== 'ai') return null;
    if (generationMode !== 'stream') return null;
    const markdown = streamingMarkdown ?? streamedGeneralCard?.content ?? null;
    if (markdown === null) return null;

    const { card } = projectTavernStreamMarkdown({
      template: state.targetTemplate,
      markdown,
      sourceName: (selectedNormalized?.name ?? '').trim(),
    });
    return card;
  }, [state.convertMode, generationMode, streamingMarkdown, streamedGeneralCard, selectedNormalized?.name, state.targetTemplate]);

  const sourceSelection = useTavernSourceSelection();
  const [originalPng, setOriginalPng] = useState<Uint8Array | undefined>();

  const onFileSelected = async (file: TavernInputFile | null) => {
    if (!file) return;
    copyAttempt.current += 1;
    const epoch = sourceSelection.begin();
    resultNavigationRef.current?.cancel();
    dispatch({ type: 'parsing' });
    setStreamingMarkdown(null);
    setStreamedGeneralCard(null);
    setStreamingReasoning(null);
    setCopyStatus('idle');
    setShowImageModal(false);
    setSavedImageUrl(null);

    try {
      const { parsed, basePngBytes } = await readTavernFile(file);
      if (!sourceSelection.isCurrent(epoch)) return;
      setOriginalPng(basePngBytes);


      dispatch({ type: 'parsed', result: parsed });
      dispatch({ type: 'setTemplate', template: guessTemplate(parsed) });
    } catch (error) {
      if (!sourceSelection.isCurrent(epoch)) return;
      dispatch({ type: 'parseError', message: error instanceof Error ? error.message : '解析失败' });
    }
  };

  const buildOutputKey = (): string | null => {
    if (!state.parseResult) return null;
    const parts: string[] = [
      state.parseResult.meta.extractedAt,
      String(state.selectedCandidateIndex),
      state.targetTemplate,
      state.keepRaw ? 'raw' : 'no-raw',
      state.convertMode,
      placeholderEnabled ? 'replace=1' : 'replace=0',
      `user=${userReplacement}`,
      `charMode=${charReplacementMode}`,
      charReplacementMode === 'custom' ? `char=${customCharReplacement}` : `char=${resolvedCharReplacement}`,
    ];

    if (state.convertMode === 'ai') {
      parts.push(generationMode);
      parts.push(selectedLanguage);
      const providerId = userProviderConfig?.providerId ?? 'system';
      const modelId = userProviderConfig?.modelId ?? 'default';
      parts.push(`provider=${providerId}`);
      parts.push(`model=${modelId}`);
    }

    return JSON.stringify(parts);
  };

  const convertToDataCard = async (
    requestController?: AbortController,
    revealGeneratedResult?: ReturnType<typeof beginResultNavigation>,
  ): Promise<unknown> => {
    if (replacement.error) throw new Error(replacement.error);
    if (!state.parseResult || !selectedCandidate || !selectedNormalized || !normalizedForConvert) {
      throw new Error('尚未解析到可用的 SillyTavern 候选块');
    }

    // Starting conversion commits to this source; an older pending library read cannot replace it.
    sourceSelection.begin();
    const meta = buildTavernMeta(state.parseResult, selectedCandidate);
    const tavernPayload: TavernAttachment = state.keepRaw ? { meta, raw: selectedCandidate.parsed } : { meta };

    if (state.convertMode === 'ai') {
      if (userProviderConfig && userProviderConfig.providerId !== 'system' && !userProviderConfig.apiKey?.trim()) {
        throw new Error('⚠️ 已选择自定义 AI 供应商，但尚未填写 API Key。');
      }

      const aiAttachment = aiAttachmentPreview ?? buildTavernAiAttachment(normalizedForConvert);
      const customProviderPayload = buildCustomProviderRequestPayload(userProviderConfig);
      const requestBody: Record<string, unknown> = {
        template: state.targetTemplate,
        sourceName: selectedNormalized.name,
        language: selectedLanguage,
        attachments: [
          {
            name: aiAttachment.attachment.name,
            type: aiAttachment.attachment.type,
            content: aiAttachment.attachment.content,
            ...(aiAttachment.attachment.truncated ? { truncated: true } : {}),
          },
        ],
        ...(customProviderPayload
          ? {
              customProvider: customProviderPayload,
            }
          : {}),
      };

      const activityHeaders = await authStorage.getActivityHeaders();
      if (generationMode === 'stream') {
        setStreamingMarkdown('');
        setStreamedGeneralCard(null);
        setStreamingReasoning(null);
        setNonStreamReasoning(null);
        setStreamNotice(null);
        setCopyStatus('idle');
        const streamController = requestController ?? new AbortController();
        streamAbortControllerRef.current?.abort(STREAM_ABORT_REASON_USER);
        streamAbortControllerRef.current = streamController;

        try {
          const response = await fetch('/api/tavern/convert-stream?format=sse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...activityHeaders },
            body: JSON.stringify(requestBody),
            signal: streamController.signal,
          });

          if (!response.ok) {
            const { payload } = await readJsonOrTextFromResponse(response);
            const errorJson = payload && typeof payload === 'object' ? (payload as any) : null;
            const redirectReason = errorJson?.reason || errorJson?.message || errorJson?.error || resolveApiErrorMessage({ payload, fallback: '' });
            if (errorJson?.shouldRedirect || errorJson?.redirect === '/arrested') {
              void router.push({
                pathname: '/arrested',
                query: { reason: redirectReason || '使用危险符文' },
              });
              throw new Error('已跳转到被捕页面');
            }
            const serverMessage = resolveApiErrorMessage({ payload, fallback: 'AI 转换失败' });
            throw new Error(formatHttpErrorMessage({ serverMessage, status: response.status, fallback: 'AI 转换失败' }));
          }

          const contentType = (response.headers.get('content-type') || '').toLowerCase();
          if (contentType.includes('application/json') || contentType.includes('+json')) {
            const { payload } = await readJsonOrTextFromResponse(response);
            const serverMessage = resolveApiErrorMessage({ payload, fallback: 'AI 转换失败' });
            throw new Error(formatHttpErrorMessage({ serverMessage, status: response.status, fallback: 'AI 转换失败' }));
          }

          const { text: markdown, outputSafetyStatus, wasAborted, abortReason } = await readSafeTextAndReasoningStreamFromResponse(response, {
            abortController: streamController,
            label: '酒馆导入（流式）',
            onText: (text) => {
              setStreamingMarkdown(text);
              if (text.trim()) revealGeneratedResult?.();
            },
            onReasoning: (reasoning) => setStreamingReasoning(reasoning),
            safetyReason: '使用危险符文',
          });

          if (outputSafetyStatus === 'blocked') {
            setStreamNotice('输出触发调查院规则，已自动截断并追加逮捕令。当前内容可能不完整，但可继续保存。');
          } else if (wasAborted) {
            setStreamNotice(
              abortReason === STREAM_ABORT_REASON_USER
                ? '已手动停止生成。当前内容可能不完整，但可继续保存。'
                : '流式生成已中断。当前内容可能不完整，但可继续保存。'
            );
          }

          if (markdown.trim()) revealGeneratedResult?.();
          const { card } = projectTavernStreamMarkdown({
            template: state.targetTemplate,
            markdown,
            sourceName: selectedNormalized.name,
          });

          setStreamedGeneralCard(card);
          startCooldown(tavernAiCooldownMs);
          return { ...card, _tavern: tavernPayload };
        } catch (error) {
          revealGeneratedResult?.cancel();
          throw error;
        } finally {
          streamAbortControllerRef.current = null;
        }
      }

      setNonStreamReasoning(null);
      const response = await fetch('/api/tavern/convert', {
        method: 'POST',
        signal: requestController?.signal,
        headers: {
          'Content-Type': 'application/json',
          [AI_META_REQUEST_HEADER]: AI_META_REQUEST_VALUE,
          ...activityHeaders,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const { payload } = await readJsonOrTextFromResponse(response);
        const errorJson = payload && typeof payload === 'object' ? (payload as any) : null;
        const redirectReason = errorJson?.reason || errorJson?.message || errorJson?.error || resolveApiErrorMessage({ payload, fallback: '' });
        if (errorJson?.shouldRedirect || errorJson?.redirect === '/arrested') {
          void router.push({
            pathname: '/arrested',
            query: { reason: redirectReason || '使用危险符文' },
          });
          throw new Error('已跳转到被捕页面');
        }
        const serverMessage = resolveApiErrorMessage({ payload, fallback: 'AI 转换失败' });
        throw new Error(formatHttpErrorMessage({ serverMessage, status: response.status, fallback: 'AI 转换失败' }));
      }

      const { data: generated, aiMeta } = await readJsonWithAiMeta<unknown>(response);
      const generatedRecord = typeof generated === 'object' && generated !== null ? (generated as Record<string, unknown>) : {};
      setNonStreamReasoning(aiMeta?.aiReasoning ?? null);
      startCooldown(tavernAiCooldownMs);
      return { ...generatedRecord, _tavern: tavernPayload };
    }

    if (state.targetTemplate === 'general-scenario') {
      const output: WithTavern<GeneralScenarioData> = {
        ...buildTavernGeneralScenarioCard(normalizedForConvert),
        _tavern: tavernPayload,
      };
      return output;
    }

    if (state.targetTemplate === 'scenario') {
      const structured = buildStructuredScenarioFromTavern(normalizedForConvert);
      const output: WithTavern<ScenarioData> = {
        ...structured,
        _tavern: tavernPayload,
      };
      return output;
    }

    if (state.targetTemplate === 'general') {
      const base = createBlankDataCard('general') as GeneralCharacterData;
      const output: WithTavern<GeneralCharacterData> = {
        ...base,
        name: normalizedForConvert.name,
        content: buildGeneralMarkdown(normalizedForConvert),
        _tavern: tavernPayload,
      };
      return output;
    }

    if (state.targetTemplate === 'magical-girl') {
      const output: WithTavern<MagicalGirlData> = {
        ...buildTavernMagicalGirlCard(normalizedForConvert),
        _tavern: tavernPayload,
      };
      return output;
    }

    const output: WithTavern<CanshouData> = {
      ...buildTavernCanshouCard(normalizedForConvert),
      _tavern: tavernPayload,
    };
    return output;
  };

  const ensureConverted = async (): Promise<{ output: unknown; outputKey: string } | null> => {
    if (state.step === 'parsing') return null;
    if (replacement.error) throw new Error(replacement.error);
    const outputKey = buildOutputKey();
    if (!outputKey) return null;
    if (state.outputDataCard && state.outputKey === outputKey) {
      return { output: state.outputDataCard, outputKey };
    }

    if (state.convertMode === 'ai' && isCooldown) {
      dispatch({ type: 'setError', message: `操作过于频繁，请等待 ${remainingTime} 秒后再试。` });
      return null;
    }

    const requestController = state.convertMode === 'ai' ? new AbortController() : undefined;
    const revealGeneratedResult = requestController
      ? beginResultNavigation(requestController, requestController.signal)
      : undefined;
    resultNavigationRef.current = revealGeneratedResult ?? null;
    dispatch({ type: 'converting' });
    try {
      const output = await convertToDataCard(requestController, revealGeneratedResult);
      dispatch({ type: 'done', output, outputKey });
      if (generationMode === 'non-stream') revealGeneratedResult?.();
      return { output, outputKey };
    } catch (error) {
      revealGeneratedResult?.cancel();
      throw error;
    }
  };

  const onGenerate = async () => {
    if (!state.parseResult || !selectedCandidate || !selectedNormalized) return;
    try {
      await ensureConverted();
    } catch (error) {
      dispatch({ type: 'parseError', message: error instanceof Error ? error.message : '转换失败' });
    }
  };

  const downloadOutputJson = (data: unknown) => {
    if (!selectedNormalized) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    downloadBlob(blob, buildSafeFileName(selectedNormalized.name, 'json', 'tavern-import'));
  };

  const onDownloadJson = async () => {
    if (!state.parseResult || !selectedCandidate || !selectedNormalized) return;
    setCopyStatus('idle');
    try {
      const result = await ensureConverted();
      if (!result) return;
      downloadOutputJson(result.output);
    } catch (error) {
      dispatch({ type: 'parseError', message: error instanceof Error ? error.message : '下载失败' });
    }
  };

  const onCopyJson = async () => {
    if (state.step === 'parsing' || !state.parseResult || !selectedCandidate || !selectedNormalized) return;
    const attempt = ++copyAttempt.current;
    try {
      const result = await ensureConverted();
      if (!result || attempt !== copyAttempt.current) return;
      if (typeof navigator === 'undefined' || !navigator.clipboard) {
        throw new Error('当前环境不支持剪贴板');
      }
      await navigator.clipboard.writeText(JSON.stringify(result.output, null, 2));
      if (attempt !== copyAttempt.current) return;
      setCopyStatus('success');
      setTimeout(() => { if (attempt === copyAttempt.current) setCopyStatus('idle'); }, 2000);
    } catch (error) {
      if (attempt !== copyAttempt.current) return;
      setCopyStatus('error');
      dispatch({ type: 'parseError', message: error instanceof Error ? error.message : '复制失败' });
    }
  };

  const currentOutputKey = buildOutputKey();
  // Keep the previous result recoverable on read failure, but do not expose any
  // old result actions (including images/cloud) while a new source is parsing.
  const outputDataCard = state.step !== 'parsing' && !replacement.error && currentOutputKey && state.outputKey === currentOutputKey ? state.outputDataCard : null;
  const outputTemplateForPreview: DataCardTemplate =
    state.convertMode === 'ai' && generationMode === 'stream'
      ? (state.targetTemplate === 'scenario' || state.targetTemplate === 'general-scenario' ? 'general-scenario' : 'general')
      : state.targetTemplate;

  const previewDataCard = outputDataCard ?? streamedGeneralCardForDisplay;
  useEffect(() => { onBusyChange?.(state.step === 'parsing' || state.step === 'converting'); return () => onBusyChange?.(false); }, [state.step, onBusyChange]);

  const isPreviewStreaming = state.convertMode === 'ai' && generationMode === 'stream' && state.step === 'converting';

  const scenarioPreview = useMemo(() => {
    if (!previewDataCard) return null;

    if (outputTemplateForPreview === 'general-scenario') {
      const record = isRecord(previewDataCard) ? previewDataCard : {};
      return {
        title: ensureString(record.title, '未命名情景'),
        content: ensureString(record.content),
      };
    }

    if (outputTemplateForPreview === 'scenario') {
      const fragment = buildTavernScenarioFragment(previewDataCard);
      if (fragment) {
        return {
          title: fragment.title,
          content: fragment.content,
        };
      }
      return {
        title: '情景',
        content: JSON.stringify(previewDataCard, null, 2),
      };
    }

    return null;
  }, [previewDataCard, outputTemplateForPreview]);

  const cloudCardType = outputTemplateForPreview === 'scenario' || outputTemplateForPreview === 'general-scenario'
    ? 'scenario'
    : 'character';

  const resolvedCloudAuthor = useMemo(() => {
    if (user && typeof user.id === 'number' && user.username) {
      return { id: user.id, username: user.username };
    }
    return { id: 0, username: '未登录用户' };
  }, [user]);

  const cloudSavePreview = useMemo(() => {
    if (!outputDataCard) return null;
    return buildTavernCloudSavePayload(outputDataCard, resolvedCloudAuthor, cloudPreset, { maxBytes: MAX_DATA_CARD_BYTES });
  }, [outputDataCard, resolvedCloudAuthor, cloudPreset]);

  const getCloudPayload = async () => {
    if (!cloudSavePreview) {
      throw new Error('尚未生成可保存的数据卡');
    }
    if ('error' in cloudSavePreview) {
      throw new Error(cloudSavePreview.error);
    }
    if (cloudSavePreview.overLimit) {
      throw new Error(`数据卡内容过大，最大允许 ${MAX_DATA_CARD_BYTES / 1024}KB，当前预估 ${formatKilobytes(cloudSavePreview.estimatedBytes)}KB`);
    }
    return cloudSavePreview.data;
  };

  const tachiePrompt = useMemo(() => {
    if (!outputDataCard) return '';

    if (outputTemplateForPreview === 'scenario' || outputTemplateForPreview === 'general-scenario') {
      return '';
    }

    if (outputTemplateForPreview === 'magical-girl') {
      const record = isRecord(outputDataCard) ? outputDataCard : {};
      const appearance = isRecord(record.appearance) ? record.appearance : {};
      return `${JSON.stringify(appearance)}, Xiabanmo, 二次元, 魔法少女`;
    }

    if (outputTemplateForPreview === 'canshou') {
      const safe = normalizeCanshouForCard(outputDataCard);
      const parts = [safe.appearance, safe.materialAndSkin, safe.featuresAndAppendages].filter((item) => typeof item === 'string' && item.trim());
      return `${parts.join(', ')}, Xiabanmo, 二次元`;
    }

    const record = isRecord(outputDataCard) ? outputDataCard : {};
    const name = ensureString(record.name).trim();
    const content = ensureString(record.content).trim();
    const head = content.length > 800 ? content.slice(0, 800) : content;
    return `${name ? `${name}, ` : ''}${head}, Xiabanmo, 二次元, 角色立绘`;
  }, [outputDataCard, outputTemplateForPreview]);

  const outputJsonPayload = useMemo(() => {
    if (!outputDataCard) return null;
    try {
      return JSON.stringify(outputDataCard, null, 2);
    } catch {
      return null;
    }
  }, [outputDataCard]);

  return (
    <div className="mt-4">
      <div className="rounded-xl border border-pink-200 bg-white/70 p-4">
        <div className="text-sm text-gray-700">
          本页面默认仅在浏览器本地解析 PNG 元数据，不会上传图片。只有当你选择 AI 深度转换时才会发起网络请求（会自动裁剪输入包以满足附件限制）。
        </div>
      </div>

      <TavernLocalSources selection={sourceSelection} repository={getLocalCardRepository()} disabled={state.step === 'parsing' || state.step === 'converting'} onSource={onFileSelected} />
      <TavernFileInput disabled={state.step === 'parsing' || state.step === 'converting'} onFileSelected={onFileSelected} />

      {state.error ? <ErrorMessage message={state.error} className="error-message mt-3" /> : null}

      {state.step === 'parsing' ? <div className="mt-3 text-sm text-gray-700">解析中…</div> : null}

      {state.parseResult && selectedCandidate && selectedNormalized ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <TavernCandidateSelector candidates={state.parseResult.candidates} selectedIndex={state.selectedCandidateIndex}
              disabled={state.step === 'converting' || state.step === 'parsing'} onSelect={(index) => { sourceSelection.begin(); dispatch({ type: 'selectCandidate', index }); resetGeneratedPreview(); }} />

            <div className="rounded-xl border border-pink-200 bg-white/70 p-4">
              <div className="grid gap-4">
                <div>
                  <TavernTemplateSelector value={state.targetTemplate} templates={TAVERN_WEB_IMPORT_TEMPLATES}
                    onChange={(template) => {
                      sourceSelection.begin();
                      dispatch({ type: 'setTemplate', template });
                      resetGeneratedPreview();
                    }} disabled={state.step === 'converting' || state.step === 'parsing'} />
                  <div className="mt-2 text-xs text-gray-600">
                    {isScenarioTemplate
                      ? '规则映射更推荐通用情景卡；结构化情景建议使用 AI 转换。'
                      : '“保守填充”会尽量不做过度推理，无法结构化的信息会被放入分析/研究备注中。'}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-pink-700">保真选项</label>
                  <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-xl border border-pink-100 bg-white/80 p-3">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={state.keepRaw}
                      onChange={(e) => {
                        dispatch({ type: 'setKeepRaw', value: e.target.checked });
                        resetGeneratedPreview();
                      }}
                      disabled={state.step === 'converting' || state.step === 'parsing'}
                    />
                    <div className="min-w-0">
                      <div className="text-sm text-gray-900">同时保存 `_tavern.raw`（体积很大，仅建议本地下载）</div>
                      <div className="mt-1 text-xs text-gray-600">
                        若你计划未来回导到 SillyTavern 或需要完整诊断信息，可开启；保存到档案馆时建议关闭。
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              <TavernConversionControls
                mode={state.convertMode}
                onModeChange={(mode) => { dispatch({ type: 'setConvertMode', mode }); resetGeneratedPreview(); }}
                disabled={state.step === 'converting' || state.step === 'parsing'}
                language={selectedLanguage}
                languages={languages}
                onLanguageChange={(language) => { setSelectedLanguage(language); resetGeneratedPreview(); }}
                languageExpanded={showLanguageSection}
                onLanguageExpandedChange={setShowLanguageSection}
                generationMode={generationMode}
                onGenerationModeChange={(mode) => { setGenerationMode(mode); resetGeneratedPreview(); }}
                generationModeDescription={describeTavernGenerationMode(state.targetTemplate, generationMode)}
                provider={<AiProviderSelector onConfigChange={handleAiProviderConfigChange} />}
                providerFootnote={<>可选：使用自有 API Key 冷却统一为 3 秒；使用官方 Key 冷却为 {Math.ceil(OFFICIAL_KEY_MAX_AI_COOLDOWN_MS / 1000)} 秒。API Key 仅存储于浏览器本地（localStorage），不会上传到服务器。</>}
              />

              <div className="mt-4">
                <button
                  type="button"
                  className="generate-button mb-0 w-full"
                  disabled={state.step === 'converting' || state.step === 'parsing' || !placeholderHydrated || !!replacement.error || (state.convertMode === 'ai' && isCooldown)}
                  onClick={onGenerate}
                >
                  {state.step === 'converting'
                    ? '生成中…'
                    : state.convertMode === 'ai' && isCooldown
                      ? `冷却中 (${remainingTime}s)`
                      : `生成${targetLabel}卡`}
                </button>
                <div className="mt-2 text-xs text-gray-600">
                  生成后会在下方展示{targetLabel}卡预览；你可以保存图片、下载/复制 JSON，或保存到云端（档案馆）。
                </div>
                {streamNotice ? <div className="mt-3 text-center text-sm text-amber-700">{streamNotice}</div> : null}
                {state.step === 'converting' && state.convertMode === 'ai' && generationMode === 'stream' ? (
                  <div className="mt-3 flex justify-center">
                    <StreamStopButton
                      onClick={() => streamAbortControllerRef.current?.abort(STREAM_ABORT_REASON_USER)}
                      label="停止生成"
                    />
                  </div>
                ) : null}

                <TavernPlaceholderFields preference={placeholderPreference} name={selectedNormalized.name}
                  disabled={state.step === 'converting' || state.step === 'parsing' || !placeholderHydrated}
                  description="规则映射与 AI 输入都会使用替换后的文本，避免导入后出现角色/用户占位符残留。"
                  onChange={(next) => { setPlaceholderPreference(next); resetGeneratedPreview(); }} />
                {replacement.error ? <div role="alert" className="mt-3 text-sm text-red-700">{replacement.error}</div> : null}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <TavernCardPreview normalized={selectedNormalized} warnings={combinedWarnings} />
            <TavernOriginalExport candidate={selectedCandidate} basePngBytes={originalPng} disabled={state.step === 'converting' || state.step === 'parsing'}
              exportFile={({ name, bytes, mimeType }) => { downloadBlob(new Blob([new Uint8Array(bytes)], { type: mimeType }), name); }} />



            {previewDataCard ? (
              <div ref={resultRef}>
                <div className="rounded-xl border border-pink-200 bg-white/70 p-4">
                  <div className="text-sm font-semibold text-pink-700">{targetLabel}卡预览</div>
                  <div className="mt-3">
                    {outputTemplateForPreview === 'magical-girl' ? (
                      <MagicalGirlCard
                        magicalGirl={previewDataCard as any}
                        gradientStyle={MAGICAL_GIRL_CARD_GRADIENT}
                        onSaveImage={handleSaveImage}
                        imageSaveMode={imageSaveMode}
                        saveButtonLabel={imageSaveButtonLabel}
                      />
                    ) : outputTemplateForPreview === 'canshou' ? (
                      <CanshouCard
                        canshou={normalizeCanshouForCard(previewDataCard)}
                        onSaveImage={handleSaveImage}
                        imageSaveMode={imageSaveMode}
                        saveButtonLabel={imageSaveButtonLabel}
                      />
                    ) : outputTemplateForPreview === 'scenario' || outputTemplateForPreview === 'general-scenario' ? (
                      <GeneralScenarioCard
                        scenario={scenarioPreview ?? { title: '未命名情景', content: '' }}
                        isStreaming={isPreviewStreaming}
                        onSaveImage={handleSaveImage}
                        imageSaveMode={imageSaveMode}
                        saveButtonLabel={imageSaveButtonLabel}
                      />
                    ) : (
                      <GeneralCharacterCard
                        general={previewDataCard as any}
                        isStreaming={isPreviewStreaming}
                        onSaveImage={handleSaveImage}
                        imageSaveMode={imageSaveMode}
                        saveButtonLabel={imageSaveButtonLabel}
                      />
                    )}
                  </div>
                </div>
                {state.convertMode === 'ai' && generationMode === 'stream' && (
                  <AiReasoningPanel background="solid-dark" reasoning={streamingReasoning} status={streamingReasoning?.status ?? 'idle'} compact />
                )}
                {state.convertMode === 'ai' && generationMode === 'non-stream' && nonStreamReasoning && (
                  <AiReasoningPanel
                    background="solid-dark"
                    reasoning={nonStreamReasoning}
                    status={nonStreamReasoning.status}
                    displayMode="content-only"
                    compact
                  />
                )}

                {outputDataCard && state.convertMode === 'rules' && (state.targetTemplate === 'general' || state.targetTemplate === 'general-scenario' || state.targetTemplate === 'canshou' || state.targetTemplate === 'magical-girl') ? (
                  <TavernLocalProjection data={outputDataCard as TavernProjection} hideExport disabled={state.step === 'parsing' || state.step === 'converting'}
                    exportFile={({ name, bytes, mimeType }) => { downloadBlob(new Blob([new Uint8Array(bytes)], { type: mimeType }), name); }}
                    saveCard={(data) => saveImportedUnsignedCard(getLocalCardRepository(), data, getTavernProjectionTitle(data), getTavernProjectionCardType(data))} />
                ) : null}

                {outputDataCard ? (
                  <div className="mt-4 rounded-xl border border-pink-200 bg-white/70 p-4">
                    <div className="space-y-5 text-left">
                      <div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium text-gray-800">设定长图保存方式</span>
                          <span className="text-xs text-gray-500">推荐：{recommendedImageMode === 'download' ? '下载' : '弹窗'}</span>
                        </div>
                        <div className="mt-2 flex gap-2">
                          <button type="button" className={preferenceButtonClass(imageSaveMode === 'download')} onClick={() => setImageSaveMode('download')}>
                            💾 一键下载
                          </button>
                          <button type="button" className={preferenceButtonClass(imageSaveMode === 'modal')} onClick={() => setImageSaveMode('modal')}>
                            📱 弹窗长按保存
                          </button>
                        </div>
                        <p className="mt-2 text-xs text-gray-500">提示：保存按钮在{targetLabel}卡最底部；移动端建议弹窗方式。</p>
                      </div>

                      <div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium text-gray-800">数据卡 JSON 保存方式</span>
                          <span className="text-xs text-gray-500">推荐：{recommendedJsonMode === 'download' ? '下载' : '复制'}</span>
                        </div>
                        <div className="mt-2 flex gap-2">
                          <button type="button" className={preferenceButtonClass(jsonSaveMode === 'download')} onClick={() => setJsonSaveMode('download')}>
                            下载 JSON
                          </button>
                          <button type="button" className={preferenceButtonClass(jsonSaveMode === 'text')} onClick={() => setJsonSaveMode('text')}>
                            复制 JSON
                          </button>
                        </div>
                        <p className="mt-2 text-xs text-gray-500">两种方式可随时切换；若你开启了 `_tavern.raw`，JSON 会变大。</p>
                      </div>

                      <TavernCloudSaveControls
                        preset={cloudPreset}
                        onPresetChange={setCloudPreset}
                        preview={cloudSavePreview}
                      />

                      <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
                        {jsonSaveMode === 'download' ? (
                          <button type="button" onClick={() => void onDownloadJson()} className="generate-button flex-1">
                            下载数据卡 JSON
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void onCopyJson()}
                            className="generate-button flex-1"
                            style={{ backgroundColor: '#3b82f6', backgroundImage: 'linear-gradient(to right, #3b82f6, #2563eb)' }}
                          >
                            {copyStatus === 'success' ? '已复制 ✓' : copyStatus === 'error' ? '复制失败' : '复制数据卡 JSON'}
                          </button>
                        )}

                        <SaveToCloudButton
                          data={outputDataCard}
                          getData={getCloudPayload}
                          cardType={cloudCardType}
                          buttonText="保存到云端"
                          defaultName={defaultCloudCardName}
                          defaultDescription={defaultCloudCardDescription}
                          className="generate-button flex-1"
                          style={{ backgroundColor: '#22c55e', backgroundImage: 'linear-gradient(to right, #22c55e, #16a34a)' }}
                        />
                      </div>
                      {cloudSavePreview && !('error' in cloudSavePreview) ? (
                        <JsonSizeIndicator
                          data={outputDataCard}
                          estimatedBytes={cloudSavePreview.estimatedBytes}
                          warningText={`⚠️ 接近云端 ${MAX_DATA_CARD_BYTES / 1024}KB 上限，保存/替换可能失败，请先精简数据。`}
                        />
                      ) : outputDataCard ? (
                        <JsonSizeIndicator
                          data={outputDataCard}
                          warningText={`⚠️ 接近云端 ${MAX_DATA_CARD_BYTES / 1024}KB 上限，保存/替换可能失败，请先精简数据。`}
                        />
                      ) : null}

                      {jsonSaveMode === 'text' && outputJsonPayload ? (
                        <div className="mt-4 rounded-xl border border-pink-100 bg-white/60 p-3">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="text-xs text-gray-600">
                              {copyStatus === 'success'
                                ? '✅ JSON 已复制，记得粘贴到编辑器中保存为 .json 文件'
                                : copyStatus === 'error'
                                  ? '⚠️ 复制遇到问题，可点击文本框全选后手动复制'
                                  : '提示：点击文本框可一键全选；复制后粘贴到文本编辑器保存为 .json。'}
                            </span>
                            <button
                              type="button"
                              onClick={() => void onCopyJson()}
                              className="rounded-md border border-indigo-200 bg-white px-3 py-1 text-xs font-medium text-indigo-600 hover:border-indigo-400 hover:text-indigo-700"
                            >
                              复制
                            </button>
                          </div>
                          <textarea
                            value={outputJsonPayload}
                            readOnly
                            className="h-64 w-full rounded-lg border bg-gray-50 p-3 font-mono text-xs text-gray-900"
                            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
                          />
                          <div className="mt-2 text-center text-xs text-gray-400">点击文本框可全选内容</div>
                        </div>
                      ) : null}

                      <p className="text-xs text-gray-400 text-center">
                        提示：云端保存会自动移除大体积字段（如 `_tavern.raw`），并按所选预设裁剪正文；本地下载不受影响。
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 text-sm text-gray-700">生成中…（生成结束后将出现保存/下载选项）</div>
                )}

              {outputDataCard && tachiePrompt.trim() ? (
                <div className="mt-4 rounded-xl border border-pink-200 bg-white/70 p-4">
                  <div className="text-sm font-semibold text-pink-700">生成立绘（LibLib / ModelScope，可选）</div>
                  <div className="mt-2 text-xs text-gray-600">提示：立绘生成会直接调用对应平台 API；凭据仅存于本地。</div>
                  <div className="mt-3">
                    <TachieGenerator prompt={tachiePrompt} />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          </div>
        </div>
      ) : null}

      <ImagePreviewModal
        isOpen={showImageModal}
        imageUrl={savedImageUrl}
        onClose={() => {
          setShowImageModal(false);
          setSavedImageUrl(null);
        }}
      />
    </div>
  );
}
