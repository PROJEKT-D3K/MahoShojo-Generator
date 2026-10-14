import { describe, expect, it } from 'vitest';
import {
  createTavernScenarioGenerationConfig,
  projectTavernScenarioResult,
  createTavernGeneralGenerationConfig,
  createTavernGeneralScenarioGenerationConfig,
  projectTavernGeneralResult,
  projectTavernGeneralScenarioResult,
} from '@mahoshojo/ai-core/tavern-generation';
import { formatReferenceAttachmentsForPrompt } from '@mahoshojo/ai-core/reference-attachments';
import { parseStructuredJsonWithSchema, validateStructuredJsonValueWithSchema } from '@mahoshojo/ai-core/structured-json';
import { GeneralScenarioSchema, ScenarioSchema } from '@mahoshojo/domain/data-card-schemas';
import { createBlankDataCard } from '@mahoshojo/domain/sublimation';
import { buildScenarioCorePrinciples, buildScenarioMarkdownRequirements } from '@mahoshojo/ai-core/scenario-generation';
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

const scenarioOutput = {
  title: '雨夜车站', scenario_type: '调查', description: '寻找失物',
  elements: { scene: {}, events: '等车', atmosphere: '安静', development: ['找到失主'] },
};

describe('Tavern structured scenario generation core', () => {
  it('retains the Tavern-specific schema descriptions, optional fields and prompt verbatim', () => {
    const config = createTavernScenarioGenerationConfig();
    expect(config).toMatchObject({
      systemPrompt: '你的任务是创作具有指定数据结构的内容。',
      temperature: 0.7, taskName: '酒馆导入：情景 AI 转换',
    });
    expect(config.schema.description).toBe('结构化情景设定，用于后续故事。');
    expect(config.schema.shape.title.description).toBe('情景标题【必需】。根据设定信息为情景取一个简洁而富有吸引力的标题。');
    expect(config.schema.shape.scenario_type.description).toBe('情景类型【必需】。根据情景的核心内容分类（如：日常/互动/调查/采访/竞技等）。');
    const elements = config.schema.shape.elements.shape;
    expect(elements.scene.description).toBe('场景描述。如果信息不足，可留空或注明“未指定”。');
    expect(elements.scene.shape.features.description).toBe('环境特征与陈设等。');
    expect(elements.roles.description).toBe('预设 NPC 角色信息，可留空。');
    expect(elements.events.description).toBe('核心事件描述（角色需要做什么？会怎么互动？有什么冲突？）。');
    expect(elements.atmosphere.description).toBe('故事的情感基调与氛围。');
    expect(config.schema.parse(scenarioOutput)).toEqual(scenarioOutput);
    expect(config.schema.safeParse({ ...scenarioOutput, elements: {} }).success).toBe(false);
    expect(config.schema.safeParse({ title: '情景', content: '# 正文' }).success).toBe(false);
    const attachmentSection = formatReferenceAttachmentsForPrompt(input.attachments, {
      title: '## 情景设定信息', intro: '以下内容为原始情景设定信息，请据此完成创作。', limits: TAVERN_IMPORT_ATTACHMENT_LIMITS,
    });
    expect(config.promptBuilder(input)).toBe(`
你是一个富有想象力的故事场景设计师。你的任务是根据情景设定信息，构思并生成一个结构化的、可供后续故事使用的自定义情景（Scenario）文件。

${buildScenarioCorePrinciples(input.language)}

情景名称提示：原情景名为「旧名」。

${attachmentSection}

任务：请严格按照 Schema 输出一个 JSON 对象（只输出 JSON，不要输出解释）。
`.trim());
    expect(config.promptBuilder({ ...input, sourceName: '' })).toContain('情景名称提示：未提供。');
  });

  it('matches legacy blank-card merging for both structured and text-fallback transport', () => {
    const schema = createTavernScenarioGenerationConfig().schema;
    const untrusted = { ...scenarioOutput, signature: 'fake', isPreset: true, metadata: { signature: 'fake' } };
    for (const generated of [
      validateStructuredJsonValueWithSchema(untrusted, schema),
      parseStructuredJsonWithSchema(JSON.stringify(untrusted), schema).data,
    ]) {
      expect(generated).toEqual(scenarioOutput);
      const legacy = ScenarioSchema.parse({ ...ScenarioSchema.parse(createBlankDataCard('scenario')), ...generated });
      expect(projectTavernScenarioResult(generated)).toEqual(legacy);
      expect(projectTavernScenarioResult(generated)).toMatchObject({ metadata: {}, adjudicationEvents: [] });
    }
  });

  it('removes nested and top-level trust extras without mutating input or losing allowed extensions', () => {
    const metadata = { created_at: '2026-01-01', signature: 'forged' };
    const generated = { ...scenarioOutput, metadata, _source: 'preserved' };
    const legacy = ScenarioSchema.parse({ ...createBlankDataCard('scenario'), ...generated });
    // Security fix: legacy Web accepted this nested signature when a transport preserved extras.
    expect(legacy.metadata?.signature).toBe('forged');
    const withTopLevelTrust = { ...generated, signature: 'forged', isPreset: true };
    // These top-level extras previously rejected the whole result; now they are explicitly discarded.
    expect(ScenarioSchema.safeParse({ ...createBlankDataCard('scenario'), ...withTopLevelTrust }).success).toBe(false);
    for (const value of [generated, withTopLevelTrust]) {
      const result = projectTavernScenarioResult(value);
      expect(result).toEqual({ ...legacy, metadata: { created_at: '2026-01-01' } });
      expect(result).not.toHaveProperty('signature');
      expect(result).not.toHaveProperty('isPreset');
      expect(result.metadata).not.toHaveProperty('signature');
    }
    expect(metadata.signature).toBe('forged');
    expect(withTopLevelTrust.signature).toBe('forged');
    const unknownExtra = { ...generated, unknownField: true };
    expect(() => projectTavernScenarioResult(unknownExtra)).toThrow();
  });

  it.each([
    { label: 'Date', metadata: new Date('2026-01-01') },
    { label: 'Map', metadata: new Map() },
    { label: 'Set', metadata: new Set() },
    { label: 'null', metadata: null },
    { label: 'array', metadata: [] },
    { label: 'non-string created_at', metadata: { created_at: 123 } },
    { label: 'non-string signature', metadata: { signature: 123 } },
  ])('preserves schema rejection for invalid metadata: $label', ({ metadata }) => {
    const generated = { ...scenarioOutput, metadata };
    expect(ScenarioSchema.safeParse({ ...createBlankDataCard('scenario'), ...generated }).success).toBe(false);
    expect(() => projectTavernScenarioResult(generated)).toThrow();
  });

});
