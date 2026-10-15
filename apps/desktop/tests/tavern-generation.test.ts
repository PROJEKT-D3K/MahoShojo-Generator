import { describe, expect, it, vi } from 'vitest';
import { tavernModelResult } from './tavern-character-fixtures';
import magicalQuestionnaire from '../../../content/questionnaires/presets/magical-girl-default.json';
import canshouQuestionnaire from '../../../content/questionnaires/presets/canshou-default.json';
import { buildStructuredJsonInstructionFromZodSchema } from '@mahoshojo/ai-core/structured-json';
import { DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE, projectTavernStreamMarkdown } from '@mahoshojo/domain/tavern-card';
import { buildTavernStreamPrompt, TAVERN_STREAM_TEMPERATURE } from '@mahoshojo/ai-core/tavern-generation';
import { getRandomFlowers } from '@mahoshojo/domain/flowers';
import { CANSHOU_LORE } from '@mahoshojo/domain/canshou-lore';
import type { AiExecutionRequest } from '@mahoshojo/contracts/ai-execution';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import { createDesktopTavernGenerationConfig, executeTavernGeneration, prepareTavernGenerationInput, validateTavernGeneratedCard, type TavernGenerationInput, type TavernGenerationIntent } from '../src/features/tavern/generation';
import { STREAM_DIRECT_AI_COMMAND, STREAM_TARGET_AI_COMMAND } from '../src/platform/direct-ai-bridge';

const scenario = { title: '情景', scenario_type: '互动', description: '简介', elements: { scene: {}, events: '事件', atmosphere: '轻松', development: [] } };
const input: TavernGenerationInput = { raw: { name: 'Alice', description: '{{user}} 对 {{char}} 说话', extensions: { script: '{{user}} 原件' } }, template: 'general', language: '日本語', preference: { ...DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE, userReplacement: '旅人' } };
const intent: TavernGenerationIntent = { requestId: 'tavern-1', mode: 'direct-remote', generationMode: 'non-stream', modelId: 'test-model' };
type StreamIdentity = Pick<AiExecutionRequest, 'requestId' | 'contractVersion' | 'mode'>;
function harness(text: string, tail?: (identity: StreamIdentity, emit: (event: AiStreamEvent) => void) => void | Promise<void>) {
  let request!: AiExecutionRequest;
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command !== STREAM_DIRECT_AI_COMMAND && command !== STREAM_TARGET_AI_COMMAND) throw new Error(command);
    request = args!.request as AiExecutionRequest;
    const channel = args!.onEvent as { onmessage(event: AiStreamEvent): void };
    const identity = { requestId: request.requestId, contractVersion: 1 as const, mode: request.mode };
    channel.onmessage({ type: 'started', ...identity, sequence: 0 });
    if (text) channel.onmessage({ type: 'text-delta', ...identity, sequence: 1, delta: text });
    if (tail) await tail(identity, event => channel.onmessage(event));
    else channel.onmessage({ type: 'result', ...identity, sequence: text ? 2 : 1, result: { ...identity, status: 'completed', finishReason: 'stop', output: { text } } });
  });
  return { invoke, options: { invoke, profileId: 'profile', createChannel: () => ({}) }, request: () => request };
}

