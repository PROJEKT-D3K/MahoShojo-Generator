import { describe, expect, it } from 'vitest';
import {
  applyTavernPlaceholderReplacement,
  buildTavernAiAttachment,
  TAVERN_IMPORT_ATTACHMENT_LIMITS,
  type TavernCardNormalized,
} from '@mahoshojo/domain/tavern-card';
import { getUtf8ByteLength } from '@mahoshojo/domain/data-card-size';

describe('Tavern AI attachment', () => {
  it('fits serialized UTF-8 bytes by trimming dialogue before other fields', () => {
    // JSON escaping consumes six bytes per control character, rather than one.
    const source: TavernCardNormalized = {
      name: '测试', description: '\0'.repeat(32_000), personality: '\0'.repeat(32_000),
      scenario: '\0'.repeat(24_000), firstMes: '\0'.repeat(8_000),
      mesExample: '\0'.repeat(80_000), creatorNotes: '\0'.repeat(40_000),
    };
    const original = JSON.stringify(source);
    const result = buildTavernAiAttachment(source);
    const payload = JSON.parse(result.attachment.content);
    expect(getUtf8ByteLength(result.attachment.content)).toBeLessThanOrEqual(TAVERN_IMPORT_ATTACHMENT_LIMITS.maxBytesPerFile);
    expect(payload.mes_example).toMatch(/\n\.\.\.\[已截断\]$/u);
    expect(payload.creator_notes).toBe(source.creatorNotes);
    expect(payload.description).toBe(source.description);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('mes_example');
    expect(result.attachment.truncated).toBe(true);
    expect(JSON.stringify(source)).toBe(original);
  });

  it('consumes the replaced view without modifying the original card or expanding tags', () => {
    const source = { name: '角色', description: '{{char}}与{{user}}', tags: ['  标签  ', '', ...Array(50).fill('中')] };
    const replaced = applyTavernPlaceholderReplacement(source, { enabled: true, charReplacement: '小花', userReplacement: '旅人' });
    const result = buildTavernAiAttachment(replaced);
    const payload = JSON.parse(result.attachment.content);
    expect(payload.description).toBe('小花与旅人');
    expect(source.description).toBe('{{char}}与{{user}}');
    expect(source.tags[0]).toBe('  标签  ');
    expect(payload.tags).toHaveLength(50);
    expect(payload.tags[0]).toBe('标签');
    expect(result.warnings).toEqual(['AI 输入包已对 tags 截断（最多 50 个）。']);
  });

  it('retains the existing unbounded-name edge and marks oversize input truncated', () => {
    const name = '名'.repeat(Math.ceil(TAVERN_IMPORT_ATTACHMENT_LIMITS.maxBytesPerFile / 3));
    const result = buildTavernAiAttachment({ name });
    expect(JSON.parse(result.attachment.content).name).toBe(name);
    expect(getUtf8ByteLength(result.attachment.content)).toBeGreaterThan(TAVERN_IMPORT_ATTACHMENT_LIMITS.maxBytesPerFile);
    expect(result.attachment.truncated).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
