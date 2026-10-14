import {
  createTavernGeneralGenerationConfig, createTavernGeneralScenarioGenerationConfig,
  projectTavernGeneralResult, projectTavernGeneralScenarioResult,
  TAVERN_GENERAL_CHARACTER_SCHEMA, TAVERN_GENERAL_SCENARIO_SCHEMA,
} from '@mahoshojo/ai-core/tavern-generation';
import {
  applyTavernPlaceholderReplacement, buildTavernAiAttachment, normalizeTavernCard,
  resolveTavernCharReplacement, validateTavernRaw, type TavernPlaceholderPreference,
} from '@mahoshojo/domain/tavern-card';
import { executeDirectGeneration, GenerationTransportError, type DesktopDirectGenerationFamily, type DesktopDirectGenerationIntent } from '../generation/executor';
import type { DesktopAiExecutionOptions } from '../../platform/desktop-ai-execution';

export type TavernAiTemplate = 'general' | 'general-scenario';
export type TavernGenerationIntent = DesktopDirectGenerationIntent & { generationMode: 'non-stream' };
export interface TavernGenerationInput {
  raw: unknown;
  template: TavernAiTemplate;
  language: string;
  preference: TavernPlaceholderPreference;
}

export function prepareTavernGenerationInput(input: TavernGenerationInput) {
  if (input.template !== 'general' && input.template !== 'general-scenario') throw new Error('本页 AI 仅支持通用角色与通用情景。');
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
  const projected = kind === 'general-scenario'
    ? projectTavernGeneralScenarioResult(TAVERN_GENERAL_SCENARIO_SCHEMA.parse(value))
    : projectTavernGeneralResult(TAVERN_GENERAL_CHARACTER_SCHEMA.parse(value));
  const raw = value && typeof value === 'object' && '_tavern' in value ? (value as { _tavern?: { raw?: unknown } })._tavern?.raw : undefined;
  return { ...projected, _tavern: { raw: validateTavernRaw(raw) } };
}

const FAMILY: DesktopDirectGenerationFamily<TavernGenerationInput, TavernGenerationIntent, TavernAiTemplate> = {
  validateInput: prepareTavernGenerationInput,
  createDirectConfig: (_intent, input) => {
    const config = input.template === 'general-scenario' ? createTavernGeneralScenarioGenerationConfig() : createTavernGeneralGenerationConfig();
    return { ...config, promptBuilder: (frozen) => config.promptBuilder(prepareTavernGenerationInput(frozen).promptInput) };
  },
  buildStructuredCard: (value, input) => ({
    card: validateTavernGeneratedCard(input.template, { ...(input.template === 'general-scenario' ? TAVERN_GENERAL_SCENARIO_SCHEMA.parse(value) : TAVERN_GENERAL_CHARACTER_SCHEMA.parse(value)), _tavern: { raw: input.raw } }),
    cardKind: input.template,
  }),
  createError: (rawText, cause) => new GenerationTransportError(rawText, cause),
  cardNoun: '酒馆转换卡',
};

export const executeTavernGeneration = (options: DesktopAiExecutionOptions, input: TavernGenerationInput, intent: TavernGenerationIntent, signal: AbortSignal, onPartialText?: (text: string) => void) =>
  executeDirectGeneration(FAMILY, options, input, intent, signal, onPartialText);
