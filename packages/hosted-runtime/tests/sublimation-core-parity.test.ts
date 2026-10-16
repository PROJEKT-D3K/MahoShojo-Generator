import { describe, expect, it } from 'vitest';
import { createSublimationGenerationConfig, buildSublimationStreamConfig } from '../src/sublimation-runtime-shared';
import { createSublimationGenerationCore, buildSublimationStreamCore } from '@mahoshojo/ai-core/sublimation-generation';

const originalData = { name: '雾灯', codename: '星灯', content: '完整设定', signature: 'do-not-send',
  userAnswers: ['回答'], current_state: { summary: '疲惫', fields: [{ label: '力量', type: 'number', value: 4 }] },
  arena_history: { entries: [{ id: 'legacy', title: '初遇', impact: '成长', winner: '星灯', future: true }] },
  future_extension: { lore: '保留数据' } };
describe('Sublimation 生成核迁移与 Hosted 行为保真', () => {
  for (const targetTemplate of ['general', 'magical-girl', 'canshou'] as const)
    for (const enabled of [true, false])
      for (const preserve of [true, false])
        it(`${targetTemplate}: state=${enabled}, preserve=${preserve}`, () => {
          const input = { originalData, baseOutputData: { ...originalData, newField: '差异' }, language: 'pt-BR',
            userGuidance: '成长', narrativeHistory: '叙事', loreText: '参考', sourceTemplate: 'general' as const, targetTemplate,
            fieldsToPreserve: preserve ? ['name', 'codename', 'future_extension', 'current_state'] : [],
            allowReshapeNames: enabled, isDowngrade: !enabled, defaultQuestions: { magicalGirl: ['问题'], canshou: ['残兽问题'] },
            stateOptions: { readArenaHistory: enabled, writeArenaHistory: enabled, readCurrentState: enabled, writeCurrentState: enabled } };
          const snapshot = structuredClone(input);
          const hosted = createSublimationGenerationConfig(input);
          const core = createSublimationGenerationCore(input);
          expect(core.promptBuilder()).toBe(hosted.promptBuilder(null));
          expect(hosted.modelOverride).toBe(enabled ? undefined : 'gemini-2.5-flash-lite');
          expect(core).not.toHaveProperty('modelOverride');
          const requiredFields = targetTemplate === 'general'
            ? ['name', 'content']
            : targetTemplate === 'magical-girl'
              ? ['codename', 'appearance', 'magicConstruct', 'wonderlandRule', 'blooming', 'analysis']
              : ['name', 'coreConcept', 'coreEmotion', 'evolutionStage', 'appearance', 'materialAndSkin',
                'featuresAndAppendages', 'attackMethod', 'specialAbility', 'origin', 'birthEnvironment', 'researcherNotes'];
          const generatedFields = requiredFields.filter(field => !input.fieldsToPreserve.includes(field));
          const event = { title: '成长', impact: '新经历' };
          const values = [null, {}, { updatedCharacterData: {}, sublimationEvent: event },
            { updatedCharacterData: { name: '雾灯「新生」', content: '完整新设定', future_extension: { lore: 'x' } }, sublimationEvent: event }];
          for (const [index, value] of values.entries()) {
            const expectedPaths = index === 0 ? [[]] : index === 1 ? [['updatedCharacterData'], ['sublimationEvent']]
              : generatedFields.filter(field => index === 2 || !['name', 'content'].includes(field))
                .map(field => ['updatedCharacterData', field]);
            for (const result of [hosted.schema.safeParse(value), core.schema.safeParse(value)]) {
              expect(result.success).toBe(expectedPaths.length === 0);
              if (!result.success) {
                expect(result.error.issues.map(issue => issue.path)).toEqual(expectedPaths);
              } else {
                expect(result.data).toEqual({
                  updatedCharacterData: { ...(!preserve ? { name: '雾灯「新生」' } : {}), content: '完整新设定' },
                  sublimationEvent: event,
                });
              }
            }
          }
          // Legacy stream callers did not declare state read controls.
          const streamInput = { ...input, stateOptions: undefined, modelOverride: 'custom-model' };
          const stream = buildSublimationStreamConfig(streamInput);
          expect(stream.modelOverride).toBe('custom-model');
          expect(buildSublimationStreamCore(streamInput).prompt).toBe(stream.prompt);
          expect(input).toEqual(snapshot);
        });
});

it('Hosted 路由保持空模型与显式覆盖语义，纯核不携带 provider 上下文', () => {
  const input = { originalData, baseOutputData: originalData, language: 'zh-CN', userGuidance: '', narrativeHistory: '', loreText: '',
    sourceTemplate: 'general' as const, targetTemplate: 'general' as const, fieldsToPreserve: [], allowReshapeNames: false,
    defaultQuestions: { magicalGirl: [], canshou: [] },
    stateOptions: { readArenaHistory: false, writeArenaHistory: false, readCurrentState: false, writeCurrentState: false } };
  for (const isDowngrade of [true, false]) for (const modelOverride of [undefined, '', 'custom-model']) {
    const config = createSublimationGenerationConfig({ ...input, isDowngrade, modelOverride });
    expect(config.modelOverride).toBe(modelOverride === '' ? undefined : modelOverride ?? (isDowngrade ? 'gemini-2.5-flash-lite' : undefined));
    const stream = buildSublimationStreamConfig({ ...input, isDowngrade, modelOverride });
    expect(stream.modelOverride).toBe(modelOverride || undefined);
  }
  const core = createSublimationGenerationCore(input);
  expect(Object.keys(core).sort()).toEqual(['promptBuilder', 'schema', 'systemPrompt', 'taskName', 'temperature']);
  expect(Object.keys(buildSublimationStreamCore({ ...input, isDowngrade: false })).sort()).toEqual(['prompt', 'temperature']);
});
