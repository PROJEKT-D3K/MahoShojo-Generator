import { afterEach, describe, expect, it, vi } from 'vitest';
import { openArenaGenerationStreamClient, type ArenaGenerationClientPorts } from '../src/arena-generation/client';
import { subscriptionToSseResponse } from '../src/arena-generation/sse-response';
import { encodeGenerationSseEvent, parseGenerationSseBlock } from '../src/arena-generation/sse';
import { createArenaGenerationService, type GenerationStreamEvent } from '../src/arena-generation/service';
import { createMemoryGenerationReplayStore } from '../src/arena-generation/memory-replay-store';

const decoder = new TextDecoder();
const event = (id: string, type: string, data: unknown): GenerationStreamEvent => ({ id, type, data });
const done = event('2-0', 'done', { status: 'completed' });
const subscription = () => {
  let upstream!: ReadableStreamDefaultController<GenerationStreamEvent>;
  const cancel = vi.fn();
  const events = new ReadableStream<GenerationStreamEvent>({ start(controller) { upstream = controller; }, cancel });
  const response = subscriptionToSseResponse({
    generationId: 'generation-keepalive', generationRequestId: 'request-keepalive', events,
    headers: { 'X-Mahoshojo-Generation-Id': 'generation-keepalive' },
  });
  return { response, upstream, cancel, events };
};
const client = (response: Response, resumed: Response = new Response(decoder.decode(encodeGenerationSseEvent(done)))) => {
  const states: string[] = [];
  const ports: ArenaGenerationClientPorts = {
    loadState: () => null, saveState: vi.fn(), createRequestId: () => 'request-keepalive',
    encodeUtf8: (value) => new TextEncoder().encode(value), waitForReconnectOpportunity: async () => {},
    isInitialCreateOutcomeAmbiguous: () => true, classifyExplicitAbort: () => null,
    prepareCreate: vi.fn(), observeResponse: vi.fn(),
    transport: {
      create: vi.fn(async ({ onRoutePinSelected }) => { onRoutePinSelected({ placement: 'hono-primary' }); return response; }),
      resume: vi.fn(async () => resumed), lookup: vi.fn(async () => Response.json({})),
      cancel: vi.fn(async () => new Response(null, { status: 202 })),
    },
  };
  const open = () => openArenaGenerationStreamClient({ endpoint: 'arena', bodyHash: 'body', maxReconnectAttempts: 2,
    onStateChange: (state) => states.push(state) }, ports);
  return { open, ports, states };
};

/** A deterministic idle intermediary, not an assertion about production proxy configuration. */
const idleProxy = (response: Response, idleMs: number) => {
  const upstream = response.body!.getReader();
  let timer: ReturnType<typeof setTimeout>;
  let closed = false;
  let disconnects = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          closed = true; disconnects += 1;
          controller.error(new TypeError('synthetic idle disconnect'));
          void upstream.cancel();
        }, idleMs);
      };
      arm();
      void (async () => {
        try {
          while (!closed) {
            const next = await upstream.read();
            if (closed) break;
            if (next.done) { closed = true; controller.close(); break; }
            arm(); controller.enqueue(next.value);
          }
        } finally { clearTimeout(timer); upstream.releaseLock(); }
      })();
    },
    async cancel() { closed = true; clearTimeout(timer); await upstream.cancel(); },
  });
  return { response: new Response(body, { headers: response.headers }), disconnects: () => disconnects };
};
afterEach(() => vi.useRealTimers());

