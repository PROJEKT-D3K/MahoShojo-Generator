import { describe, expect, it } from 'vitest';
import { MAGICAL_GIRL_GENERATION_CONFIG, MAGICAL_GIRL_GENERATION_SCHEMA, MAGICAL_GIRL_SYSTEM_PROMPT, buildMagicalGirlGenerationPrompt } from '../src/name-generation';

describe('classic name AI contract', () => {
  it.each(['zh-CN', '日本語', 'English', 'العربية'])('preserves exact prompt text and language %s', language => {
    expect(buildMagicalGirlGenerationPrompt({ realName: '小满🌸', language })).toBe(`请为名叫"小满🌸"的人设计一个魔法少女角色。真实姓名：小满🌸\n\n【重要指令】请你必须使用【${language}】进行内容创作。`);
  });
  it('preserves system text, temperature and schema identity', () => {
    expect(MAGICAL_GIRL_SYSTEM_PROMPT).toBe('你是一个专业的魔法少女角色设计师。请根据用户输入的真名，设计一个独特的魔法少女角色。\n设计要求：\n1. 魔法少女名字应该以花名为主题，要与用户的真名有某种关联性或呼应\n2. 外貌特征要协调统一，符合魔法少女的设定\n3. 变身咒语要朗朗上口，充满魔法感\n请严格按照提供的 JSON schema 格式返回结果。');
    expect(MAGICAL_GIRL_GENERATION_CONFIG).toEqual({ systemPrompt: MAGICAL_GIRL_SYSTEM_PROMPT, temperature: 0.8, schema: MAGICAL_GIRL_GENERATION_SCHEMA, promptBuilder: buildMagicalGirlGenerationPrompt, taskName: '生成魔法少女' });
    expect(MAGICAL_GIRL_GENERATION_SCHEMA.shape.appearance.shape.firstPageColor.description).toContain('#000000');
    expect(MAGICAL_GIRL_GENERATION_SCHEMA.shape.spell.description).toContain('在此寄讬吾真红的金光吧');
  });
});
