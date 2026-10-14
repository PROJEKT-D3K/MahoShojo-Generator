import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  createTavernMagicalGirlGenerationConfig,
  createTavernCanshouGenerationConfig,
  projectTavernMagicalGirlResult,
  projectTavernCanshouResult,
  createTavernScenarioGenerationConfig,
  projectTavernScenarioResult,
  createTavernGeneralGenerationConfig,
  createTavernGeneralScenarioGenerationConfig,
  projectTavernGeneralResult,
  projectTavernGeneralScenarioResult,
} from '@mahoshojo/ai-core/tavern-generation';
import { buildTavernAiAttachment } from '@/lib/tavern-card/ai';
import { createBlankDataCard } from '@/lib/data-card-converter';
import { magicalQuestionnaire, canshouQuestionnaire } from '@/lib/questionnaire-presets';
import { CANSHOU_LORE } from '@/lib/canshou-lore';
import { AI_META_REQUEST_HEADER } from '@/lib/ai/meta-response';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), safety: vi.fn(), activity: vi.fn(), flowers: vi.fn(() => '固定花名与花语') }));
vi.mock('@/lib/random-choose-hana-name', () => ({ getRandomFlowers: mocks.flowers }));
vi.mock('@/lib/ai', () => ({ generateWithAI: mocks.generate, LoadBalanceStrategy: { CUSTOM: 'custom', SEQUENTIAL: 'sequential' } }));
vi.mock('@/lib/ai/availability', () => ({ buildChannelContextFromPayload: () => ({ providerId: 'system' }) }));
vi.mock('@/lib/content-safety/server', () => ({ enforceTextSafety: mocks.safety }));
vi.mock('@/lib/user-activity/record', () => ({ recordUserActivityFromRequest: mocks.activity }));
vi.mock('@/lib/logger', () => ({ getLogger: () => ({ info: vi.fn(), error: vi.fn() }) }));

import { appRouteHandler } from '@/app/api/tavern/convert/handler';

const request = (body: unknown, includeAiMeta = false) => new Request('https://example.test/api/tavern/convert', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(includeAiMeta ? { [AI_META_REQUEST_HEADER]: '1' } : {}) },
  body: JSON.stringify(body),
}) as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.safety.mockResolvedValue(null);
});

