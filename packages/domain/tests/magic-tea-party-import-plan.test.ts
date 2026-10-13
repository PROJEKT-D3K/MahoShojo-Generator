import { describe, expect, it, vi } from 'vitest';
import {
  buildMagicTeaPartyImportPlan, pickMagicTeaPartyRequestSettings, type MagicTeaPartyImportPlanOptions,
} from '../src/magic-tea-party/import-plan';
import { buildMagicTeaPartySessionExport, parseSillyTavernJsonl } from '../src/magic-tea-party/transfer';

type JsonRecord = Record<string, unknown>;
const role = { id: 'r1', name: '角色', source: 'local', card: { unknownCard: { keep: true } }, unknownRole: 'keep' };
const entry = (id: string, prefix: string) => ({
  schema: 'magic-tea-party.session.v1',
  session: {
    id, title: id, settings: { providerId: 'local', modelId: 'test', unknownOption: { url: 'https://never.invalid' }, outputPlan: { choices: 'auto', futurePlan: true } },
    summary: '摘要', summaryMeta: { updatedAt: 3, fromMessageId: `${prefix}1`, toMessageId: `${prefix}2`, unknownSummary: ['keep'] },
    protocolShadow: {
      updatedAt: 4, messageRange: { fromMessageId: `${prefix}1`, toMessageId: `${prefix}2`, unknownRange: true },
      drafts: [{ character: '角色', current_state_summary: '旧草稿', unknownDraft: true, meta: { sessionId: id, messageRange: { fromMessageId: `${prefix}1`, toMessageId: `${prefix}2`, count: 2 }, futureMeta: true } }],
      unknownProtocol: true,
    },
    updateSnapshot: {
      id: 'snapshot', createdAt: 4, mode: 'confirm', messageRange: { fromMessageId: `${prefix}1`, toMessageId: `${prefix}2` },
      drafts: [], rolesBefore: [role], rolesAfter: [role], unknownSnapshot: true,
    },
    unknownSession: { future: ['retained'] },
  },
  roles: [role], scenario: { id: 'scenario', title: '情景', source: 'local', card: { text: 'keep' }, future: true },
  auxScenarios: [],
  messages: [
    { id: `${prefix}1`, sessionId: id, role: 'user', content: '起点', createdAt: 1, unknownMessage: { future: true } },
    { id: `${prefix}2`, sessionId: id, role: 'assistant', content: '回应', createdAt: 2, sourceMessageId: `${prefix}1`, revisionOf: `${prefix}1`, tachieId: `${prefix}-asset`,
      segments: [{ type: 'dialogue', speakerId: 'r1', text: '对白', futureSegment: true }], meta: { unknownMeta: true } },
  ],
  tachieAssets: [{ id: `${prefix}-asset`, sessionId: id, anchorMessageId: `${prefix}2`, cacheKey: 'cache', fragmentHash: 'hash', styleId: 'style', imageUrl: 'https://image.invalid/a.png', blobRef: 'opaque-blob', createdAt: 1, lastUsedAt: 2, unknownAsset: true }],
  unknownEnvelope: { future: true },
});
const plan = (value: unknown, overrides: Partial<MagicTeaPartyImportPlanOptions> = {}) => {
  let next = 0;
  return buildMagicTeaPartyImportPlan({
    input: { format: 'json', value }, now: 100,
    createId: () => `new-${++next}`,
    normalizeSettings: known => ({ providerId: String(known?.providerId ?? 'unknown'), modelId: String(known?.modelId ?? ''), outputPlan: { choices: 'auto', summary: 'off', updates: 'on' } }),
    ...overrides,
  });
};
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('shared complete-batch tea import plan', () => {
  it('allocates the complete archive before remapping forward forks, messages, ranges, drafts and media', () => {
    const parent = entry('parent', 'p');
    const child = entry('child', 'c');
    Object.assign(child.session, { forkedFrom: { sessionId: 'parent', messageId: 'p2', createdAt: 4, futureFork: true } });
    child.messages[1].revisionOf = 'p2';
    const input = { schema: 'magic-tavern.archive.v1', sessions: [child, parent], unknownArchive: { keep: true } };
    const original = JSON.stringify(input);
    const result = plan(input);
    const [c, p] = result.entries;
    expect(result.kind).toBe('archive');
    expect(c.session.forkedFrom).toEqual({ sessionId: p.session.id, messageId: p.messages[1].id, createdAt: 4, futureFork: true });
    expect(c.messages[1]).toMatchObject({ sourceMessageId: c.messages[0].id, revisionOf: p.messages[1].id, tachieId: c.tachieAssets[0].id });
    expect(c.tachieAssets[0]).toMatchObject({ sessionId: c.session.id, anchorMessageId: c.messages[1].id, imageUrl: 'https://image.invalid/a.png', blobRef: 'opaque-blob', unknownAsset: true });
    expect(c.session.summaryMeta).toMatchObject({ fromMessageId: c.messages[0].id, toMessageId: c.messages[1].id, unknownSummary: ['keep'] });
    expect(c.session.protocolShadow).toMatchObject({ unknownProtocol: true, messageRange: { fromMessageId: c.messages[0].id, toMessageId: c.messages[1].id, count: 2, unknownRange: true }, drafts: [{ characterName: '角色', currentStateSummary: '旧草稿', unknownDraft: true, meta: { sessionId: c.session.id, messageRange: { fromMessageId: c.messages[0].id, toMessageId: c.messages[1].id, count: 2 }, futureMeta: true } }] });
    expect(c.session.updateSnapshot).toMatchObject({ unknownSnapshot: true, messageRange: { fromMessageId: c.messages[0].id, toMessageId: c.messages[1].id, count: 2 }, rolesBefore: [role], rolesAfter: [role] });
    expect(c.session).toMatchObject({ unknownSession: { future: ['retained'] }, importMetadata: { sourceEnvelope: { session: { unknownEnvelope: { future: true } }, archive: { unknownArchive: { keep: true } } } } });
    expect(JSON.stringify(input)).toBe(original);
    const allIds = result.entries.flatMap(item => [item.session.id, ...item.messages.map(message => message.id), ...item.tachieAssets.map(asset => asset.id)]);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('retains unknown settings in place while only known fields reach the normalizer or request projection', () => {
    const normalizeSettings = vi.fn(() => ({ providerId: 'normalized', modelId: 'model' }));
    const result = plan(entry('source', 'm'), { normalizeSettings });
    expect(normalizeSettings).toHaveBeenCalledWith({ providerId: 'local', modelId: 'test', outputPlan: { choices: 'auto' } });
    expect(result.entries[0].session.settings).toMatchObject({ providerId: 'normalized', unknownOption: { url: 'https://never.invalid' }, outputPlan: { choices: 'auto', futurePlan: true } });
    expect(pickMagicTeaPartyRequestSettings(result.entries[0].session.settings)).toEqual({ providerId: 'normalized', modelId: 'model', outputPlan: { choices: 'auto' } });
  });

  it('preserves unknown fields through real v1 export and reimport, without making external forks live', () => {
    const input = entry('source', 'm');
    Object.assign(input.session, { forkedFrom: { sessionId: 'existing-local-id', messageId: 'existing-local-message', createdAt: 8 }, importMetadata: { userExtension: ['keep'] } });
    const first = plan(input);
    expect(first.warnings.join('')).toContain('未解析来源');
    expect(first.entries[0].session.forkedFrom).toBeUndefined();
    expect(first.entries[0].session).toMatchObject({ importMetadata: { unresolvedForkedFrom: { sessionId: 'existing-local-id', messageId: 'existing-local-message', createdAt: 8 }, userExtension: ['keep'] } });
    let serial = 0;
    const second = plan(json(buildMagicTeaPartySessionExport(first.entries[0])), { createId: () => `again-${++serial}` });
    expect(second.entries[0].session.forkedFrom).toBeUndefined();
    expect(second.entries[0].session).toMatchObject({ unknownSession: input.session.unknownSession, importMetadata: { unresolvedForkedFrom: { sessionId: 'existing-local-id', messageId: 'existing-local-message', createdAt: 8 } } });
    expect(second.entries[0].messages[0]).toMatchObject({ unknownMessage: { future: true } });
    expect(second.entries[0].tachieAssets[0]).toMatchObject({ unknownAsset: true });
  });

  it.each(['session', 'message', 'asset'])('rejects duplicate original %s IDs before invoking the normalizer', type => {
    const a = entry('a', 'a'); const b = entry('b', 'b');
    if (type === 'session') b.session.id = a.session.id;
    if (type === 'message') b.messages[0].id = a.messages[0].id;
    if (type === 'asset') b.tachieAssets[0].id = a.tachieAssets[0].id;
    const normalizeSettings = vi.fn(() => ({ providerId: '', modelId: '' }));
    expect(() => plan({ schema: 'magic-tea-party.archive.v1', sessions: [a, b] }, { normalizeSettings })).toThrow(/重复|不属于/);
    expect(normalizeSettings).not.toHaveBeenCalled();
  });

  it('rejects ambiguous internal fork ownership and generated ID collisions', () => {
    const a = entry('a', 'a'); const b = entry('b', 'b');
    Object.assign(a.session, { forkedFrom: { sessionId: 'b', messageId: 'a1', createdAt: 1 } });
    expect(() => plan({ schema: 'magic-tea-party.archive.v1', sessions: [a, b] })).toThrow('内部来源消息不属于父会话');
    expect(() => plan(b, { createId: () => 'same' })).toThrow('新 ID 必须唯一');
    expect(() => plan(b, { createId: () => 'b1' })).toThrow('新 ID 必须唯一');
  });

  it('rejects cyclic internal fork chains before generating any new identities', () => {
    const a = entry('a', 'a'); const b = entry('b', 'b');
    Object.assign(a.session, { forkedFrom: { sessionId: 'b', messageId: 'b1', createdAt: 1 } });
    Object.assign(b.session, { forkedFrom: { sessionId: 'a', messageId: 'a1', createdAt: 1 } });
    const createId = vi.fn(() => 'new');
    expect(() => plan({ schema: 'magic-tea-party.archive.v1', sessions: [a, b] }, { createId })).toThrow('分支环');
    expect(createId).not.toHaveBeenCalled();
  });

  it('keeps legacy embedded roles, scenarios and null settings defaults', () => {
    const result = plan({ schema: 'magic-tavern.session.v1', session: {
      id: 'source', roles: [role], scenario: { id: 'scene', title: '场景', source: 'local', card: {} },
      auxScenarios: [], settings: null,
    }, roles: [], auxScenarios: [], messages: [] });
    expect(result.entries[0].session).toMatchObject({ roles: [role], scenario: { id: 'scene', title: '场景' }, settings: { providerId: 'unknown', modelId: '' } });
  });

  it.each([false, { unresolvedForkedFrom: { userOwned: true } }])('rejects occupied provenance slots without replacing unknown values', metadata => {
    const input = entry('source', 'm');
    Object.assign(input.session, { forkedFrom: { sessionId: 'external', messageId: 'external-message', createdAt: 1 }, importMetadata: metadata });
    const before = JSON.stringify(input);
    expect(() => plan(input)).toThrow(/元数据/);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('rejects an unknown envelope provenance collision', () => {
    const input = entry('source', 'm');
    Object.assign(input.session, { importMetadata: { sourceEnvelope: { userOwned: true } } });
    expect(() => plan(input)).toThrow('来源元数据冲突');
  });

  it.each(['__proto__', 'constructor', 'prototype'])('rejects prototype key %s at any metadata depth', key => {
    const input = entry('source', 'm');
    Object.assign(input.session, { unknownSession: JSON.parse(`{"${key}":{"polluted":true}}`) });
    expect(() => plan(input)).toThrow('不安全的对象键');
    expect(({} as JsonRecord).polluted).toBeUndefined();
  });

  it.each([NaN, Infinity, undefined, () => 'no', new Date()])('rejects non-JSON extension values: %s', illegal => {
    const input = entry('source', 'm'); Object.assign(input.session, { illegal });
    expect(() => plan(input)).toThrow(/JSON|有限/);
  });

  it('rejects accessors without invoking them and rejects cycles', () => {
    const input = entry('source', 'm'); const getter = vi.fn(() => 'no');
    Object.defineProperty(input.session, 'extension', { enumerable: true, get: getter });
    expect(() => plan(input)).toThrow('访问器'); expect(getter).not.toHaveBeenCalled();
    const cyclic = entry('source', 'm'); Object.assign(cyclic.session, { extension: cyclic });
    expect(() => plan(cyclic)).toThrow('循环引用');
  });

  it('applies only explicitly supplied host capacity limits', () => {
    const input = entry('source', 'm');
    expect(() => plan(input, { limits: { maxNodes: 2 } })).toThrow('结构超过');
    expect(() => plan(input, { limits: { maxDepth: 2 } })).toThrow('结构超过');
    expect(() => plan(input, { limits: { maxBytes: 64 } })).toThrow('字节预算');
    expect(plan(input).entries).toHaveLength(1);
  });

  it('uses the existing JSONL parser warnings, rawLine and legacy media extra with fresh identities', () => {
    const row = '  {"id":"original-message","name":"叙述者","mes":"  正文  ","send_date":1700000000,"extra":{"future":true,"magic_tavern":{"tachieId":"legacy-media","speakerId":"role-old"}}}  ';
    const text = ['{"user_name":"旅人"}', row, '{broken'].join('\r\n');
    const parsed = parseSillyTavernJsonl({ text, sessionId: 'old', createId: () => 'old-message', now: 100 });
    const result = plan(null, { input: { format: 'jsonl', text }, titleHint: '旧日志' });
    expect(result.warnings).toEqual(parsed.warnings);
    expect(result.entries[0].session.title).toBe('旧日志');
    expect(result.entries[0].messages[0]).toEqual({ ...parsed.messages[0], id: 'new-2', sessionId: 'new-1' });
    expect(result.entries[0].messages[0].meta).toMatchObject({ source: { rawLine: row } });
  });

  it('remaps JSONL revision references when original line identities are supplied', () => {
    const text = [
      JSON.stringify({ id: 'a', mes: 'old', is_user: true }),
      JSON.stringify({ id: 'b', mes: 'new', extra: { magic_tea_party: { revisionOf: 'a' } } }),
    ].join('\n');
    const result = plan(null, { input: { format: 'jsonl', text } });
    expect(result.entries[0].messages[1].revisionOf).toBe(result.entries[0].messages[0].id);
    expect(() => plan(null, { input: { format: 'jsonl', text: text.replace('"id":"b"', '"id":"a"') } })).toThrow('原始 ID 重复');
  });
  it('preserves parser skip warnings for primitive/array lines and accepts numeric message IDs', () => {
    const row = '{"id":42,"mes":"有效正文","extra":{"future":true}}';
    const text = ['42', '[]', row].join('\n');
    const baseline = parseSillyTavernJsonl({ text, sessionId: 'old', createId: () => 'old-message', now: 100 });
    const result = plan(null, { input: { format: 'jsonl', text } });
    expect(result.warnings).toEqual(baseline.warnings);
    expect(result.warnings).toHaveLength(2);
    expect(result.entries[0].messages[0]).toEqual({ ...baseline.messages[0], id: 'new-2', sessionId: 'new-1' });
  });

  it('does not collide explicit JSONL identities with parser-only temporary IDs', () => {
    const text = [
      '{"mes":"没有原 ID"}',
      '{"id":"@jsonl-message-1","mes":"有原 ID"}',
      '{"id":"revision","mes":"后续","extra":{"magic_tea_party":{"revisionOf":"@jsonl-message-1"}}}',
    ].join('\n');
    const result = plan(null, { input: { format: 'jsonl', text } });
    expect(result.entries[0].messages).toHaveLength(3);
    expect(new Set(result.entries[0].messages.map(message => message.id)).size).toBe(3);
    expect(result.entries[0].messages[2].revisionOf).toBe(result.entries[0].messages[1].id);
  });

  it.each(['title', 'summary', 'draft', 'branchLabel'])('rejects malformed known session text %s while retaining unknown records', key => {
    const input = entry('source', 'm');
    Object.assign(input.session, { [key]: { x: 1 } });
    expect(() => plan(input)).toThrow('必须为字符串');
    expect(plan(entry('source', 'm')).entries[0].session).toMatchObject({ unknownSession: { future: ['retained'] } });
  });

  it.each(['impact', 'currentStateSummary', 'winner', 'current_state_summary'])('rejects malformed known draft text %s', key => {
    const input = entry('source', 'm');
    Object.assign(input.session.protocolShadow.drafts[0], { [key]: { x: 1 } });
    expect(() => plan(input)).toThrow('必须为字符串');
  });

  it('rejects malformed summary section values and role notes before producing a plan', () => {
    const input = entry('source', 'm');
    Object.assign(input.session, { summarySections: { recap: { x: 1 } } });
    expect(() => plan(input)).toThrow('必须为字符串');
    const roleInput = entry('source', 'm');
    roleInput.roles = [{ ...role, notes: { x: 1 } } as unknown as typeof role];
    expect(() => plan(roleInput)).toThrow('必须为字符串');
  });

  it('remaps only known supersededBySessionId metadata including a forward session reference', () => {
    const first = entry('first', 'f'); const later = entry('later', 'l');
    Object.assign(first.messages[1], { meta: { supersededBySessionId: 'later', future: { supersededBySessionId: 'later' } } });
    Object.assign(later.messages[1], { meta: { supersededBySessionId: 'external-session', future: true } });
    const result = plan({ schema: 'magic-tea-party.archive.v1', sessions: [first, later] });
    expect(result.entries[0].messages[1].meta).toEqual({ supersededBySessionId: result.entries[1].session.id, future: { supersededBySessionId: 'later' } });
    expect(result.entries[1].messages[1].meta).toEqual({ supersededBySessionId: 'external-session', future: true });
  });

});
