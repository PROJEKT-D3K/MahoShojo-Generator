import type { MagicTeaPartyHistoryMessage, MagicTeaPartySession } from '@mahoshojo/domain/magic-tea-party/types';
import { estimateMagicTeaPartyTokens, resolveMagicTeaPartyTokenBudget } from './budget';
import { buildMagicTeaPartySummarizePrompt } from './prompts';
import { projectMagicTeaPartySummaryInput, type MagicTeaPartySummaryInputProjection } from './summary';

/** All eligible history is counted, while hosts may retain only bounded tail descriptors. */
export type MagicTeaPartyAutoSummaryScan = {
  sourceMessageCount: number;
  historyTokens: number;
  fromMessageId?: string;
  toMessageId?: string;
  summaryThroughIndex: number | null;
  lastAttemptedThroughIndex: number | null;
};

export const createMagicTeaPartyAutoSummaryScan = (): MagicTeaPartyAutoSummaryScan => ({
  sourceMessageCount: 0, historyTokens: 0, summaryThroughIndex: null, lastAttemptedThroughIndex: null,
});

export const appendMagicTeaPartyAutoSummaryMessage = (
  scan: MagicTeaPartyAutoSummaryScan,
  message: MagicTeaPartyHistoryMessage,
  options: {
    providerId?: string | null;
    userDisplayName?: string;
    summaryThroughMessageId?: string;
    lastAttemptedThroughMessageId?: string;
  },
): MagicTeaPartyAutoSummaryScan => ({
  sourceMessageCount: scan.sourceMessageCount + 1,
  historyTokens: scan.historyTokens + estimateMagicTeaPartyTokens(
    `${message.role === 'user' ? options.userDisplayName?.trim() || '{{user}}' : message.role}: ${message.content}`, options.providerId),
  fromMessageId: scan.fromMessageId ?? message.id,
  toMessageId: message.id,
  summaryThroughIndex: options.summaryThroughMessageId === message.id ? scan.sourceMessageCount : scan.summaryThroughIndex,
  lastAttemptedThroughIndex: options.lastAttemptedThroughMessageId === message.id ? scan.sourceMessageCount : scan.lastAttemptedThroughIndex,
});

/** Eligibility from one already-committed normal turn. This function never dispatches or restores work. */
export const planMagicTeaPartyAutoSummary = (params: {
  settings: MagicTeaPartySession['settings'];
  providerId?: string | null;
  scan: MagicTeaPartyAutoSummaryScan;
  consecutiveDroppedTurns: number;
}): { throughMessageId: string } | null => {
  const { settings, scan } = params;
  if (settings.autoSummaryEnabled !== true || !scan.toMessageId || !Number.isSafeInteger(scan.sourceMessageCount)
    || scan.sourceMessageCount < 1 || !Number.isFinite(scan.historyTokens) || scan.historyTokens < 0) return null;
  const budget = resolveMagicTeaPartyTokenBudget(settings, params.providerId);
  const anchors = [scan.summaryThroughIndex, scan.lastAttemptedThroughIndex].filter((value): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < scan.sourceMessageCount);
  const newest = anchors.length ? Math.max(...anchors) : -1;
  const gap = scan.sourceMessageCount - newest - 1;
  // Even a configured zero gap must not authorize a repeat for the same source.
  if (gap < Math.max(1, budget.summaryMinGapMessages)) return null;
  if (!(scan.historyTokens > budget.historyBudgetTokens * budget.summaryTriggerRatio
    || scan.sourceMessageCount > budget.maxContextMessages
    || params.consecutiveDroppedTurns >= 2)) return null;
  return { throughMessageId: scan.toMessageId };
};

const boundedSeed = (summary: string | undefined): string | null => {
  const text = summary?.trim();
  if (!text) return null;
  const content = `【既有摘要】\n${text}`;
  if (content.length <= 4000) return content;
  const suffix = '...[已截断]';
  let end = 4000 - suffix.length;
  const high = content.charCodeAt(end - 1); const low = content.charCodeAt(end);
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) end -= 1;
  return content.slice(0, end) + suffix;
};

export const resolveMagicTeaPartyAutoSummaryBudget = (params: {
  settings: MagicTeaPartySession['settings'];
  providerId?: string | null;
  previousSummary?: string;
  maxOutputTokens?: number;
}) => {
  const budget = resolveMagicTeaPartyTokenBudget(params.settings, params.providerId);
  const seedContent = boundedSeed(params.previousSummary);
  const fixedPrompt = buildMagicTeaPartySummarizePrompt({ messages: [], language: params.settings.language,
    userDisplayName: params.settings.userDisplayName });
  const seedTokens = seedContent ? estimateMagicTeaPartyTokens(`system: ${seedContent}`, params.providerId) : 0;
  const output = params.maxOutputTokens ?? budget.summaryMaxTokens;
  return {
    seedContent,
    historyBudgetTokens: Math.max(0, budget.historyBudgetTokens - estimateMagicTeaPartyTokens(fixedPrompt, params.providerId) - seedTokens),
    maxMessages: Math.min(Math.max(1, budget.maxContextMessages), seedContent ? 199 : 200),
    maxOutputTokens: Number.isSafeInteger(output) && output > 0 ? output : 1200,
    contextWindowTokens: budget.contextWindowTokens,
  };
};

/** The seed participates in the request check, never in archive-message coverage. */
export const projectMagicTeaPartyAutoSummaryInput = (
  params: Parameters<typeof projectMagicTeaPartySummaryInput>[0] & { seedContent?: string | null },
): MagicTeaPartySummaryInputProjection => {
  if (!params.seedContent?.trim()) return projectMagicTeaPartySummaryInput(params);
  let seedId = '@magic-tea-party-summary-seed';
  const ids = new Set(params.messages.map(message => message.id));
  while (ids.has(seedId)) seedId += ':';
  const projection = projectMagicTeaPartySummaryInput({ ...params,
    messages: [{ id: seedId, role: 'system', content: params.seedContent }, ...params.messages],
    sourceMessageCount: params.sourceMessageCount + 1 });
  const selectedMessageIds = projection.coverage.selectedMessageIds.slice(1);
  return { ...projection, coverage: {
    ...projection.coverage,
    sourceMessageCount: projection.coverage.sourceMessageCount - 1,
    selectedMessageIds,
    clippedMessageIds: projection.coverage.clippedMessageIds.filter(id => id !== seedId),
    omittedMessageCount: projection.coverage.sourceMessageCount - 1 - selectedMessageIds.length,
  } };
};
