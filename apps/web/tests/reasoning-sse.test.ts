import { describe, expect, test, vi } from 'vitest';

import {
  createReasoningSseBridge,
  encodeSseEvent,
  shouldUseClientSse,
} from '@/lib/stream/reasoning-sse';
import { createSafePublicAiError } from '@mahoshojo/hosted-api/regular-generation';

describe('stream/reasoning-sse', () => {
  test('shouldUseClientSse 支持 query 与 Accept 双判定', () => {
    const byQuery = new Request('https://example.com/api/test?format=sse', { method: 'POST' });
    const byAccept = new Request('https://example.com/api/test', {
      method: 'POST',
      headers: { accept: 'text/event-stream' },
    });
    const normal = new Request('https://example.com/api/test', { method: 'POST' });

    expect(shouldUseClientSse(byQuery)).toBe(true);
    expect(shouldUseClientSse(byAccept)).toBe(true);
    expect(shouldUseClientSse(normal)).toBe(false);
  });

  test('会把文本流与 reasoning 事件桥接为 SSE', async () => {
    const bridge = createReasoningSseBridge('桥接测试');
    bridge.onReasoningEvent({ type: 'reasoning-start' });
    bridge.onReasoningEvent({ type: 'reasoning-delta', text: '先识别核心需求。' });
    bridge.onReasoningEvent({ type: 'reasoning-end' });

    const textResponse = new Response('## 正文\n测试内容', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });

    const sseResponse = bridge.toResponse(textResponse, {
      usagePromise: Promise.resolve({
        promptTokens: 11,
        completionTokens: 25,
        reasoningTokens: 4,
      }),
      aiModel: 'gemini-test',
    });

    const sseRaw = await sseResponse.text();
    expect(sseResponse.headers.get('content-type')).toContain('text/event-stream');
    expect(sseRaw).toContain('event: reasoning');
    expect(sseRaw).toContain('event: markdown');
    expect(sseRaw).toContain('event: reasoning_done');
    expect(sseRaw).toContain('event: telemetry');
    expect(sseRaw).toContain('"aiModel":"gemini-test"');
    expect(sseRaw).toContain('event: done');
  });

  test('正文延迟时，reasoning 事件可先于 markdown 输出', async () => {
    const bridge = createReasoningSseBridge('延迟正文测试');
    bridge.onReasoningEvent({ type: 'reasoning-start' });
    bridge.onReasoningEvent({ type: 'reasoning-delta', text: '先做任务分解。' });

    const encoder = new TextEncoder();
    const delayedTextBody = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(encoder.encode('正文稍后到达'));
          controller.close();
        }, 40);
      },
    });
    const textResponse = new Response(delayedTextBody, {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });

    const sseResponse = bridge.toResponse(textResponse);
    const reader = sseResponse.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();

    const first = await reader!.read();
    const firstChunk = decoder.decode(first.value ?? new Uint8Array(), { stream: true });
    expect(firstChunk).toContain('event: reasoning');
    expect(firstChunk).not.toContain('event: markdown');

    let merged = firstChunk;
    for (let i = 0; i < 6; i++) {
      const next = await reader!.read();
      if (next.done) break;
      merged += decoder.decode(next.value ?? new Uint8Array(), { stream: true });
      if (merged.includes('event: markdown')) break;
    }
    expect(merged).toContain('event: markdown');
  });

  test('无 reasoning 时会发出 unavailable', async () => {
    const bridge = createReasoningSseBridge('无推理测试');
    const textResponse = new Response('纯正文');
    const sseResponse = bridge.toResponse(textResponse);
    const sseRaw = await sseResponse.text();
    expect(sseRaw).toContain('"status":"unavailable"');
    expect(sseRaw).toContain('event: done');
  });

  test('SSE 序列化失败时不泄漏异常消息', () => {
    const cyclic: { self?: unknown; secret: string } = { secret: 'sse-secret-canary' };
    cyclic.self = cyclic;

    const serialized = new TextDecoder().decode(encodeSseEvent('test', cyclic));

    expect(serialized).toContain('SSE_EVENT_SERIALIZATION_FAILED');
    expect(serialized).not.toContain('sse-secret-canary');
  });

  test('上游流读取失败时返回同一安全公共投影', async () => {
    const bridge = createReasoningSseBridge('流错误投影测试');
    const safeError = createSafePublicAiError({
      code: 'AI_UPSTREAM_REQUEST_FAILED',
      message: 'AI_APICallError: 余额不足（HTTP 402）',
      upstreamStatus: 402,
      upstreamRequestId: 'req-stream-402',
    });
    const response = bridge.toResponse(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(safeError);
      },
    })));

    const serialized = await response.text();

    expect(serialized).toContain('AI_UPSTREAM_REQUEST_FAILED');
    expect(serialized).toContain('AI_APICallError: 余额不足（HTTP 402）');
    expect(serialized).toContain('req-stream-402');
    expect(serialized).toContain('"upstreamStatus":402');
  });

  test('关闭思考但仅收到 reasoning 时保留稳定公共异常码', async () => {
    const bridge = createReasoningSseBridge('reasoning-only 异常测试');
    const safeError = createSafePublicAiError({
      code: 'THINKING_DISABLED_REASONING_ONLY',
      message: '模型在已关闭思考的情况下未返回可安全显示的正文，请重试或切换模型。',
    });
    const response = bridge.toResponse(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(safeError);
      },
    })));

    const serialized = await response.text();

    expect(serialized).toContain('THINKING_DISABLED_REASONING_ONLY');
    expect(serialized).toContain('未返回可安全显示的正文');
  });

  test('未知流错误继续 generic 且不泄漏消息', async () => {
    const bridge = createReasoningSseBridge('未知流错误投影测试');
    const response = bridge.toResponse(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('stream-secret-canary'));
      },
    })));

    const serialized = await response.text();

    expect(serialized).toContain('HOSTED_GENERATION_FAILED');
    expect(serialized).toContain('服务器内部错误');
    expect(serialized).not.toContain('stream-secret-canary');
  });
});

