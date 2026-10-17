import { withFixtureStreamReceipt } from './helpers/stream-receipt-fixture';
import { describe, expect, it, vi } from 'vitest';
import { MAGICAL_GIRL_GENERATION_CONFIG } from '@mahoshojo/ai-core/name-generation';
import { buildStructuredJsonInstructionFromZodSchema } from '@mahoshojo/ai-core/structured-json';
import { buildNameGenerationResult, serializeNameGenerationResult } from '@mahoshojo/domain/name-generation';
import type { AiExecutionRequest } from '@mahoshojo/contracts/ai-execution';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import { executeNameGeneration, normalizeNameGenerationInput, type NameGenerationIntent } from '../src/features/name/generation';
import { STREAM_DIRECT_AI_COMMAND, CANCEL_DIRECT_AI_COMMAND } from '../src/platform/direct-ai-bridge';
import type { DesktopHostedJsonExecutionOptions } from '../src/features/generation/executor';

const generated = {
  flowerName: '铃兰', flowerDescription: '幸福归来',
  appearance: { height: '155cm', weight: '45kg', hairColor: '银白色', hairStyle: '长发', eyeColor: '绿色', skinTone: '白皙', wearing: '礼服', specialFeature: '微笑', mainColor: '绿色', firstPageColor: '#123456', secondPageColor: '#654321' }, spell: '花よ\n花啊',
};
const input = { realName: '  小满🌸  ', language: '日本語' };
const intent: NameGenerationIntent = { requestId: 'name-1', mode: 'direct-local', generationMode: 'non-stream', modelId: 'test-model' };
function nativeHarness(text: string, gate?: Promise<void>) {
  let sent: AiExecutionRequest | undefined;
  const invoke = vi.fn(withFixtureStreamReceipt(async (command: string, args?: Record<string, unknown>) => {
    if (command === CANCEL_DIRECT_AI_COMMAND) return true;
    if (command !== STREAM_DIRECT_AI_COMMAND) throw new Error(command);
    sent = args!.request as AiExecutionRequest;
    const channel = args!.onEvent as { onmessage(event: AiStreamEvent): void };
    const identity = { requestId: sent.requestId, contractVersion: 1 as const, mode: sent.mode };
    channel.onmessage({ type: 'started', ...identity, sequence: 0 });
    channel.onmessage({ type: 'text-delta', ...identity, sequence: 1, delta: text });
    if (gate) await gate;
    channel.onmessage({ type: 'result', ...identity, sequence: 2, result: { ...identity, status: 'completed', finishReason: 'stop', output: { text } } });
  }));
  return { invoke, options: { invoke, profileId: 'profile', createChannel: () => ({}) }, request: () => sent! };
}

