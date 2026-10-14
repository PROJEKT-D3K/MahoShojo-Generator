import { DesktopHostedTavernBodySchema } from '@mahoshojo/contracts/desktop-cloud';
import { ScenarioSchema } from '@mahoshojo/domain/data-card-schemas';
import type { JsonValue } from '@mahoshojo/contracts/json-value';
import {
  createTavernGeneralGenerationConfig, createTavernGeneralScenarioGenerationConfig, createTavernScenarioGenerationConfig,
  projectTavernGeneralResult, projectTavernGeneralScenarioResult, projectTavernScenarioResult,
  TAVERN_GENERAL_CHARACTER_SCHEMA, TAVERN_GENERAL_SCENARIO_SCHEMA, TAVERN_SCENARIO_SCHEMA,
} from '@mahoshojo/ai-core/tavern-generation';
import {
  applyTavernPlaceholderReplacement, buildTavernAiAttachment, normalizeTavernCard,
  resolveTavernCharReplacement, validateTavernRaw, type TavernPlaceholderPreference,
} from '@mahoshojo/domain/tavern-card';
import { executeDirectGeneration, executeDesktopHostedJsonGeneration, GenerationTransportError, type DesktopDirectGenerationFamily, type DesktopHostedJsonGenerationFamily, type DesktopHostedJsonExecutionOptions, type DesktopGenerationIntent } from '../generation/executor';

export type TavernAiTemplate = 'general' | 'general-scenario' | 'scenario';
export type TavernGenerationIntent = DesktopGenerationIntent & { mode: 'direct-local' | 'direct-remote' | 'hosted-json'; generationMode: 'non-stream' };
export interface TavernGenerationInput {
  raw: unknown;
  template: TavernAiTemplate;
  language: string;
  preference: TavernPlaceholderPreference;
}

export function prepareTavernGenerationInput(input: TavernGenerationInput) {
  if (input.template !== 'general' && input.template !== 'general-scenario' && input.template !== 'scenario') throw new Error('本页 AI 仅支持通用角色、通用情景与结构化情景。');
  if (typeof input.language !== 'string' || !input.language.trim() || input.language.length > 32) throw new Error('生成语言无效。');
  const raw = validateTavernRaw(input.raw);
  const p = input.preference;
  if (!p || typeof p.enabled !== 'boolean' || typeof p.userReplacement !== 'string' || typeof p.customCharReplacement !== 'string' || !['auto', 'custom'].includes(p.charReplacementMode)) throw new Error('占位符设置无效。');
  const source = normalizeTavernCard({ keyword: 'json', chunkType: 'tEXt', parseMethod: 'json', parsed: raw }).normalized;
  const normalized = applyTavernPlaceholderReplacement(source, { enabled: p.enabled, userReplacement: p.userReplacement, charReplacement: resolveTavernCharReplacement(source.name, p) });
  const { attachment, warnings } = buildTavernAiAttachment(normalized);
  return { raw, warnings, promptInput: { language: input.language, sourceName: normalized.name, attachments: [attachment] } };
}

export function validateTavernGeneratedCard(kind: TavernAiTemplate, value: unknown) {
  // Restored cards use the full app schema; the model-output schema belongs only at generation.
  const unsigned = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } as Record<string, unknown> : value;
  if (kind === 'scenario' && unsigned && typeof unsigned === 'object') {
    const card = unsigned as Record<string, unknown>;
    delete card.signature; delete card.isPreset;
  }
  const projected = kind === 'scenario'
    ? (() => {
      const scenario = ScenarioSchema.parse(unsigned);
      if (scenario.metadata) delete scenario.metadata.signature;
      return scenario;
    })()
    : kind === 'general-scenario'
    ? projectTavernGeneralScenarioResult(TAVERN_GENERAL_SCENARIO_SCHEMA.parse(value))
    : projectTavernGeneralResult(TAVERN_GENERAL_CHARACTER_SCHEMA.parse(value));
  const raw = value && typeof value === 'object' && '_tavern' in value ? (value as { _tavern?: { raw?: unknown } })._tavern?.raw : undefined;
  return { ...projected, _tavern: { raw: validateTavernRaw(raw) } };
}

const FAMILY: DesktopDirectGenerationFamily<TavernGenerationInput, TavernGenerationIntent, TavernAiTemplate> = {
  validateInput: prepareTavernGenerationInput,
  createDirectConfig: (_intent, input) => {
    const config = input.template === 'scenario' ? createTavernScenarioGenerationConfig() : input.template === 'general-scenario' ? createTavernGeneralScenarioGenerationConfig() : createTavernGeneralGenerationConfig();
    return { ...config, promptBuilder: (frozen) => config.promptBuilder(prepareTavernGenerationInput(frozen).promptInput) };
  },
  buildStructuredCard: (value, input) => ({
    card: validateTavernGeneratedCard(input.template, { ...(input.template === 'scenario' ? projectTavernScenarioResult(TAVERN_SCENARIO_SCHEMA.parse(value)) : input.template === 'general-scenario' ? TAVERN_GENERAL_SCENARIO_SCHEMA.parse(value) : TAVERN_GENERAL_CHARACTER_SCHEMA.parse(value)), _tavern: { raw: input.raw } }),
    cardKind: input.template,
  }),
  createError: (rawText, cause) => new GenerationTransportError(rawText, cause),
  cardNoun: '酒馆转换卡',
};

export function buildTavernHostedBody(input: TavernGenerationInput): Record<string, JsonValue> {
  const prepared = prepareTavernGenerationInput(input).promptInput;
  const body = { template: input.template, language: prepared.language, sourceName: prepared.sourceName,
    attachments: prepared.attachments.map(attachment => ({ ...attachment })) };
  if (!DesktopHostedTavernBodySchema.safeParse(body).success) throw new Error('酒馆服务器输入超出限制：名称最多 4096 字符，附件正文单件及合计最多 1 MiB。请精简后重试。');
  return body;
}

const HOSTED_FAMILY: DesktopHostedJsonGenerationFamily<TavernGenerationInput, TavernGenerationIntent, TavernAiTemplate> = {
  validateInput: prepareTavernGenerationInput,
  jsonRouteId: 'tavern-convert',
  buildHostedBody: buildTavernHostedBody,
  normalizeHostedJsonCard: FAMILY.buildStructuredCard,
  cardNoun: FAMILY.cardNoun,
};

export const executeTavernGeneration = (options: DesktopHostedJsonExecutionOptions, input: TavernGenerationInput, intent: TavernGenerationIntent, signal: AbortSignal, onPartialText?: (text: string) => void) =>
  intent.mode === 'hosted-json'
    ? executeDesktopHostedJsonGeneration(HOSTED_FAMILY, options, input, intent, signal)
    : executeDirectGeneration(FAMILY, options, input, { ...intent, mode: intent.mode }, signal, onPartialText);
