import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMagicTeaPartySessionExport, parseSillyTavernJsonl, stringifySillyTavernJsonl } from '../src/magic-tea-party/transfer';
import type { MagicTeaPartyMessage, MagicTeaPartySession } from '../src/magic-tea-party/types';
import { parseSillyTavernJsonl as parseBeforeSummary } from './fixtures/tea-jsonl-before-summary';

const outcome = {
  kind: 'summary', status: 'done', completion: 'provider', content: '  摘要正文😀\n', rawOutput: ' \n原始摘要输出\n ',
};
const choiceOutcome = { kind: 'choices', status: 'done', outputFormat: 'jsonl', choicesValid: true, completion: 'provider' };
const parse = (text: string) => parseSillyTavernJsonl({ text, sessionId: 'new-session', createId: () => 'new-message', now: 10 });
const message = (overrides: Partial<MagicTeaPartyMessage> = {}): MagicTeaPartyMessage => ({
  id: 'summary', sessionId: 'session', role: 'assistant', content: outcome.content, createdAt: 1, status: 'done',
  meta: { kind: 'summary', completion: 'provider', rawOutput: outcome.rawOutput }, ...overrides,
});
const stringify = (messages: MagicTeaPartyMessage[]) => stringifySillyTavernJsonl({ messages, userDisplayName: '旅人' });
afterEach(() => vi.restoreAllMocks());

