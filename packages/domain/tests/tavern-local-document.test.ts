import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { createBlankDataCard } from '../src/sublimation';
import { parseDataCardByTemplate } from '../src/data-card-schemas';
import { convertTavernToCanshouCard, buildTavernCanshouCard, TAVERN_CANSHOU_TEMPLATE_ID, convertTavernToGeneralCard, convertTavernToGeneralScenarioCard, buildTavernGeneralScenarioCard, normalizeTavernCard, decodeBase64ToBytes, getPlaceholderPngBytes, MAX_TAVERN_FILE_BYTES, MAX_TAVERN_TEXT_BYTES, MAX_TAVERN_PNG_TEXT_BYTES, encodeBytesToBase64, replacePngTextChunks, parsePngChunkRanges, readTavernLocalDocument, writeTavernCardToPngBytes, crc32Concat, extractPngTextChunks } from '../src/tavern-card';
const encoder = new TextEncoder();
const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '测试', description: '角色', extensions: { custom: { deep: [1, '未知'] } }, character_book: { entries: [{ content: '设定' }] } }, signature: 'not-verified' };
function withCompressedChunk(text: string, kind: 'zTXt' | 'iTXt', keyword = 'ccv3') {
  const base = getPlaceholderPngBytes();
  const prefix = [...encoder.encode(keyword), ...(kind === 'zTXt' ? [0, 0] : [0, 1, 0, 0, 0])];
  const compressed = zlibSync(encoder.encode(text));
  const data = new Uint8Array(prefix.length + compressed.length); data.set(prefix); data.set(compressed, prefix.length);
  const type = encoder.encode(kind); const chunk = new Uint8Array(12 + data.length); const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length); chunk.set(type, 4); chunk.set(data, 8); view.setUint32(8 + data.length, crc32Concat([type, data]));
  const iend = parsePngChunkRanges(base).find((range) => range.type === 'IEND')!;
  const out = new Uint8Array(base.length + chunk.length); out.set(base.subarray(0, iend.start)); out.set(chunk, iend.start); out.set(base.subarray(iend.start), iend.start + chunk.length); return out;
}
describe('Tavern local journey', () => {
  it('checks final retained compressed text plus new chunks, without silently deleting ancillary data', () => {
    const base = withCompressedChunk('a'.repeat(MAX_TAVERN_PNG_TEXT_BYTES - 100), 'zTXt', 'Comment');
    const original = base.slice();
    expect(extractPngTextChunks(base)).toHaveLength(1);
    expect(() => writeTavernCardToPngBytes(base, card)).toThrow('TAVERN_LIMIT_EXCEEDED');
    expect(() => writeTavernCardToPngBytes(base, card, { overwriteExisting: false })).toThrow('TAVERN_LIMIT_EXCEEDED');
    expect(base).toEqual(original);
    const small = { name: 'x', description: 'y' };
    const single = writeTavernCardToPngBytes(base, small, { includeCharaChunk: false });
    expect(readTavernLocalDocument(single, 'png').candidates[0].parsed).toEqual(small);
    expect(extractPngTextChunks(single).some((chunk) => chunk.keyword === 'Comment')).toBe(true);
  });
  it('PNG → unsigned projection → JSON reopen → PNG preserves the complete inert original', () => {
    const original = writeTavernCardToPngBytes(getPlaceholderPngBytes(), card);
    const parsed = readTavernLocalDocument(original, 'png');
    const projection = convertTavernToGeneralCard(parsed.candidates[parsed.selectedIndex]);
    expect(projection).not.toHaveProperty('signature'); expect(projection._tavern.raw).toEqual(card);
    expect(projection.content).toContain('角色'); expect(projection.content).not.toContain('设定');
    const reopened = readTavernLocalDocument(encoder.encode(JSON.stringify(projection)), 'json');
    expect(reopened.warnings.join('')).toContain('不会合并');
    const result = readTavernLocalDocument(writeTavernCardToPngBytes(parsed.basePngBytes!, reopened.candidates[0].parsed), 'png');
    expect(result.candidates[0].parsed).toEqual(card);
  });
  it('maps a general scenario using the Web rule and reopens only its retained inert original', () => {
    const raw = { ...card, data: { ...card.data, name: ' {{char}} 庭院 ', scenario: ' 场景 ', description: ' 背景 ', personality: ' 氛围 ', first_mes: ' {{user}} 开场 ', mes_example: ' 对话 ', tags: ['一', '二'] } };
    const candidate = readTavernLocalDocument(encoder.encode(JSON.stringify(raw)), 'json').candidates[0];
    const normalized = normalizeTavernCard(candidate).normalized;
    const projection = convertTavernToGeneralScenarioCard(candidate);
    expect(projection).toEqual({ ...buildTavernGeneralScenarioCard(normalized), _tavern: { raw } });
    expect(projection.templateId).toBe('通用情景');
    expect(projection.content).toContain('## 场景概览\n场景\n\n## 背景摘要\n背景\n\n## 氛围\n氛围');
    expect(projection.content).toContain('## 标签\n一、二');
    expect(projection).not.toHaveProperty('signature');
    const edited = { ...projection, title: '编辑后的标题', content: '修改不会合并回酒馆原件' };
    expect(readTavernLocalDocument(encoder.encode(JSON.stringify(edited)), 'json').candidates[0].parsed).toEqual(raw);
    const replaced = convertTavernToGeneralScenarioCard(candidate, { enabled: true, userReplacement: '访客', charReplacementMode: 'custom', customCharReplacement: '春日' });
    expect(replaced.title).toContain('春日'); expect(replaced.content).toContain('访客 开场'); expect(replaced._tavern.raw).toEqual(raw);
    const png = writeTavernCardToPngBytes(getPlaceholderPngBytes(), replaced._tavern.raw);
    expect(readTavernLocalDocument(png, 'png').candidates[0].parsed).toEqual(raw);
    expect(() => readTavernLocalDocument(encoder.encode(JSON.stringify({ ...projection, _tavern: undefined })), 'json')).toThrow();
  });
  it('preserves the conservative Canshou fields and round-trips only its complete original', () => {
    const raw = { ...card, data: { ...card.data, name: '残兽', description: '{{user}} 外观', personality: '情感', scenario: '场景', mes_example: '样例', first_mes: '不映射开场', tags: ['不映射标签'] } };
    const candidate = readTavernLocalDocument(encoder.encode(JSON.stringify(raw)), 'json').candidates[0];
    const projection = convertTavernToCanshouCard(candidate);
    expect(projection).toEqual({ ...buildTavernCanshouCard(normalizeTavernCard(candidate).normalized), _tavern: { raw } });
    expect(projection).toMatchObject({ templateId: TAVERN_CANSHOU_TEMPLATE_ID, name: '残兽', appearance: '{{user}} 外观', coreEmotion: '情感', researcherNotes: '【场景】\n场景\n\n【对话样例】\n样例', materialAndSkin: '', origin: '' });
    expect(projection).not.toHaveProperty('content'); expect(projection).not.toHaveProperty('signature');
    const { _tavern, ...body } = projection;
    expect(JSON.stringify(body)).not.toMatch(/不映射|设定|not-verified/);
    const replaced = convertTavernToCanshouCard(candidate, { enabled: true, userReplacement: '访客', charReplacementMode: 'auto', customCharReplacement: '' });
    expect(replaced.appearance).toBe('访客 外观'); expect(replaced._tavern.raw).toEqual(raw);
    const reopened = readTavernLocalDocument(encoder.encode(JSON.stringify({ ...replaced, appearance: '用户编辑' })), 'json');
    expect(reopened.warnings.join('')).toContain('不会合并');
    expect(readTavernLocalDocument(writeTavernCardToPngBytes(getPlaceholderPngBytes(), reopened.candidates[0].parsed), 'png').candidates[0].parsed).toEqual(raw);
    expect(() => readTavernLocalDocument(encoder.encode(JSON.stringify(body)), 'json')).toThrow();
    expect(_tavern.raw).toEqual(raw);
  });
  it('uses existing blank Canshou defaults and rejects guessed or malformed projection wrappers', () => {
    const blank = buildTavernCanshouCard({ name: '空白' });
    expect(blank).toEqual({ ...parseDataCardByTemplate('canshou', createBlankDataCard('canshou')), name: '空白' });
    for (const wrapper of [
      { ...blank, templateId: '残兽' },
      { ...blank, appearance: {} },
      { ...blank, coreEmotion: undefined },
      { ...blank, researcherNotes: 1 },
      { name: 'guess', coreEmotion: '情绪' },
    ]) expect(() => readTavernLocalDocument(encoder.encode(JSON.stringify({ ...wrapper, _tavern: { raw: card } })), 'json')).toThrow();
    const genuine = { ...blank, ...card, _tavern: { raw: { name: '恶意替换', description: '不能覆盖原卡' } } };
    expect(readTavernLocalDocument(encoder.encode(JSON.stringify(genuine)), 'json').candidates[0].parsed).toEqual(genuine);
  });
  it('preserves a genuine Tavern card whose unknown extension is named _tavern.raw', () => {
    const outer = { ...card, _tavern: { raw: { name: 'nested', description: 'not the selected card' }, extension: 'keep' } };
    const document = readTavernLocalDocument(encoder.encode(JSON.stringify(outer)), 'json');
    expect(document.candidates[0].parsed).toEqual(outer);
    expect(convertTavernToGeneralCard(document.candidates[0]).name).toBe('测试');
  });
  it('can reread dual-chunk PNG output for a large accepted JSON original', () => {
    const large = { name: 'large', description: 'a'.repeat(2 * 1024 * 1024) };
    const json = readTavernLocalDocument(encoder.encode(JSON.stringify(large)), 'json');
    const png = writeTavernCardToPngBytes(getPlaceholderPngBytes(), json.candidates[0].parsed);
    expect(readTavernLocalDocument(png, 'png').candidates[0].parsed).toEqual(large);
  });
  it('rejects malformed, oversized and unsafe JSON before conversion', () => {
    expect(() => readTavernLocalDocument(encoder.encode('{'), 'json')).toThrow();
    expect(() => readTavernLocalDocument(new Uint8Array(MAX_TAVERN_TEXT_BYTES + 1), 'json')).toThrow('4 MiB');
    expect(() => readTavernLocalDocument(new Uint8Array(MAX_TAVERN_FILE_BYTES + 1), 'png')).toThrow('32 MiB');
    expect(() => readTavernLocalDocument(encoder.encode('{"name":"x","description":"x","__proto__":{}}'), 'json')).toThrow();
  });
  it.each(['zTXt', 'iTXt'] as const)('bounds high-ratio %s expansion using a tiny generated fixture', (kind) => {
    const bomb = withCompressedChunk('A'.repeat(MAX_TAVERN_PNG_TEXT_BYTES + 100_000), kind);
    expect(bomb.length).toBeLessThan(20_000);
    expect(() => readTavernLocalDocument(bomb, 'png')).toThrow('上限');
    expect(readTavernLocalDocument(withCompressedChunk(JSON.stringify(card), kind), 'png').candidates[0].parsed).toEqual(card);
  });
  it('rejects invalid UTF-8 instead of silently replacing bytes and falls back to a valid candidate', () => {
    const prefix = encoder.encode('{"name":"bad","description":"');
    const suffix = encoder.encode('"}');
    const bad = new Uint8Array(prefix.length + 1 + suffix.length); bad.set(prefix); bad[prefix.length] = 255; bad.set(suffix, prefix.length + 1);
    const png = replacePngTextChunks(getPlaceholderPngBytes(), [{ keyword: 'ccv3', text: encodeBytesToBase64(bad) }]);
    expect(() => readTavernLocalDocument(png, 'png')).toThrow('未能');
    const fallback = replacePngTextChunks(png, [{ keyword: 'chara', text: encodeBytesToBase64(encoder.encode(JSON.stringify(card))) }]);
    expect(readTavernLocalDocument(fallback, 'png').candidates[0].parsed).toEqual(card);
  });
  it('rejects incomplete PNG structure', () => {
    const png = getPlaceholderPngBytes();
    expect(() => readTavernLocalDocument(png.slice(0, -12), 'png')).toThrow('不完整');
  });
  it.each(['ĀAAA', '=AAA', 'AA=A', 'AA==AAAA', '!!!!'])('rejects malformed base64 %s', (input) => {
    expect(() => decodeBase64ToBytes(input)).toThrow();
  });
});