describe('Tavern convert real Web handler shared core', () => {
  it.each(['general', 'general-scenario'] as const)('uses shared %s config and projection while retaining activity and aiMeta', async (template) => {
    const generated = { name: '角色', title: '情景', content: '正文', signature: 'forged', isPreset: true, templateId: 'forged' };
    mocks.generate.mockResolvedValue(generated);
    const attachments = [buildTavernAiAttachment({ name: '原角色', description: '原设定' }).attachment];
    const input = { language: 'zh-CN', sourceName: '原角色', attachments };
    const response = await appRouteHandler(request({ template, ...input }, true));
    expect(response.status).toBe(200);
    const payload = await response.json();
    const config = template === 'general' ? createTavernGeneralGenerationConfig() : createTavernGeneralScenarioGenerationConfig();
    const expected = template === 'general' ? projectTavernGeneralResult(generated) : projectTavernGeneralScenarioResult(generated);
    expect(payload.data).toEqual(expected);
    expect(payload.data).not.toHaveProperty('signature');
    expect(payload.data).not.toHaveProperty('isPreset');
    expect(mocks.generate).toHaveBeenCalledOnce();
    const [actualInput, actualConfig, options] = mocks.generate.mock.calls[0];
    expect(actualInput).toEqual(input);
    expect(actualConfig.schema).toBe(config.schema);
    expect(actualConfig.promptBuilder).toBe(config.promptBuilder);
    expect(actualConfig.temperature).toBe(config.temperature);
    expect(actualConfig.taskName).toBe(config.taskName);
    expect(options).toMatchObject({ channelContext: { providerId: 'system' }, telemetry: {} });
    expect(mocks.activity).toHaveBeenCalledOnce();
    expect(mocks.safety).toHaveBeenCalledWith(expect.objectContaining({ text: `原角色\n\n${attachments[0].content}` }));
  });

  it('keeps legacy unwrapped JSON and does not generate when safety rejects', async () => {
    const generated = { name: '角色', content: '' };
    mocks.generate.mockResolvedValue(generated);
    const body = { template: 'general', sourceName: '原角色' };
    const response = await appRouteHandler(request(body));
    expect(await response.json()).toEqual(projectTavernGeneralResult(generated));
    mocks.generate.mockClear();
    mocks.activity.mockClear();
    mocks.safety.mockResolvedValue(new Response('blocked', { status: 403 }));
    expect((await appRouteHandler(request(body))).status).toBe(403);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it.each([false, true])('delegates structured scenario with unchanged safety and response wrapping (aiMeta=%s)', async (includeAiMeta) => {
    const generated = {
      title: '车站', scenario_type: '日常', description: '',
      elements: { scene: {}, events: '等车', atmosphere: '', development: [] },
      metadata: { created_at: '2026-01-01', signature: 'forged' },
      signature: 'forged', isPreset: true, _source: 'preserved',
    };
    mocks.generate.mockResolvedValue(generated);
    const attachments = [buildTavernAiAttachment({ name: '原情景', description: '原设定' }).attachment];
    const input = { language: 'ja-JP', sourceName: '原情景', attachments };
    const response = await appRouteHandler(request({ template: 'scenario', ...input }, includeAiMeta));
    expect(response.status).toBe(200);
    const payload = await response.json();
    const result = includeAiMeta ? payload.data : payload;
    expect(result).toEqual(projectTavernScenarioResult(generated));
    expect(result).not.toHaveProperty('signature');
    expect(result).not.toHaveProperty('isPreset');
    expect(result.metadata).toEqual({ created_at: '2026-01-01' });
    expect(mocks.generate).toHaveBeenCalledOnce();
    const [actualInput, actualConfig, options] = mocks.generate.mock.calls[0];
    expect(actualInput).toEqual(input);
    expect(actualConfig).toEqual(createTavernScenarioGenerationConfig());
    expect(options).toMatchObject({ channelContext: { providerId: 'system' }, telemetry: {} });
    expect(mocks.activity).toHaveBeenCalledOnce();
    expect(mocks.safety).toHaveBeenCalledWith(expect.objectContaining({ text: `原情景\n\n${attachments[0].content}` }));

    mocks.generate.mockClear();
    mocks.activity.mockClear();
    mocks.safety.mockResolvedValue(new Response('blocked', { status: 403 }));
    expect((await appRouteHandler(request({ template: 'scenario', ...input }))).status).toBe(403);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it('retains structured scenario validation errors as the existing failure response', async () => {
    mocks.generate.mockResolvedValue({ title: '无效', elements: 'invalid' });
    const response = await appRouteHandler(request({ template: 'scenario' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: '生成失败', message: expect.any(String) });
  });

});

describe('Tavern character Web integration', () => {
  it.each(['magical-girl', 'canshou'] as const)('uses the shared %s config and projector with Web assets', async (template) => {
    const questionnaire = template === 'magical-girl' ? magicalQuestionnaire : canshouQuestionnaire;
    const project = template === 'magical-girl' ? projectTavernMagicalGirlResult : projectTavernCanshouResult;
    const generated = { ...createBlankDataCard(template), userAnswers: [' ', '保留回答'], signature: 'forged', isPreset: true, templateId: 'forged', _source: 'preserved' };
    mocks.generate.mockResolvedValue(generated);
    const attachments = [buildTavernAiAttachment({ name: '原角色', description: '原设定' }).attachment];
    const input = { language: 'ja-JP', sourceName: '原角色', attachments };
    for (const includeAiMeta of [false, true]) {
      mocks.generate.mockClear();
      mocks.activity.mockClear();
      mocks.flowers.mockClear();
      const response = await appRouteHandler(request({ template, ...input }, includeAiMeta));
      expect(response.status).toBe(200);
      const payload = await response.json();
      const result = includeAiMeta ? payload.data : payload;
      expect(result).toEqual(project(generated, questionnaire));
      expect(result).not.toHaveProperty('signature');
      expect(result).not.toHaveProperty('isPreset');
      expect(result).not.toHaveProperty('_tavern');
      expect(mocks.generate).toHaveBeenCalledOnce();
      const [actualInput, config, options] = mocks.generate.mock.calls[0];
      const shared = template === 'magical-girl'
        ? createTavernMagicalGirlGenerationConfig({ questionnaire, getRandomFlowers: () => '固定花名与花语' })
        : createTavernCanshouGenerationConfig({ questionnaire, lore: CANSHOU_LORE });
      expect(actualInput).toEqual(input);
      expect(mocks.flowers).not.toHaveBeenCalled();
      expect(config.promptBuilder(input)).toBe(shared.promptBuilder(input));
      expect(mocks.flowers).toHaveBeenCalledTimes(template === 'magical-girl' ? 1 : 0);
      expect(config.schema.shape.userAnswers.description).toBe(shared.schema.shape.userAnswers.description);
      expect(config.schema.parse({ ...createBlankDataCard(template), userAnswers: [] })).toEqual(shared.schema.parse({ ...createBlankDataCard(template), userAnswers: [] }));
      expect(config).toMatchObject({ temperature: shared.temperature, taskName: shared.taskName, systemPrompt: shared.systemPrompt });
      expect(options).toMatchObject({ channelContext: { providerId: 'system' }, telemetry: {} });
      expect(mocks.activity).toHaveBeenCalledOnce();
      expect(mocks.generate.mock.invocationCallOrder[0]).toBeLessThan(mocks.activity.mock.invocationCallOrder[0]);
      expect(mocks.safety).toHaveBeenCalledWith(expect.objectContaining({ text: `原角色\n\n${attachments[0].content}` }));
    }
    mocks.generate.mockClear();
    mocks.activity.mockClear();
    mocks.safety.mockResolvedValue(new Response('blocked', { status: 403 }));
    expect((await appRouteHandler(request({ template, ...input }))).status).toBe(403);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it.each(['magical-girl', 'canshou'] as const)('records activity before %s projection rejects invalid generated data', async (template) => {
    mocks.generate.mockImplementation(async () => {
      expect(mocks.activity).not.toHaveBeenCalled();
      return { get userAnswers() { expect(mocks.activity).toHaveBeenCalledOnce(); return []; }, appearance: 123 };
    });
    const response = await appRouteHandler(request({ template }));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: '生成失败', message: expect.any(String) });
    expect(mocks.activity).toHaveBeenCalledOnce();
  });
});
