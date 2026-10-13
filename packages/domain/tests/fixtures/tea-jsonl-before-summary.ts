// Frozen pre-summary reader: keep this independent of the current transfer implementation.
import type { MagicTeaPartyMessage, MagicTeaPartyOutputSegment } from '../../src/magic-tea-party/types';

type ParseJsonlResult = {
  messages: MagicTeaPartyMessage[];
  warnings: string[];
};

const readString = (value: unknown): string => (typeof value === 'string' ? value : '').trim();

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const choiceOutcomeKeys = ['status', 'kind', 'outputFormat', 'completion', 'choicesValid', 'notices', 'rawOutput', 'error'];
const terminalMetaKeys = ['kind', 'outputFormat', 'completion', 'choicesValid', 'notices', 'rawOutput'] as const;
type ChoiceOutcome = { status: 'done' | 'error' | 'blocked'; meta: Record<string, unknown>; error?: { code: string; message: string } };
/** JSONL preserves this narrow terminal seam; it is evidence, never authority to enable actions. */
const parseChoiceOutcome = (raw: unknown): ChoiceOutcome | null => {
  const value = asRecord(raw);
  if (!value || Object.keys(value).some(key => !choiceOutcomeKeys.includes(key))) return null;
  if (value.status !== 'done' && value.status !== 'error' && value.status !== 'blocked') return null;
  if (value.kind !== 'choices' && value.kind !== 'reply') return null;
  if (value.outputFormat !== 'jsonl' && value.outputFormat !== 'markdown') return null;
  if (value.completion !== undefined && (typeof value.completion !== 'string' || !['provider', 'completed', 'stopped', 'failed', 'blocked', 'discarded'].includes(value.completion))) return null;
  if (value.choicesValid !== undefined && typeof value.choicesValid !== 'boolean') return null;
  if (value.rawOutput !== undefined && typeof value.rawOutput !== 'string') return null;
  if (value.notices !== undefined && (!Array.isArray(value.notices) || value.notices.some(item => {
    const notice = asRecord(item);
    return !notice || Object.keys(notice).some(key => !['type', 'level', 'code', 'message', 'meta'].includes(key))
      || notice.type !== 'notice' || typeof notice.level !== 'string' || !['info', 'warning', 'error'].includes(notice.level)
      || typeof notice.message !== 'string' || notice.code !== undefined && typeof notice.code !== 'string'
      || notice.meta !== undefined && !asRecord(notice.meta);
  }))) return null;
  const error = value.error === undefined ? undefined : asRecord(value.error);
  if (value.error !== undefined && (!error || Object.keys(error).some(key => key !== 'code' && key !== 'message')
    || typeof error.code !== 'string' || typeof error.message !== 'string')) return null;
  return { status: value.status, meta: Object.fromEntries(terminalMetaKeys.filter(key => value[key] !== undefined).map(key => [key, value[key]])),
    ...(error ? { error: { code: error.code as string, message: error.message as string } } : {}) };
};
const choiceOutcomeIdentity = (outcome: ChoiceOutcome): string => JSON.stringify([
  outcome.status, outcome.meta.kind, outcome.meta.outputFormat, outcome.meta.completion, outcome.meta.choicesValid,
  outcome.meta.rawOutput, outcome.error?.code, outcome.error?.message,
  Array.isArray(outcome.meta.notices) ? outcome.meta.notices.map((notice: Record<string, unknown>) => [notice.type, notice.level, notice.code, notice.message]) : null,
]);

