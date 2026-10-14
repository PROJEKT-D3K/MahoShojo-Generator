import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  createTavernGeneralGenerationConfig,
  createTavernGeneralScenarioGenerationConfig,
  projectTavernGeneralResult,
  projectTavernGeneralScenarioResult,
} from '@mahoshojo/ai-core/tavern-generation';
import { buildTavernAiAttachment } from '@/lib/tavern-card/ai';
import { AI_META_REQUEST_HEADER } from '@/lib/ai/meta-response';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), safety: vi.fn(), activity: vi.fn() }));
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
});
