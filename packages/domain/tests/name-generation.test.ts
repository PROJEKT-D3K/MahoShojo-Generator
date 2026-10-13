import { describe, expect, it } from 'vitest';
import { buildNameGenerationResult, isNameWithinLength, nameResultGradient, serializeNameGenerationResult, type NameGeneratedData } from '../src/name-generation';
import { COLOR_GRADIENTS, MainColor } from '../src/main-color';

const output: NameGeneratedData = {
  flowerName: '铃兰', flowerDescription: '幸福归来',
  appearance: { height: '155cm', weight: '45kg', hairColor: '银白色', hairStyle: '长发', eyeColor: '绿色', skinTone: '白皙', wearing: '礼服', specialFeature: '微笑', mainColor: '绿色', firstPageColor: '#123456', secondPageColor: '#654321' },
  spell: '花よ\n花啊',
};

describe('classic name result', () => {
  it.each([
    ['小满', '宝石权杖', '💎'],
    ['鹿目圆香', '芽', '🍃'],
    ['Alice', '蕾', '🌸'],
    ['🌸', '叶', '🌿'],
    ['مريم', '蕾', '🌸'],
  ])('preserves the original UTF-16 seeded level for %s', (name, level, levelEmoji) => {
    expect(buildNameGenerationResult(name, output)).toMatchObject({ realName: name, level, levelEmoji });
  });
  it('uses code units, preserving raw name boundary before trim', () => {
    expect(isNameWithinLength('名'.repeat(300))).toBe(true);
    expect(isNameWithinLength('名'.repeat(301))).toBe(false);
    expect(isNameWithinLength('🌸'.repeat(150))).toBe(true);
    expect(isNameWithinLength('🌸'.repeat(151))).toBe(false);
    expect(isNameWithinLength(' '+ '名'.repeat(300))).toBe(false);
  });
  it('keeps seven top-level fields and original JSON order without a signature/template id', () => {
    const result = buildNameGenerationResult('小满', { ...output, signature: 'server', templateId: 'template' } as NameGeneratedData);
    expect(Object.keys(result)).toEqual(['realName', 'name', 'flowerDescription', 'appearance', 'spell', 'level', 'levelEmoji']);
    expect(serializeNameGenerationResult(result)).toBe(JSON.stringify(result, null, 2));
    expect(JSON.parse(serializeNameGenerationResult(result)).appearance).toEqual(output.appearance);
  });
  it('uses canonical gradient rather than AI color strings and preserves unknown-color pink fallback', () => {
    const result = buildNameGenerationResult('小满', output);
    const colors = COLOR_GRADIENTS[MainColor.Green];
    expect(nameResultGradient(result)).toBe(`linear-gradient(135deg, ${colors.first} 0%, ${colors.second} 100%)`);
    const pink = COLOR_GRADIENTS[MainColor.Pink];
    expect(nameResultGradient({ ...result, appearance: { ...result.appearance, mainColor: 'unknown' } })).toBe(`linear-gradient(135deg, ${pink.first} 0%, ${pink.second} 100%)`);
  });
});
