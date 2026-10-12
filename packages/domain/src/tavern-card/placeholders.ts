import type { TavernCardNormalized } from './types';

export interface TavernPlaceholderPreference {
  enabled: boolean;
  userReplacement: string;
  charReplacementMode: 'auto' | 'custom';
  customCharReplacement: string;
}

export const DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE: Readonly<TavernPlaceholderPreference> = {
  enabled: true,
  userReplacement: '【某人】',
  charReplacementMode: 'auto',
  customCharReplacement: '',
};
export const TAVERN_CHAR_FALLBACK = '角色';

export function resolveTavernCharReplacement(name: string | undefined, preference: TavernPlaceholderPreference): string {
  if (preference.charReplacementMode === 'custom') return preference.customCharReplacement;
  const trimmed = (name ?? '').trim();
  return trimmed && !trimmed.includes('{{user}}') && !trimmed.includes('{{char}}') ? trimmed : TAVERN_CHAR_FALLBACK;
}

export interface TavernPlaceholderConfig { enabled: boolean; userReplacement: string; charReplacement: string }

// Temporary replacement allocations, not the 4 MiB serialized local-card limit.
// A first pass may exceed this even when the second pass would shrink it: reject,
// never truncate. One budget covers every changed field/list entry and both passes.
export const MAX_TAVERN_PLACEHOLDER_WORK_BYTES = 32 * 1024 * 1024;
const limitError = () => new Error('占位符替换超过 32 MiB 临时处理预算，未截断内容；请缩短替换文本或关闭替换。原件仍保留。');

/** Bounded TextEncoder-compatible byte count without allocating an encoded copy. */
function countUtf8Bytes(text: string, maxBytes: number): number {
  if (text.length > maxBytes) throw limitError();
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4; index += 1;
    } else bytes += 3;
    if (bytes > maxBytes) throw limitError();
  }
  return bytes;
}

/** The Web import's literal, case-sensitive two-pass rule; source data stays inert. */
export function applyTavernPlaceholderReplacement(normalized: TavernCardNormalized, config: TavernPlaceholderConfig): TavernCardNormalized {
  if (!config.enabled) return normalized;
  let remaining = MAX_TAVERN_PLACEHOLDER_WORK_BYTES;
  const replace = (input: string, token: string, replacement: string): string => {
    let count = 0;
    for (let index = input.indexOf(token); index !== -1; index = input.indexOf(token, index + token.length)) count += 1;
    if (count === 0 || replacement === token) return input;
    const removedBytes = count * token.length; // Both tokens are ASCII.
    const unchangedBytes = countUtf8Bytes(input, remaining + removedBytes) - removedBytes;
    const replacementBytes = countUtf8Bytes(replacement, Math.floor((remaining - unchangedBytes) / count));
    // Joining surrogate halves can only reduce this estimate, never increase it.
    remaining -= unchangedBytes + count * replacementBytes;
    return input.split(token).join(replacement);
  };
  const scalar = (value: string | undefined) => typeof value !== 'string' ? value
    : replace(replace(value, '{{user}}', config.userReplacement), '{{char}}', config.charReplacement);
  const list = (value: string[] | undefined) => value?.map((item) => scalar(item) ?? '');
  return {
    ...normalized,
    name: scalar(normalized.name) ?? normalized.name,
    description: scalar(normalized.description),
    personality: scalar(normalized.personality),
    scenario: scalar(normalized.scenario),
    firstMes: scalar(normalized.firstMes),
    mesExample: scalar(normalized.mesExample),
    creatorComment: scalar(normalized.creatorComment),
    creatorNotes: scalar(normalized.creatorNotes),
    systemPrompt: scalar(normalized.systemPrompt),
    postHistoryInstructions: scalar(normalized.postHistoryInstructions),
    alternateGreetings: list(normalized.alternateGreetings),
    groupOnlyGreetings: list(normalized.groupOnlyGreetings),
  };
}
