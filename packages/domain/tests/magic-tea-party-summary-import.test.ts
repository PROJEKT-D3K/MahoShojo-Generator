import { describe, expect, it, vi } from 'vitest';
import { buildMagicTeaPartyImportPlan } from '../src/magic-tea-party/import-plan';
import { buildMagicTeaPartySessionExport, stringifySillyTavernJsonl } from '../src/magic-tea-party/transfer';

const coverage = { version: 1, sourceMessageCount: 3, selectedMessageIds: ['a', 'c'], clippedMessageIds: ['c'], omittedMessageCount: 1 };
const entry = () => ({
  schema: 'magic-tea-party.session.v1',
  session: { id: 'session', summary: '摘要', summarySections: { recap: '原始内容' },
    summaryMeta: { updatedAt: 1, fromMessageId: 'a', toMessageId: 'c', coverage, unknownSummary: { selectedMessageIds: ['a'] } },
    unknownSession: { keep: true } },
  messages: ['a', 'b', 'c'].map((id, index) => ({ id, sessionId: 'session', role: 'user', content: id, createdAt: index })),
});
const plan = (value: unknown, prefix = 'new') => {
  let index = 0;
  return buildMagicTeaPartyImportPlan({ input: { format: 'json', value }, now: 10, createId: () => `${prefix}-${++index}`,
    normalizeSettings: () => ({ providerId: 'p', modelId: 'm' }) });
};

