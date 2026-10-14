import { describe, expect, it } from 'vitest';
import { appendMagicTeaPartyAutoSummaryMessage, createMagicTeaPartyAutoSummaryScan, planMagicTeaPartyAutoSummary,
  projectMagicTeaPartyAutoSummaryInput, projectMagicTeaPartySummaryInput, resolveMagicTeaPartyAutoSummaryBudget,
  resolveMagicTeaPartyTokenBudget, trimMagicTeaPartyHistory, estimateMagicTeaPartyTokens } from '../src/magic-tea-party';
import type { MagicTeaPartySession } from '@mahoshojo/domain/magic-tea-party/types';

const settings: MagicTeaPartySession['settings'] = { providerId: 'openai', modelId: 'synthetic', autoSummaryEnabled: true };
const history = Array.from({ length: 130 }, (_, index) => ({ id: `m-${index}`, role: 'user' as const, content: `消息${index}` }));
const scan = (summaryThroughMessageId?: string, lastAttemptedThroughMessageId?: string) => history.reduce((state, message) =>
  appendMagicTeaPartyAutoSummaryMessage(state, message, { providerId: 'openai', summaryThroughMessageId, lastAttemptedThroughMessageId }), createMagicTeaPartyAutoSummaryScan());
const plan = (patch: Partial<Parameters<typeof planMagicTeaPartyAutoSummary>[0]> = {}) => planMagicTeaPartyAutoSummary({ settings, providerId: 'openai', scan: scan(), consecutiveDroppedTurns: 0, ...patch });

describe('explicit bounded auto-summary plan', () => {
  it('does not inherit old combined-output permission', () => {
    expect(plan({ settings: { providerId: 'openai', modelId: 'm', enableSummary: true, outputPlan: { summary: 'on', choices: 'on', updates: 'off' } } })).toBeNull();
    expect(plan({ settings: { ...settings, autoSummaryEnabled: false } })).toBeNull();
    expect(plan()).toEqual({ throughMessageId: 'm-129' });
  });
  it('uses strict token/count thresholds and exactly two dropped turns', () => {
    const budget = resolveMagicTeaPartyTokenBudget(settings, 'openai');
    const boundary = { ...scan(), sourceMessageCount: 120, historyTokens: budget.historyBudgetTokens * budget.summaryTriggerRatio };
    expect(plan({ scan: boundary })).toBeNull();
    expect(plan({ scan: { ...boundary, historyTokens: boundary.historyTokens + 1 } })).not.toBeNull();
    expect(plan({ scan: { ...boundary, sourceMessageCount: 121 } })).not.toBeNull();
    expect(plan({ scan: boundary, consecutiveDroppedTurns: 1 })).toBeNull();
    expect(plan({ scan: boundary, consecutiveDroppedTurns: 2 })).not.toBeNull();
  });
  it('uses the newer valid attempt or summary anchor and never repeats the same source', () => {
    expect(plan({ scan: scan('m-110', 'm-122') })).toBeNull();
    expect(plan({ scan: scan('m-122', 'm-110') })).toBeNull();
    expect(plan({ scan: scan('m-110', 'm-121') })).not.toBeNull();
    expect(plan({ scan: scan(undefined, 'm-129'), settings: { ...settings, summaryMinGapMessages: 0 } })).toBeNull();
    expect(plan({ scan: scan('missing', 'missing') })).not.toBeNull();
    expect(plan({ scan: { ...scan(), summaryThroughIndex: Infinity, lastAttemptedThroughIndex: 999 } })).not.toBeNull();
    expect(plan({ scan: { ...scan(), sourceMessageCount: 7 }, consecutiveDroppedTurns: 2 })).toBeNull();
    expect(plan({ scan: createMagicTeaPartyAutoSummaryScan(), consecutiveDroppedTurns: 2 })).toBeNull();
  });
});

describe('bounded auto-summary input', () => {
  it('charges the final seed and fixed prompt, counts the seed toward 200, and chooses the explicit output override', () => {
    const budget = resolveMagicTeaPartyAutoSummaryBudget({ settings: { ...settings, maxContextMessages: 200 }, providerId: 'openai', previousSummary: '😀'.repeat(5000) });
    expect(budget.seedContent?.startsWith('【既有摘要】\n')).toBe(true);
    expect(budget.seedContent!.length).toBeLessThanOrEqual(4000);
    expect(budget.seedContent).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(budget.maxMessages).toBe(199);
    expect(budget.maxOutputTokens).toBe(1200);
    expect(budget.historyBudgetTokens).toBeLessThan(resolveMagicTeaPartyTokenBudget(settings, 'openai').historyBudgetTokens - estimateMagicTeaPartyTokens(budget.seedContent!, 'openai'));
    expect(resolveMagicTeaPartyAutoSummaryBudget({ settings: { ...settings, summaryMaxTokens: 700 }, maxOutputTokens: 900 }).maxOutputTokens).toBe(900);
    expect(resolveMagicTeaPartyAutoSummaryBudget({ settings: { ...settings, summaryMaxTokens: 700 } }).maxOutputTokens).toBe(700);
  });
  it('matches the server manual projector byte-for-byte without claiming seed or omitted source coverage', () => {
    const source = [...history]; source[127] = { ...source[127]!, content: '中'.repeat(200000) };
    source[129] = { ...source[129]!, content: '尾部'.repeat(20000) };
    const budget = resolveMagicTeaPartyAutoSummaryBudget({ settings: { ...settings, contextWindowTokens: 8192, maxContextMessages: 200 }, providerId: 'openai', previousSummary: '旧摘要' });
    const selected = trimMagicTeaPartyHistory(source, { maxMessages: budget.maxMessages, tokenBudget: budget.historyBudgetTokens, providerId: 'openai', minKeep: 2 });
    // A source ID that resembles a synthetic ID must remain real coverage.
    selected[0] = { ...selected[0]!, id: '@magic-tea-party-summary-seed' };
    const result = projectMagicTeaPartyAutoSummaryInput({ messages: selected, seedContent: budget.seedContent, sourceMessageCount: source.length, contextWindowTokens: budget.contextWindowTokens });
    const server = projectMagicTeaPartySummaryInput({ messages: result.requestMessages, sourceMessageCount: result.requestMessages.length, contextWindowTokens: budget.contextWindowTokens });
    expect(result.prompt).toBe(server.prompt);
    expect(result.summaryInput).toEqual(server.summaryInput);
    expect(result.summaryInput.messageIds[0]).toBe('@magic-tea-party-summary-seed:');
    expect(result.coverage.selectedMessageIds).toContain('@magic-tea-party-summary-seed');
    expect(result.coverage.selectedMessageIds).not.toContain('@magic-tea-party-summary-seed:');
    expect(result.coverage.selectedMessageIds).not.toContain('m-127');
    expect(result.coverage.clippedMessageIds).toContain('m-129');
    expect(result.coverage.sourceMessageCount).toBe(source.length);
    expect(result.coverage.omittedMessageCount).toBe(source.length - selected.length);
  });
  it('preserves the manual projection when there is no seed', () => {
    const input = { messages: history, sourceMessageCount: history.length };
    expect(projectMagicTeaPartyAutoSummaryInput(input)).toEqual(projectMagicTeaPartySummaryInput(input));
    expect(projectMagicTeaPartyAutoSummaryInput({ ...input, seedContent: '   ' })).toEqual(projectMagicTeaPartySummaryInput(input));
  });
});