describe('Arena SSE transport keepalive', () => {
  it('flushes headers before the first event, then sends only comments during a long silence', async () => {
    vi.useFakeTimers();
    const run = subscription();
    const reader = run.response.body!.getReader();
    expect(run.response.headers.get('X-Accel-Buffering')).toBe('no');
    expect(run.response.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    expect(decoder.decode((await reader.read()).value)).toBe(': keepalive\n\n');
    for (let i = 0; i < 12; i += 1) {
      const pending = reader.read();
      await vi.advanceTimersByTimeAsync(15_000);
      const block = decoder.decode((await pending).value);
      expect(parseGenerationSseBlock(block.trim())).toBeNull();
      expect(block).toBe(': keepalive\n\n');
    }
    run.upstream.enqueue(done); run.upstream.close();
    expect(decoder.decode((await reader.read()).value)).toBe(decoder.decode(encodeGenerationSseEvent(done)));
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(run.events.locked).toBe(false);
  });

  it('bounds comments under backpressure and preserves the following event bytes', async () => {
    vi.useFakeTimers();
    const run = subscription();
    await vi.advanceTimersByTimeAsync(15_000 * 100);
    const reader = run.response.body!.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe(': keepalive\n\n');
    run.upstream.enqueue(event('1-0', 'markdown', { delta: '正文' }));
    expect(parseGenerationSseBlock(decoder.decode((await reader.read()).value))).toEqual({
      id: '1-0', event: 'markdown', data: '{"delta":"正文"}',
    });
    await reader.cancel('leave');
    expect(run.cancel).toHaveBeenCalledExactlyOnceWith('leave');
    expect(vi.getTimerCount()).toBe(0);
    expect(run.events.locked).toBe(false);
  });

  it.each(['done', 'error'])('stops the timer at %s even before the consumer drains EOF', async (type) => {
    vi.useFakeTimers();
    const run = subscription(); const reader = run.response.body!.getReader();
    await reader.read();
    run.upstream.enqueue(event('1-0', type, { status: type === 'done' ? 'completed' : 'failed' }));
    await reader.read();
    expect(vi.getTimerCount()).toBe(0);
    await reader.cancel();
  });

  it('cleans up on a transport error while a read is pending', async () => {
    vi.useFakeTimers();
    const run = subscription(); const reader = run.response.body!.getReader(); await reader.read();
    const pending = reader.read(); const assertion = expect(pending).rejects.toThrow('replay unavailable');
    run.upstream.error(new Error('replay unavailable')); await assertion;
    expect(vi.getTimerCount()).toBe(0); expect(run.events.locked).toBe(false);
  });

  it('cancels an outstanding subscriber read without leaking a timer or cancelling a producer', async () => {
    vi.useFakeTimers();
    const run = subscription(); const reader = run.response.body!.getReader(); await reader.read();
    const pending = reader.read(); await reader.cancel('disconnect');
    expect((await pending).done).toBe(true);
    expect(run.cancel).toHaveBeenCalledExactlyOnceWith('disconnect');
    expect(vi.getTimerCount()).toBe(0); expect(run.events.locked).toBe(false);
  });

  it('does not treat split comments as generation progress, cursor updates or terminal events', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const run = client(new Response(new ReadableStream({ start(controller) { upstream = controller; } }), {
      headers: { 'X-Mahoshojo-Generation-Id': 'generation-keepalive' },
    }));
    const response = await run.open(); const reader = response.body!.getReader();
    const saves = vi.mocked(run.ports.saveState).mock.calls.length;
    for (const part of [': keep', 'alive\n', '\n']) upstream.enqueue(new TextEncoder().encode(part));
    // Observe actual delivery before checking that the comment did not create a state write.
    expect(decoder.decode((await reader.read()).value)).toBe(': keepalive\n\n');
    expect(vi.mocked(run.ports.saveState).mock.calls).toHaveLength(saves);
    expect(run.states).toEqual(['connecting', 'generating']);
    upstream.enqueue(encodeGenerationSseEvent(done)); upstream.close();
    expect(decoder.decode((await reader.read()).value)).toBe(decoder.decode(encodeGenerationSseEvent(done)));
    expect((await reader.read()).done).toBe(true);
    expect(run.states.at(-1)).toBe('completed');
  });

  it('keeps a delayed first token and a later quiet period connected across a synthetic idle cutoff', async () => {
    vi.useFakeTimers();
    const source = subscription(); const proxy = idleProxy(source.response, 45_000);
    const run = client(proxy.response); const response = await run.open(); const consumed = response.text();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(proxy.disconnects()).toBe(0);
    source.upstream.enqueue(event('1-0', 'markdown', { delta: '首字' }));
    await vi.advanceTimersByTimeAsync(125_000);
    source.upstream.enqueue(done); source.upstream.close();
    const text = await consumed;
    expect(text).toContain('首字'); expect(text).toContain('event: done');
    expect(proxy.disconnects()).toBe(0);
    expect(run.ports.transport.create).toHaveBeenCalledOnce();
    expect(run.ports.transport.resume).not.toHaveBeenCalled();
    expect(run.ports.transport.lookup).not.toHaveBeenCalled();
    expect(run.ports.transport.cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still resumes the same generation after a real EOF without replaying create', async () => {
    const run = client(new Response(': keepalive\n\n', { headers: { 'X-Mahoshojo-Generation-Id': 'generation-keepalive' } }));
    expect(await (await run.open()).text()).toContain('event: done');
    expect(run.ports.transport.create).toHaveBeenCalledOnce();
    expect(run.ports.transport.resume).toHaveBeenCalledExactlyOnceWith({ generationId: 'generation-keepalive',
      lastEventId: null, signal: undefined, routePin: { placement: 'hono-primary' } });
    expect(run.ports.transport.cancel).not.toHaveBeenCalled();
  });

  it('the real create and resume service wires send an early comment without advancing replay or aborting the producer', async () => {
    const store = createMemoryGenerationReplayStore();
    let finish!: () => void; let producerSignal!: AbortSignal;
    const execute = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      producerSignal = signal; await new Promise<void>((resolve) => { finish = resolve; });
      return { status: 'completed' as const };
    });
    const service = createArenaGenerationService({ store, executor: { execute },
      resolveActor: async () => ({ actorKey: 'synthetic-user' }), deriveGenerationId: async () => 'generation-keepalive',
      now: () => new Date(), hashPayload: async () => 'hash', replayPollMs: 1,
    });
    const response = await service.create(new Request('https://example.test/create', {
      method: 'POST', body: JSON.stringify({ generationRequestId: 'request-keepalive' }),
    }));
    const reader = response.body!.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe(': keepalive\n\n');
    const resumed = await service.resume(new Request('https://example.test/resume'), { generationId: 'generation-keepalive' });
    const resumeReader = resumed.body!.getReader();
    expect(decoder.decode((await resumeReader.read()).value)).toBe(': keepalive\n\n');
    expect((await store.readState({ generationId: 'generation-keepalive' }))?.lastEventId).toBeNull();
    await reader.cancel(); await resumeReader.cancel();
    expect(producerSignal.aborted).toBe(false); expect(execute).toHaveBeenCalledOnce();
    finish();
    await vi.waitFor(async () => expect((await store.readState({ generationId: 'generation-keepalive' }))?.status).toBe('completed'));
  });
});
