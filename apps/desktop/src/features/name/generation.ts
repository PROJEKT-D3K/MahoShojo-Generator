import { MAGICAL_GIRL_GENERATION_CONFIG, MAGICAL_GIRL_GENERATION_SCHEMA } from '@mahoshojo/ai-core/name-generation';
import { buildNameGenerationResult, isNameWithinLength, type NameGenerationInput } from '@mahoshojo/domain/name-generation';
import { executeDirectGeneration, executeDesktopHostedJsonGeneration, GenerationTransportError, type DesktopDirectGenerationFamily, type DesktopHostedJsonGenerationFamily, type DesktopHostedJsonExecutionOptions, type DesktopGenerationIntent } from '../generation/executor';

export type NameGenerationIntent = DesktopGenerationIntent & { mode: 'direct-local' | 'direct-remote' | 'hosted-json'; generationMode?: 'non-stream' };
export type NameCardKind = 'name';

/** Match the Web form's raw UTF-16 limit before trimming the dispatched name. */
export const normalizeNameGenerationInput = (input: NameGenerationInput): NameGenerationInput => {
  if (!isNameWithinLength(input.realName)) throw new Error('名字太长啦，你怎么回事！');
  if (!input.realName.trim()) throw new Error('请输入你的名字。');
  const language = input.language.trim();
  if (!language || language.length > 32) throw new Error('生成语言无效。');
  return { realName: input.realName.trim(), language };
};

export const validateNameResult = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('名字生成结果损坏');
  const card = value as Record<string, unknown>;
  if (typeof card.realName !== 'string') throw new Error('名字生成结果损坏');
  const input = normalizeNameGenerationInput({ realName: card.realName, language: 'zh-CN' });
  const generated = MAGICAL_GIRL_GENERATION_SCHEMA.parse({ ...card, flowerName: card.name });
  const result = buildNameGenerationResult(input.realName, generated);
  if (card.level !== result.level || card.levelEmoji !== result.levelEmoji) throw new Error('名字生成等级损坏');
  return { ...result };
};

const NAME_FAMILY: DesktopDirectGenerationFamily<NameGenerationInput, NameGenerationIntent, NameCardKind> = {
  validateInput: normalizeNameGenerationInput,
  createDirectConfig: () => ({ ...MAGICAL_GIRL_GENERATION_CONFIG, promptBuilder: (input) => MAGICAL_GIRL_GENERATION_CONFIG.promptBuilder(normalizeNameGenerationInput(input)) }),
  buildStructuredCard: (data, input) => ({ card: { ...buildNameGenerationResult(input.realName.trim(), MAGICAL_GIRL_GENERATION_SCHEMA.parse(data)) }, cardKind: 'name' }),
  createError: (rawText, cause) => new GenerationTransportError(rawText, cause),
  cardNoun: '名字生成结果',
};

const HOSTED_NAME_FAMILY: DesktopHostedJsonGenerationFamily<NameGenerationInput, NameGenerationIntent, NameCardKind> = {
  validateInput: normalizeNameGenerationInput,
  jsonRouteId: 'generate-magical-girl',
  buildHostedBody: (input) => {
    const normalized = normalizeNameGenerationInput(input);
    return { name: normalized.realName, language: normalized.language };
  },
  // 服务端原始 flowerName/signature 留在 rawText；七字段展示卡是 unsigned 转换结果。
  normalizeHostedJsonCard: (data, input) => ({
    card: { ...buildNameGenerationResult(input.realName.trim(), MAGICAL_GIRL_GENERATION_SCHEMA.parse(data)) },
    cardKind: 'name',
  }),
  cardNoun: '名字生成结果',
};

export const executeNameGeneration = (options: DesktopHostedJsonExecutionOptions, input: NameGenerationInput, intent: NameGenerationIntent, signal: AbortSignal, onPartialText?: (text: string) => void) =>
  intent.mode === 'hosted-json'
    ? executeDesktopHostedJsonGeneration(HOSTED_NAME_FAMILY, options, input, intent, signal)
    : executeDirectGeneration(NAME_FAMILY, options, input, { ...intent, mode: intent.mode }, signal, onPartialText);
