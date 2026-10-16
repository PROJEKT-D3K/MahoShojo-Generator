import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  MAGICAL_GIRL_DETAILS_SCHEMA,
  createMagicalGirlDetailsGenerationConfig as createCoreConfig,
  buildMagicalGirlDetailsStreamPrompt as buildCoreStreamPrompt,
  buildUnsignedMagicalGirlDetailsCard,
  type MagicalGirlDetailsGenerationInput,
} from '@mahoshojo/ai-core/magical-girl-details-generation';
import {
  buildMagicalGirlDetailsStreamPrompt,
  createMagicalGirlDetailsGenerationConfig,
} from '../src/magical-girl-details-runtime-shared';
import { createGenerateMagicalGirlDetailsRuntime } from '../src/generate-magical-girl-details-runtime';

const legacy = JSON.parse(readFileSync(new URL('../../ai-core/fixtures/magical-girl-details-legacy.json', import.meta.url), 'utf8'));

describe('Hosted details shared core adapter', () => {
  it('复用共享生成核并仅由 Hosted 包装运行配置', () => {
    for (const fixture of legacy.cases as {
      input: MagicalGirlDetailsGenerationInput & { flowers: string };
    }[]) {
      const context = { providerId: 'test' };
      const config = createMagicalGirlDetailsGenerationConfig(() => fixture.input.flowers, 'model', context);
      expect(config.schema).toBe(MAGICAL_GIRL_DETAILS_SCHEMA);
      expect(config.modelOverride).toBe('model');
      expect(config.generationSettingsContext).toBe(context);
      const core = createCoreConfig(() => fixture.input.flowers);
      expect(config.systemPrompt).toBe(core.systemPrompt);
      expect(config.promptBuilder(fixture.input)).toBe(core.promptBuilder(fixture.input));
      expect(buildMagicalGirlDetailsStreamPrompt).toBe(buildCoreStreamPrompt);
    }
    const defaults = createMagicalGirlDetailsGenerationConfig(() => '', undefined, undefined);
    expect(defaults).not.toHaveProperty('modelOverride');
    expect(defaults).not.toHaveProperty('generationSettingsContext');
  });

  it('实际 Hosted service 对共享 fixture 构造同一 unsigned 角色卡', async () => {
    const fixture = legacy.cases[0].input as MagicalGirlDetailsGenerationInput & { flowers: string };
    const details = MAGICAL_GIRL_DETAILS_SCHEMA.parse({
      codename: '海棠',
      appearance: { outfit: '', accessories: '', colorScheme: '', overallLook: '' },
      magicConstruct: { name: '', form: '', basicAbilities: [], description: '' },
      wonderlandRule: { name: '', description: '', tendency: '', activation: '' },
      blooming: { name: '', evolvedAbilities: [], evolvedForm: '', evolvedOutfit: '', powerLevel: '' },
      analysis: { personalityAnalysis: '', abilityReasoning: '', coreTraits: [], predictionBasis: '', background: { belief: '', bonds: '' } },
    });
    let normalizedInput: MagicalGirlDetailsGenerationInput | undefined;
    const runtime = createGenerateMagicalGirlDetailsRuntime({
      presetIndex: { presets: [] },
      loadPreset: async () => null,
      loadDataCard: async () => null,
      getRandomFlowers: () => fixture.flowers,
      findProvider: () => null,
      resolveModel: () => ({ modelId: 'model' }),
      checkRateLimit: async () => null,
      enforceSafety: async () => null,
      generateWithAI: async (input) => { normalizedInput = input; return details; },
      sign: async () => { throw new Error('unsigned flow must not sign'); },
      recordActivity: () => {},
      buildResponse: ({ data }) => Response.json(data),
      logInfo: () => {}, logWarn: () => {}, logError: () => {},
    });
    const response = await runtime.service(new Request('https://example.test/api/generate-magical-girl-details', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: fixture.answers, language: fixture.language }),
    }));
    expect(response.status).toBe(200);
    expect(normalizedInput).toBeDefined();
    expect(await response.json()).toEqual(buildUnsignedMagicalGirlDetailsCard(details, normalizedInput!.answers));
  });
});