const isNumberLike = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const parseSillyTavernHumanDate = (raw: string): number | null => {
  const normalized = raw.trim();
  if (!normalized) return null;
  const match = normalized.match(
    /^(\d{4}-\d{2}-\d{2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s(?:\s*(\d{1,3})ms)?$/i
  );
  if (!match) return null;
  const [, datePart, hourPart, minutePart, secondPart, msPart] = match;
  const hour = Number(hourPart ?? 0);
  const minute = Number(minutePart ?? 0);
  const second = Number(secondPart ?? 0);
  const ms = Number(msPart ?? 0);
  const iso = `${datePart}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.${String(ms).padStart(3, '0')}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseTimestamp = (value: unknown, fallback: number): number => {
  if (isNumberLike(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  const raw = readString(value);
  if (!raw) return fallback;
  const stDate = parseSillyTavernHumanDate(raw);
  if (stDate) return stDate;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return numeric > 1e12 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeSpeakerName = (payload: Record<string, unknown>): string => {
  return (
    readString(payload.name) ||
    readString(payload.character) ||
    readString(payload.character_name) ||
    readString(payload.characterName) ||
    readString(payload.speaker)
  );
};

const parseSwipes = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
};

const parseSwipeId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  const raw = readString(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
};

const pickSwipeContent = (swipes: string[], swipeId: number | null): string => {
  if (swipes.length === 0) return '';
  if (typeof swipeId === 'number' && Number.isFinite(swipeId)) {
    const index = Math.min(Math.max(swipeId, 0), swipes.length - 1);
    return swipes[index] ?? swipes[0] ?? '';
  }
  return swipes[0] ?? '';
};

export const parseSillyTavernJsonl = (params: {
  text: string;
  sessionId: string;
  createId: () => string;
  userDisplayName?: string;
  now?: number;
}): ParseJsonlResult => {
  const lines = params.text.split(/\r?\n/);
  const warnings: string[] = [];
  const messages: MagicTeaPartyMessage[] = [];
  const now = typeof params.now === 'number' ? params.now : Date.now();
  let fallbackUserName = readString(params.userDisplayName);
  let fallbackCharacterName = '';

  lines.forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      warnings.push(`第 ${index + 1} 行 JSON 解析失败，已跳过。`);
      return;
    }

    const hasHeaderFields =
      (typeof parsed.user_name === 'string' || typeof parsed.character_name === 'string' || parsed.chat_metadata) &&
      !readString(parsed.mes) &&
      !readString(parsed.content) &&
      !readString(parsed.text) &&
      typeof parsed.is_user === 'undefined';
    if (hasHeaderFields) {
      if (readString(parsed.user_name)) fallbackUserName = readString(parsed.user_name);
      if (readString(parsed.character_name)) fallbackCharacterName = readString(parsed.character_name);
      return;
    }

    const swipes = parseSwipes(parsed.swipes);
    const swipeId = parseSwipeId(parsed.swipe_id);
    const content =
      readString(parsed.mes) ||
      readString(parsed.content) ||
      readString(parsed.text) ||
      readString(parsed.message) ||
      pickSwipeContent(swipes, swipeId);
    const extra = asRecord(parsed.extra);
    const mtExtra = asRecord(extra?.magic_tea_party) ?? asRecord(extra?.magic_tavern);
    // Either known alias can carry a denial; an empty preferred slot must not hide it.
    const outcomeSlots = [asRecord(extra?.magic_tea_party), asRecord(extra?.magic_tavern)]
      .filter((slot): slot is Record<string, unknown> => Boolean(slot && Object.prototype.hasOwnProperty.call(slot, 'choiceOutcome')));
    const hasChoiceOutcome = outcomeSlots.length > 0;
    const outcomes = outcomeSlots.map(slot => parseChoiceOutcome(slot.choiceOutcome));
    const firstOutcome = outcomes[0];
    const choiceOutcome = firstOutcome && outcomes.every(outcome => outcome && choiceOutcomeIdentity(outcome) === choiceOutcomeIdentity(firstOutcome)) ? firstOutcome : null;
    if (!content && !hasChoiceOutcome) {
      warnings.push(`第 ${index + 1} 行缺少内容字段，已跳过。`);
      return;
    }

    const isUser =
      parsed.is_user === true ||
      parsed.is_user === 'true' ||
      parsed.is_user === 1;
    const isSystem =
      parsed.is_system === true ||
      parsed.is_system === 'true' ||
      parsed.is_system === 1;
    const speakerName = normalizeSpeakerName(parsed);
    const createdAt = parseTimestamp(
      parsed.send_date ?? parsed.send_date_utc ?? parsed.create_date ?? parsed.created_at ?? parsed.timestamp,
      now + index
    );
    const resolvedSpeakerName =
      speakerName ||
      (isUser ? fallbackUserName || params.userDisplayName || '' : isSystem ? 'system' : fallbackCharacterName);

    if (hasChoiceOutcome && !choiceOutcome) warnings.push(`第 ${index + 1} 行选项终态信息无效，已保留原文并禁用行动。`);
    const extraSpeakerId = mtExtra && typeof mtExtra.speakerId === 'string' ? mtExtra.speakerId : undefined;
    const extraSegments = mtExtra && Array.isArray(mtExtra.segments) ? (mtExtra.segments as MagicTeaPartyOutputSegment[]) : undefined;
    const extraChoices = mtExtra && Array.isArray(mtExtra.choices) ? (mtExtra.choices as { id: string; text: string }[]) : undefined;
    const extraTachieId = mtExtra && typeof mtExtra.tachieId === 'string' ? mtExtra.tachieId : undefined;
    const extraRevisionOf = mtExtra && typeof mtExtra.revisionOf === 'string' ? mtExtra.revisionOf : undefined;

    const meta: Record<string, unknown> = {
      ...(choiceOutcome?.meta ?? (hasChoiceOutcome ? { choicesValid: false } : {})),
      ...(resolvedSpeakerName ? { speakerName: resolvedSpeakerName } : {}),
      source: {
        rawLine,
      },
      ...(swipes.length > 0 || typeof swipeId === 'number' || extra
        ? {
            sillyTavern: {
              ...(swipes.length > 0 ? { swipes } : {}),
              ...(typeof swipeId === 'number' ? { swipeId } : {}),
              ...(extra ? { extra } : {}),
            },
          }
        : {}),
    };

    messages.push({
      id: params.createId(),
      sessionId: params.sessionId,
      role: isSystem ? 'system' : isUser ? 'user' : 'assistant',
      content,
      createdAt,
      status: choiceOutcome?.status ?? (hasChoiceOutcome ? 'error' : 'done'),
      ...(choiceOutcome?.error ? { error: choiceOutcome.error } : hasChoiceOutcome && !choiceOutcome
        ? { error: { code: 'invalid_choice_outcome', message: '选项终态信息无效，已保留原文' } } : {}),
      ...(extraSpeakerId ? { speakerId: extraSpeakerId } : {}),
      ...(extraSegments ? { segments: extraSegments } : {}),
      ...(extraChoices ? { choices: extraChoices } : {}),
      ...(extraTachieId ? { tachieId: extraTachieId } : {}),
      ...(extraRevisionOf ? { revisionOf: extraRevisionOf } : {}),
      meta,
    });
  });

  return { messages, warnings };
};
