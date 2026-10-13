import type {
  MagicTeaPartyMessage,
  MagicTeaPartyOutputSegment,
  MagicTeaPartyRole,
  MagicTeaPartyScenario,
  MagicTeaPartySession,
  MagicTeaPartyTachieAsset,
} from './types';

export type MagicTeaPartySessionExport = {
  schema: 'magic-tea-party.session.v1';
  exportedAt: string;
  appVersion?: string;
  session: Omit<MagicTeaPartySession, 'roles' | 'scenario' | 'auxScenarios'>;
  roles: MagicTeaPartyRole[];
  scenario: MagicTeaPartyScenario | null;
  auxScenarios: MagicTeaPartyScenario[];
  messages: MagicTeaPartyMessage[];
  tachieAssets: MagicTeaPartyTachieAsset[];
};

export type MagicTeaPartyArchiveExport = {
  schema: 'magic-tea-party.archive.v1';
  exportedAt: string;
  appVersion?: string;
  sessions: MagicTeaPartySessionExport[];
};

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
const exportChoiceOutcome = (message: MagicTeaPartyMessage): Record<string, unknown> | null => {
  const meta = asRecord(message.meta);
  if (message.role !== 'assistant' || !meta || meta.kind !== 'choices' && typeof meta.choicesValid !== 'boolean') return null;
  return { status: message.status, kind: meta.kind === 'choices' ? 'choices' : 'reply', outputFormat: meta.outputFormat,
    ...Object.fromEntries(terminalMetaKeys.filter(key => key !== 'kind' && key !== 'outputFormat' && meta[key] !== undefined).map(key => [key, meta[key]])),
    ...(message.error ? { error: { code: message.error.code, message: message.error.message } } : {}) };
};
const choiceOutcomeIdentity = (outcome: ChoiceOutcome): string => JSON.stringify([
  outcome.status, outcome.meta.kind, outcome.meta.outputFormat, outcome.meta.completion, outcome.meta.choicesValid,
  outcome.meta.rawOutput, outcome.error?.code, outcome.error?.message,
  Array.isArray(outcome.meta.notices) ? outcome.meta.notices.map((notice: Record<string, unknown>) => [notice.type, notice.level, notice.code, notice.message]) : null,
]);

const summaryOutcomeKeys = ['kind', 'status', 'completion', 'content', 'rawOutput', 'error'];
type SummaryOutcome = {
  kind: 'summary';
  status: 'done' | 'error' | 'blocked';
  completion: 'provider' | 'stopped' | 'failed' | 'discarded';
  content: string;
  rawOutput: string;
  error?: { code: string; message: string };
};
const parseSummaryOutcome = (raw: unknown): SummaryOutcome | null => {
  const value = asRecord(raw);
  if (!value || Object.keys(value).some(key => !summaryOutcomeKeys.includes(key))) return null;
  if (value.kind !== 'summary' || value.status !== 'done' && value.status !== 'error' && value.status !== 'blocked') return null;
  if (typeof value.completion !== 'string' || !['provider', 'stopped', 'failed', 'discarded'].includes(value.completion)) return null;
  if (typeof value.content !== 'string' || typeof value.rawOutput !== 'string') return null;
  const error = value.error === undefined ? undefined : asRecord(value.error);
  if (value.error !== undefined && (!error || Object.keys(error).some(key => key !== 'code' && key !== 'message')
    || typeof error.code !== 'string' || typeof error.message !== 'string')) return null;
  return {
    kind: 'summary', status: value.status as SummaryOutcome['status'], completion: value.completion as SummaryOutcome['completion'],
    content: value.content, rawOutput: value.rawOutput,
    ...(error ? { error: { code: error.code as string, message: error.message as string } } : {}),
  };
};
const exportSummaryOutcome = (message: MagicTeaPartyMessage): Record<string, unknown> | null => {
  if (message.meta?.kind !== 'summary') return null;
  // Even unfinished/malformed summaries keep the marker so they cannot become story text.
  // The reader validates terminal values and fails closed while retaining the original line.
  return {
    kind: 'summary', status: message.status, completion: message.meta.completion,
    content: message.content, rawOutput: message.meta.rawOutput ?? '',
    ...(message.error ? { error: { code: message.error.code, message: message.error.message } } : {}),
  };
};

