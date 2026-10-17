import { describe, expect, test, vi } from 'vitest';

import { createMemoryGenerationReplayStore } from '../src/arena-generation/memory-replay-store';
import {
  createArenaGenerationService,
  type ArenaGenerationExecutor,
  type ArenaGenerationSubscription,
  type ArenaGenerationTerminalRecord,
  type GenerationReplayStore,
  type GenerationStreamEvent,
  type GenerationTerminal,
} from '../src/arena-generation/service';

const now = '2026-01-01T00:00:00.000Z';
const generationId = 'generation-uncertain';
const generationRequestId = 'request-uncertain';
const actorKey = 'user:synthetic';
const request = () => new Request('https://example.test/api/arena/generate-stream', {
  method: 'POST', body: JSON.stringify({ generationRequestId, value: 'synthetic' }),
});
const durable = (overrides: Partial<ArenaGenerationTerminalRecord> = {}): ArenaGenerationTerminalRecord => ({
  generationId, generationRequestId, payloadHash: 'payload', status: 'completed',
  markdown: 'ABC', reasoning: 'full reasoning', resultRef: 'r2:synthetic', updatedAt: now,
  contentAvailable: true, telemetry: { aiModel: 'synthetic' }, ...overrides,
});
const serviceFor = (
  store: GenerationReplayStore,
  execute: ArenaGenerationExecutor['execute'],
  options: { snapshotMaxBytes?: number; terminal?: () => Promise<ArenaGenerationTerminalRecord | null> } = {},
) => createArenaGenerationService({
  store, executor: { execute }, now: () => new Date(now),
  resolveActor: async () => ({ actorKey }), deriveGenerationId: async () => generationId,
  hashPayload: async () => 'payload', createProducerToken: () => 'producer',
  replayPollMs: 1, heartbeatIntervalMs: 60_000, deltaFlushBytes: 1,
  deltaFlushIntervalMs: 60_000, snapshotFlushBytes: 1, snapshotFlushIntervalMs: 1,
  ...(options.snapshotMaxBytes ? { snapshotMaxBytes: options.snapshotMaxBytes } : {}),
  ...(options.terminal ? { terminalStore: { readOwnedTerminal: options.terminal } } : {}),
});
const memory = () => createMemoryGenerationReplayStore({ now: () => Date.parse(now) });
const collect = async (subscription: ArenaGenerationSubscription | Response) => {
  expect(subscription).not.toBeInstanceOf(Response);
  if (subscription instanceof Response) throw new Error(`Unexpected HTTP ${subscription.status}`);
  const reader = subscription.events.getReader();
  const events: GenerationStreamEvent[] = [];
  let error: unknown;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      events.push(next.value);
    }
  } catch (caught) { error = caught; }
  return { events, error };
};
const content = (events: GenerationStreamEvent[]) => {
  let markdown = '';
  let reasoning = '';
  for (const event of events) {
    const data = event.data as { markdown?: string; reasoning?: string; chunk?: string };
    if (event.type === 'snapshot') {
      markdown = data.markdown ?? '';
      reasoning = data.reasoning ?? '';
    } else if (event.type === 'markdown') markdown += data.chunk ?? '';
    else if (event.type === 'reasoning') reasoning += data.chunk ?? '';
  }
  return { markdown, reasoning };
};
const terminalEvents = (events: GenerationStreamEvent[]) => events.filter((event) => event.type === 'done' || event.type === 'error');

