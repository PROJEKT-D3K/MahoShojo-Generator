import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildMagicTeaPartySessionExport, parseSillyTavernJsonl, stringifySillyTavernJsonl } from '../src/magic-tea-party/transfer';
import type { MagicTeaPartyMessage, MagicTeaPartySession } from '../src/magic-tea-party/types';

describe('magic tea party transfer', () => {
  it.each(['done', 'error', 'blocked'] as const)('preserves the narrow choices terminal evidence through JSONL (%s)', status => {
    const rawOutput = ' \n{"type":"choices","items":[{"id":"c1","text":"喝茶😀"}]}\n';
    const message: MagicTeaPartyMessage = { id: 'old', sessionId: 's', role: 'assistant', content: '喝茶😀', createdAt: 1, status,
      segments: [{ type: 'choices', items: [{ id: 'c1', text: '喝茶😀' }] }], choices: [{ id: 'c1', text: '喝茶😀' }],
      meta: { kind: 'choices', outputFormat: 'jsonl', completion: status === 'done' ? 'provider' : status === 'error' ? 'stopped' : 'blocked', choicesValid: status === 'done', rawOutput,
        notices: [{ type: 'notice', level: 'warning', message: '保留提示', meta: { inert: ['original'] } }], unrelated: 'not part of the narrow JSONL seam' },
      ...(status === 'error' ? { error: { code: 'stopped', message: '已停止' } } : {}) };
    const text = stringifySillyTavernJsonl({ messages: [message], userDisplayName: '旅人' });
    const { messages, warnings } = parseSillyTavernJsonl({ text, sessionId: 'restored', createId: () => 'new' });
    expect(warnings).toEqual([]); expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ status, segments: message.segments, choices: message.choices, meta: {
      kind: 'choices', outputFormat: 'jsonl', completion: message.meta!.completion, choicesValid: status === 'done', rawOutput, notices: message.meta!.notices } });
    expect(messages[0]!.error).toEqual(message.error); expect(messages[0]!.meta).not.toHaveProperty('unrelated');
  });
  it('keeps empty failed choices and an unfinished exported choices placeholder non-actionable', () => {
    for (const status of ['error', 'streaming'] as const) {
      const message: MagicTeaPartyMessage = { id: 'a', sessionId: 's', role: 'assistant', content: '', createdAt: 1, status,
        meta: { kind: 'choices', outputFormat: 'jsonl', choicesValid: false, rawOutput: '' } };
      const text = stringifySillyTavernJsonl({ messages: [message], userDisplayName: '旅人' });
      const parsed = parseSillyTavernJsonl({ text, sessionId: 'new', createId: () => 'm' });
      expect(parsed.messages).toHaveLength(1); expect(parsed.messages[0]).toMatchObject({ status: 'error', meta: { choicesValid: false } });
      expect(parsed.warnings.length).toBe(status === 'streaming' ? 1 : 0);
    }
  });
  it.each([null, { status: 'done', choicesValid: true }, { status: 'done', kind: 'choices', outputFormat: 'jsonl', choicesValid: 'true' },
    { status: 'done', kind: 'choices', outputFormat: 'jsonl', completion: ['provider'] },
    { status: 'done', kind: 'choices', outputFormat: 'jsonl', rawOutput: 4 },
    { status: 'done', kind: 'choices', outputFormat: 'jsonl', notices: [{ type: 'notice', level: ['error'], message: 'invalid' }] },
    { status: 'done', kind: 'choices', outputFormat: 'jsonl', futureAuthority: true }])('preserves invalid imported choiceOutcome inertly and fails closed: %j', choiceOutcome => {
    const extra = { magic_tea_party: { segments: [{ type: 'choices', items: [{ id: 'c1', text: '原文保留' }] }], choiceOutcome } };
    const text = JSON.stringify({ is_user: false, mes: '原文保留', extra });
    const parsed = parseSillyTavernJsonl({ text, sessionId: 'new', createId: () => 'm' });
    expect(parsed.warnings).toHaveLength(1); expect(parsed.messages[0]).toMatchObject({ status: 'error', meta: { choicesValid: false, sillyTavern: { extra } } });
  });
  it('retains contradictory true as untrusted evidence and keeps truly legacy JSONL compatible', () => {
    const choices = [{ id: 'c1', text: '继续' }];
    for (const outcome of [undefined, { status: 'error', kind: 'choices', outputFormat: 'jsonl', completion: 'stopped', choicesValid: true,
      notices: [{ type: 'notice', level: 'error', message: '不能继续' }] }]) {
      const text = JSON.stringify({ is_user: false, mes: '继续', extra: { magic_tea_party: { segments: [{ type: 'choices', items: choices }], choices, ...(outcome ? { choiceOutcome: outcome } : {}) } } });
      const parsed = parseSillyTavernJsonl({ text, sessionId: 'new', createId: () => 'm' });
      expect(parsed.warnings).toEqual([]); expect(parsed.messages[0]).toMatchObject({ status: outcome ? 'error' : 'done', choices });
      if (outcome) expect(parsed.messages[0]!.meta).toMatchObject({ completion: 'stopped', choicesValid: true, notices: outcome.notices });
      else expect(parsed.messages[0]!.meta).not.toHaveProperty('choicesValid');
    }
  });
  it('checks both known JSONL aliases so an empty primary slot cannot hide a terminal denial', () => {
    const segments = [{ type: 'choices', items: [{ id: 'c1', text: '不可由首槽重新启用' }] }];
    const stopped = { status: 'error', kind: 'choices', outputFormat: 'jsonl', completion: 'stopped', choicesValid: false };
    for (const primary of [{ segments }, { segments, choiceOutcome: { ...stopped, status: 'done', completion: 'completed', choicesValid: true } },
      { segments, choiceOutcome: stopped }, { segments, choiceOutcome: null }]) {
      const extra = { magic_tea_party: primary, magic_tavern: { choiceOutcome: stopped } };
      const text = JSON.stringify({ is_user: false, mes: '前缀', extra });
      const result = parseSillyTavernJsonl({ text, sessionId: 'new', createId: () => 'm' });
      expect(result.messages[0]).toMatchObject({ status: 'error', segments, meta: { choicesValid: false, sillyTavern: { extra } } });
      expect(result.warnings.length).toBe(!('choiceOutcome' in primary) || primary.choiceOutcome === stopped ? 0 : 1);
    }
  });
  it('可以导入 SillyTavern JSONL', () => {
    const text = [
      '{"user_name":"旅人","character_name":"Narrator","create_date":"2024-01-01 @00h 00m 00s 000ms"}',
      '{"name":"旅人","is_user":true,"mes":"你好","send_date":"2024-01-01T00:00:00.000Z"}',
      '{"name":"Narrator","is_user":false,"mes":"欢迎来到茶会","send_date":1700000000}',
    ].join('\n');

    let counter = 0;
    const { messages, warnings } = parseSillyTavernJsonl({
      text,
      sessionId: 's1',
      createId: () => `m${(counter += 1)}`,
      userDisplayName: '旅人',
      now: 0,
    });

    expect(warnings).toHaveLength(0);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('你好');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('欢迎来到茶会');
  });

  it('导出 SillyTavern JSONL 会优先使用分段文本', () => {
    const messages: MagicTeaPartyMessage[] = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        content: '',
        createdAt: 0,
        segments: [{ type: 'dialogue', speakerId: 'r1', speakerName: '星见澪', text: '要来一杯草莓奶茶吗？' }],
      },
    ];
    const jsonl = stringifySillyTavernJsonl({
      messages,
      userDisplayName: '旅人',
      roleNameLookup: (id) => id,
    });
    const lines = jsonl.split('\n').map((row) => JSON.parse(row));
    expect(lines[0].user_name).toBe('旅人');
    expect(lines[0].character_name).toBe('星见澪');
    expect(lines[1].mes).toBe('星见澪: 要来一杯草莓奶茶吗？');
    expect(lines[1].is_user).toBe(false);
    expect(typeof lines[1].send_date).toBe('number');
  });

  it('优先使用 swipes 作为内容', () => {
    const text = [
      '{"user_name":"旅人","character_name":"Narrator","create_date":"2024-01-01 @00h 00m 00s 000ms"}',
      '{"name":"Narrator","is_user":false,"swipes":["候选 A","候选 B"],"swipe_id":1,"mes":""}',
    ].join('\n');

    const { messages, warnings } = parseSillyTavernJsonl({
      text,
      sessionId: 's1',
      createId: () => 'm1',
      userDisplayName: '',
      now: 0,
    });

    expect(warnings).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('候选 B');
  });
});

