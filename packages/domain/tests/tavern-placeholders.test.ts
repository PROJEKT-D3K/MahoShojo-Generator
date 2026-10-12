import { describe, expect, it, vi } from 'vitest';
import {
  applyTavernPlaceholderReplacement, resolveTavernCharReplacement, DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE,
  convertTavernToGeneralCard, MAX_TAVERN_PLACEHOLDER_WORK_BYTES, type TavernCardNormalized, type TavernCardCandidate,
} from '../src/tavern-card';

const preference = { ...DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE };
const config = { enabled: true, userReplacement: '用户', charReplacement: '角色' };
describe('Tavern placeholder rules', () => {
  it('keeps literal replacement, casing, two-pass order and tokens formed at insertion boundaries', () => {
    const source = { name: '{{user}} {{char}} {{USER}}', description: '{{{{user}}}}' };
    expect(applyTavernPlaceholderReplacement(source, { ...config, userReplacement: 'char', charReplacement: '$&{{user}}' }))
      .toMatchObject({ name: 'char $&{{user}} {{USER}}', description: '$&{{user}}' });
    expect(applyTavernPlaceholderReplacement({ name: '{{user}}' }, { ...config, userReplacement: '{{char}}', charReplacement: '{{user}}' }).name).toBe('{{user}}');
  });
  it('replaces only the original scalar/list whitelist, without mutating the source', () => {
    const source: TavernCardNormalized = {
      name: '{{char}}', description: '{{user}}', personality: '{{user}}', scenario: '{{user}}', firstMes: '{{user}}', mesExample: '{{user}}',
      creatorComment: '{{user}}', creatorNotes: '{{user}}', systemPrompt: '{{user}}', postHistoryInstructions: '{{user}}',
      alternateGreetings: ['{{user}}'], groupOnlyGreetings: ['{{char}}'], tags: ['{{user}}'], creator: '{{user}}',
      extensions: { text: '{{user}}' }, characterBook: { text: '{{user}}' },
    };
    const before = structuredClone(source);
    const result = applyTavernPlaceholderReplacement(source, config);
    for (const key of ['description', 'personality', 'scenario', 'firstMes', 'mesExample', 'creatorComment', 'creatorNotes', 'systemPrompt', 'postHistoryInstructions'] as const) expect(result[key]).toBe('用户');
    expect(result.alternateGreetings).toEqual(['用户']); expect(result.groupOnlyGreetings).toEqual(['角色']);
    expect(result.tags).toBe(source.tags); expect(result.extensions).toBe(source.extensions); expect(result.characterBook).toBe(source.characterBook); expect(result.creator).toBe('{{user}}');
    expect(source).toEqual(before);
  });
  it('preserves custom whitespace/empty values and resolves auto from the original name', () => {
    expect(resolveTavernCharReplacement('  Alice  ', preference)).toBe('Alice');
    for (const name of ['', '  ', '{{char}}', '{{user}} Alice']) expect(resolveTavernCharReplacement(name, preference)).toBe('角色');
    for (const customCharReplacement of ['', '  ', '{{user}}']) expect(resolveTavernCharReplacement('Alice', { ...preference, charReplacementMode: 'custom', customCharReplacement })).toBe(customCharReplacement);
    expect(applyTavernPlaceholderReplacement({ name: '{{user}}{{char}}' }, { ...config, userReplacement: '', charReplacement: '  ' }).name).toBe('  ');
  });
  it('derives each projection afresh and keeps the archived source unchanged', () => {
    const candidate: TavernCardCandidate = { keyword: 'json', chunkType: 'tEXt', parseMethod: 'json', parsed: { name: 'Alice', description: '{{user}} {{char}}', signature: 'unverified', data: { extensions: { keep: '{{user}}' } } } };
    const first = convertTavernToGeneralCard(candidate, preference);
    const second = convertTavernToGeneralCard(candidate, { ...preference, userReplacement: 'Bob' });
    const disabled = convertTavernToGeneralCard(candidate, { ...preference, enabled: false });
    expect(first.content).toContain('【某人】 Alice'); expect(second.content).toContain('Bob Alice'); expect(disabled.content).toContain('{{user}} {{char}}');
    expect(first._tavern.raw).toEqual(candidate.parsed); expect(second._tavern.raw).toEqual(candidate.parsed); expect(first).not.toHaveProperty('signature');
  });
  it('rejects amplification before split/join and does not truncate', () => {
    const source = { name: '{{user}}'.repeat(40_000) };
    const split = vi.spyOn(String.prototype, 'split');
    try {
      expect(() => applyTavernPlaceholderReplacement(source, { ...config, userReplacement: 'x'.repeat(1024) })).toThrow('32 MiB');
      expect(split).not.toHaveBeenCalled(); expect(source.name).toHaveLength(320_000);
    } finally { split.mockRestore(); }
  });
  it('counts UTF-8 bytes and accumulates all changed fields and both stages', () => {
    const source = { name: '{{user}}'.repeat(6000), description: '{{user}}'.repeat(6000), personality: '{{user}}'.repeat(6000) };
    expect(() => applyTavernPlaceholderReplacement(source, { ...config, userReplacement: '中'.repeat(1024) })).toThrow('32 MiB');
    expect(() => applyTavernPlaceholderReplacement({ name: '{{user}}'.repeat(3000) }, { ...config, userReplacement: '{{char}}'.repeat(1024), charReplacement: 'x' })).not.toThrow();
    expect(() => applyTavernPlaceholderReplacement({ name: '{{user}}'.repeat(4000) }, { ...config, userReplacement: '{{char}}'.repeat(1024), charReplacement: 'x' })).toThrow('32 MiB');
    expect(() => applyTavernPlaceholderReplacement({ name: 'Alice', alternateGreetings: [source.name, source.name] }, { ...config, userReplacement: '中'.repeat(1024) })).toThrow('32 MiB');
    expect(() => applyTavernPlaceholderReplacement({ name: '{{user}}'.repeat(5000) }, { ...config, userReplacement: '{{char}}'.repeat(1024), charReplacement: '' })).toThrow('32 MiB');
  });
  it('does not inspect unused replacement values or charge disabled/untouched text', () => {
    const source = { name: 'untouched', extensions: { value: '{{user}}' } };
    expect(applyTavernPlaceholderReplacement(source, { ...config, userReplacement: 'x'.repeat(MAX_TAVERN_PLACEHOLDER_WORK_BYTES + 1) })).toEqual(source);
    expect(applyTavernPlaceholderReplacement(source, { ...config, enabled: false })).toBe(source);
    const oversized = { name: 'x'.repeat(MAX_TAVERN_PLACEHOLDER_WORK_BYTES + 1) };
    expect(applyTavernPlaceholderReplacement(oversized, config).name).toBe(oversized.name);
    expect(applyTavernPlaceholderReplacement(oversized, { ...config, enabled: false })).toBe(oversized);
  });
  it('keeps surrogate joins byte-for-byte equivalent to the original literal two-pass rule', () => {
    for (const [name, userReplacement, charReplacement] of [
      ['\ud83d{{user}}', '\ude00', ''], ['{{user}}\ude00', '\ud83d', ''], ['\ud83d{{user}}\ude00', '', ''],
      ['{{user}}', '\ud83d{{char}}', '\ude00'], ['{{{{user}}}}', 'char', '\ud83d'],
    ]) {
      expect(applyTavernPlaceholderReplacement({ name }, { ...config, userReplacement, charReplacement }).name)
        .toBe(name.split('{{user}}').join(userReplacement).split('{{char}}').join(charReplacement));
    }
  });
});