describe('Tavern Direct uses the shared Web generation core', () => {
  it.each(['general', 'general-scenario', 'scenario', 'magical-girl', 'canshou'] as const)('dispatches %s prompt/schema to Direct and retains the untouched original', async template => {
    const native = harness(JSON.stringify({ ...tavernModelResult(template), metadata: { signature: 'forged' }, signature: 'forged', isPreset: true }));
    const selected = { ...input, template };
    const prepared = prepareTavernGenerationInput(selected);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const config = createDesktopTavernGenerationConfig(template);
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
    expect(outcome).toMatchObject({ status: 'completed', cardKind: template, card: { ...(template === 'scenario' ? scenario : template === 'magical-girl' ? { codename: '星花' } : template === 'canshou' ? { name: '雾兽' } : { templateId: template === 'general' ? '通用角色' : '通用情景', content: '正文' }), _tavern: { raw: input.raw } } });
    if (outcome.status !== 'completed') throw new Error('expected completed');
    expect(outcome.card).not.toHaveProperty('metadata.signature'); expect(outcome.card).not.toHaveProperty('signature'); expect(outcome.card).not.toHaveProperty('isPreset');
    random.mockRestore();
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
  it('rejects direct system rather than inventing a fallback', async () => {
    const native = harness('{}'); const signal = new AbortController().signal;
    expect(await executeTavernGeneration({ ...native.options, providerTarget: { kind: 'system' } }, input, intent, signal)).toMatchObject({ status: 'failed', code: 'invalid-request' });
    expect(native.invoke).not.toHaveBeenCalled();
  });
});

describe('Tavern Direct Markdown generation', () => {
  const streamIntent: TavernGenerationIntent = { requestId: 'tavern-stream', mode: 'direct-local', generationMode: 'stream', modelId: 'test-model' };
  const markdown = '# 整理后的标题\n名字：字段角色名\n情景名：字段情景名\n\n完整正文 {{user}}';
  it.each(['general', 'general-scenario', 'scenario', 'magical-girl', 'canshou'] as const)('uses the shared %s prompt and projector in both Direct modes with a frozen original', async template => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      for (const mode of ['direct-local', 'direct-remote'] as const) {
        const original = structuredClone({ ...input, template });
        const frozen = structuredClone(original);
        const prepared = prepareTavernGenerationInput(frozen);
        let finish!: () => void;
        const native = harness(markdown, async (identity, emit) => {
          await new Promise<void>(resolve => { finish = resolve; });
          emit({ type: 'result', ...identity, sequence: 2, result: { ...identity, status: 'completed', finishReason: 'stop', output: { text: markdown } } });
        });
        const pending = executeTavernGeneration(native.options, original, { ...streamIntent, mode }, new AbortController().signal);
        (original.raw as { description: string; extensions: { script: string } }).description = 'changed';
        (original.raw as { extensions: { script: string } }).extensions.script = 'changed';
        original.preference.userReplacement = 'changed'; original.template = 'general';
        finish();
        const outcome = await pending;
        expect(native.request()).toMatchObject({ mode, modelId: 'test-model', responseFormat: 'text', temperature: TAVERN_STREAM_TEMPERATURE });
        expect(native.request().messages).toEqual([{ role: 'user', content: buildTavernStreamPrompt({ ...prepared.promptInput, template }, { getRandomFlowers, lore: CANSHOU_LORE }) }]);
        expect(native.request().messages[0].content).toContain('旅人 对 Alice 说话');
        const cardKind = template === 'scenario' || template === 'general-scenario' ? 'general-scenario' : 'general';
        expect(outcome).toMatchObject({ status: 'completed', cardKind, rawText: markdown, card: { ...projectTavernStreamMarkdown({ template, markdown, sourceName: prepared.promptInput.sourceName }).card, _tavern: { raw: frozen.raw } } });
        if (outcome.status !== 'completed') throw new Error('expected completed');
        expect(outcome.result).not.toHaveProperty('usage');
        expect(outcome.card).not.toHaveProperty('signature'); expect(outcome.card).not.toHaveProperty('isPreset');
        expect(native.invoke).toHaveBeenCalledOnce();
      }
    } finally { random.mockRestore(); }
  });
  it('publishes accepted body before completion without mixing reasoning, and forwards generation overrides', async () => {
    let finish!: () => void;
    const partial = vi.fn();
    const native = harness('# 部分正文\n', async (identity, emit) => {
      emit({ type: 'reasoning-delta', ...identity, sequence: 2, delta: '推理不是正文' });
      await new Promise<void>(resolve => { finish = resolve; });
      emit({ type: 'text-delta', ...identity, sequence: 3, delta: '后半段' });
      emit({ type: 'result', ...identity, sequence: 4, result: { ...identity, status: 'completed', finishReason: 'stop', output: { text: '# 部分正文\n后半段', reasoning: '推理不是正文' }, usage: { outputTokens: 8, reasoningTokens: 3 } } });
    });
    let settled = false;
    const pending = executeTavernGeneration(native.options, input, { ...streamIntent, overrides: { temperature: 0.3, maxOutputTokens: 1234 } }, new AbortController().signal, partial).finally(() => { settled = true; });
    await vi.waitFor(() => expect(partial).toHaveBeenCalledWith('# 部分正文\n'));
    expect(settled).toBe(false);
    expect(native.request()).toMatchObject({ temperature: 0.3, maxOutputTokens: 1234 });
    finish();
    expect(await pending).toMatchObject({ status: 'completed', rawText: '# 部分正文\n后半段', reasoning: { text: '推理不是正文' }, result: { usage: { outputTokens: 8 } } });
    expect(partial.mock.calls).toEqual([['# 部分正文\n'], ['# 部分正文\n后半段']]);
    expect(native.invoke).toHaveBeenCalledOnce();
  });
  it.each(['length', 'content-filter', 'tool-calls', 'other'] as const)('keeps %s output as raw text, never a card', async finishReason => {
    const native = harness(markdown, (identity, emit) => emit({ type: 'result', ...identity, sequence: 2, result: { ...identity, status: 'completed', finishReason, output: { text: markdown } } }));
    const outcome = await executeTavernGeneration(native.options, input, streamIntent, new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'invalid-output', rawText: markdown }); expect(outcome).not.toHaveProperty('card');
    expect(native.invoke).toHaveBeenCalledOnce();
  });
  it.each(['{}', '{ \n }', '[]', '[ ]', 'null', 'undefined', '\uFEFF{}'])('rejects a stop terminal containing only %j', async text => {
    const native = harness(text);
    expect(await executeTavernGeneration(native.options, input, streamIntent, new AbortController().signal)).toMatchObject({ status: 'invalid-output', rawText: text });
    expect(native.invoke).toHaveBeenCalledOnce();
  });
  it.each(['', '  \n'])('rejects a blank terminal %j at the protocol boundary and retains accepted deltas', async text => {
    const native = harness(text);
    await expect(executeTavernGeneration(native.options, input, streamIntent, new AbortController().signal)).rejects.toMatchObject({ name: 'GenerationTransportError', rawText: text, cause: { code: 'invalid-event' } });
    expect(native.invoke).toHaveBeenCalledOnce();
  });
  it.each(['stop', 'length'] as const)('cannot overwrite accepted body with an empty %s terminal text', async finishReason => {
    const native = harness(markdown, (identity, emit) => emit({ type: 'result', ...identity, sequence: 2, result: { ...identity, status: 'completed', finishReason, output: { text: '' } } }));
    await expect(executeTavernGeneration(native.options, input, streamIntent, new AbortController().signal)).rejects.toMatchObject({ name: 'GenerationTransportError', rawText: markdown, cause: { code: 'invalid-event' } });
    expect(native.invoke).toHaveBeenCalledOnce();
  });
  it.each(['failed', 'cancelled'] as const)('retains accepted body on a %s terminal without creating a card', async status => {
    const native = harness(markdown, (identity, emit) => emit({ type: 'result', ...identity, sequence: 2, result: status === 'failed'
      ? { ...identity, status, error: { code: 'rate-limited', message: '稍后重试', retryAfterMs: 1500 } }
      : { ...identity, status, reason: 'user' } }));
    const outcome = await executeTavernGeneration(native.options, input, streamIntent, new AbortController().signal);
    expect(outcome).toMatchObject({ status, rawText: markdown }); expect(outcome).not.toHaveProperty('card');
    if (status === 'failed') expect(outcome).toMatchObject({ code: 'rate-limited', retryAfterSeconds: 2 });
    expect(native.invoke).toHaveBeenCalledOnce();
  });
  it.each([
    ['EOF', 'missing-terminal'], ['source failure', 'source-failed'],
    ['sequence', 'sequence-mismatch'], ['identity', 'identity-mismatch'], ['invalid event', 'invalid-event'],
  ] as const)('keeps only accepted body after %s, without retry or fallback', async (failure, code) => {
    const partial = vi.fn();
    const native = harness(markdown, (identity, emit) => {
      if (failure === 'source failure') throw new Error('offline');
      if (failure !== 'EOF') emit({ type: 'text-delta', ...identity, sequence: failure === 'sequence' ? 8 : 2,
        requestId: failure === 'identity' ? 'another-request' : identity.requestId,
        delta: failure === 'invalid event' ? 42 : '未被接受的正文',
      } as AiStreamEvent);
    });
    await expect(executeTavernGeneration(native.options, input, streamIntent, new AbortController().signal, partial)).rejects.toMatchObject({ name: 'GenerationTransportError', rawText: markdown, cause: { code } });
    expect(partial.mock.calls).toEqual([[markdown]]); expect(native.invoke).toHaveBeenCalledOnce();
  });
});