const EXPORTED_AT = '2026-01-17T00:00:00.000Z';
const makeSession = (): MagicTeaPartySession => ({
  id: 'session-source',
  title: '茶会',
  createdAt: 1,
  updatedAt: 2,
  roles: [],
  settings: { providerId: 'test', modelId: 'model' },
});
const parse = (text: string) => {
  let id = 0;
  return parseSillyTavernJsonl({ text, sessionId: 'session-new', createId: () => `new-${++id}`, now: 123 });
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('tea party exchange format compatibility boundaries', () => {
  it('session export retains runtime extensions and reference identity without validating or deep cloning', () => {
    const role = { id: 'role', name: '角色', source: 'local' as const, card: { unknown: { kept: true } }, extension: 'role-extra' };
    const scenario = { id: 'scenario', title: '情景', source: 'local' as const, card: { extra: 2 }, extension: 'scenario-extra' };
    const session = { ...makeSession(), roles: [role], scenario, auxScenarios: [scenario], extension: { nested: 'session-extra' } };
    const message = { id: 'old-message', sessionId: session.id, role: 'assistant' as const, content: '正文', createdAt: 3, extension: 'message-extra' };
    const asset = { id: 'old-asset', sessionId: session.id, cacheKey: 'cache', fragmentHash: 'fragment', styleId: 'style', createdAt: 4, lastUsedAt: 5,
      imageUrl: 'https://example.invalid/image.png', blobRef: 'local-reference', blobSize: 17, extension: 'asset-extra' };
    const messages = [message];
    const tachieAssets = [asset];
    const output = buildMagicTeaPartySessionExport({ session, messages, tachieAssets, exportedAt: EXPORTED_AT, appVersion: 'fixture' });
    expect(output).toEqual({ schema: 'magic-tea-party.session.v1', exportedAt: EXPORTED_AT, appVersion: 'fixture',
      session: { id: 'session-source', title: '茶会', createdAt: 1, updatedAt: 2, settings: session.settings, extension: session.extension },
      roles: [role], scenario, auxScenarios: [scenario], messages, tachieAssets });
    expect(output.roles).toBe(session.roles);
    expect(output.scenario).toBe(scenario);
    expect(output.messages).toBe(messages);
    expect(output.tachieAssets).toBe(tachieAssets);
    expect(output.session.settings).toBe(session.settings);
    expect(JSON.parse(JSON.stringify(output)).tachieAssets).toEqual([asset]);
  });

  it('retains existing default time and array fallbacks, with metadata only', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(EXPORTED_AT));
    const output = buildMagicTeaPartySessionExport({
      session: { ...makeSession(), roles: null, auxScenarios: 'invalid' } as unknown as MagicTeaPartySession,
      messages: null as unknown as MagicTeaPartyMessage[],
    });
    expect(output.exportedAt).toBe(EXPORTED_AT);
    expect(output).toMatchObject({ roles: [], scenario: null, auxScenarios: [], messages: [], tachieAssets: [] });
    expect(JSON.parse(JSON.stringify(output))).not.toHaveProperty('appVersion');
  });

  it('keeps raw message line but discards blank/header lines and warns on malformed or contentless lines', () => {
    const raw = '  {"mes":"  内容  ","unknownTop":{"keptOnlyInRaw":true}}  ';
    const result = parse(['{"user_name":"旅人","character_name":"角色"}', '', raw, '{bad', '{"name":"空"}'].join('\r\n'));
    expect(result.warnings).toEqual(['第 4 行 JSON 解析失败，已跳过。', '第 5 行缺少内容字段，已跳过。']);
    expect(result.messages).toEqual([{ id: 'new-1', sessionId: 'session-new', role: 'assistant', content: '内容', createdAt: 125,
      status: 'done', meta: { speakerName: '角色', source: { rawLine: raw } } }]);
    expect(result.messages[0]).not.toHaveProperty('unknownTop');
  });

  it('preserves the existing null-row exception rather than silently introducing a permissive parser', () => {
    expect(() => parse('null')).toThrow(TypeError);
  });

  it.each([
    [-8, 'A', -8], ['1.9', 'B', 1], [99, 'B', 99], [undefined, 'A', undefined],
  ])('retains swipe compression and clamping for selector %s', (swipeId, expected, storedId) => {
    const row = { swipes: [' A ', '', '  ', 'B'], ...(swipeId === undefined ? {} : { swipe_id: swipeId }) };
    const message = parse(JSON.stringify(row)).messages[0]!;
    expect(message.content).toBe(expected);
    expect(message.meta).toMatchObject({ sillyTavern: { swipes: ['A', 'B'], ...(storedId === undefined ? {} : { swipeId: storedId }) } });
  });

  it.each([
    [1700000000, 1700000000000], [1000000000000, 1000000000000000], [1000000000001, 1000000000001],
    ['2024-01-02 @03h 04m 05s 006ms', Date.UTC(2024, 0, 2, 3, 4, 5, 6)], ['invalid time', 123],
  ])('retains timestamp conversion for %s', (input, expected) => {
    expect(parse(JSON.stringify({ mes: '文本', send_date: input })).messages[0]!.createdAt).toBe(expected);
  });

  it('keeps legacy magic_tavern metadata and gives current magic_tea_party metadata precedence', () => {
    const legacy = { speakerId: 'legacy', tachieId: 'old-image', revisionOf: 'old-message', choices: [{ id: 'c1', text: '选择' }] };
    const first = parse(JSON.stringify({ mes: '旧格式', extra: { magic_tavern: legacy, other: { kept: true } } })).messages[0]!;
    expect(first).toMatchObject(legacy);
    expect(first.meta).toMatchObject({ sillyTavern: { extra: { magic_tavern: legacy, other: { kept: true } } } });
    const second = parse(JSON.stringify({ mes: '新格式', extra: { magic_tavern: legacy, magic_tea_party: { speakerId: 'current' } } })).messages[0]!;
    expect(second.speakerId).toBe('current');
    expect(second.tachieId).toBeUndefined();
  });

  it('exports the fixed existing JSONL mapping, reconstructing headers and the current magic block', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(EXPORTED_AT));
    const rawLine = JSON.stringify({ name: '原名', mes: ' 原文 ', unknownTop: 'not-restored', send_date: 1700000000001,
      extra: { other: { kept: true }, magic_tea_party: { speakerId: 'role', tachieId: 'old-image', unknownNested: 'replaced' } } });
    const input = parse(rawLine).messages;
    input[0]!.segments = [{ type: 'narration', text: '  旁白  ' }, { type: 'dialogue', speakerId: 'role', text: ' 台词 ' }, { type: 'choices', items: [{ id: 'a', text: ' 选项甲 ' }] }];
    const text = stringifySillyTavernJsonl({ messages: input, userDisplayName: ' 旅人 ', roleNameLookup: () => '角色' });
    expect(text).toBe([
      JSON.stringify({ user_name: '旅人', character_name: '原名', create_date: '2026-01-17 @00h 00m 00s 000ms', chat_metadata: { source: 'magic-tea-party' } }),
      JSON.stringify({ name: '原名', mes: '旁白\n角色: 台词\n选项：选项甲', send_date: 1700000000001, is_user: false,
        extra: { other: { kept: true }, magic_tea_party: { speakerId: 'role', segments: input[0]!.segments, choices: null, tachieId: 'old-image', revisionOf: null } } }),
    ].join('\n'));
    expect(text).not.toContain('unknownTop');
    expect(text).not.toContain('unknownNested');
    expect(text).not.toContain('rawLine');
    expect(input[0]!.meta).toMatchObject({ source: { rawLine } });
  });

  it('does not silently apply generation or ordinary-card size truncation to exchange text', () => {
    const content = '茶'.repeat(100_000);
    const result = parse(JSON.stringify({ mes: content }));
    expect(result.messages[0]!.content).toBe(content);
    const exported = stringifySillyTavernJsonl({ messages: result.messages, userDisplayName: '旅人' });
    expect(JSON.parse(exported.split('\n')[1]!).mes).toBe(content);
  });
});
