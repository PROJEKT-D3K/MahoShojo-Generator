import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TAVERN_COMPLETION_HEADER, TAVERN_COMPLETION_HEADER_VALUE, parseTavernCompletionDone } from '@mahoshojo/contracts/tavern-completion';
import type { NextRequest } from 'next/server';
import { buildTavernStreamPrompt, TAVERN_STREAM_TEMPERATURE } from '@mahoshojo/ai-core/tavern-generation';
import { AI_PROVIDER_CATALOG } from '@/lib/ai/constants';
import { CANSHOU_LORE } from '@/lib/canshou-lore';
import type { GenerateWithAIOptions } from '@/lib/stream/raw-ai';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), safety: vi.fn(), activity: vi.fn(), flowers: vi.fn(() => '固定花名'), channel: vi.fn(() => ({ providerId: 'system' })) }));
vi.mock('@mahoshojo/ai-core/tavern-generation', async (importOriginal) => {
  const original = await importOriginal<typeof import('@mahoshojo/ai-core/tavern-generation')>();
  return { ...original, buildTavernStreamPrompt: vi.fn(original.buildTavernStreamPrompt) };
});
vi.mock('@/lib/random-choose-hana-name', () => ({ getRandomFlowers: mocks.flowers }));
vi.mock('@/lib/stream/raw-ai', () => ({ generateWithStreamAI: mocks.generate, LoadBalanceStrategy: { CUSTOM: 'custom', SEQUENTIAL: 'sequential' } }));
vi.mock('@/lib/ai/availability', () => ({ buildChannelContextFromPayload: mocks.channel }));
vi.mock('@/lib/content-safety/server', () => ({ enforceTextSafety: mocks.safety }));
vi.mock('@/lib/user-activity/record', () => ({ recordUserActivityFromRequest: mocks.activity }));
vi.mock('@/lib/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { appRouteHandler } from '@/app/api/tavern/convert-stream/handler';

const request = (body: unknown, sse = false) => new Request(`https://example.test/api/tavern/convert-stream${sse ? '?format=sse' : ''}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}) as NextRequest;
const readEvents = (text: string) => text.trim().split('\n\n').map(block => {
  const [event, data] = block.split('\n');
  return { event: event.slice(7), data: JSON.parse(data.slice(6)) };
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.safety.mockResolvedValue(null);
  mocks.generate.mockImplementation(async () => ({ response: new Response('# 正文'), usagePromise: Promise.resolve(null) }));
});

describe('Tavern stream real Web handler shared core', () => {
  it.each(['general', 'magical-girl', 'canshou', 'scenario', 'general-scenario'] as const)('actually calls the shared %s Markdown builder with Web assets', async template => {
    const input = { template, language: 'ja-JP', sourceName: ' 原名 ', attachments: [{ name: '资料.json', type: 'application/json', content: '原设定', truncated: true }] };
    const req = request({ ...input, _tavern: { raw: 'not-model-input' } });
    const response = await appRouteHandler(req);
    expect(await response.text()).toBe('# 正文');
    expect(buildTavernStreamPrompt).toHaveBeenCalledExactlyOnceWith(input, { getRandomFlowers: mocks.flowers, lore: CANSHOU_LORE });
    expect(mocks.flowers).toHaveBeenCalledOnce();
    expect(mocks.generate).toHaveBeenCalledOnce();
    const [config, options] = mocks.generate.mock.calls[0];
    expect(config).toEqual({ prompt: vi.mocked(buildTavernStreamPrompt).mock.results[0].value, temperature: TAVERN_STREAM_TEMPERATURE });
    expect(config.temperature).toBe(0.75);
    expect(config.prompt).not.toContain('not-model-input');
    expect(options).toEqual({ abortSignal: req.signal, telemetry: {}, channelContext: { providerId: 'system' } });
    expect(mocks.safety).toHaveBeenCalledWith(expect.objectContaining({ text: ' 原名 \n\n原设定', sensitiveWordReason: '使用危险符文', aiPromptTemplate: 'free' }));
    expect(mocks.safety.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(buildTavernStreamPrompt).mock.invocationCallOrder[0]);
    expect(mocks.activity).toHaveBeenCalledExactlyOnceWith(req);
    expect(mocks.generate.mock.invocationCallOrder[0]).toBeLessThan(mocks.activity.mock.invocationCallOrder[0]);
  });

  it('retains the real SSE reasoning, telemetry and legacy done payload without a new finish contract', async () => {
    mocks.generate.mockImplementation(async (_config, options: GenerateWithAIOptions) => {
      options.onReasoningEvent?.({ type: 'reasoning-start' });
      options.onReasoningEvent?.({ type: 'reasoning-delta', text: '独立思考' });
      options.onReasoningEvent?.({ type: 'reasoning-end' });
      if (options.telemetry) options.telemetry.model = 'actual-model';
      return { response: new Response('# 完整正文'), usagePromise: Promise.resolve({ inputTokens: 2, outputTokens: 3, totalTokens: 5 }), finishReasonPromise: Promise.resolve('length') };
    });
    const response = await appRouteHandler(request({ template: 'general' }, true));
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = readEvents(await response.text());
    expect(events.filter(event => event.event === 'markdown')).toEqual([{ event: 'markdown', data: { chunk: '# 完整正文' } }]);
    expect(events.filter(event => event.event === 'reasoning')).toEqual([
      { event: 'reasoning', data: { source: 'sdk', status: 'thinking', chunk: '' } },
      { event: 'reasoning', data: { source: 'sdk', status: 'thinking', chunk: '独立思考' } },
    ]);
    expect(events.find(event => event.event === 'telemetry')?.data).toMatchObject({ version: 1, aiModel: 'actual-model', usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } });
    expect(events.at(-1)).toEqual({ event: 'done', data: { ok: true } });
    expect(mocks.activity).toHaveBeenCalledOnce();
  });

  it('keeps catalog BYOK, sanitized credentials, model parameters and channel preparation outside the core', async () => {
    const provider = AI_PROVIDER_CATALOG.find(item => item.id !== 'system' && item.baseUrl && item.models.length)!;
    const customProvider = { providerId: provider.id, modelId: provider.models[0].value, apiKey: ' synthetic-test-key ', maxOutputTokens: 1234 };
    const req = request({ template: 'canshou', customProvider });
    expect((await appRouteHandler(req)).status).toBe(200);
    const [config, options] = mocks.generate.mock.calls[0];
    expect(config).toMatchObject({ temperature: 0.75, generationSettingsContext: { providerId: provider.id } });
    expect(options).toMatchObject({
      abortSignal: req.signal, loadBalanceStrategy: 'custom',
      providerOverride: { name: provider.name, apiKey: 'synthetic-test-key', baseUrl: provider.baseUrl.trim(), model: provider.models[0].value, type: provider.type, mode: provider.mode || 'auto', retryCount: 1, skipProbability: 0, defaultMaxOutputTokens: 1234, providerId: provider.id },
    });
    expect(mocks.channel).toHaveBeenCalledExactlyOnceWith(customProvider, undefined);
    expect(vi.mocked(buildTavernStreamPrompt).mock.calls[0][0]).not.toHaveProperty('customProvider');
    expect(config.prompt).not.toContain('synthetic-test-key');
  });

  it('keeps system default selection, request defaults, and validation-before-generation', async () => {
    const customProvider = { providerId: 'system', modelId: 'default', apiKey: '' };
    const response = await appRouteHandler(request({ template: 'general', customProvider }));
    expect(response.status).toBe(200);
    expect(vi.mocked(buildTavernStreamPrompt).mock.calls[0][0]).toEqual({ template: 'general', sourceName: '', language: 'zh-CN', attachments: [] });
    expect(mocks.generate.mock.calls[0][0]).toMatchObject({ generationSettingsContext: { providerId: 'system' } });
    expect(mocks.generate.mock.calls[0][0]).not.toHaveProperty('modelOverride');
    expect(mocks.generate.mock.calls[0][1]).not.toHaveProperty('providerOverride');
    expect(mocks.generate.mock.calls[0][1]).not.toHaveProperty('loadBalanceStrategy');
    mocks.generate.mockClear();
    vi.mocked(buildTavernStreamPrompt).mockClear();
    mocks.activity.mockClear();
    for (const body of [
      { template: 'unknown' },
      { template: 'general', attachments: [{ name: 'empty' }] },
      { template: 'general', customProvider: { providerId: 'unknown', modelId: 'default', apiKey: '' } },
      { template: 'general', customProvider: { ...customProvider, modelId: 'unknown' } },
    ]) expect((await appRouteHandler(request(body))).status).toBe(400);
    expect(buildTavernStreamPrompt).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it('preserves safety rejection and stream failure without activity, retry or projection', async () => {
    mocks.safety.mockResolvedValueOnce(new Response('blocked', { status: 403 }));
    expect((await appRouteHandler(request({ template: 'general' }))).status).toBe(403);
    expect(buildTavernStreamPrompt).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.activity).not.toHaveBeenCalled();
    mocks.generate.mockRejectedValueOnce(new Error('synthetic failure'));
    const failed = await appRouteHandler(request({ template: 'general' }));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: '生成失败', message: 'synthetic failure' });
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(mocks.activity).not.toHaveBeenCalled();
    expect((await appRouteHandler(new Request('https://example.test', { method: 'GET' }) as NextRequest)).status).toBe(405);
  });
});

const evidenceRequest = (body: unknown = { template: 'general' }, signal?: AbortSignal) => new Request('https://example.test/api/tavern/convert-stream', {
  method: 'POST', signal,
  headers: { 'Content-Type': 'application/json', [TAVERN_COMPLETION_HEADER]: TAVERN_COMPLETION_HEADER_VALUE },
  body: JSON.stringify(body),
}) as NextRequest;

afterEach(() => vi.useRealTimers());

describe('Tavern opt-in provider completion evidence', () => {
  it.each(['general', 'magical-girl', 'canshou', 'scenario', 'general-scenario'])(
    'emits stop evidence for %s without changing its shared prompt', async template => {
      mocks.generate.mockResolvedValueOnce({ response: new Response('# 正文'), finishReasonPromise: Promise.resolve('stop') });
      const response = await appRouteHandler(evidenceRequest({ template }));
      expect(response.headers.get(TAVERN_COMPLETION_HEADER)).toBe('v1');
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-store');
      const events = readEvents(await response.text());
      expect(events.filter(event => event.event === 'markdown')).toEqual([{ event: 'markdown', data: { chunk: '# 正文' } }]);
      expect(parseTavernCompletionDone(events.at(-1)?.data)).toEqual({ ok: true, tavernCompletion: { version: 1, finishReason: 'stop' } });
      expect(buildTavernStreamPrompt).toHaveBeenCalledExactlyOnceWith(
        { template, language: 'zh-CN', sourceName: '', attachments: [] }, { getRandomFlowers: mocks.flowers, lore: CANSHOU_LORE },
      );
    },
  );

  it.each(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', 'unknown', null, undefined, 'STOP', 'end_turn', 1, false, {}])(
    'projects only recognized provider finishReason: %j', async reason => {
      mocks.generate.mockResolvedValueOnce({ response: new Response('正文'), finishReasonPromise: Promise.resolve(reason) });
      const events = readEvents(await (await appRouteHandler(evidenceRequest())).text());
      const expected = typeof reason === 'string' && ['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', 'unknown'].includes(reason) ? reason : null;
      expect(events.at(-1)).toEqual({ event: 'done', data: { ok: true, tavernCompletion: { version: 1, finishReason: expected } } });
    },
  );

  it('does not infer stop from reasoning, usage or EOF when provider evidence is missing', async () => {
    mocks.generate.mockImplementationOnce(async (_config, options: GenerateWithAIOptions) => {
      options.onReasoningEvent?.({ type: 'reasoning-delta', text: '思考' });
      options.onReasoningEvent?.({ type: 'reasoning-end' });
      return { response: new Response('正文'), usagePromise: Promise.resolve({ totalTokens: 4 }) };
    });
    const events = readEvents(await (await appRouteHandler(evidenceRequest())).text());
    expect(events.map(event => event.event)).toEqual(['reasoning', 'reasoning_done', 'markdown', 'telemetry', 'done']);
    expect(events.at(-1)?.data).toEqual({ ok: true, tavernCompletion: { version: 1, finishReason: null } });
  });

  it('handles an immediate provider Promise rejection as null', async () => {
    mocks.generate.mockImplementationOnce(async () => ({ response: new Response('正文'), finishReasonPromise: Promise.reject(new Error('private-provider-error')) }));
    const raw = await (await appRouteHandler(evidenceRequest())).text();
    expect(readEvents(raw).at(-1)?.data.tavernCompletion.finishReason).toBeNull();
    expect(raw).not.toContain('private-provider-error');
  });

  it('retains a provider terminal arriving after EOF within the bounded wait', async () => {
    vi.useFakeTimers();
    let resolveReason!: (reason: string) => void;
    mocks.generate.mockResolvedValueOnce({ response: new Response('正文'), finishReasonPromise: new Promise(resolve => { resolveReason = resolve; }) });
    const result = (await appRouteHandler(evidenceRequest())).text();
    const settled = vi.fn();
    void result.then(settled);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).not.toHaveBeenCalled();
    resolveReason('length');
    const raw = await result;
    expect(readEvents(raw).at(-1)?.data).toEqual({ ok: true, tavernCompletion: { version: 1, finishReason: 'length' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds an unsettled provider Promise and ignores a later stop', async () => {
    vi.useFakeTimers();
    let resolveReason!: (reason: string) => void;
    mocks.generate.mockResolvedValueOnce({ response: new Response('正文'), finishReasonPromise: new Promise(resolve => { resolveReason = resolve; }) });
    const response = await appRouteHandler(evidenceRequest());
    const result = response.text();
    await vi.advanceTimersByTimeAsync(1_500);
    const raw = await result;
    expect(readEvents(raw).at(-1)?.data.tavernCompletion.finishReason).toBeNull();
    resolveReason('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(readEvents(raw).filter(event => event.event === 'done')).toHaveLength(1);
  });

  it('does not append done after a body error even with rejected terminal evidence', async () => {
    mocks.generate.mockImplementationOnce(async () => ({
      response: new Response(new ReadableStream({ pull(controller) { controller.error(new Error('private-body-error')); } })),
      finishReasonPromise: Promise.reject(new Error('private-provider-error')),
    }));
    const raw = await (await appRouteHandler(evidenceRequest())).text();
    expect(readEvents(raw).at(-1)?.event).toBe('error');
    expect(raw).not.toContain('event: done');
    expect(raw).not.toContain('tavernCompletion');
    expect(raw).not.toContain('private-');
  });

  it('abort while waiting for provider evidence preserves accepted body and writes no late done', async () => {
    const abort = new AbortController();
    let resolveReason!: (reason: string) => void;
    mocks.generate.mockResolvedValueOnce({ response: new Response('已收正文'), finishReasonPromise: new Promise(resolve => { resolveReason = resolve; }) });
    const response = await appRouteHandler(evidenceRequest(undefined, abort.signal));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let raw = decoder.decode((await reader.read()).value);
    raw += decoder.decode((await reader.read()).value);
    expect(raw).toContain('已收正文');
    abort.abort();
    resolveReason('stop');
    expect((await reader.read()).done).toBe(true);
    expect(raw).not.toContain('event: done');
  });

  it('abort during body consumption cancels upstream without a fabricated done', async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    mocks.generate.mockResolvedValueOnce({
      response: new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('部分正文')); }, cancel,
      })), finishReasonPromise: Promise.resolve('stop'),
    });
    const response = await appRouteHandler(evidenceRequest(undefined, abort.signal));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('部分正文');
    abort.abort();
    expect((await reader.read()).done).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('abort while waiting for usage suppresses late telemetry and provider done', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let resolveUsage!: (usage: unknown) => void;
    mocks.generate.mockResolvedValueOnce({
      response: new Response('已收正文'), finishReasonPromise: Promise.resolve('stop'),
      usagePromise: new Promise(resolve => { resolveUsage = resolve; }),
    });
    const reader = (await appRouteHandler(evidenceRequest(undefined, abort.signal))).body!.getReader();
    const decoder = new TextDecoder();
    const raw = decoder.decode((await reader.read()).value) + decoder.decode((await reader.read()).value);
    expect(raw).toContain('已收正文');
    abort.abort();
    resolveUsage({ totalTokens: 4 });
    await vi.advanceTimersByTimeAsync(0);
    expect((await reader.read()).done).toBe(true);
    expect(raw).not.toContain('event: telemetry');
    expect(raw).not.toContain('event: done');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps exact legacy plain and SSE bytes and omits the new response header', async () => {
    const plain = await appRouteHandler(request({ template: 'general' }));
    expect(await plain.text()).toBe('# 正文');
    expect(plain.headers.has(TAVERN_COMPLETION_HEADER)).toBe(false);
    const sse = await appRouteHandler(request({ template: 'general' }, true));
    expect(await sse.text()).toBe('event: markdown\ndata: {"chunk":"# 正文"}\n\nevent: reasoning_done\ndata: {"source":"sdk","status":"unavailable"}\n\nevent: done\ndata: {"ok":true}\n\n');
    expect(sse.headers.has(TAVERN_COMPLETION_HEADER)).toBe(false);
  });

  it('GET with the fixed version probes the protocol without parsing input, safety or model calls', async () => {
    const response = await appRouteHandler(new Request('https://example.test/api/tavern/convert-stream', { headers: { [TAVERN_COMPLETION_HEADER]: 'v1' } }) as NextRequest);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ protocol: 'tavern-completion', version: 1 });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get(TAVERN_COMPLETION_HEADER)).toBe('v1');
    expect(mocks.safety).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.activity).not.toHaveBeenCalled();
    expect(buildTavernStreamPrompt).not.toHaveBeenCalled();
  });

  it.each(['', 'v2', '1', 'V1', 'v1, v2'])('rejects unknown explicit version %j before model dispatch', async version => {
    for (const method of ['GET', 'POST']) {
      const response = await appRouteHandler(new Request('https://example.test/api/tavern/convert-stream', { method, headers: { [TAVERN_COMPLETION_HEADER]: version } }) as NextRequest);
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(mocks.safety).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it('returns the selected response version on pre-dispatch validation errors too', async () => {
    const response = await appRouteHandler(evidenceRequest({ template: 'unknown' }));
    expect(response.status).toBe(400);
    expect(response.headers.get(TAVERN_COMPLETION_HEADER)).toBe('v1');
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it.each(['safety-rejected', 'generation-failed'])('returns the selected response version when %s', async failure => {
    if (failure === 'safety-rejected') mocks.safety.mockResolvedValueOnce(new Response('blocked', { status: 403 }));
    else mocks.generate.mockRejectedValueOnce(new Error('synthetic failure'));
    const response = await appRouteHandler(evidenceRequest());
    expect(response.status).toBe(failure === 'safety-rejected' ? 403 : 500);
    expect(response.headers.get(TAVERN_COMPLETION_HEADER)).toBe('v1');
    expect(await response.text()).not.toContain('tavernCompletion');
    expect(mocks.generate).toHaveBeenCalledTimes(failure === 'safety-rejected' ? 0 : 1);
    expect(mocks.activity).not.toHaveBeenCalled();
  });
});
