import { describe, expect, it } from 'vitest';
import {
  createTavernGeneralGenerationConfig,
  createTavernGeneralScenarioGenerationConfig,
  projectTavernGeneralResult,
  projectTavernGeneralScenarioResult,
} from '@mahoshojo/ai-core/tavern-generation';
import { formatReferenceAttachmentsForPrompt } from '@mahoshojo/ai-core/reference-attachments';
import { parseStructuredJsonWithSchema, validateStructuredJsonValueWithSchema } from '@mahoshojo/ai-core/structured-json';
import { GeneralScenarioSchema } from '@mahoshojo/domain/data-card-schemas';
import { createBlankDataCard } from '@mahoshojo/domain/sublimation';
import { buildScenarioMarkdownRequirements } from '@mahoshojo/ai-core/scenario-generation';
import { TAVERN_IMPORT_ATTACHMENT_LIMITS } from '@mahoshojo/domain/tavern-card/limits';
import { GENERAL_CHARACTER_TEMPLATE_ID, GENERAL_SCENARIO_TEMPLATE_ID } from '@mahoshojo/domain/data-cards';

const input = { language: 'ja-JP', sourceName: '旧名', attachments: [{ name: 'tavern-card.json', type: 'application/json', content: '{"description":"原设定"}', truncated: true }] };

describe('Tavern general generation core', () => {
  it('keeps the two model schemas, temperatures and shared prompt sections', () => {
    const general = createTavernGeneralGenerationConfig();
    const scenario = createTavernGeneralScenarioGenerationConfig();
    expect(general.temperature).toBe(0.75);
    expect(scenario.temperature).toBe(0.7);
    expect(general.systemPrompt).toBe('你的任务是创作具有指定数据结构的内容。');
    expect(scenario.systemPrompt).toBe(general.systemPrompt);
    expect(general.schema.parse({ name: '', content: '', signature: 'fake', isPreset: true })).toEqual({ name: '', content: '' });
    expect(scenario.schema.parse({ title: '', content: '', signature: 'fake', isPreset: true })).toEqual({ title: '', content: '' });
    expect(general.schema.safeParse({ name: '缺正文' }).success).toBe(false);
    expect(scenario.schema.safeParse({ name: '不是模型输出的title', content: '' }).success).toBe(false);
    expect(general.promptBuilder(input)).toContain('角色名提示：原角色名为「旧名」。');
    expect(general.promptBuilder(input)).toContain('你必须使用【ja-JP】');
    expect(general.promptBuilder(input)).toContain(formatReferenceAttachmentsForPrompt(input.attachments, { limits: TAVERN_IMPORT_ATTACHMENT_LIMITS }));
    expect(scenario.promptBuilder(input)).toContain(buildScenarioMarkdownRequirements(input.language));
    expect(scenario.promptBuilder(input)).toContain(formatReferenceAttachmentsForPrompt(input.attachments, {
      title: '## 情景设定信息', intro: '以下内容为原始情景设定信息，请据此完成创作。', limits: TAVERN_IMPORT_ATTACHMENT_LIMITS,
    }));
    expect(general.promptBuilder({ ...input, sourceName: '' })).toContain('原角色名未提供。');
    expect(scenario.promptBuilder({ ...input, sourceName: '' })).toContain('情景名称提示：未提供。');
  });

  it('preserves Web results after either structured transport has stripped model extras', () => {
    const schema = createTavernGeneralScenarioGenerationConfig().schema;
    const modelOutput = { title: '情景', content: '# 情景', signature: 'fake', isPreset: true, templateId: 'fake' };
    const structured = validateStructuredJsonValueWithSchema(modelOutput, schema);
    const textFallback = parseStructuredJsonWithSchema(JSON.stringify(modelOutput), schema).data;
    for (const generated of [structured, textFallback]) {
      expect(generated).toEqual({ title: '情景', content: '# 情景' });
      // Legacy Web projection did not delete trust fields, but neither runtime path supplies them.
      const legacy = GeneralScenarioSchema.parse({
        ...GeneralScenarioSchema.parse(createBlankDataCard('general-scenario')),
        ...generated,
        templateId: GENERAL_SCENARIO_TEMPLATE_ID,
      });
      expect(projectTavernGeneralScenarioResult(generated)).toEqual(legacy);
    }
  });

  it('projects fresh cards with canonical templates and rejects model trust fields without mutating input', () => {
    const extras = { templateId: 'untrusted', signature: 'fake', isPreset: true };
    const general = { name: '角色', content: '正文', ...extras };
    const scenario = { title: '情景', content: '# 情景', ...extras };
    const characterCard = projectTavernGeneralResult(general);
    const scenarioCard = projectTavernGeneralScenarioResult(scenario);
    expect(characterCard).toMatchObject({ templateId: GENERAL_CHARACTER_TEMPLATE_ID, name: '角色', content: '正文' });
    expect(scenarioCard).toMatchObject({ templateId: GENERAL_SCENARIO_TEMPLATE_ID, title: '情景', content: '# 情景' });
    for (const card of [characterCard, scenarioCard]) {
      expect(card).not.toHaveProperty('signature');
      expect(card).not.toHaveProperty('isPreset');
    }
    expect(general).toMatchObject(extras);
    expect(scenario).toMatchObject(extras);
  });
});