/** Re-export canonical rows without recursively embedding the row that already contains their provenance. */
const exportSummaryProvenance = (message: MagicTeaPartyMessage, outcome: Record<string, unknown>): Record<string, unknown> => {
  const extra = asRecord(asRecord(message.meta?.sillyTavern)?.extra);
  const source = asRecord(message.meta?.source);
  const rawLine = typeof source?.rawLine === 'string' ? source.rawLine : undefined;
  let raw: Record<string, unknown> | null = null;
  if (rawLine !== undefined) {
    try { raw = asRecord(JSON.parse(rawLine)); } catch { /* Preserve non-JSON provenance verbatim below. */ }
  }
  const rawExtra = asRecord(raw?.extra);
  const slot = asRecord(rawExtra?.magic_tea_party);
  const storedOutcome = parseSummaryOutcome(slot?.summaryOutcome);
  const currentOutcome = parseSummaryOutcome(outcome);
  const sameExtra = rawExtra !== null && JSON.stringify(rawExtra) === JSON.stringify(extra);
  const canonical = raw && rawLine === JSON.stringify(raw) && source && Object.keys(source).every(key => key === 'rawLine')
    && Object.keys(raw).every(key => ['name', 'mes', 'is_user', 'send_date', 'extra'].includes(key))
    && typeof raw.name === 'string' && raw.mes === '' && raw.is_user === false
    && typeof raw.send_date === 'number' && Number.isFinite(raw.send_date)
    && sameExtra && !Object.prototype.hasOwnProperty.call(rawExtra, 'magic_tavern')
    && slot && Object.keys(slot).every(key => key === 'summaryOutcome' || key === 'source')
    && storedOutcome && currentOutcome && JSON.stringify(storedOutcome) === JSON.stringify(currentOutcome);
  if (canonical && slot) {
    return Object.prototype.hasOwnProperty.call(slot, 'source') ? { source: slot.source } : {};
  }
  const originalAliases = Object.fromEntries(Object.entries(extra ?? {}).filter(([key]) => key === 'magic_tea_party' || key === 'magic_tavern'));
  // A parsed source line already contains the complete original extra. Keep that evidence once.
  // Independently edited metadata still needs its own copy when it no longer matches the line.
  const aliases = !sameExtra && Object.keys(originalAliases).length ? { extra: originalAliases } : {};
  return source || Object.keys(aliases).length ? { source: { ...(source ? { message: source } : {}), ...aliases } } : {};
};

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

const buildPlainTextFromSegments = (
  segments: MagicTeaPartyOutputSegment[] | undefined,
  roleNameLookup?: (_roleId: string) => string
): string => {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  const lines: string[] = [];
  for (const seg of segments) {
    if (!seg) continue;
    if (seg.type === 'narration') {
      const text = readString(seg.text);
      if (text) lines.push(text);
      continue;
    }
    if (seg.type === 'dialogue') {
      const speakerName = readString(seg.speakerName) || (roleNameLookup ? roleNameLookup(seg.speakerId) : seg.speakerId);
      const text = readString(seg.text);
      if (!text) continue;
      lines.push(speakerName ? `${speakerName}: ${text}` : text);
      continue;
    }
    if (seg.type === 'choices') {
      const items = seg.items?.map((item) => readString(item.text)).filter(Boolean) ?? [];
      if (items.length > 0) lines.push(`选项：${items.join(' / ')}`);
    }
  }
  return lines.join('\n').trim();
};