describe('name generation uses the existing Direct request/collector', () => {
  it('sends the shared prompt and schema instruction to the actual IPC boundary, never a hosted route', async () => {
    const native = nativeHarness(JSON.stringify({ ...generated, signature: 'fake', templateId: 'fake' }));
    const result = await executeNameGeneration(native.options, input, intent, new AbortController().signal);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.request()).toMatchObject({ modelId: 'test-model', mode: 'direct-local', responseFormat: 'text', temperature: 0.8 });
    expect(native.request().messages).toEqual([
      { role: 'system', content: `${MAGICAL_GIRL_GENERATION_CONFIG.systemPrompt}\n\n${buildStructuredJsonInstructionFromZodSchema(MAGICAL_GIRL_GENERATION_CONFIG.schema)}` },
      { role: 'user', content: MAGICAL_GIRL_GENERATION_CONFIG.promptBuilder({ realName: '小满🌸', language: '日本語' }) },
    ]);
    expect(result).toMatchObject({ status: 'completed', cardKind: 'name', card: buildNameGenerationResult('小满🌸', generated) });
    if (result.status !== 'completed') throw new Error('expected completed');
    expect(JSON.stringify(result.card, null, 2)).toBe(serializeNameGenerationResult(buildNameGenerationResult('小满🌸', generated)));
    expect(result.card).not.toHaveProperty('signature');
    expect(result.card).not.toHaveProperty('templateId');
  });
  it.each(['', '  ', '名'.repeat(301), '🌸'.repeat(151), ' '+ '名'.repeat(300)])('rejects invalid raw names before IPC', async realName => {
    const native = nativeHarness('{}');
    await expect(executeNameGeneration(native.options, { ...input, realName }, intent, new AbortController().signal)).rejects.toThrow();
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it.each(['名'.repeat(300), '🌸'.repeat(150)])('accepts original boundary without counting code points', realName => {
    expect(normalizeNameGenerationInput({ realName, language: ' zh-CN ' })).toEqual({ realName, language: 'zh-CN' });
  });
  it.each(['', ' '.repeat(3), 'a'.repeat(33)])('rejects invalid language before IPC', async language => {
    const native = nativeHarness('{}');
    await expect(executeNameGeneration(native.options, { ...input, language }, intent, new AbortController().signal)).rejects.toThrow();
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it.each(['hosted-stream', 'invented'])('rejects unsupported %s modes at runtime without IPC', async mode => {
    const native = nativeHarness('{}');
    expect(await executeNameGeneration(native.options, input, { ...intent, mode } as NameGenerationIntent, new AbortController().signal)).toMatchObject({ status: 'failed', code: 'invalid-request' });
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it('rejects a system target rather than silently routing it as local Direct', async () => {
    const native = nativeHarness('{}');
    expect(await executeNameGeneration({ ...native.options, providerTarget: { kind: 'system' } }, input, intent, new AbortController().signal)).toMatchObject({ status: 'failed', code: 'invalid-request' });
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it.each(['not JSON', '{"flowerName":"missing fields"}'])('preserves malformed raw output: %s', async text => {
    const native = nativeHarness(text);
    expect(await executeNameGeneration(native.options, input, intent, new AbortController().signal)).toMatchObject({ status: 'invalid-output', rawText: text });
  });
  it('does not dispatch a pre-cancelled request', async () => {
    const native = nativeHarness('{}'); const controller = new AbortController(); controller.abort();
    expect(await executeNameGeneration(native.options, input, intent, controller.signal)).toMatchObject({ status: 'cancelled' });
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it('cancels the original native request and ignores a late terminal card', async () => {
    let finish!: () => void;
    const native = nativeHarness(JSON.stringify(generated), new Promise<void>(resolve => { finish = resolve; }));
    const controller = new AbortController(); const partial = vi.fn();
    const result = executeNameGeneration(native.options, input, intent, controller.signal, partial);
    await new Promise(resolve => setTimeout(resolve, 0)); controller.abort(); finish();
    expect(await result).toMatchObject({ status: 'cancelled', rawText: JSON.stringify(generated) });
    expect(native.invoke).toHaveBeenCalledWith(CANCEL_DIRECT_AI_COMMAND, { requestId: 'name-1' });
    expect(partial).toHaveBeenCalledWith(JSON.stringify(generated));
  });
});


describe('name JSON-only fixed server channel', () => {
  const hosted = { requestId: 'hosted-name-1', mode: 'hosted-json' as const, modelId: 'default' };
  const signed = { ...generated, templateId: '魔法少女/心之花/魔法少女（名字生成）', signature: 'synthetic.signed-flower' };
  const options = (invoke: DesktopHostedJsonExecutionOptions['invoke'], onHostedDispatchSettled = vi.fn()) => ({ invoke, profileId: '', providerTarget: { kind: 'system' as const }, onHostedDispatchSettled });
  it('sends only name/language through the real bridge schema, preserves signed original and projects seven unsigned fields', async () => {
    const invoke = vi.fn(async () => ({ status: 200, body: signed })); const notify = vi.fn();
    const result = await executeNameGeneration(options(invoke, notify), input, hosted, new AbortController().signal);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('hosted_ai_request', { request: {
      requestId: 'hosted-name-1', routeId: 'generate-magical-girl', body: { name: '小满🌸', language: '日本語' }, systemConfig: { modelId: 'default' },
    } });
    expect(result).toMatchObject({ status: 'completed', mode: 'hosted-json', cardKind: 'name', card: buildNameGenerationResult('小满🌸', generated), rawText: JSON.stringify(signed) });
    if (result.status !== 'completed') throw new Error('expected completed');
    expect(Object.keys(result.card)).toHaveLength(7); expect(result.card).not.toHaveProperty('signature');
    expect(notify).toHaveBeenCalledOnce();
  });
  it.each([{ kind: 'preset', providerId: 'deepseek' }, { kind: 'custom', profileId: 'local' }] as const)('rejects unsupported target $kind without any invoke/cooldown', async providerTarget => {
    const invoke = vi.fn(); const notify = vi.fn();
    const result = await executeNameGeneration({ ...options(invoke, notify), providerTarget }, input, hosted, new AbortController().signal);
    expect(result).toMatchObject({ status: 'failed', code: 'invalid-request' }); expect(invoke).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
  it.each([{ modelId: 'not-default' }, { modelId: ' ' }, { overrides: { temperature: 0.8 } }, { overrides: { thinking: { mode: 'default' as const } } }])('rejects model/override requests rather than ignoring them', async extra => {
    const invoke = vi.fn(); const notify = vi.fn();
    expect(await executeNameGeneration(options(invoke, notify), input, { ...hosted, ...extra }, new AbortController().signal)).toMatchObject({ status: 'failed', code: 'invalid-request' });
    expect(invoke).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
  it.each(['invalid-request', 'protocol-mismatch', 'server-unavailable', 'storage-unavailable', 'cancelled-before-dispatch'])('does not cool down native preparation failure %s', async code => {
    const invoke = vi.fn(async () => { throw { code, message: 'not dispatched' }; }); const notify = vi.fn();
    expect(await executeNameGeneration(options(invoke, notify), input, hosted, new AbortController().signal)).toMatchObject({ status: code === 'cancelled-before-dispatch' ? 'cancelled' : 'failed' });
    expect(notify).not.toHaveBeenCalled(); expect(invoke).toHaveBeenCalledOnce();
  });
  it.each(['cancelled', 'network-error', 'timeout', 'invalid-response', 'internal-error', 'future-native-code'])('keeps %s uncertain, cools down once, and never retries', async code => {
    const invoke = vi.fn(async () => { throw { code, message: 'cannot confirm' }; }); const notify = vi.fn();
    const result = await executeNameGeneration(options(invoke, notify), input, hosted, new AbortController().signal);
    expect(result).toMatchObject({ status: 'uncertain' }); expect(notify).toHaveBeenCalledOnce(); expect(invoke).toHaveBeenCalledOnce();
  });
  it('pre-abort never invokes or starts cooldown; a post-invoke abort remains uncertain', async () => {
    const controller = new AbortController(); controller.abort(); const before = vi.fn(); const notify = vi.fn();
    expect(await executeNameGeneration(options(before, notify), input, hosted, controller.signal)).toMatchObject({ status: 'cancelled' });
    expect(before).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
    const after = new AbortController(); let finish!: (value: unknown) => void;
    const invoke = vi.fn((command: string) => command === 'cancel_hosted_ai' ? Promise.resolve(true) : new Promise(resolve => { finish = resolve; }));
    const pending = executeNameGeneration(options(invoke, notify), input, hosted, after.signal);
    after.abort(); finish({ status: 200, body: signed });
    expect(await pending).toMatchObject({ status: 'uncertain' }); expect(notify).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('cancel_hosted_ai', { requestId: 'hosted-name-1' });
    expect(invoke.mock.calls.filter(call => call[0] === 'hosted_ai_request')).toHaveLength(1);
  });
  it.each([null, {}])('uses 429 header fallback without a useful payload (%s)', async body => {
    const invoke = vi.fn(async () => ({ status: 429, body, retryAfterSeconds: 75 })); const notify = vi.fn();
    expect(await executeNameGeneration(options(invoke, notify), input, hosted, new AbortController().signal)).toMatchObject({ status: 'failed', message: expect.stringContaining('75'), retryAfterSeconds: 75 });
    expect(notify).toHaveBeenCalledWith(75);
  });
  it('preserves invalid signed output for diagnosis, and callback failures never turn success/unknown into failed', async () => {
    const invalid = { flowerName: 'bad', signature: 'synthetic' };
    const invoke = vi.fn(async () => ({ status: 200, body: invalid }));
    expect(await executeNameGeneration(options(invoke), input, hosted, new AbortController().signal)).toMatchObject({ status: 'invalid-output', rawText: JSON.stringify(invalid) });
    const notify = vi.fn(() => { throw new Error('storage callback failed'); });
    invoke.mockResolvedValue({ status: 200, body: signed });
    expect(await executeNameGeneration(options(invoke, notify), input, hosted, new AbortController().signal)).toMatchObject({ status: 'completed' });
    invoke.mockRejectedValue(new Error('unknown invoke failure'));
    expect(await executeNameGeneration(options(invoke, notify), input, hosted, new AbortController().signal)).toMatchObject({ status: 'uncertain' });
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
