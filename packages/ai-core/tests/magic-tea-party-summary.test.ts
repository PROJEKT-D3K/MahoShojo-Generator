import { describe, expect, it } from 'vitest';
import type { MagicTeaPartyHistoryMessage, MagicTeaPartyMessage } from '@mahoshojo/domain/magic-tea-party/types';
import {
  buildMagicTeaPartyHistory,
  matchesMagicTeaPartySummaryInput,
  projectMagicTeaPartySummaryInput,
  trimMagicTeaPartyHistory,
} from '../src/magic-tea-party';

const project = (messages: MagicTeaPartyHistoryMessage[], contextWindowTokens = 128_000, sourceMessageCount = messages.length) =>
  projectMagicTeaPartySummaryInput({ messages, contextWindowTokens, sourceMessageCount, userDisplayName: '  旅人  ', language: 'zh-CN' });

describe('manual summary input projection', () => {
  it('preserves context head/tail clipping before the formatter head cap, including the tail only at the small tier', () => {
    const source = [{ id: 'u1', role: 'user' as const, content: `${'甲'.repeat(39_998)}尾声` }];
    const small = project(source, 8192);
    const body = `${'甲'.repeat(5566)}\n\n…（本条消息过长，已省略中段 32048 字）…\n\n${'甲'.repeat(2384)}尾声`;
    expect(small.requestMessages).toEqual([{ ...source[0], content: body }]);
    expect(small.prompt.endsWith(`【对话记录】\n旅人: ${body}`)).toBe(true);
    expect(small.summaryInput).toEqual({ messageIds: ['u1'], contentLengths: [body.length] });

    const large = project(source, 128_000);
    expect(large.requestMessages[0].content.endsWith('尾声')).toBe(true);
    expect(large.prompt.endsWith(`旅人: ${'甲'.repeat(8000)}...[已截断]`)).toBe(true);
    expect(large.prompt).not.toContain('尾声');
    expect(large.summaryInput.contentLengths).toEqual([8008]);
    expect(large.coverage.clippedMessageIds).toEqual(['u1']);
  });

  it('accounts for both clipping stages, uses formatter body lengths without labels and strips metadata from requests', () => {
    const messages = [
      { id: 'user', role: 'user' as const, content: ' u ', meta: { unknown: true }, settings: { unknown: true } },
      { id: 'assistant', role: 'assistant' as const, content: 'a'.repeat(12_001) },
      { id: 'system', role: 'system' as const, content: 's'.repeat(4_001) },
      { id: 'context', role: 'assistant' as const, content: 'c'.repeat(50_000) },
    ];
    const before = structuredClone(messages);
    const result = project(messages, 128_000, 8);
    expect(result.summaryInput).toEqual({ messageIds: ['user', 'assistant', 'system', 'context'], contentLengths: [1, 12_008, 4_008, 12_008] });
    expect(result.coverage).toEqual({ version: 1, sourceMessageCount: 8, selectedMessageIds: ['user', 'assistant', 'system', 'context'],
      clippedMessageIds: ['assistant', 'system', 'context'], omittedMessageCount: 4 });
    expect(result.requestMessages[0]).toEqual({ id: 'user', role: 'user', content: ' u ' });
    expect(messages).toEqual(before);
    expect(result.coverage).not.toHaveProperty('omittedChars');
  });

  it('retreats the formatter cut for surrogate pairs and retains legacy whitespace handling', () => {
    const result = project([
      { id: 'pair', role: 'user', content: `  ${'a'.repeat(7999)}😀z  ` },
      { id: 'empty', role: 'assistant', content: ' \n\t ' },
    ]);
    expect(result.prompt.endsWith(`旅人: ${'a'.repeat(7999)}...[已截断]`)).toBe(true);
    expect(result.summaryInput).toEqual({ messageIds: ['pair'], contentLengths: [8007] });
    expect(result.coverage).toEqual({ version: 1, sourceMessageCount: 2, selectedMessageIds: ['pair'], clippedMessageIds: ['pair'], omittedMessageCount: 1 });
  });

  it('preserves noncontiguous trim selection and reports whole-message omissions separately from clipping', () => {
    const history: MagicTeaPartyHistoryMessage[] = [
      { id: 'first', role: 'user', content: '甲' },
      { id: 'omitted', role: 'assistant', content: '长'.repeat(1000) },
      { id: 'last', role: 'assistant', content: '乙' },
    ];
    const selected = trimMagicTeaPartyHistory(history, { maxMessages: 3, tokenBudget: 100, providerId: 'openai', minKeep: 1 });
    expect(selected.map((message) => message.id)).toEqual(['first', 'last']);
    expect(project(selected, 128_000, history.length).coverage).toEqual({
      version: 1, sourceMessageCount: 3, selectedMessageIds: ['first', 'last'], clippedMessageIds: [], omittedMessageCount: 1,
    });
  });

  it('matches server re-projection of the request without replacing first-pass source coverage', () => {
    const first = project([{ id: 'long', role: 'assistant', content: 'a'.repeat(40_000) }], 8192, 12);
    const server = project(first.requestMessages, 8192);
    expect(first.prompt).toBe(server.prompt);
    expect(matchesMagicTeaPartySummaryInput(server.summaryInput, first.summaryInput)).toBe(true);
    expect(first.coverage).toMatchObject({ sourceMessageCount: 12, clippedMessageIds: ['long'], omittedMessageCount: 11 });
    expect(server.coverage.clippedMessageIds).toEqual([]);
    for (const invalid of [undefined, null, {}, { messageIds: ['other'], contentLengths: first.summaryInput.contentLengths },
      { messageIds: ['long'], contentLengths: [1] }, { messageIds: ['long', 'extra'], contentLengths: first.summaryInput.contentLengths }]) {
      expect(matchesMagicTeaPartySummaryInput(invalid, first.summaryInput)).toBe(false);
    }
  });

  it('merges bounded-adapter context clip facts without claiming unrelated or empty IDs', () => {
    const first = project([{ id: 'source', role: 'assistant', content: '中'.repeat(40000) }], 8192, 3);
    const bounded = projectMagicTeaPartySummaryInput({ messages: first.requestMessages, sourceMessageCount: 3, contextWindowTokens: 8192,
      contextClippedMessageIds: ['source', 'missing'] });
    expect(bounded.coverage).toEqual(first.coverage);
  });

  it('excludes every summary operation record from shared history, even empty, failed or user-shaped records', () => {
    const messages: MagicTeaPartyMessage[] = [
      { id: 'story', sessionId: 'tea', role: 'assistant', content: '故事', createdAt: 0 },
      ...(['done', 'error', 'blocked'] as const).map((status) => ({
        id: status, sessionId: 'tea', role: 'assistant' as const, content: status === 'error' ? '' : '摘要', createdAt: 1, status, meta: { kind: 'summary' },
      })),
      { id: 'user-summary', sessionId: 'tea', role: 'user', content: '摘要', createdAt: 1, meta: { kind: 'summary' } },
    ];
    expect(buildMagicTeaPartyHistory(messages)).toEqual([{ id: 'story', role: 'assistant', content: '故事' }]);
    expect(buildMagicTeaPartyHistory(messages, { includeEmptyContent: false })).toEqual([{ id: 'story', role: 'assistant', content: '故事' }]);
  });
});