describe('narrow terminal summary JSONL boundary', () => {
  it('uses a functional frozen reader that still imports ordinary text and empty-body choice outcomes', () => {
    const text = [JSON.stringify({ mes: '旧版普通剧情' }), JSON.stringify({ mes: '', extra: { magic_tea_party: { choiceOutcome } } })].join('\n');
    const restored = parseBeforeSummary({ text, sessionId: 'old', createId: () => 'old' });
    expect(restored.messages).toHaveLength(2);
    expect(restored.messages[0]!.content).toBe('旧版普通剧情');
    expect(restored.messages[1]!.meta?.kind).toBe('choices');
  });

  it.each(['done', 'error', 'blocked'] as const)('round trips exact summary content/raw for all terminal completions (%s)', status => {
    for (const completion of ['provider', 'stopped', 'failed', 'discarded']) {
      for (const content of ['', outcome.content]) {
        const source = message({ status, content, error: { code: 'original-code', message: '原始错误' },
          meta: { kind: 'summary', completion, rawOutput: outcome.rawOutput } });
        const text = stringify([source]);
        const restored = parse(text);
        expect(restored.warnings).toEqual([]);
        expect(restored.messages).toHaveLength(1);
        expect(restored.messages[0]).toMatchObject({ role: 'assistant', content, status, error: source.error,
          meta: { kind: 'summary', completion, rawOutput: outcome.rawOutput } });
        expect(restored.messages[0]).not.toHaveProperty('segments');
        expect(restored.messages[0]).not.toHaveProperty('choices');
        // Execute the real frozen reader, not a string-only guess about its empty-body behavior.
        expect(parseBeforeSummary({ text, sessionId: 'old', createId: () => 'old' }).messages).toEqual([]);
      }
    }
  });

  it('keeps every summary out of the old reader, even with hostile fallbacks and both legacy action aliases', () => {
    const extra = { other: { untouched: true },
      magic_tea_party: { choiceOutcome, summaryOutcome: { ...outcome, content: '冲突摘要' }, future: ['keep'], choices: [{ id: 'go', text: '执行' }] },
      magic_tavern: { choiceOutcome, summaryOutcome: null, segments: [{ type: 'narration', text: '旧正文' }], future: { keep: true } } };
    for (const status of ['done', 'error', 'blocked', 'streaming', undefined] as const) {
      const source = message({ status, role: 'system', content: '', segments: [{ type: 'narration', text: '不可降为正文' }],
        choices: [{ id: 'go', text: '不可执行' }], meta: { kind: 'summary', completion: 'stopped', rawOutput: '原文',
          source: { rawLine: '原始完整行', extra: { userOwned: true } },
          sillyTavern: { swipes: ['也不可降为正文'], swipeId: 0, extra } } });
      const text = stringify([source]);
      const row = JSON.parse(text.split('\n')[1]!);
      expect(row).toMatchObject({ mes: '', is_user: false, extra: { other: extra.other, magic_tea_party: {
        source: { message: { rawLine: '原始完整行', extra: { userOwned: true } }, extra: {
          magic_tea_party: extra.magic_tea_party, magic_tavern: extra.magic_tavern,
        } },
      } } });
      for (const key of ['content', 'message', 'text', 'swipes', 'segments', 'choices']) expect(row).not.toHaveProperty(key);
      expect(row.extra).not.toHaveProperty('magic_tavern');
      expect(row.extra.magic_tea_party).not.toHaveProperty('choiceOutcome');
      expect(row.extra.magic_tea_party).not.toHaveProperty('segments');
      expect(parseBeforeSummary({ text, sessionId: 'old', createId: () => 'old' }).messages).toEqual([]);
      expect(parse(text).messages[0]!.meta?.kind).toBe('summary');
    }
  });

  it.each(['magic_tea_party', 'magic_tavern'])('recognizes %s before header and empty-body gates', alias => {
    const text = JSON.stringify({ character_name: 'header-like', mes: '', extra: { magic_tea_party: {}, [alias]: { summaryOutcome: outcome } } });
    const result = parse(text);
    expect(result.warnings).toEqual([]);
    expect(result.messages[0]).toMatchObject({ role: 'assistant', content: outcome.content, meta: { kind: 'summary', rawOutput: outcome.rawOutput } });
  });

  it.each([null, false, [], {}, { ...outcome, status: ['done'] }, { ...outcome, completion: 'completed' },
    { ...outcome, content: null }, { ...outcome, rawOutput: 3 }, { ...outcome, futureAuthority: true },
    { ...outcome, error: { code: 'x', message: 'y', retry: true } }, { ...outcome, error: { code: 1, message: 'x' } },
  ])('fails closed on malformed or unknown summary fields: %j', summaryOutcome => {
    const extra = { magic_tea_party: {}, magic_tavern: { summaryOutcome, choices: [{ id: 'x', text: '行动' }],
      segments: [{ type: 'narration', text: '伪造剧情' }], updates: [{ currentStateSummary: '不得应用' }] } };
    const text = `  ${JSON.stringify({ character_name: 'header-like', mes: '伪造正文', extra })}  `;
    const result = parse(text);
    expect(result.warnings).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ role: 'assistant', content: '', status: 'error', error: { code: 'invalid_summary_outcome' },
      meta: { kind: 'summary', source: { rawLine: text }, sillyTavern: { extra } } });
    expect(result.messages[0]).not.toHaveProperty('choices');
    expect(result.messages[0]).not.toHaveProperty('segments');
  });

  it('compares complete normalized alias values, independent of object field order', () => {
    const error = { code: 'x', message: '错' };
    const first = { ...outcome, error };
    const reordered = { error: { message: '错', code: 'x' }, rawOutput: outcome.rawOutput, completion: 'provider',
      content: outcome.content, status: 'done', kind: 'summary' };
    const result = parse(JSON.stringify({ extra: { magic_tea_party: { summaryOutcome: first }, magic_tavern: { summaryOutcome: reordered } } }));
    expect(result.warnings).toEqual([]);
    expect(result.messages[0]!.error).toEqual(error);
    for (const field of ['content', 'rawOutput', 'completion', 'status', 'error'] as const) {
      const changed = { ...first, [field]: field === 'error' ? { ...error, message: '不同错误' }
        : field === 'status' ? 'error' : field === 'completion' ? 'stopped' : '不同文本' };
      const text = JSON.stringify({ mes: '', extra: { magic_tea_party: { summaryOutcome: first }, magic_tavern: { summaryOutcome: changed } } });
      expect(parse(text).messages[0]).toMatchObject({ status: 'error', error: { code: 'invalid_summary_outcome' }, meta: { kind: 'summary' } });
    }
  });

  it.each(['magic_tea_party', 'magic_tavern'])('does not upgrade mixed summary/choice evidence in %s', alias => {
    const extra = { magic_tea_party: { summaryOutcome: outcome }, magic_tavern: {}, [alias]: {
      ...(alias === 'magic_tea_party' ? { summaryOutcome: outcome } : {}), choiceOutcome,
      choices: [{ id: 'go', text: '不得执行' }],
    } };
    const text = JSON.stringify({ is_user: true, is_system: true, mes: '不得作为剧情', extra });
    const result = parse(text);
    expect(result.messages[0]).toMatchObject({ role: 'assistant', status: 'error', meta: { kind: 'summary', choicesValid: false, sillyTavern: { extra } } });
    expect(result.messages[0]).not.toHaveProperty('choices');
    expect(parseBeforeSummary({ text: stringify(result.messages), sessionId: 'old', createId: () => 'old' }).messages).toEqual([]);
  });

  it('keeps canonical summary JSONL byte-stable through repeated real parse/export cycles', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    let text = stringify([message({ createdAt: 1700000000001 })]);
    const initial = text;
    for (let index = 0; index < 30; index++) {
      text = stringify(parse(text).messages);
      expect(text).toBe(initial);
      expect(JSON.parse(text.split('\n')[1]!).extra.magic_tea_party).not.toHaveProperty('source');
      expect(parseBeforeSummary({ text, sessionId: 'old', createId: () => 'old' }).messages).toEqual([]);
    }
  });

  it('retains a complete conflicting foreign line once without amplifying its rawLine or alias evidence', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const extra = {
      other: { untouched: '原始其他元数据' },
      magic_tea_party: { summaryOutcome: outcome, unknownCurrent: ['完整原件'] },
      magic_tavern: { summaryOutcome: { ...outcome, content: '相冲突的摘要' }, choiceOutcome, unknownLegacy: { keep: true } },
    };
    const original = `  ${JSON.stringify({ name: '原名', mes: '不得当剧情', unknownTop: { keep: '原字段' }, extra, send_date: 1700000000001 })}  `;
    let text = stringify(parse(original).messages);
    const stable = text;
    for (let index = 0; index < 30; index++) {
      const row = JSON.parse(text.split('\n')[1]!);
      expect(row.extra.other).toEqual(extra.other);
      expect(row.extra.magic_tea_party.source).toEqual({ message: { rawLine: original } });
      expect(JSON.parse(row.extra.magic_tea_party.source.message.rawLine).extra).toEqual(extra);
      expect(parse(text).messages[0]).toMatchObject({ status: 'error', error: { code: 'invalid_summary_outcome' }, meta: { kind: 'summary' } });
      expect(parseBeforeSummary({ text, sessionId: 'old', createId: () => 'old' }).messages).toEqual([]);
      text = stringify(parse(text).messages);
      expect(text).toBe(stable);
    }
  });

  it('does not drop foreign unknown fields just because the summary alias resembles a canonical row', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    for (const row of [
      { name: 'Narrator', mes: '', is_user: false, send_date: 1700000000001, extra: { magic_tea_party: { summaryOutcome: outcome } }, unknownTop: ['keep'] },
      { name: 'Narrator', mes: '', is_user: false, send_date: 1700000000001, extra: { magic_tea_party: { summaryOutcome: outcome, unknownAlias: ['keep'] } } },
    ]) {
      const original = JSON.stringify(row);
      const exported = stringify(parse(original).messages);
      expect(JSON.parse(exported.split('\n')[1]!).extra.magic_tea_party.source).toEqual({ message: { rawLine: original } });
      expect(stringify(parse(exported).messages)).toBe(exported);
    }
  });

  it('preserves complete session summary, unknown fields and raw evidence in JSON export', () => {
    const session = { id: 'session', title: '茶会', createdAt: 1, updatedAt: 1, roles: [], settings: { providerId: 'p', modelId: 'm' },
      summary: '完整摘要', summaryMeta: { updatedAt: 1, coverage: { version: 1, sourceMessageCount: 1, selectedMessageIds: ['source'], clippedMessageIds: [], omittedMessageCount: 0 }, future: ['keep'] },
      future: { source: true } } as MagicTeaPartySession;
    const original = message({ meta: { ...message().meta, future: { preserved: true } } });
    const exported = buildMagicTeaPartySessionExport({ session, messages: [original] });
    expect(exported.session).toMatchObject({ summary: session.summary, summaryMeta: session.summaryMeta, future: { source: true } });
    expect(exported.messages[0]).toBe(original);
  });
});
