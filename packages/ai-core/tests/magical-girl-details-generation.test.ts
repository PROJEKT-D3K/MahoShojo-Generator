import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v3';

import {
  MAGICAL_GIRL_DETAILS_SCHEMA,
  buildMagicalGirlDetailsStreamPrompt,
  buildUnsignedMagicalGirlDetailsCard,
  createMagicalGirlDetailsGenerationConfig,
  type MagicalGirlDetailsGenerationInput,
} from '@mahoshojo/ai-core/magical-girl-details-generation';

const legacy = JSON.parse(readFileSync(new URL('../fixtures/magical-girl-details-legacy.json', import.meta.url), 'utf8'));
const describeSchema = (schema: z.ZodTypeAny): unknown => ({
  type: schema._def.typeName,
  ...(schema instanceof z.ZodObject
    ? { shape: Object.fromEntries(Object.entries(schema.shape).map(([key, value]) => [key, describeSchema(value as z.ZodTypeAny)])) }
    : {}),
  ...(schema instanceof z.ZodArray ? { element: describeSchema(schema.element) } : {}),
});

describe('magical girl details shared generation', () => {
  it('保留 schema 结构，并把问卷、语言、设定与花名传给两种生成模式', () => {
    expect(describeSchema(MAGICAL_GIRL_DETAILS_SCHEMA)).toEqual(legacy.schema);
    for (const fixture of legacy.cases as {
      input: MagicalGirlDetailsGenerationInput & { flowers: string };
    }[]) {
      const config = createMagicalGirlDetailsGenerationConfig(() => fixture.input.flowers);
      const prompts = [config.promptBuilder(fixture.input), buildMagicalGirlDetailsStreamPrompt({
        ...fixture.input, questionnaireLore: fixture.input.loreText,
      })];
      expect(config.schema).toBe(MAGICAL_GIRL_DETAILS_SCHEMA);
      for (const prompt of prompts) {
        expect(prompt).toContain(fixture.input.language);
        if (fixture.input.loreText) expect(prompt).toContain(fixture.input.loreText);
        if (fixture.input.flowers) expect(prompt).toContain(fixture.input.flowers);
        for (const answer of fixture.input.answers) {
          if (answer.question.trim()) expect(prompt).toContain(answer.question.trim());
          expect(prompt).toContain(answer.answer);
          if (answer.questionnaireTitle?.trim()) {
            expect(prompt).toContain(answer.questionnaireTitle.trim());
          }
        }
      }
      expect(config).toMatchObject({ temperature: 0.8, taskName: '生成魔法少女详细信息' });
      expect(config).not.toHaveProperty('modelOverride');
      expect(config).not.toHaveProperty('generationSettingsContext');
    }
  });

  it('在构建 Prompt 时取花名，保留重复调用的抽样时机', () => {
    const flowers = vi.fn().mockReturnValueOnce('海棠').mockReturnValueOnce('百合');
    const config = createMagicalGirlDetailsGenerationConfig(flowers);
    expect(flowers).not.toHaveBeenCalled();
    const input = { answers: [], language: '中文', loreText: '' };
    expect(config.promptBuilder(input)).toContain('海棠');
    expect(config.promptBuilder(input)).toContain('百合');
    expect(flowers).toHaveBeenCalledTimes(2);
  });

  it('把可选缔造者指令传入结构化生成', () => {
    const creatorPromptText = '偏好以潮汐作为能力意象';
    const config = createMagicalGirlDetailsGenerationConfig(() => '');
    expect(config.promptBuilder({
      answers: [], language: '中文', loreText: '', creatorPromptText,
    })).toContain(creatorPromptText);
  });

  it('按原 schema 接受未解锁的空字段，并构造不带签名的角色卡', () => {
    const details = MAGICAL_GIRL_DETAILS_SCHEMA.parse({
      codename: '海棠',
      appearance: { outfit: '', accessories: '', colorScheme: '', overallLook: '' },
      magicConstruct: { name: '', form: '', basicAbilities: [], description: '' },
      wonderlandRule: { name: '', description: '', tendency: '', activation: '' },
      blooming: { name: '', evolvedAbilities: [], evolvedForm: '', evolvedOutfit: '', powerLevel: '' },
      analysis: { personalityAnalysis: '', abilityReasoning: '', coreTraits: [], predictionBasis: '', background: { belief: '', bonds: '' } },
    });
    const answer = { question: '愿望？', answer: '守护', questionId: 'q1', questionnaireId: 'a', questionnaireTitle: '起点' };
    const card = buildUnsignedMagicalGirlDetailsCard(details, [answer]);
    expect(card).toEqual({
      ...details, templateId: '魔法少女/心之花/魔法少女（问卷生成）',
      userAnswers: [{ question: '愿望？', answer: '守护', questionId: 'q1' }],
    });
    expect(card).not.toHaveProperty('signature');
    expect(answer.questionnaireId).toBe('a');
    expect(details).not.toHaveProperty('templateId');
    expect(MAGICAL_GIRL_DETAILS_SCHEMA.safeParse({ ...details, blooming: null }).success).toBe(false);
  });
});
