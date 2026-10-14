import { describe, expect, it, vi } from 'vitest';
import { createTavernGeneralGenerationConfig, createTavernGeneralScenarioGenerationConfig, createTavernScenarioGenerationConfig } from '@mahoshojo/ai-core/tavern-generation';
import { buildStructuredJsonInstructionFromZodSchema } from '@mahoshojo/ai-core/structured-json';
import { DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE } from '@mahoshojo/domain/tavern-card';
import type { AiExecutionRequest } from '@mahoshojo/contracts/ai-execution';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import { executeTavernGeneration, prepareTavernGenerationInput, validateTavernGeneratedCard, type TavernGenerationInput, type TavernGenerationIntent } from '../src/features/tavern/generation';
import { STREAM_DIRECT_AI_COMMAND, STREAM_TARGET_AI_COMMAND } from '../src/platform/direct-ai-bridge';

const scenario = { title: '情景', scenario_type: '互动', description: '简介', elements: { scene: {}, events: '事件', atmosphere: '轻松', development: [] } };
const input: TavernGenerationInput = { raw: { name: 'Alice', description: '{{user}} 对 {{char}} 说话', extensions: { script: '{{user}} 原件' } }, template: 'general', language: '日本語', preference: { ...DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE, userReplacement: '旅人' } };
const intent: TavernGenerationIntent = { requestId: 'tavern-1', mode: 'direct-remote', generationMode: 'non-stream', modelId: 'test-model' };
function harness(text: string) {
  let request!: AiExecutionRequest;
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command !== STREAM_DIRECT_AI_COMMAND && command !== STREAM_TARGET_AI_COMMAND) throw new Error(command);
    request = args!.request as AiExecutionRequest;
    const channel = args!.onEvent as { onmessage(event: AiStreamEvent): void };
    const identity = { requestId: request.requestId, contractVersion: 1 as const, mode: request.mode };
    channel.onmessage({ type: 'started', ...identity, sequence: 0 });
    channel.onmessage({ type: 'text-delta', ...identity, sequence: 1, delta: text });
    channel.onmessage({ type: 'result', ...identity, sequence: 2, result: { ...identity, status: 'completed', finishReason: 'stop', output: { text } } });
  });
  return { invoke, options: { invoke, profileId: 'profile', createChannel: () => ({}) }, request: () => request };
}