describe('optional reasoning bridge terminal extension', () => {
  test('waits for body EOF and appends fields while preserving ok=true', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const resolveDonePayload = vi.fn(async () => ({ fixture: { terminal: 'stop' }, ok: false }));
    const response = createReasoningSseBridge().toResponse(new Response(new ReadableStream({
      start(controller) { upstream = controller; controller.enqueue(new TextEncoder().encode('正文')); },
    })), { resolveDonePayload });
    const reader = response.body!.getReader();
    let raw = new TextDecoder().decode((await reader.read()).value);
    expect(resolveDonePayload).not.toHaveBeenCalled();
    upstream.close();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      raw += new TextDecoder().decode(next.value);
    }
    expect(resolveDonePayload).toHaveBeenCalledOnce();
    expect(raw).toContain('event: done\ndata: {"fixture":{"terminal":"stop"},"ok":true}');
  });

  test('body errors never invoke the optional completion hook', async () => {
    const resolveDonePayload = vi.fn(async () => ({ fixture: true }));
    const response = createReasoningSseBridge().toResponse(new Response(new ReadableStream({
      pull(controller) { controller.error(new Error('private-canary')); },
    })), { resolveDonePayload });
    const raw = await response.text();
    expect(resolveDonePayload).not.toHaveBeenCalled();
    expect(raw).toContain('event: error');
    expect(raw).not.toContain('event: done');
  });

  test('a failing optional completion hook becomes a safe error, never done', async () => {
    const response = createReasoningSseBridge().toResponse(new Response('正文'), {
      resolveDonePayload: async () => { throw new Error('private-canary'); },
    });
    const raw = await response.text();
    expect(raw).toContain('event: error');
    expect(raw).not.toContain('private-canary');
    expect(raw).not.toContain('event: done');
  });

  test('consumer cancellation during the optional hook discards its late completion', async () => {
    let resolvePayload!: (value: Record<string, unknown>) => void;
    let started!: () => void;
    const hookStarted = new Promise<void>(resolve => { started = resolve; });
    const response = createReasoningSseBridge().toResponse(new Response('正文'), {
      resolveDonePayload: () => { started(); return new Promise(resolve => { resolvePayload = resolve; }); },
    });
    const reader = response.body!.getReader();
    await hookStarted;
    await reader.cancel('user-cancel');
    resolvePayload({ fixture: true });
    expect((await reader.read()).done).toBe(true);
    await Promise.resolve();
  });

  test('an already aborted opt-in stream cancels upstream before emitting anything', async () => {
    const abort = new AbortController();
    abort.abort();
    const cancel = vi.fn();
    const resolveDonePayload = vi.fn(async () => ({ fixture: true }));
    const response = createReasoningSseBridge().toResponse(new Response(new ReadableStream({ cancel })), {
      signal: abort.signal, resolveDonePayload,
    });
    expect(await response.text()).toBe('');
    expect(cancel).toHaveBeenCalledOnce();
    expect(resolveDonePayload).not.toHaveBeenCalled();
  });
});
