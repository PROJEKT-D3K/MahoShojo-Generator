import { describe, expect, it } from 'vitest';
import { getUtf8ByteLength, MAX_DATA_CARD_BYTES } from '@mahoshojo/domain/data-card-size';
import { buildTavernCloudSavePayload, estimateDataCardBytesAfterAuthorInjection, type TavernCloudSavePreset } from '@mahoshojo/domain/tavern-card/cloud';
import * as tavern from '@mahoshojo/domain/tavern-card';

const author = { id: 42, username: '作者🌸' };
const build = (input: unknown, preset: TavernCloudSavePreset = 'standard', maxBytes?: number) => {
  const result = buildTavernCloudSavePayload(input, author, preset, { maxBytes });
  if ('error' in result) throw new Error(result.error);
  return result;
};

describe('Tavern cloud projection', () => {
  it('exports one implementation and estimates UTF-8 after replacing author metadata', () => {
    expect(tavern.buildTavernCloudSavePayload).toBe(buildTavernCloudSavePayload);
    const data = { content: '中文🌸', _author: '原作者', _authorId: 1 };
    expect(estimateDataCardBytesAfterAuthorInjection(data, author)).toBe(
      getUtf8ByteLength(JSON.stringify({ ...data, _author: author.username, _authorId: author.id })),
    );
    // Author injection is only estimated here. The server remains its writer.
    expect(build(data).data).toEqual(data);
  });

  it.each<TavernCloudSavePreset>(['standard', 'light', 'minimal'])('%s removes raw only from the cloud copy, without mutating the source', (preset) => {
    const raw = { extensions: { unknown: ['原件', 1] }, signature: 'unverified' };
    const input = { name: '角色', content: '正文', extension: { untouched: true }, _tavern: { raw, meta: { name: '角色' } } };
    const before = JSON.stringify(input);
    const output = build(input, preset);
    expect(output.data).toEqual({ name: '角色', content: '正文', extension: { untouched: true }, _tavern: { meta: { name: '角色' } } });
    expect(output.warnings).toContain('保存到云端时已强制移除 `_tavern.raw`（体积很大，仅建议本地保留）。');
    expect(JSON.stringify(input)).toBe(before);
    expect(input._tavern.raw).toBe(raw);
  });

  it('standard preserves body, whitespace, examples, metadata and unknown extensions exactly', () => {
    const input = { content: `  ${'字'.repeat(30_000)}  `, mesExample: ' 样例 ', _tavern: { meta: { description: ' 描述 ', unknown: { nested: true } } } };
    expect(build(input).data).toEqual(input);
  });

  it.each([
    ['light', { content: 20_000, description: 8_000, personality: 8_000, scenario: 6_000, first_mes: 2_000, firstMes: 2_000, mes_example: 12_000, mesExample: 12_000, predictionBasis: 12_000, researcherNotes: 12_000 }],
    ['minimal', { content: 12_000, description: 6_000, personality: 6_000, scenario: 4_000, first_mes: 2_000, firstMes: 2_000, mes_example: 0, mesExample: 0, predictionBasis: 8_000, researcherNotes: 8_000 }],
  ] as const)('%s keeps the existing recursive field limits, including body truncation', (preset, limits) => {
    const long = `  ${'文'.repeat(30_000)}  `;
    const fields = Object.fromEntries(Object.keys(limits).map(key => [key, long]));
    const input = { ...fields, nested: [fields, { content: ' 短正文 ', other: long }], unknown: long };
    const expected = Object.fromEntries(Object.entries(limits).map(([key, limit]) => [key, limit === 0 ? '' : `${'文'.repeat(limit)}\n...[已截断]`]));
    expect(build(input, preset).data).toEqual({ ...expected, nested: [expected, { content: '短正文', other: long }], unknown: long });
    expect(input).toHaveProperty('content', long);
  });

  it('minimal keeps the original metadata allowlist and retains unknown non-meta extensions', () => {
    const kept = { extractedAt: 'fixture', sourceChunk: 'chara', spec: 'chara_card_v3', specVersion: '3.0', name: '角色', tags: ['a'], warnings: ['b'], sizes: { raw: 1 }, candidates: [1] };
    const input = { _tavern: { raw: {}, meta: { ...kept, description: '移除', personality: '移除', mesExample: '移除', unknown: true }, extension: { kept: true } } };
    expect(build(input, 'minimal').data).toEqual({ _tavern: { meta: kept, extension: { kept: true } } });
  });

  it('uses the 1 MiB boundary after author injection and never automatically downgrades', () => {
    const overhead = estimateDataCardBytesAfterAuthorInjection({ content: '' }, author)!;
    const atLimit = { content: 'a'.repeat(MAX_DATA_CARD_BYTES - overhead) };
    expect(build(atLimit).estimatedBytes).toBe(MAX_DATA_CARD_BYTES);
    expect(build(atLimit).overLimit).toBe(false);
    const tooBig = { content: `${atLimit.content}a` };
    expect(build(tooBig).overLimit).toBe(true);
    expect(build(tooBig).data).toEqual(tooBig);
    expect(build({ content: 'a' }, 'standard', overhead).overLimit).toBe(true);
    // Unknown fields are intentionally retained, so the smallest preset is not a guarantee.
    expect(build({ unknown: 'a'.repeat(MAX_DATA_CARD_BYTES) }, 'minimal').overLimit).toBe(true);
  });

  it('reports unserializable inputs without modifying them', () => {
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    expect(buildTavernCloudSavePayload(cyclic, author, 'standard')).toHaveProperty('error');
    expect(estimateDataCardBytesAfterAuthorInjection(cyclic, author)).toBeNull();
    expect(buildTavernCloudSavePayload(undefined, author, 'standard')).toHaveProperty('error');
    expect(cyclic.self).toBe(cyclic);
  });
});