describe('summary coverage import preflight', () => {
  it('remaps every selected/clipped ID without treating the sparse selection as a continuous range', () => {
    const source = entry();
    const before = JSON.stringify(source);
    const restored = plan(source).entries[0]!;
    expect(restored.session.summaryMeta).toEqual({ updatedAt: 1, fromMessageId: restored.messages[0]!.id, toMessageId: restored.messages[2]!.id,
      coverage: { ...coverage, selectedMessageIds: [restored.messages[0]!.id, restored.messages[2]!.id], clippedMessageIds: [restored.messages[2]!.id] },
      unknownSummary: { selectedMessageIds: ['a'] } });
    expect(restored.session).toMatchObject({ summary: '摘要', unknownSession: { keep: true } });
    expect(JSON.stringify(source)).toBe(before);
  });

  it('preserves coverage, summary/raw and unknown extensions through the real JSON and archive export paths', () => {
    const source = entry();
    source.messages.push({ id: 'summary-message', sessionId: 'session', role: 'assistant', content: '精确摘要', createdAt: 3 });
    Object.assign(source.messages[3]!, { status: 'error', meta: { kind: 'summary', completion: 'stopped', rawOutput: ' \n原始摘要😀\n ', future: { keep: true } } });
    const imported = plan(source).entries[0]!;
    const exported = JSON.parse(JSON.stringify(buildMagicTeaPartySessionExport(imported)));
    const restored = plan({ schema: 'magic-tea-party.archive.v1', sessions: [exported], futureBackup: { keep: true } }, 'again').entries[0]!;
    expect(restored.session.summary).toBe('摘要');
    expect(restored.session.summaryMeta?.coverage).toMatchObject({ sourceMessageCount: 3, omittedMessageCount: 1,
      selectedMessageIds: [restored.messages[0]!.id, restored.messages[2]!.id], clippedMessageIds: [restored.messages[2]!.id] });
    expect(restored.messages[3]).toMatchObject({ content: '精确摘要', status: 'error', meta: { kind: 'summary', completion: 'stopped', rawOutput: ' \n原始摘要😀\n ', future: { keep: true } } });
    expect(restored.session).toMatchObject({ importMetadata: { sourceEnvelope: { archive: { futureBackup: { keep: true } } } } });
  });

  it.each([null, {}, { ...coverage, version: 2 }, { ...coverage, unknownAuthority: true },
    { ...coverage, sourceMessageCount: -1 }, { ...coverage, omittedMessageCount: 0.5 },
    { ...coverage, sourceMessageCount: Number.MAX_SAFE_INTEGER + 1 }, { ...coverage, omittedMessageCount: 0 },
    { ...coverage, selectedMessageIds: ['a', 'a'] },
    { ...coverage, selectedMessageIds: ['a', 'missing'] }, { ...coverage, selectedMessageIds: ['', 'c'] },
    { ...coverage, selectedMessageIds: [1, 'c'] }, { ...coverage, selectedMessageIds: null },
    { ...coverage, clippedMessageIds: ['b'] }, { ...coverage, clippedMessageIds: ['c', 'c'] },
    { ...coverage, clippedMessageIds: null }, { ...coverage, selectedMessageIds: Array.from({ length: 201 }, (_, i) => `m${i}`) },
  ])('rejects malformed coverage before ID allocation/normalization and leaves source intact: %j', invalid => {
    const source = entry();
    Object.assign(source.session.summaryMeta, { coverage: invalid });
    const before = JSON.stringify(source);
    const createId = vi.fn(() => 'new');
    const normalizeSettings = vi.fn(() => ({ providerId: 'p', modelId: 'm' }));
    expect(() => buildMagicTeaPartyImportPlan({ input: { format: 'json', value: source }, now: 10, createId, normalizeSettings })).toThrow();
    expect(createId).not.toHaveBeenCalled();
    expect(normalizeSettings).not.toHaveBeenCalled();
    expect(JSON.stringify(source)).toBe(before);
  });

  it('preserves prompt coverage order after remapped equal-timestamp messages are re-sorted by Web storage', () => {
    const source = entry();
    source.messages = ['old-a', 'old-b'].map(id => ({ id, sessionId: 'session', role: 'user', content: id, createdAt: 1 }));
    source.session.summaryMeta.fromMessageId = 'old-a';
    source.session.summaryMeta.toMessageId = 'old-b';
    source.session.summaryMeta.coverage = { version: 1, sourceMessageCount: 2,
      selectedMessageIds: ['old-a', 'old-b'], clippedMessageIds: [], omittedMessageCount: 0 };
    const generated = ['new-session', 'z', 'a'];
    const first = buildMagicTeaPartyImportPlan({ input: { format: 'json', value: source }, now: 10,
      createId: () => generated.shift()!, normalizeSettings: () => ({ providerId: 'p', modelId: 'm' }) }).entries[0]!;
    expect(first.session.summaryMeta!.coverage!.selectedMessageIds).toEqual(['z', 'a']);
    // The (sessionId, createdAt) index breaks timestamp ties by the newly generated primary key.
    first.messages.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    expect(first.messages.map(item => item.id)).toEqual(['a', 'z']);
    const exported = JSON.parse(JSON.stringify(buildMagicTeaPartySessionExport(first)));
    const restored = plan(exported, 'again').entries[0]!;
    expect(restored.session.summaryMeta!.coverage!.selectedMessageIds).toEqual([restored.messages[1]!.id, restored.messages[0]!.id]);
    expect(restored.messages.map(item => item.content)).toEqual(['old-b', 'old-a']);
  });

  it('does not make a same-batch foreign message an active coverage reference', () => {
    const source = entry();
    source.session.summaryMeta.coverage = { ...coverage, selectedMessageIds: ['a', 'foreign'], clippedMessageIds: [] };
    const foreign = { schema: source.schema, session: { id: 'foreign-session' }, messages: [{ id: 'foreign', role: 'user', content: '另一会话' }] };
    expect(() => plan({ schema: 'magic-tea-party.archive.v1', sessions: [source, foreign] })).toThrow('本会话');
  });

  it('accepts the 200-ID boundary and remaps the full list', () => {
    const source = entry();
    source.messages = Array.from({ length: 200 }, (_, index) => ({ id: `m${index}`, sessionId: 'session', role: 'user', content: '正文', createdAt: index }));
    source.session.summaryMeta.coverage = { version: 1, sourceMessageCount: 200,
      selectedMessageIds: source.messages.map(item => item.id), clippedMessageIds: ['m0', 'm199'], omittedMessageCount: 0 };
    const restored = plan(source).entries[0]!;
    expect(restored.session.summaryMeta?.coverage?.selectedMessageIds).toEqual(restored.messages.map(item => item.id));
    expect(restored.session.summaryMeta?.coverage?.clippedMessageIds).toEqual([restored.messages[0]!.id, restored.messages[199]!.id]);
  });

  it('imports JSONL summary evidence with fresh identities without claiming session.summary restoration', () => {
    const text = stringifySillyTavernJsonl({ userDisplayName: '旅人', messages: [{ id: 's', sessionId: 's', role: 'assistant', content: '摘要', status: 'done', createdAt: 1,
      meta: { kind: 'summary', completion: 'provider', rawOutput: '原文' } }] });
    let next = 0;
    const result = buildMagicTeaPartyImportPlan({ input: { format: 'jsonl', text }, now: 10, createId: () => `new-${++next}`,
      normalizeSettings: () => ({ providerId: 'p', modelId: 'm' }) });
    expect(result.entries[0]!.session.summary).toBeUndefined();
    expect(result.entries[0]!.messages[0]).toMatchObject({ id: 'new-2', sessionId: 'new-1', content: '摘要', meta: { kind: 'summary', completion: 'provider', rawOutput: '原文' } });
  });
});
