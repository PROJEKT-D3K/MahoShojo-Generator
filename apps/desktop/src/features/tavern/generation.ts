import { DesktopHostedTavernBodySchema } from '@mahoshojo/contracts/desktop-cloud';
import { parseDataCardByTemplate } from '@mahoshojo/domain/data-card-schemas';
import type { JsonValue } from '@mahoshojo/contracts/json-value';
import {
  createTavernMagicalGirlGenerationConfig, createTavernCanshouGenerationConfig,
  projectTavernMagicalGirlResult, projectTavernCanshouResult,
  createTavernGeneralGenerationConfig, createTavernGeneralScenarioGenerationConfig, createTavernScenarioGenerationConfig,
  projectTavernGeneralResult, projectTavernGeneralScenarioResult, projectTavernScenarioResult,
} from '@mahoshojo/ai-core/tavern-generation';
import {
  applyTavernPlaceholderReplacement, buildTavernAiAttachment, normalizeTavernCard,
  resolveTavernCharReplacement, validateTavernRaw, type TavernPlaceholderPreference,
} from '@mahoshojo/domain/tavern-card';
import { executeDirectGeneration, executeDesktopHostedJsonGeneration, GenerationTransportError, type DesktopDirectGenerationFamily, type DesktopHostedJsonGenerationFamily, type DesktopHostedJsonExecutionOptions, type DesktopGenerationIntent } from '../generation/executor';

import { getRandomFlowers } from '@mahoshojo/domain/flowers';
import { CANSHOU_LORE } from '@mahoshojo/domain/canshou-lore';
import magicalQuestionnaire from '../../../../../content/questionnaires/presets/magical-girl-default.json';
import canshouQuestionnaire from '../../../../../content/questionnaires/presets/canshou-default.json';

export type TavernAiTemplate = 'general' | 'general-scenario' | 'scenario' | 'magical-girl' | 'canshou';
export function createDesktopTavernGenerationConfig(template: TavernAiTemplate) {
  switch (template) {
    case 'magical-girl': return createTavernMagicalGirlGenerationConfig({ questionnaire: magicalQuestionnaire, getRandomFlowers });
    case 'canshou': return createTavernCanshouGenerationConfig({ questionnaire: canshouQuestionnaire, lore: CANSHOU_LORE });
    case 'scenario': return createTavernScenarioGenerationConfig();
    case 'general-scenario': return createTavernGeneralScenarioGenerationConfig();
    default: return createTavernGeneralGenerationConfig();
  }
}

function projectFreshCard(template: TavernAiTemplate, value: unknown) {
  switch (template) {
    case 'magical-girl': return projectTavernMagicalGirlResult(createDesktopTavernGenerationConfig('magical-girl').schema.parse(value), magicalQuestionnaire);
    case 'canshou': return projectTavernCanshouResult(createDesktopTavernGenerationConfig('canshou').schema.parse(value), canshouQuestionnaire);
    case 'scenario': return projectTavernScenarioResult(createTavernScenarioGenerationConfig().schema.parse(value));
    case 'general-scenario': return projectTavernGeneralScenarioResult(createTavernGeneralScenarioGenerationConfig().schema.parse(value));
    default: return projectTavernGeneralResult(createTavernGeneralGenerationConfig().schema.parse(value));
  }
}
export type TavernGenerationIntent = DesktopGenerationIntent & { mode: 'direct-local' | 'direct-remote' | 'hosted-json'; generationMode: 'non-stream' };
export interface TavernGenerationInput {
  raw: unknown;
  template: TavernAiTemplate;
  language: string;
  preference: TavernPlaceholderPreference;
}

export function prepareTavernGenerationInput(input: TavernGenerationInput) {
  if (!['general', 'general-scenario', 'scenario', 'magical-girl', 'canshou'].includes(input.template)) throw new Error('不支持的酒馆转换模板。');
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
  // Restore full app data without rerunning model-answer normalization. Only scenario lacks
  // top-level signature fields in its domain schema; these old authority claims are discarded.
  const candidate = kind === 'scenario' && value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'signature' && key !== 'isPreset')) : value;
  const projected = parseDataCardByTemplate(kind, candidate);
  delete projected.signature; delete projected.isPreset;
  if (kind === 'scenario' && 'metadata' in projected && projected.metadata) {
    // Domain parsing must precede cleanup: malformed metadata must never be repaired by spread.
    delete (projected.metadata as { signature?: string }).signature;
  }
  const archive = projected._tavern;
  const raw = archive && typeof archive === 'object' && !Array.isArray(archive) && 'raw' in archive ? archive.raw : undefined;
  return { ...projected, _tavern: { ...(archive && typeof archive === 'object' && !Array.isArray(archive) ? archive : {}), raw: validateTavernRaw(raw) } };
}

const FAMILY: DesktopDirectGenerationFamily<TavernGenerationInput, TavernGenerationIntent, TavernAiTemplate> = {
  validateInput: prepareTavernGenerationInput,
  createDirectConfig: (_intent, input) => {
    const config = createDesktopTavernGenerationConfig(input.template);
    return { ...config, promptBuilder: (frozen) => config.promptBuilder(prepareTavernGenerationInput(frozen).promptInput) };
  },
  buildStructuredCard: (value, input) => ({
    card: validateTavernGeneratedCard(input.template, { ...projectFreshCard(input.template, value), _tavern: { raw: input.raw } }),
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
