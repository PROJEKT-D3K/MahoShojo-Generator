import { describe, expect, it, vi } from 'vitest';
import { createTavernGeneralGenerationConfig, createTavernGeneralScenarioGenerationConfig } from '@mahoshojo/ai-core/tavern-generation';
import { buildStructuredJsonInstructionFromZodSchema } from '@mahoshojo/ai-core/structured-json';
import { DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE } from '@mahoshojo/domain/tavern-card';
import type { AiExecutionRequest } from '@mahoshojo/contracts/ai-execution';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import { executeTavernGeneration, prepareTavernGenerationInput, type TavernGenerationInput, type TavernGenerationIntent } from '../src/features/tavern/generation';
import { STREAM_DIRECT_AI_COMMAND, STREAM_TARGET_AI_COMMAND } from '../src/platform/direct-ai-bridge';

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
  it.each(['general', 'general-scenario'] as const)('dispatches %s prompt/schema to Direct and retains the untouched original', async template => {
    const native = harness(JSON.stringify({ name: '角色', title: '情景', content: '正文', signature: 'forged', isPreset: true }));
    const selected = { ...input, template };
    const prepared = prepareTavernGenerationInput(selected);
    const config = template === 'general' ? createTavernGeneralGenerationConfig() : createTavernGeneralScenarioGenerationConfig();
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
    expect(outcome).toMatchObject({ status: 'completed', cardKind: template, card: { templateId: template === 'general' ? '通用角色' : '通用情景', content: '正文', _tavern: { raw: input.raw } } });
    if (outcome.status !== 'completed') throw new Error('expected completed');
    expect(outcome.card).not.toHaveProperty('signature'); expect(outcome.card).not.toHaveProperty('isPreset');
    expect(input.raw).toMatchObject({ description: '{{user}} 对 {{char}} 说话' });
  });
  it.each(['not JSON', '{"name":"missing content"}', '{"title":1,"content":{}}'])('rejects malformed model output without retry: %s', async text => {
    const native = harness(text);
    expect(await executeTavernGeneration(native.options, input, intent, new AbortController().signal)).toMatchObject({ status: 'invalid-output', rawText: text });
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
  it('rejects system, hosted and stream rather than inventing a route or fallback', async () => {
    const native = harness('{}'); const signal = new AbortController().signal;
    expect(await executeTavernGeneration({ ...native.options, providerTarget: { kind: 'system' } }, input, intent, signal)).toMatchObject({ status: 'failed', code: 'invalid-request' });
    expect(await executeTavernGeneration(native.options, input, { ...intent, mode: 'hosted-json' } as unknown as TavernGenerationIntent, signal)).toMatchObject({ status: 'failed', code: 'invalid-request' });
    expect(await executeTavernGeneration(native.options, input, { ...intent, generationMode: 'stream' } as unknown as TavernGenerationIntent, signal)).toMatchObject({ status: 'failed', code: 'invalid-request' });
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
