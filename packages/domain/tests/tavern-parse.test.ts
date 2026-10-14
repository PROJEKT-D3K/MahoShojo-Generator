import { describe, expect, it, vi } from 'vitest';
import * as base64 from '../src/tavern-card/base64';
import { readTavernLocalDocument } from '../src/tavern-card/document';
import { getPlaceholderPngBytes } from '../src/tavern-card/v3';
import { parseTavernCandidates } from '../src/tavern-card/parse';
import { extractPngTextChunks, replacePngTextChunks } from '../src/tavern-card/png';

const encoded = (text: string) => base64.encodeBytesToBase64(new TextEncoder().encode(text));
const pngWith = (chunks: Array<{ keyword: string; text: string }>) =>
  replacePngTextChunks(getPlaceholderPngBytes(), chunks);

describe('Tavern PNG candidate parsing', () => {
  it('decodes and parses each base64 chunk once through the real local-document path', () => {
    const raw = { name: '角色', description: '原文', extensions: { unknown: ['保留'] } };
    const json = JSON.stringify(raw);
    const text = encoded(json);
    const png = pngWith([{ keyword: 'ccv3', text }, { keyword: 'chara', text }]);
    const decode = vi.spyOn(base64, 'decodeBase64ToBytes');
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const document = readTavernLocalDocument(png, 'png');
      expect(decode.mock.calls).toEqual([[text], [text]]);
      expect(parse.mock.calls).toEqual([[json], [json]]);
      expect(document.candidates.map((candidate) => candidate.parsed)).toEqual([raw, raw]);
      expect(document.candidates[0].parsed).not.toBe(document.candidates[1].parsed);
      expect(document.selectedIndex).toBe(0);
      expect(document.parsed?.selected).toBe(document.candidates[0]);
      expect(document.parsed?.meta.candidates.map((candidate) => candidate.ok)).toEqual([true, true]);
    } finally {
      decode.mockRestore();
      parse.mockRestore();
    }
  });

  it('preserves invalid metadata, duplicate keywords, selection, warnings and raw JSON fallback', () => {
    const first = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'First' } };
    const last = { ...first, data: { name: 'Last', description: 'longer payload wins', extensions: { unknown: 1 } } };
    const chara = { name: 'Legacy', description: 'fallback' };
    const chunks = [
      { keyword: 'ccv3', text: '!!!!' },
      { keyword: 'ccv3', text: encoded(JSON.stringify(first)) },
      { keyword: 'empty', text: '' },
      { keyword: 'plain', text: '{}' },
      { keyword: 'encoded', text: encoded('{}') },
      { keyword: 'chara', text: JSON.stringify(chara) },
      { keyword: 'ccv3', text: encoded(JSON.stringify(last)) },
    ];
    const png = pngWith(chunks);
    const document = readTavernLocalDocument(png, 'png');
    expect(document.candidates.map((candidate) => candidate.parsed)).toEqual([first, chara, last]);
    expect(document.candidates).toEqual(parseTavernCandidates(extractPngTextChunks(png)));
    expect(document.selectedIndex).toBe(2);
    expect(document.parsed?.selected).toBe(document.candidates[2]);
    expect(document.parsed?.normalized.name).toBe('Last');
    const expected = [
      { ok: false, parseMethod: 'base64-json' },
      { ok: true, parseMethod: 'base64-json', spec: first.spec, specVersion: '3.0', name: 'First' },
      { ok: false, parseMethod: 'base64-json' },
      { ok: false, parseMethod: 'json' },
      { ok: false, parseMethod: 'base64-json' },
      { ok: true, parseMethod: 'json', name: 'Legacy' },
      { ok: true, parseMethod: 'base64-json', spec: last.spec, specVersion: '3.0', name: 'Last' },
    ];
    expect(document.parsed?.meta.candidates).toEqual(chunks.map((chunk, index) => ({
      keyword: chunk.keyword, chunkType: 'tEXt', sizeChars: chunk.text.length,
      spec: undefined, specVersion: undefined, name: undefined, ...expected[index],
    })));
    // Keep the existing first-matching metadata lookup, even when a later duplicate wins.
    expect(document.parsed?.meta.sizes?.selectedPayloadChars).toBe(chunks[1].text.length);
    expect(document.warnings).toEqual(['检测到多个块（ccv3/chara）关键信息不一致：建议手动切换预览后再导入。']);
  });

  it('still validates unsafe non-selected candidates before returning a local document', () => {
    const png = pngWith([
      { keyword: 'ccv3', text: encoded('{"name":"safe","description":"selected"}') },
      { keyword: 'chara', text: encoded('{"name":"unsafe","description":"rejected","__proto__":{}}') },
    ]);
    expect(() => readTavernLocalDocument(png, 'png')).toThrow('安全有效');
  });
});