describe('uncertain replay recovery', () => {
  test.each(['committed', 'not-committed', 'late-commit'] as const)('%s append rejection is repaired once online and after reconnect', async (fault) => {
    const base = memory();
    let rejected = false;
    let delayed: Parameters<GenerationReplayStore['appendEvents']>[0] | undefined;
    let snapshotCountAtFailure = -1;
    const writeSnapshot = vi.fn(base.writeSnapshot);
    const appendEvents = vi.fn(async (input: Parameters<GenerationReplayStore['appendEvents']>[0]) => {
      if (delayed) {
        await base.appendEvents(delayed);
        delayed = undefined;
      }
      if (!rejected && input.events.some((event) => event.type === 'markdown' && (event.data as { chunk?: string }).chunk === 'B')) {
        rejected = true;
        snapshotCountAtFailure = writeSnapshot.mock.calls.length;
        if (fault === 'committed') await base.appendEvents(input);
        if (fault === 'late-commit') delayed = input;
        throw new Error('SYNTHETIC_UNKNOWN_APPEND_OUTCOME');
      }
      return base.appendEvents(input);
    });
    const store = { ...base, appendEvents, writeSnapshot };
    const webPackage = {
      packageRef: { id: 'test.fixture', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` },
      targetPath: 'data/report.json', targetMediaType: 'application/json' as const,
      generatedDigest: `sha256:${'b'.repeat(64)}`,
    };
    const execute = vi.fn(async ({ emit }: Parameters<ArenaGenerationExecutor['execute']>[0]) => {
      await emit({ type: 'meta', data: { model: 'synthetic' } });
      await emit({ type: 'markdown', data: { chunk: 'A' } });
      await emit({ type: 'markdown', data: { chunk: 'B' } });
      await emit({ type: 'markdown', data: { chunk: 'C' } });
      await emit({ type: 'reasoning', data: { chunk: 'full reasoning' } });
      await emit({ type: 'telemetry', data: { aiModel: 'synthetic' } });
      await emit({ type: 'ranking', data: { rank: 1 } });
      return { status: 'completed' as const, resultRef: 'r2:synthetic', webPackage };
    });
    const readTerminal = vi.fn(async () => null);
    const service = serviceFor(store, execute, { terminal: readTerminal });
    const subscription = await service.createSubscription(request());
    readTerminal.mockClear();
    const online = await collect(subscription);
    expect(online.error).toBeUndefined();
    expect(content(online.events)).toEqual({ markdown: 'ABC', reasoning: 'full reasoning' });
    expect(terminalEvents(online.events)).toHaveLength(1);
    expect(terminalEvents(online.events)[0]!.data).toMatchObject({ webPackage });
    expect(online.events.some((event) => event.type === 'meta')).toBe(true);
    expect(online.events.some((event) => event.type === 'ranking')).toBe(true);
    expect(online.events.some((event) => event.type === 'telemetry')).toBe(true);
    expect(online.events.filter((event) => event.type === 'snapshot').at(-1)?.data).toMatchObject({
      markdown: 'ABC', reasoning: 'full reasoning', telemetry: { aiModel: 'synthetic' },
    });
    expect(writeSnapshot.mock.calls).toHaveLength(snapshotCountAtFailure);
    expect(appendEvents.mock.calls.filter(([input]) => input.events.some((event) => (event.data as { chunk?: string }).chunk === 'B'))).toHaveLength(1);
    expect((await base.readState({ generationId }))?.terminal?.replayUncertain).toBe(true);
    for (const after of [null, '2-0']) {
      const resumed = await service.resumeOwnedSubscription({ generationId, actorKey, after });
      expect(resumed.kind).toBe('subscribed');
      if (resumed.kind !== 'subscribed') throw new Error('Missing recovered subscription');
      const replay = await collect(resumed.subscription);
      expect(replay.error).toBeUndefined();
      expect(content(replay.events)).toEqual({ markdown: 'ABC', reasoning: 'full reasoning' });
      expect(terminalEvents(replay.events)).toHaveLength(1);
      expect(terminalEvents(replay.events)[0]!.data).toMatchObject({ webPackage });
      expect(JSON.stringify(replay.events)).not.toContain('replayUncertain');
    }
    expect(readTerminal).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    const status = await service.status(new Request('https://example.test/status'), { generationId });
    expect(await status.text()).not.toContain('replayUncertain');
  });

  test('normal completion explicitly records false without reset or a durable read', async () => {
    const base = memory();
    const readTerminal = vi.fn(async () => null);
    const reasoning = 'R'.repeat(1_024);
    const service = serviceFor(base, async ({ emit }) => {
      await emit({ type: 'markdown', data: { chunk: 'ABC' } });
      await emit({ type: 'reasoning', data: { chunk: reasoning } });
      return { status: 'completed' };
    }, { terminal: readTerminal, snapshotMaxBytes: 512 });
    const subscription = await service.createSubscription(request());
    readTerminal.mockClear();
    const result = await collect(subscription);
    expect(result.error).toBeUndefined();
    expect(result.events.filter((event) => event.type === 'snapshot')).toHaveLength(0);
    expect(content(result.events)).toEqual({ markdown: 'ABC', reasoning });
    expect((await base.readState({ generationId }))?.terminal?.replayUncertain).toBe(false);
    expect((await base.readState({ generationId }))?.snapshot?.reasoning).toBe('');
    expect(readTerminal).not.toHaveBeenCalled();
  });

  test.each(['failed', 'cancelled'] as const)('uncertain %s snapshot preserves generated body and reasoning', async (status) => {
    const base = memory();
    let fail = true;
    const store = { ...base, appendEvents: async (input: Parameters<GenerationReplayStore['appendEvents']>[0]) => {
      if (fail) { fail = false; throw new Error('unknown'); }
      return base.appendEvents(input);
    } };
    const service = serviceFor(store, async ({ emit }) => {
      await emit({ type: 'markdown', data: { chunk: 'partial' } });
      await emit({ type: 'reasoning', data: { chunk: 'kept reasoning' } });
      return { status, code: status === 'failed' ? 'GENERATION_FAILED' : 'USER_CANCELLED' };
    });
    const result = await collect(await service.createSubscription(request()));
    expect(result.error).toBeUndefined();
    expect(content(result.events)).toEqual({ markdown: 'partial', reasoning: 'kept reasoning' });
    expect(terminalEvents(result.events)).toHaveLength(1);
    expect(terminalEvents(result.events)[0]!.data).toMatchObject({ status });
  });

  test.each(['failed', 'cancelled', 'producer_lost'] as const)('uncertain %s without full text reports only its exact terminal and preserves partial content', async (status) => {
    const base = memory();
    const markdown = 'B'.repeat(600);
    const reasoning = 'R'.repeat(600);
    const code = status === 'cancelled' ? 'USER_CANCELLED'
      : status === 'producer_lost' ? 'PRODUCER_OWNERSHIP_LOST' : 'GENERATION_FAILED';
    const appendEvents = vi.fn(async (input: Parameters<GenerationReplayStore['appendEvents']>[0]) => {
      if (input.events.some((event) => (event.data as { chunk?: string })?.chunk === 'unknown')) throw new Error('unknown append');
      return base.appendEvents(input);
    });
    const execute = vi.fn(async ({ emit }: Parameters<ArenaGenerationExecutor['execute']>[0]) => {
      await emit({ type: 'markdown', data: { chunk: markdown } });
      await emit({ type: 'reasoning', data: { chunk: reasoning } });
      await emit({ type: 'markdown', data: { chunk: 'unknown' } });
      return { status, code };
    });
    const service = serviceFor({ ...base, appendEvents }, execute, { snapshotMaxBytes: 512 });
    const live = await collect(await service.createSubscription(request()));
    expect(live.error).toBeUndefined();
    expect(content(live.events)).toEqual({ markdown, reasoning });
    expect(live.events.filter((event) => event.type === 'snapshot')).toEqual([]);
    expect(terminalEvents(live.events)).toHaveLength(1);
    expect(terminalEvents(live.events)[0]!.data).toMatchObject({ status, ok: false, code });
    const state = await base.readState({ generationId });
    expect(state).toMatchObject({ snapshot: null, terminal: { status, replayUncertain: true } });

    const resumed = await service.resumeOwnedSubscription({ generationId, actorKey, after: state!.lastEventId });
    expect(resumed.kind).toBe('subscribed');
    if (resumed.kind !== 'subscribed') throw new Error('Missing replay');
    const replay = await collect(resumed.subscription);
    expect(replay.error).toBeUndefined();
    expect(replay.events).toHaveLength(1);
    const [milliseconds, sequence] = state!.lastEventId!.split('-');
    expect(replay.events[0]!.id).toBe(`${milliseconds}-${BigInt(sequence!) + 1n}`);
    expect(replay.events[0]!.data).toMatchObject({ status, ok: false, code });
    const response = await service.resume(new Request('https://example.test/resume'), { generationId });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('event: snapshot');

    const readTerminal = vi.fn(async () => durable({ status, markdown: '', reasoning: '', errorCode: code }));
    const repeat = serviceFor({ ...base, reserve: async () => { throw new Error('unknown reservation'); } }, execute, { terminal: readTerminal });
    const repeated = await collect(await repeat.createSubscription(request()));
    expect(repeated.error).toBeUndefined();
    expect(terminalEvents(repeated.events)).toHaveLength(1);
    expect(repeated.events.filter((event) => event.type === 'snapshot')).toEqual([]);
    expect(readTerminal).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });

  test('a failure adopted after a new reservation is replayed without a durable empty reset', async () => {
    const base = memory();
    const store: GenerationReplayStore = { ...base, reserve: async (input) => {
      const result = await base.reserve(input);
      if (result.kind === 'created') await base.markTerminal({ generationId, producerToken: input.producerToken, now,
        terminal: { status: 'producer_lost', code: 'PRODUCER_OWNERSHIP_LOST', replayUncertain: true },
        terminalEvent: { type: 'error', data: { status: 'producer_lost', ok: false, code: 'PRODUCER_OWNERSHIP_LOST' } },
        clearTerminalSnapshot: true });
      return result;
    } };
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    const service = serviceFor(store, execute, { terminal: async () => durable({
      status: 'producer_lost', markdown: '', reasoning: '', resultRef: null, errorCode: 'PRODUCER_OWNERSHIP_LOST',
    }) });
    const replay = await collect(await service.createSubscription(request()));
    expect(replay.error).toBeUndefined();
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]).toMatchObject({ type: 'error', data: { status: 'producer_lost', ok: false } });
    expect(execute).not.toHaveBeenCalled();
  });

  test('an uncertain failure without an exact matching terminal event remains unavailable', async () => {
    const base = memory();
    await base.reserve({ generationId, generationRequestId, actorKey, payloadHash: 'payload', producerToken: 'producer',
      now, leaseExpiresAt: '2026-01-01T00:01:00.000Z' });
    await base.markTerminal({ generationId, producerToken: 'producer', now,
      terminal: { status: 'producer_lost', code: 'PRODUCER_OWNERSHIP_LOST', replayUncertain: true },
      terminalEvent: { type: 'error', data: { status: 'producer_lost', ok: false, code: 'PRODUCER_OWNERSHIP_LOST' } },
      clearTerminalSnapshot: true });
    const service = serviceFor({ ...base, readEvent: async () => null }, async () => ({ status: 'completed' }));
    expect(await service.resumeOwnedSubscription({ generationId, actorKey, after: null })).toMatchObject({
      kind: 'unavailable', code: 'GENERATION_TERMINAL_RECONCILIATION_PENDING',
    });
  });

  test.each([true, false])('oversized uncertain snapshot clears and fails closed even with body-only durable available=%s', async (available) => {
    const base = memory();
    const body = 'B'.repeat(600);
    const reasoning = 'R'.repeat(600);
    let fail = true;
    let finalized = false;
    const store = { ...base, appendEvents: async (input: Parameters<GenerationReplayStore['appendEvents']>[0]) => {
      if (fail) { fail = false; throw new Error('unknown'); }
      return base.appendEvents(input);
    } };
    const service = serviceFor(store, async ({ emit }) => {
      await emit({ type: 'markdown', data: { chunk: body } });
      await emit({ type: 'reasoning', data: { chunk: reasoning } });
      finalized = true;
      return { status: 'completed', resultRef: available ? 'r2:synthetic' : null,
        ...(available ? {} : { persistenceWarning: 'OUTPUT_NOT_ARCHIVED' as const }) };
    }, {
      snapshotMaxBytes: 512,
      terminal: async () => finalized ? durable({
        markdown: available ? body : '', reasoning: '',
        resultRef: available ? 'r2:synthetic' : null, contentAvailable: available,
        ...(available ? {} : { contentUnavailableReason: 'not-archived', persistenceWarning: 'OUTPUT_NOT_ARCHIVED' }),
      }) : null,
    });
    const result = await collect(await service.createSubscription(request()));
    expect((await base.readState({ generationId }))?.snapshot).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.events.filter((event) => event.type === 'snapshot')).toHaveLength(0);
    expect(terminalEvents(result.events)).toHaveLength(0);
    expect((await base.readState({ generationId }))?.status).toBe('completed');
    const resumed = await service.resume(new Request('https://example.test/resume'), { generationId });
    expect(resumed.status).toBe(503);
    expect(await service.resumeOwnedSubscription({ generationId, actorKey, after: null })).toMatchObject({ kind: 'unavailable' });
  });

  test.each([true, false])('legacy missing bit preserves its prior replay path; durable available=%s', async (available) => {
    const base = memory();
    const service = serviceFor(base, async ({ emit }) => {
      await emit({ type: 'markdown', data: { chunk: 'ABC' } });
      return { status: 'completed', resultRef: 'r2:synthetic' };
    });
    await collect(await service.createSubscription(request()));
    const originalRead = base.readState;
    const legacy: GenerationReplayStore = { ...base, readState: async (input) => {
      const state = await originalRead(input);
      if (state?.terminal) {
        const terminal = { ...state.terminal };
        delete terminal.replayUncertain;
        state.terminal = terminal;
      }
      return state;
    } };
    const reader = serviceFor(legacy, async () => ({ status: 'completed' }), {
      terminal: async () => available ? durable() : null,
    });
    const resumed = await reader.resumeOwnedSubscription({ generationId, actorKey, after: null });
    expect(resumed.kind).toBe('subscribed');
    if (resumed.kind !== 'subscribed') throw new Error('Missing subscription');
    const result = await collect(resumed.subscription);
    expect(result.error).toBeUndefined();
    expect(content(result.events)).toEqual({ markdown: 'ABC', reasoning: '' });
    expect(result.events.filter((event) => event.type === 'snapshot')).toHaveLength(0);
    expect(terminalEvents(result.events)).toHaveLength(1);
  });

  test('uncertain full-only budget measures encoded UTF-8 bytes instead of JSON character count', async () => {
    const base = memory();
    const markdown = '界'.repeat(90);
    const reasoning = '理'.repeat(90);
    const encoded = JSON.stringify({ status: 'completed', markdown, reasoning, lastEventId: '1-0',
      updatedAt: now, telemetry: null, terminalResultRef: null });
    expect(encoded.length).toBeLessThan(512);
    expect(new TextEncoder().encode(encoded).byteLength).toBeGreaterThan(512);
    let fail = true;
    const store = { ...base, appendEvents: async (input: Parameters<GenerationReplayStore['appendEvents']>[0]) => {
      if (fail) { fail = false; throw new Error('unknown'); }
      return base.appendEvents(input);
    } };
    const service = serviceFor(store, async ({ emit }) => {
      await emit({ type: 'markdown', data: { chunk: markdown } });
      await emit({ type: 'reasoning', data: { chunk: reasoning } });
      return { status: 'completed' };
    }, { snapshotMaxBytes: 512 });
    const result = await collect(await service.createSubscription(request()));
    expect(result.error).toBeInstanceOf(Error);
    const state = await base.readState({ generationId });
    expect(state?.terminal?.replayUncertain).toBe(true);
    expect(state?.snapshot).toBeNull();
    expect(result.events.filter((event) => event.type === 'snapshot')).toHaveLength(0);
  });

  test('ordinary durable history rebuild after Redis expiry preserves legacy replay without claiming clean evidence', async () => {
    let cacheClock = Date.parse(now);
    const base = createMemoryGenerationReplayStore({ now: () => cacheClock, terminalTtlMs: 1 });
    await base.reserve({ generationId, generationRequestId, actorKey, payloadHash: 'payload', producerToken: 'old',
      now, leaseExpiresAt: '2026-01-01T00:01:00.000Z' });
    await base.markTerminal({ generationId, producerToken: 'old', now,
      terminal: { status: 'completed', resultRef: 'r2:synthetic', replayUncertain: false },
      terminalEvent: { type: 'done', data: { status: 'completed', ok: true, resultRef: 'r2:synthetic' } },
      clearTerminalSnapshot: true });
    cacheClock += 2;
    expect(await base.readState({ generationId })).toBeNull();
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    const service = serviceFor(base, execute, { terminal: async () => durable({ reasoning: '' }) });
    const result = await service.createSubscription(request());
    const replay = await collect(result);
    expect(replay.error).toBeUndefined();
    expect(content(replay.events)).toEqual({ markdown: 'ABC', reasoning: '' });
    expect(terminalEvents(replay.events)).toHaveLength(1);
    const state = await base.readState({ generationId });
    expect(state?.terminal).toMatchObject({ status: 'completed' });
    expect(state?.terminal?.replayUncertain).toBeUndefined();
    expect(state?.snapshot?.markdown).toBe('ABC');
    expect(execute).not.toHaveBeenCalled();
  });

  test('expired lease adoption is uncertain and resumes unavailable without replacing completed status', async () => {
    const base = memory();
    await base.reserve({ generationId, generationRequestId, actorKey, payloadHash: 'payload', producerToken: 'old',
      now: '2025-12-31T23:59:00.000Z', leaseExpiresAt: '2025-12-31T23:59:10.000Z' });
    const service = serviceFor(base, async () => ({ status: 'completed' }), { terminal: async () => durable({ reasoning: '' }) });
    const result = await service.resume(new Request('https://example.test/resume'), { generationId });
    expect(result.status).toBe(503);
    const state = await base.readState({ generationId });
    expect(state?.terminal).toMatchObject({ status: 'completed', replayUncertain: true });
    expect(state?.snapshot).toBeNull();
    expect((await service.status(new Request('https://example.test/status'), { generationId })).status).toBe(200);
  });

  test('unavailable uncertain sidecar cannot lose its hint through a durable fallback', async () => {
    const base = memory();
    const store = { ...base, readState: async () => { throw new Error('REDIS_GENERATION_UNCERTAIN_SNAPSHOT_UNAVAILABLE'); } };
    const readTerminal = vi.fn(async () => durable({ reasoning: '' }));
    const service = serviceFor(store, async () => ({ status: 'completed' }), { terminal: readTerminal });
    expect((await service.resume(new Request('https://example.test/resume'), { generationId })).status).toBe(503);
    expect(await service.resumeOwnedSubscription({ generationId, actorKey, after: null })).toMatchObject({
      kind: 'unavailable', code: 'GENERATION_TERMINAL_CONTENT_UNAVAILABLE',
    });
    expect(readTerminal).not.toHaveBeenCalled();
  });

  test('window-loss fallback rechecks a concurrent uncertain terminal commit', async () => {
    const base = memory();
    await base.reserve({ generationId, generationRequestId, actorKey, payloadHash: 'payload', producerToken: 'producer',
      now, leaseExpiresAt: '2026-01-01T00:01:00.000Z' });
    await base.markRunning({ generationId, producerToken: 'producer', now, leaseExpiresAt: '2026-01-01T00:01:00.000Z' });
    let reads = 0;
    const store: GenerationReplayStore = {
      ...base,
      readAfter: async () => ({ kind: 'window-lost', events: [] }),
      readState: async (input) => {
        const state = await base.readState(input);
        reads += 1;
        if (reads === 2) {
          await base.markTerminal({ generationId, producerToken: 'producer', now,
            terminal: { status: 'completed', resultRef: 'r2:synthetic', replayUncertain: true },
            terminalEvent: { type: 'done', data: { status: 'completed', ok: true, resultRef: 'r2:synthetic' } },
            clearTerminalSnapshot: true });
        }
        return state;
      },
    };
    const service = serviceFor(store, async () => ({ status: 'completed' }), { terminal: async () => durable({ reasoning: '' }) });
    const resumed = await service.resumeOwnedSubscription({ generationId, actorKey, after: '1-0' });
    expect(resumed.kind).toBe('subscribed');
    if (resumed.kind !== 'subscribed') throw new Error('Missing subscription');
    const result = await collect(resumed.subscription);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.events).toEqual([]);
    expect((await base.readState({ generationId }))?.terminal?.replayUncertain).toBe(true);
  });

  test.each([true, false])('reserve failure on repeated create preserves known uncertainty; full snapshot=%s', async (full) => {
    const base = memory();
    await base.reserve({ generationId, generationRequestId, actorKey, payloadHash: 'payload', producerToken: 'producer',
      now, leaseExpiresAt: '2026-01-01T00:01:00.000Z' });
    const common = { generationId, producerToken: 'producer', now,
      terminal: { status: 'completed' as const, resultRef: 'r2:synthetic', replayUncertain: true },
      terminalEvent: { type: 'done', data: { status: 'completed', ok: true, resultRef: 'r2:synthetic' } } };
    await base.markTerminal(full ? { ...common, terminalSnapshot: {
      status: 'completed', markdown: 'ABC', reasoning: 'full reasoning', updatedAt: now,
      lastEventId: null, terminalResultRef: 'r2:synthetic',
    } } : { ...common, clearTerminalSnapshot: true });
    const reserve = vi.fn(async () => { throw new Error('SYNTHETIC_RESERVE_UNAVAILABLE'); });
    const readTerminal = vi.fn(async () => durable({ reasoning: '' }));
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    const service = serviceFor({ ...base, reserve }, execute, { terminal: readTerminal });
    const result = await service.createSubscription(request());
    if (full) {
      const recovered = await collect(result);
      expect(recovered.error).toBeUndefined();
      expect(content(recovered.events)).toEqual({ markdown: 'ABC', reasoning: 'full reasoning' });
      expect(terminalEvents(recovered.events)).toHaveLength(1);
    } else {
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(503);
    }
    expect(reserve).toHaveBeenCalledOnce();
    expect(readTerminal).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test('ordinary Redis read failure retains the existing durable recovery path when no uncertainty hint is available', async () => {
    const base = memory();
    await base.reserve({ generationId, generationRequestId, actorKey, payloadHash: 'payload', producerToken: 'producer',
      now, leaseExpiresAt: '2026-01-01T00:01:00.000Z' });
    let reads = 0;
    const store: GenerationReplayStore = { ...base,
      readAfter: async () => ({ kind: 'window-lost', events: [] }),
      readSnapshot: async () => null,
      readState: async (input) => {
        reads += 1;
        if (reads === 1) return base.readState(input);
        if (reads === 2) return null;
        throw new Error('SYNTHETIC_REDIS_UNAVAILABLE');
      },
    };
    const service = serviceFor(store, async () => ({ status: 'completed' }), {
      terminal: async () => durable({ reasoning: '' }),
    });
    const resumed = await service.resumeOwnedSubscription({ generationId, actorKey, after: '1-0' });
    expect(resumed.kind).toBe('subscribed');
    if (resumed.kind !== 'subscribed') throw new Error('Missing subscription');
    const result = await collect(resumed.subscription);
    expect(result.error).toBeUndefined();
    expect(content(result.events)).toEqual({ markdown: 'ABC', reasoning: '' });
    expect(terminalEvents(result.events)).toHaveLength(1);
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  test('an active state that reappears during durable fallback is not replaced by an empty terminal reset', async () => {
    const base = memory();
    await base.reserve({ generationId, generationRequestId, actorKey, payloadHash: 'payload', producerToken: 'producer',
      now, leaseExpiresAt: '2026-01-01T00:01:00.000Z' });
    await base.markRunning({ generationId, producerToken: 'producer', now, leaseExpiresAt: '2026-01-01T00:01:00.000Z' });
    let reads = 0;
    const store: GenerationReplayStore = { ...base,
      readAfter: async () => ({ kind: 'window-lost', events: [] }),
      readSnapshot: async () => null,
      readState: async (input) => ++reads === 2 ? null : base.readState(input),
    };
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    const service = serviceFor(store, execute, {
      terminal: async () => durable({ markdown: '', reasoning: '', contentAvailable: false, contentUnavailableReason: 'not-found' }),
    });
    const resumed = await service.resumeOwnedSubscription({ generationId, actorKey, after: '1-0' });
    expect(resumed.kind).toBe('subscribed');
    if (resumed.kind !== 'subscribed') throw new Error('Missing stream');
    const result = await collect(resumed.subscription);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.events).toEqual([]);
    expect(await base.readState({ generationId })).toMatchObject({ status: 'running', terminal: null });
    expect(execute).not.toHaveBeenCalled();
  });

  test.each([true, false, undefined])('memory store retains internal uncertainty=%s without adding it to terminal event', async (replayUncertain) => {
    const base = memory();
    await base.reserve({ generationId, generationRequestId, actorKey, payloadHash: 'payload', producerToken: 'producer', now, leaseExpiresAt: '2026-01-01T00:01:00.000Z' });
    const terminal: GenerationTerminal = { status: 'completed', ...(replayUncertain === undefined ? {} : { replayUncertain }) };
    const result = await base.markTerminal({ generationId, producerToken: 'producer', now, terminal,
      terminalEvent: { type: 'done', data: { status: 'completed', ok: true } }, clearTerminalSnapshot: true });
    expect((await base.readState({ generationId }))?.terminal).toEqual(terminal);
    expect(JSON.stringify(result.event)).not.toContain('replayUncertain');
  });
});
