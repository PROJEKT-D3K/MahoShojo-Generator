import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v3';

import {
  CANSHOU_GENERATION_SCHEMA,
  buildCanshouStreamPrompt,
  buildUnsignedCanshouCard,
  createCanshouGenerationConfig,
  type CanshouGenerationInput,
} from '@mahoshojo/ai-core/canshou-generation';

const legacy = JSON.parse(
  readFileSync(new URL('../fixtures/canshou-generation-legacy.json', import.meta.url), 'utf8'),
);
const describeSchema = (schema: z.ZodTypeAny): unknown => ({
  type: schema._def.typeName,
  ...(schema instanceof z.ZodObject
    ? {
        shape: Object.fromEntries(
          Object.entries(schema.shape).map(([key, value]) => [
            key,
            describeSchema(value as z.ZodTypeAny),
          ]),
        ),
      }
    : {}),
  ...(schema instanceof z.ZodArray ? { element: describeSchema(schema.element) } : {}),
});

describe('canshou shared generation', () => {
  it('保留 schema 结构，并把问卷、语言与参考设定传给两种生成模式', () => {
    expect(describeSchema(CANSHOU_GENERATION_SCHEMA)).toEqual(legacy.schema);
    for (const fixture of legacy.cases as {
      input: CanshouGenerationInput;
    }[]) {
      const config = createCanshouGenerationConfig(legacy.fixtureLore);
      const structuredPrompt = config.promptBuilder(fixture.input);
      const streamPrompt = buildCanshouStreamPrompt({
        answers: fixture.input.answers,
        questionnairesLore: fixture.input.loreText,
        canshouLore: legacy.fixtureLore,
        language: fixture.input.language,
      });
      expect(config.schema).toBe(CANSHOU_GENERATION_SCHEMA);
      expect(config.systemPrompt).toContain(legacy.fixtureLore);
      expect(streamPrompt).toContain(legacy.fixtureLore);
      for (const prompt of [structuredPrompt, streamPrompt]) {
        expect(prompt).toContain(fixture.input.language);
        if (fixture.input.loreText) expect(prompt).toContain(fixture.input.loreText);
        for (const answer of fixture.input.answers) {
          expect(prompt).toContain(answer.question.trim());
          expect(prompt).toContain(answer.answer);
        }
      }
      if (fixture.input.creatorPromptText) {
        expect(structuredPrompt).toContain(fixture.input.creatorPromptText);
      }
      expect(config).toMatchObject({ temperature: 0.8, taskName: '生成残兽档案' });
      expect(config).not.toHaveProperty('modelOverride');
      expect(config).not.toHaveProperty('generationSettingsContext');
    }
  });

  it('还原 schema 拒绝未知字段的卡对象，并组装不签名的结果卡', () => {
    const details = CANSHOU_GENERATION_SCHEMA.parse({
      name: '溶腔残兽',
      coreConcept: '消化',
      coreEmotion: '饥饿',
      evolutionStage: '卵',
      appearance: '',
      materialAndSkin: '',
      featuresAndAppendages: '',
      attackMethod: '',
      specialAbility: '',
      origin: '',
      birthEnvironment: '',
      researcherNotes: '',
    });
    const answer = {
      question: '残兽的捕食对象是什么？',
      answer: '深夜加班的人',
      questionId: 'q1',
      questionnaireId: 'a',
      questionnaireTitle: '残兽调查报告',
    };
    const card = buildUnsignedCanshouCard(details, [answer]);
    expect(card).toEqual({
      ...details,
      templateId: '魔法少女/心之花/残兽（问卷生成）',
      userAnswers: [{ question: '残兽的捕食对象是什么？', answer: '深夜加班的人', questionId: 'q1' }],
    });
    expect(card).not.toHaveProperty('signature');
    expect(answer.questionnaireId).toBe('a');
    expect(details).not.toHaveProperty('templateId');
    expect(CANSHOU_GENERATION_SCHEMA.safeParse({ ...details, researcherNotes: null }).success).toBe(
      false,
    );
  });
});
