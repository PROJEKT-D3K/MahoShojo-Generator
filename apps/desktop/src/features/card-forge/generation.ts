import { GAME_CARD_GENERATION_CONFIG, type GameCardGenerationInput } from '@mahoshojo/ai-core/game-card-generation';
import { GameCardFaceDataSchema } from '@mahoshojo/contracts/game-card';
import { SafeJsonValueSchema } from '@mahoshojo/contracts/json-value';
import { MAX_DATA_CARD_BYTES, exceedsUtf8ByteLimit } from '@mahoshojo/domain/data-card-size';
import { parseGameCardForgeImport } from '@mahoshojo/domain/card-forge-document';
import { GAME_CARD_FORGE_DOCUMENT_TYPE } from '@mahoshojo/domain/game-card';
import { executeDirectGeneration, GenerationTransportError, type DesktopDirectGenerationFamily, type DesktopDirectGenerationIntent } from '../generation/executor';
import type { DesktopAiExecutionOptions } from '../../platform/desktop-ai-execution';

export function normalizeForgeGenerationInput(input: GameCardGenerationInput): GameCardGenerationInput {
  if (exceedsUtf8ByteLimit(input.sourceCardJson, MAX_DATA_CARD_BYTES)) throw new Error('源数据卡超过 1 MiB，请精简后重试。');
  const text = input.sourceCardJson.replace(/^\uFEFF/, '').trim();
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('源数据卡不是有效 JSON，未替换当前作品。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !SafeJsonValueSchema.safeParse(value).success || Object.keys(value).length === 0) throw new Error('请提供安全、非空的源数据卡 JSON 对象。');
  let isForge = false;
  try { parseGameCardForgeImport(value); isForge = true; } catch { /* 源卡不使用卡面 schema。 */ }
  if (isForge || (value as Record<string, unknown>).documentType === GAME_CARD_FORGE_DOCUMENT_TYPE || 'faceData' in value) throw new Error('这是工坊存档或卡面，请使用「导入工坊存档 / 卡面」；生成需要角色卡或情景卡源数据。');
  if (exceedsUtf8ByteLimit(input.customInstructions ?? '', 16 * 1024)) throw new Error('附加要求超过 16 KiB，请精简后重试。');
  return { sourceCardJson: text, customInstructions: input.customInstructions?.trim() || undefined };
}

const family: DesktopDirectGenerationFamily<GameCardGenerationInput, DesktopDirectGenerationIntent, 'game-card'> = {
  createDirectConfig: () => GAME_CARD_GENERATION_CONFIG,
  buildStructuredCard: data => ({ cardKind: 'game-card', card: { ...GameCardFaceDataSchema.parse(data) } }),
  createError: (rawText, cause) => new GenerationTransportError(rawText, cause),
  cardNoun: '卡牌卡面',
};
export const executeForgeGeneration = (options: DesktopAiExecutionOptions, input: GameCardGenerationInput, intent: DesktopDirectGenerationIntent, signal: AbortSignal, onPartialText?: (text: string) => void) =>
  executeDirectGeneration(family, options, normalizeForgeGenerationInput(input), intent, signal, onPartialText);
