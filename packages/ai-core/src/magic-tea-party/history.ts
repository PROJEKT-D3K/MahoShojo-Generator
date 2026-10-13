import { estimateMagicTeaPartyTokens } from './budget';
import type { MagicTeaPartyHistoryMessage, MagicTeaPartyMessage } from '@mahoshojo/domain/magic-tea-party/types';

const isMessageSuperseded = (message: MagicTeaPartyMessage): boolean => {
  const meta = message.meta && typeof message.meta === 'object' ? (message.meta as Record<string, unknown>) : null;
  return Boolean(meta && meta.superseded === true);
};

const isNoticeSuppressed = (message: MagicTeaPartyMessage): boolean => {
  const meta = message.meta && typeof message.meta === 'object' ? (message.meta as Record<string, unknown>) : null;
  return Boolean(meta && meta.noticeSuppressed === true);
};

const shouldIncludeInHistory = (message: MagicTeaPartyMessage): boolean => {
  if (message.meta?.kind === 'summary') return false;
  if (isMessageSuperseded(message)) return false;
  if (isNoticeSuppressed(message)) return false;
  if (message.role === 'user') return true;
  if (message.role !== 'assistant') return false;
  if (message.status === 'blocked' || message.status === 'error') return false;
  return true;
};

type BuildHistoryOptions = {
  includeEmptyContent?: boolean;
  // eslint-disable-next-line no-unused-vars -- 保留旧 API 的类型参数名，无运行时绑定。
  extraFilter?: (message: MagicTeaPartyMessage) => boolean;
};

export const buildMagicTeaPartyHistory = (
  messages: MagicTeaPartyMessage[],
  options?: BuildHistoryOptions
): MagicTeaPartyHistoryMessage[] => {
  const includeEmptyContent = options?.includeEmptyContent ?? true;
  const extraFilter = options?.extraFilter;

  return messages
    .filter(shouldIncludeInHistory)
    .filter((message) => (extraFilter ? extraFilter(message) : true))
    .filter((message) => {
      if (includeEmptyContent) return true;
      return typeof message.content === 'string' && message.content.trim().length > 0;
    })
    .map((message) => ({ id: message.id, role: message.role, content: message.content }));
};

export type TrimMagicTeaPartyHistoryOptions = {
  maxMessages: number;
  tokenBudget: number;
  providerId?: string | null;
  userDisplayName?: string;
  minKeep?: number;
};

export type EstimateMagicTeaPartyHistoryOptions = {
  providerId?: string | null;
  userDisplayName?: string;
};

/** Positions refer to the original ordered history, even when IDs repeat. */
export const selectMagicTeaPartyHistoryPositions = (
  length: number,
  // eslint-disable-next-line no-unused-vars -- 函数类型参数不是运行时绑定。
  estimateAt: (index: number) => number,
  options: Pick<TrimMagicTeaPartyHistoryOptions, 'maxMessages' | 'tokenBudget' | 'minKeep'>,
): number[] => {
  if (length === 0) return [];
  const maxMessages = Number.isFinite(options.maxMessages) ? Math.max(1, Math.floor(options.maxMessages)) : length;
  const minKeepRaw = typeof options.minKeep === 'number' ? options.minKeep : 1;
  const minKeep = Number.isFinite(minKeepRaw) ? Math.max(1, Math.floor(minKeepRaw)) : 1;
  const start = Math.max(0, length - maxMessages);
  const budget = Number.isFinite(options.tokenBudget) ? Math.max(0, Math.floor(options.tokenBudget)) : 0;
  if (budget <= 0 || length - start <= minKeep) {
    return Array.from({ length: Math.min(length - start, minKeep) }, (_, index) => Math.max(start, length - minKeep) + index);
  }
  const kept: number[] = [];
  let usedTokens = 0;
  for (let index = length - 1; index >= start; index -= 1) {
    const estimate = estimateAt(index);
    if (kept.length < minKeep || usedTokens + estimate <= budget) {
      kept.push(index);
      usedTokens += estimate;
    }
  }
  return kept.reverse();
};

export const trimMagicTeaPartyHistory = (
  history: MagicTeaPartyHistoryMessage[],
  options: TrimMagicTeaPartyHistoryOptions
): MagicTeaPartyHistoryMessage[] => {
  if (!Array.isArray(history) || history.length === 0) return [];
  const userLabel = options.userDisplayName?.trim() || '{{user}}';
  return selectMagicTeaPartyHistoryPositions(history.length, index => {
    const message = history[index];
    const prefix = message.role === 'user' ? userLabel : message.role;
    return estimateMagicTeaPartyTokens(`${prefix}: ${message.content}`, options.providerId);
  }, options).map(index => history[index]);
};

export const estimateMagicTeaPartyHistoryTokens = (
  history: MagicTeaPartyHistoryMessage[],
  options?: EstimateMagicTeaPartyHistoryOptions
): number => {
  if (!Array.isArray(history) || history.length === 0) return 0;
  const userLabel = options?.userDisplayName?.trim() || '{{user}}';
  const providerId = options?.providerId ?? null;
  let total = 0;

  for (const message of history) {
    if (!message) continue;
    const content = typeof message.content === 'string' ? message.content : '';
    const prefix = message.role === 'user' ? userLabel : message.role;
    total += estimateMagicTeaPartyTokens(`${prefix}: ${content}`, providerId);
  }

  return total;
};