export const buildMagicTeaPartySessionExport = (params: {
  session: MagicTeaPartySession;
  messages: MagicTeaPartyMessage[];
  tachieAssets?: MagicTeaPartyTachieAsset[];
  appVersion?: string;
  exportedAt?: string;
}): MagicTeaPartySessionExport => {
  const { roles, scenario, auxScenarios, ...sessionCore } = params.session;
  return {
    schema: 'magic-tea-party.session.v1',
    exportedAt: params.exportedAt ?? new Date().toISOString(),
    appVersion: params.appVersion,
    session: sessionCore,
    roles: Array.isArray(roles) ? roles : [],
    scenario: scenario ?? null,
    auxScenarios: Array.isArray(auxScenarios) ? auxScenarios : [],
    messages: Array.isArray(params.messages) ? params.messages : [],
    tachieAssets: Array.isArray(params.tachieAssets) ? params.tachieAssets : [],
  };
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

    const extra = asRecord(parsed.extra);
    const aliases = [asRecord(extra?.magic_tea_party), asRecord(extra?.magic_tavern)];
    const summarySlots = aliases.filter((slot): slot is Record<string, unknown> =>
      Boolean(slot && Object.prototype.hasOwnProperty.call(slot, 'summaryOutcome')));
    const hasSummaryOutcome = summarySlots.length > 0;
    const summaryOutcomes = summarySlots.map(slot => parseSummaryOutcome(slot.summaryOutcome));
    const firstSummary = summaryOutcomes[0];
    const outcomeSlots = aliases.filter((slot): slot is Record<string, unknown> =>
      Boolean(slot && Object.prototype.hasOwnProperty.call(slot, 'choiceOutcome')));
    const hasChoiceOutcome = outcomeSlots.length > 0;
    const summaryOutcome = !hasChoiceOutcome && firstSummary
      && summaryOutcomes.every(outcome => outcome && JSON.stringify(outcome) === JSON.stringify(firstSummary)) ? firstSummary : null;

    const hasHeaderFields =
      (typeof parsed.user_name === 'string' || typeof parsed.character_name === 'string' || parsed.chat_metadata) &&
      !readString(parsed.mes) &&
      !readString(parsed.content) &&
      !readString(parsed.text) &&
      typeof parsed.is_user === 'undefined';
    if (hasHeaderFields && !hasSummaryOutcome) {
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
    const mtExtra = asRecord(extra?.magic_tea_party) ?? asRecord(extra?.magic_tavern);
    // Either known alias can carry a denial; an empty preferred slot must not hide it.
    const outcomes = hasSummaryOutcome ? [] : outcomeSlots.map(slot => parseChoiceOutcome(slot.choiceOutcome));
    const firstOutcome = outcomes[0];
    const choiceOutcome = firstOutcome && outcomes.every(outcome => outcome && choiceOutcomeIdentity(outcome) === choiceOutcomeIdentity(firstOutcome)) ? firstOutcome : null;
    if (!content && !hasChoiceOutcome && !hasSummaryOutcome) {
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

    if (hasSummaryOutcome) {
      if (!summaryOutcome) warnings.push(`第 ${index + 1} 行摘要终态信息无效，已保留原文并禁用行动。`);
      messages.push({
        id: params.createId(), sessionId: params.sessionId, role: 'assistant', createdAt,
        content: summaryOutcome?.content ?? '', status: summaryOutcome?.status ?? 'error',
        ...(summaryOutcome?.error ? { error: summaryOutcome.error } : !summaryOutcome
          ? { error: { code: 'invalid_summary_outcome', message: '摘要终态信息无效，已保留原文' } } : {}),
        meta: {
          kind: 'summary', completion: summaryOutcome?.completion ?? 'failed', rawOutput: summaryOutcome?.rawOutput ?? '',
          ...(hasChoiceOutcome ? { choicesValid: false } : {}),
          ...(resolvedSpeakerName ? { speakerName: resolvedSpeakerName } : {}),
          source: { rawLine },
          ...(extra ? { sillyTavern: { extra } } : {}),
        },
      });
      return;
    }

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

export const stringifySillyTavernJsonl = (params: {
  messages: MagicTeaPartyMessage[];
  userDisplayName: string;
  playerRoleName?: string;
  roleNameLookup?: (_roleId: string) => string;
}): string => {
  const lines: string[] = [];
  const lookup = params.roleNameLookup;
  const normalizedUserName = readString(params.userDisplayName) || 'User';

  const resolveAssistantName = (): string => {
    for (const message of params.messages) {
      if (!message || message.role !== 'assistant') continue;
      const metaSpeaker =
        message.meta && typeof message.meta === 'object' && typeof (message.meta as any).speakerName === 'string'
          ? readString((message.meta as any).speakerName)
          : '';
      if (metaSpeaker) return metaSpeaker;
      const segments = Array.isArray(message.segments) ? message.segments : [];
      const firstDialogue = segments.find((seg) => seg.type === 'dialogue');
      if (firstDialogue && firstDialogue.type === 'dialogue') {
        if (readString(firstDialogue.speakerName)) return readString(firstDialogue.speakerName);
        if (firstDialogue.speakerId && lookup) return lookup(firstDialogue.speakerId);
      }
    }
    return 'Narrator';
  };

  const formatHeaderDate = (timestamp: number): string => {
    const date = new Date(timestamp);
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mi = String(date.getUTCMinutes()).padStart(2, '0');
    const ss = String(date.getUTCSeconds()).padStart(2, '0');
    const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
    return `${yyyy}-${mm}-${dd} @${hh}h ${mi}m ${ss}s ${ms}ms`;
  };

  lines.push(
    JSON.stringify({
      user_name: normalizedUserName,
      character_name: resolveAssistantName(),
      create_date: formatHeaderDate(Date.now()),
      chat_metadata: { source: 'magic-tea-party' },
    })
  );

  for (const message of params.messages) {
    if (!message) continue;
    const isSystem = message.role === 'system';
    const isUser = message.role === 'user';
    const metaSpeaker =
      message.meta && typeof message.meta === 'object' && typeof (message.meta as any).speakerName === 'string'
        ? readString((message.meta as any).speakerName)
        : '';
    const speakerName = isUser
      ? params.playerRoleName || normalizedUserName || 'User'
      : metaSpeaker || (message.speakerId && lookup ? lookup(message.speakerId) : '') || 'Narrator';
    const summaryOutcome = exportSummaryOutcome(message);
    if (summaryOutcome) {
      const extra = asRecord(asRecord(message.meta?.sillyTavern)?.extra);
      const otherExtra = Object.fromEntries(Object.entries(extra ?? {}).filter(([key]) => key !== 'magic_tea_party' && key !== 'magic_tavern'));
      lines.push(JSON.stringify({
        name: speakerName, mes: '', is_user: false,
        send_date: typeof message.createdAt === 'number' && Number.isFinite(message.createdAt) ? message.createdAt : Date.now(),
        extra: {
          ...otherExtra,
          magic_tea_party: {
            summaryOutcome,
            // Preserve unknown/contradictory aliases only as stable, inert provenance.
            ...exportSummaryProvenance(message, summaryOutcome),
          },
        },
      }));
      continue;
    }
    const segmentText = buildPlainTextFromSegments(message.segments, lookup);
    const content = segmentText || readString(message.content);
    const choiceOutcome = exportChoiceOutcome(message);
    if (!content && !choiceOutcome) continue;

    const meta = message.meta && typeof message.meta === 'object' ? (message.meta as Record<string, unknown>) : null;
    const stMeta = meta && typeof meta.sillyTavern === 'object' ? (meta.sillyTavern as Record<string, unknown>) : null;
    const extraFromMeta =
      stMeta && typeof stMeta.extra === 'object' && stMeta.extra !== null ? (stMeta.extra as Record<string, unknown>) : null;
    const swipes = parseSwipes(stMeta?.swipes);
    const swipeId = parseSwipeId(stMeta?.swipeId);

    const payload: Record<string, unknown> = {
      name: speakerName,
      mes: content,
      send_date: typeof message.createdAt === 'number' && Number.isFinite(message.createdAt) ? message.createdAt : Date.now(),
    };
    if (isSystem) payload.is_system = true;
    payload.is_user = isUser;
    if (swipes.length > 0) payload.swipes = swipes;
    if (typeof swipeId === 'number') payload.swipe_id = swipeId;

    const extraPayload: Record<string, unknown> = {
      ...(extraFromMeta ? { ...extraFromMeta } : {}),
      magic_tea_party: {
        speakerId: message.speakerId,
        segments: message.segments ?? null,
        choices: message.choices ?? null,
        tachieId: message.tachieId ?? null,
        revisionOf: message.revisionOf ?? null,
        ...(choiceOutcome ? { choiceOutcome } : {}),
      },
    };
    payload.extra = extraPayload;
    lines.push(JSON.stringify(payload));
  }

  return lines.join('\n');
};