describe('Tavern Direct uses the shared Web generation core', () => {
  it.each(['general', 'general-scenario', 'scenario'] as const)('dispatches %s prompt/schema to Direct and retains the untouched original', async template => {
    const native = harness(JSON.stringify({ ...scenario, name: '角色', content: '正文', metadata: { signature: 'forged' }, signature: 'forged', isPreset: true }));
    const selected = { ...input, template };
    const prepared = prepareTavernGenerationInput(selected);
    const config = template === 'scenario' ? createTavernScenarioGenerationConfig() : template === 'general' ? createTavernGeneralGenerationConfig() : createTavernGeneralScenarioGenerationConfig();
    const target = { kind: 'preset' as const, providerId: 'deepseek' };
    const outcome = await executeTavernGeneration({ ...native.options, providerTarget: target }, selected, { ...intent, overrides: { temperature: 0.4, maxOutputTokens: 900 } }, new AbortController().signal);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith(STREAM_TARGET_AI_COMMAND, { target, request: native.request(), onEvent: expect.objectContaining({ onmessage: expect.any(Function) }) });
    expect(native.request()).toMatchObject({ modelId: 'test-model', mode: 'direct-remote', responseFormat: 'text', temperature: 0.4, maxOutputTokens: 900 });
    expect(native.request().messages).toEqual([
      { role: 'system', content: `${config.systemPrompt}\n\n${buildStructuredJsonInstructionFromZodSchema(config.schema)}` },
      { role: 'user', content: config.promptBuilder(prepared.promptInput) },
    ]);
    expect(prepared.promptInput.attachments[0].content).toContain('旅人 对 Alice 说话');
    expect(outcome).toMatchObject({ status: 'completed', cardKind: template, card: { ...(template === 'scenario' ? scenario : { templateId: template === 'general' ? '通用角色' : '通用情景', content: '正文' }), _tavern: { raw: input.raw } } });
    if (outcome.status !== 'completed') throw new Error('expected completed');
    expect(outcome.card).not.toHaveProperty('metadata.signature'); expect(outcome.card).not.toHaveProperty('signature'); expect(outcome.card).not.toHaveProperty('isPreset');
    expect(input.raw).toMatchObject({ description: '{{user}} 对 {{char}} 说话' });
  });
  it.each(['not JSON', '{"name":"missing content"}', '{"title":1,"content":{}}'])('rejects malformed model output without retry: %s', async text => {
    const native = harness(text);
    expect(await executeTavernGeneration(native.options, input, intent, new AbortController().signal)).toMatchObject({ status: 'invalid-output', rawText: text });
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
  it('rejects unknown app fields when validating a restored structured card', () => {
    expect(() => validateTavernGeneratedCard('scenario', { ...scenario, arbitrary: 'unknown', _tavern: { raw: input.raw } })).toThrow();
  });
  it('rejects malformed structured scenario without falling back to a general card', async () => {
    const text = JSON.stringify({ title: '错误情景', content: '不是结构化数据', elements: { events: 1 } });
    const native = harness(text);
    expect(await executeTavernGeneration(native.options, { ...input, template: 'scenario' }, intent, new AbortController().signal)).toMatchObject({ status: 'invalid-output', rawText: text });
    expect(native.invoke).toHaveBeenCalledOnce();
  });
  it('rejects direct system and stream rather than inventing a fallback', async () => {
    const native = harness('{}'); const signal = new AbortController().signal;
    expect(await executeTavernGeneration({ ...native.options, providerTarget: { kind: 'system' } }, input, intent, signal)).toMatchObject({ status: 'failed', code: 'invalid-request' });
    expect(await executeTavernGeneration(native.options, input, { ...intent, generationMode: 'stream' } as unknown as TavernGenerationIntent, signal)).toMatchObject({ status: 'failed', code: 'invalid-request' });
    expect(native.invoke).not.toHaveBeenCalled();
  });
});

describe('Tavern JSON-only Hosted generation', () => {
  const hosted = { requestId: 'tavern-hosted', mode: 'hosted-json' as const, generationMode: 'non-stream' as const, modelId: 'default' };
  it.each(['general', 'general-scenario', 'scenario'] as const)('projects unsigned %s and restores only the frozen local original', async template => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise(resolve => { finish = resolve; })); const notify = vi.fn();
    const original = JSON.parse(JSON.stringify(input)) as TavernGenerationInput; original.template = template;
    const frozenRaw = JSON.parse(JSON.stringify(original.raw));
    const pending = executeTavernGeneration({ invoke, profileId: '', providerTarget: { kind: 'preset', providerId: 'deepseek' }, onHostedDispatchSettled: notify }, original,
      { ...hosted, modelId: 'deepseek-chat', overrides: { temperature: 0.4 } }, new AbortController().signal);
    const request = invoke.mock.calls[0] as unknown as [string, { request: { body: unknown; presetConfig: unknown } }];
    expect(request[0]).toBe('hosted_ai_request');
    expect(request[1].request).toMatchObject({ routeId: 'tavern-convert', body: { template, ...prepareTavernGenerationInput(original).promptInput }, presetConfig: { providerId: 'deepseek', modelId: 'deepseek-chat', generationOverrides: { temperature: 0.4 } } });
    expect(request[1].request.body).not.toHaveProperty('raw'); expect(request[1].request.body).not.toHaveProperty('preference');
    original.raw = { name: 'changed' };
    finish({ status: 200, body: { aiMeta: null, data: { ...scenario, name: '角色', content: '正文', metadata: { signature: 'forged' }, signature: 'forged', isPreset: true, _tavern: { raw: { name: 'server' } } } } });
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: 'completed', cardKind: template, card: { ...(template === 'scenario' ? scenario : { content: '正文' }), _tavern: { raw: frozenRaw } } });
    if (outcome.status !== 'completed') throw new Error('expected completed');
    expect(outcome.card).not.toHaveProperty('metadata.signature'); expect(outcome.card).not.toHaveProperty('signature'); expect(outcome.card).not.toHaveProperty('isPreset');
    expect(invoke).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledOnce();
  });
  it('rejects overlong source metadata before any Native invocation or cooldown', async () => {
    const invoke = vi.fn(); const notify = vi.fn();
    await expect(executeTavernGeneration({ invoke, profileId: '', providerTarget: { kind: 'preset', providerId: 'deepseek' }, onHostedDispatchSettled: notify },
      { ...input, raw: { name: 'x'.repeat(4097), description: '有效的角色设定' } }, { ...hosted, modelId: 'deepseek-chat' }, new AbortController().signal)).rejects.toThrow('4096');
    expect(invoke).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
  it('sends system config and keeps 429 cooldown without replay', async () => {
    const invoke = vi.fn(async () => ({ status: 429, body: { error: 'slow down', retryAfterSeconds: 120 } })); const notify = vi.fn();
    const result = await executeTavernGeneration({ invoke, profileId: '', providerTarget: { kind: 'system' }, onHostedDispatchSettled: notify }, input, { ...hosted, modelId: 'selected', overrides: { temperature: 0.4 } }, new AbortController().signal);
    expect(invoke).toHaveBeenCalledWith('hosted_ai_request', { request: expect.objectContaining({ routeId: 'tavern-convert', systemConfig: { modelId: 'selected', generationOverrides: { temperature: 0.4 } } }) });
    expect(result).toMatchObject({ status: 'failed', retryAfterSeconds: 120 }); expect(notify).toHaveBeenCalledWith(120); expect(invoke).toHaveBeenCalledOnce();
  });
  it.each([
    ['protocol-mismatch', 'failed', false], ['storage-unavailable', 'failed', false],
    ['invalid-response', 'uncertain', true], ['internal-error', 'uncertain', true],
  ] as const)('keeps %s tied to its dispatch certainty without replay', async (code, status, cooldown) => {
    const invoke = vi.fn(async () => { throw { code, message: 'synthetic boundary failure' }; }); const notify = vi.fn();
    const outcome = await executeTavernGeneration({ invoke, profileId: '', onHostedDispatchSettled: notify }, input, hosted, new AbortController().signal);
    expect(outcome.status).toBe(status); expect(notify).toHaveBeenCalledTimes(cooldown ? 1 : 0); expect(invoke).toHaveBeenCalledOnce();
  });
  it('retains unknown dispatch as uncertain and refuses custom targets before invocation', async () => {
    const invoke = vi.fn(async () => { throw { code: 'future-native-code', message: 'unknown' }; }); const notify = vi.fn();
    const options = { invoke, profileId: '', onHostedDispatchSettled: notify };
    expect(await executeTavernGeneration(options, input, hosted, new AbortController().signal)).toMatchObject({ status: 'uncertain' });
    expect(invoke).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledOnce(); invoke.mockClear(); notify.mockClear();
    expect(await executeTavernGeneration({ ...options, providerTarget: { kind: 'custom', profileId: 'custom' } }, input, hosted, new AbortController().signal)).toMatchObject({ status: 'failed', code: 'invalid-request' });
    expect(invoke).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
});