describe('Tavern Hosted JSON generation', () => {
  const hosted = { requestId: 'tavern-hosted', mode: 'hosted-json' as const, generationMode: 'non-stream' as const, modelId: 'default' };
  it.each(['hosted-json', 'hosted-stream'] as const)('rejects a mismatched %s output intent before Native dispatch', async mode => {
    const invoke = vi.fn(); const notify = vi.fn();
    const outcome = await executeTavernGeneration({ invoke, profileId: '', onHostedDispatchSettled: notify }, input, { ...hosted, mode, generationMode: mode === 'hosted-json' ? 'stream' : 'non-stream' } as unknown as TavernGenerationIntent, new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'failed', code: 'invalid-request' });
    expect(invoke).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
  it.each(['general', 'general-scenario', 'scenario', 'magical-girl', 'canshou'] as const)('projects unsigned %s and restores only the frozen local original', async template => {
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
    finish({ status: 200, body: { aiMeta: null, data: { ...tavernModelResult(template), metadata: { signature: 'forged' }, signature: 'forged', isPreset: true, _tavern: { raw: { name: 'server' } } } } });
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: 'completed', cardKind: template, card: { ...(template === 'scenario' ? scenario : template === 'magical-girl' ? { codename: '星花' } : template === 'canshou' ? { name: '雾兽' } : { content: '正文' }), _tavern: { raw: frozenRaw } } });
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


describe('Tavern character questionnaire and restore boundaries', () => {
  it.each(['magical-girl', 'canshou'] as const)('uses the default %s questions and accepts the canonical answer shape', template => {
    const questionnaire = template === 'magical-girl' ? magicalQuestionnaire : canshouQuestionnaire;
    const config = createDesktopTavernGenerationConfig(template);
    const prompt = config.promptBuilder(prepareTavernGenerationInput({ ...input, template }).promptInput);
    for (const question of questionnaire.questions) expect(prompt).toContain(question.question);
    expect(config.schema.safeParse(tavernModelResult(template)).success).toBe(true);
    expect(config.schema.safeParse({ ...tavernModelResult(template), userAnswers: [123] }).success).toBe(false);
    expect(config.schema.safeParse({ ...tavernModelResult(template), appearance: 5 }).success).toBe(false);
  });
  it.each(['general', 'general-scenario', 'magical-girl', 'canshou'] as const)('retains full stored %s data and extensions without model renormalization', template => {
    const original = { ...tavernModelResult(template), ...(template === 'general' ? { templateId: '通用角色' } : template === 'general-scenario' ? { templateId: '通用情景' } : {}),
      _custom: { keep: [1, '中文'] }, current_state: { summary: '仍需保留', fields: [] },
      ...(template === 'magical-girl' || template === 'canshou' ? { userAnswers: { custom: { question: '旧问题', value: '旧回答' } } } : {}),
      signature: 'forged', isPreset: true, _tavern: { raw: input.raw } };
    const card = validateTavernGeneratedCard(template, original);
    expect(card).toMatchObject({ _custom: original._custom, current_state: original.current_state, _tavern: original._tavern });
    if ('userAnswers' in original) {
      expect(card).toHaveProperty('userAnswers');
      if (!('userAnswers' in card)) throw new Error('Restored character answers are missing');
      expect(card.userAnswers).toEqual(original.userAnswers);
    }
    expect(card).not.toHaveProperty('signature'); expect(card).not.toHaveProperty('isPreset');
  });
  it.each([[], 'broken', 42, { signature: 3 }])('rejects malformed restored scenario metadata %j', metadata => {
    expect(() => validateTavernGeneratedCard('scenario', { ...scenario, metadata, _tavern: { raw: input.raw } })).toThrow();
  });
});


it.each(['magical-girl', 'canshou'] as const)('applies every placeholder option to %s prompt data only', template => {
  for (const [preference, expected] of [
    [{ ...input.preference, enabled: false }, '{{user}} 对 {{char}} 说话'],
    [{ ...input.preference, enabled: true, charReplacementMode: 'auto' as const }, '旅人 对 Alice 说话'],
    [{ ...input.preference, enabled: true, charReplacementMode: 'custom' as const, customCharReplacement: '花' }, '旅人 对 花 说话'],
  ] as const) {
    const prepared = prepareTavernGenerationInput({ ...input, template, preference });
    expect(prepared.promptInput.attachments[0].content).toContain(expected);
    expect(prepared.raw).toEqual(input.raw);
    expect(prepared.raw).toMatchObject({ extensions: { script: '{{user}} 原件' } });
  }
});
