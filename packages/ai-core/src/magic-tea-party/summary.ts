import type {
  MagicTeaPartyHistoryMessage,
  MagicTeaPartySession,
  MagicTeaPartySummaryCoverage,
} from '@mahoshojo/domain/magic-tea-party/types';
import { applyMagicTeaPartyMessageLimits, resolveMagicTeaPartyMessageCharLimit } from './message-limits';
import { buildMagicTeaPartySummarizePrompt, projectMagicTeaPartyDialogueHistory } from './prompts';

/** Auxiliary input check, not a digest or proof of the original message bytes. */
export type MagicTeaPartySummaryInput = {
  messageIds: string[];
  contentLengths: number[];
};

export type MagicTeaPartySummaryInputProjection = {
  requestMessages: MagicTeaPartyHistoryMessage[];
  prompt: string;
  summaryInput: MagicTeaPartySummaryInput;
  coverage: MagicTeaPartySummaryCoverage;
};

/** The caller selects history first; preserve the legacy context clip → formatter clip order. */
export const projectMagicTeaPartySummaryInput = (params: {
  messages: readonly MagicTeaPartyHistoryMessage[];
  contextWindowTokens?: number | null;
  language?: MagicTeaPartySession['settings']['language'];
  userDisplayName?: string;
  sourceMessageCount: number;
  /** Bounded adapters may context-clip each source record before retaining it. */
  contextClippedMessageIds?: readonly string[];
}): MagicTeaPartySummaryInputProjection => {
  const selected = params.messages.map(({ id, role, content }) => ({ id, role, content }));
  const limited = applyMagicTeaPartyMessageLimits(selected, resolveMagicTeaPartyMessageCharLimit(params.contextWindowTokens));
  const formatted = projectMagicTeaPartyDialogueHistory(limited.messages, params.userDisplayName?.trim() || '{{user}}');
  const clippedIds = new Set([
    ...(params.contextClippedMessageIds ?? []),
    ...limited.clippedMessages.map((message) => message.id),
    ...formatted.clippedMessageIds,
  ]);
  const sourceMessageCount = Number.isSafeInteger(params.sourceMessageCount)
    ? Math.max(selected.length, params.sourceMessageCount)
    : selected.length;

  return {
    requestMessages: limited.messages,
    prompt: buildMagicTeaPartySummarizePrompt({
      messages: limited.messages,
      language: params.language,
      userDisplayName: params.userDisplayName,
    }),
    summaryInput: { messageIds: formatted.messageIds, contentLengths: formatted.contentLengths },
    coverage: {
      version: 1,
      sourceMessageCount,
      selectedMessageIds: formatted.messageIds,
      clippedMessageIds: formatted.messageIds.filter((id) => clippedIds.has(id)),
      omittedMessageCount: sourceMessageCount - formatted.messageIds.length,
    },
  };
};

export const matchesMagicTeaPartySummaryInput = (actual: unknown, expected: MagicTeaPartySummaryInput): boolean => {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const input = actual as Record<string, unknown>;
  return Array.isArray(input.messageIds) && Array.isArray(input.contentLengths)
    && input.messageIds.length === expected.messageIds.length
    && input.contentLengths.length === expected.contentLengths.length
    && input.messageIds.every((id, index) => id === expected.messageIds[index])
    && input.contentLengths.every((length, index) => length === expected.contentLengths[index]);
};
