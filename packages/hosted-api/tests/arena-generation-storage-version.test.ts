import { expect, test, vi } from 'vitest';

import { createMemoryGenerationReplayStore } from '../src/arena-generation/memory-replay-store';
import { createArenaGenerationService, type GenerationReplayStore } from '../src/arena-generation/service';

const now = '2026-01-01T00:00:00.000Z';
const generationId = 'generation-version';
const generationRequestId = 'request-version';
const actorKey = 'user:synthetic';
const invalidVersion = () => { throw new Error('REDIS_GENERATION_STORAGE_VERSION_INVALID'); };
const make = (store: GenerationReplayStore) => {
  const readOwnedTerminal = vi.fn(async () => ({
    generationId, generationRequestId, payloadHash: 'payload', status: 'completed' as const,
    markdown: 'durable body', reasoning: '', updatedAt: now, resultRef: 'r2:synthetic', contentAvailable: true,
  }));
  const execute = vi.fn(async () => ({ status: 'completed' as const }));
  const service = createArenaGenerationService({
    store, executor: { execute }, terminalStore: { readOwnedTerminal }, now: () => new Date(now),
    resolveActor: async () => ({ actorKey }), deriveGenerationId: async () => generationId,
    hashPayload: async () => 'payload', replayPollMs: 1,
  });
  return { service, readOwnedTerminal, execute };
};

test('an existing unknown Redis layout never becomes a legacy durable resume', async () => {
  const store = { ...createMemoryGenerationReplayStore(), readState: async () => invalidVersion() };
  const { service, readOwnedTerminal } = make(store);
  const response = await service.resume(new Request('https://example.test/resume'), { generationId });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'GENERATION_STATE_UNAVAILABLE' });
  expect(await service.resumeOwnedSubscription({ generationId, actorKey, after: null })).toEqual({
    kind: 'unavailable', code: 'GENERATION_STATE_UNAVAILABLE',
  });
  expect(readOwnedTerminal).not.toHaveBeenCalled();
});

test('reservation failure cannot hide an unknown retained layout behind a durable body', async () => {
  const store = { ...createMemoryGenerationReplayStore(), readState: async () => invalidVersion(),
    reserve: async () => { throw new Error('SYNTHETIC_RESERVATION_UNAVAILABLE'); } };
  const { service, readOwnedTerminal, execute } = make(store);
  const response = await service.create(new Request('https://example.test/create', {
    method: 'POST', body: JSON.stringify({ generationRequestId }),
  }));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'GENERATION_STATE_UNAVAILABLE' });
  expect(readOwnedTerminal).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

test('the stream fallback recheck fails closed if an unknown layout appears before delivery', async () => {
  const base = createMemoryGenerationReplayStore({ now: () => Date.parse(now) });
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
      return invalidVersion();
    },
  };
  const { service } = make(store);
  const resumed = await service.resumeOwnedSubscription({ generationId, actorKey, after: '1-0' });
  expect(resumed.kind).toBe('subscribed');
  if (resumed.kind !== 'subscribed') throw new Error('Missing stream');
  await expect(resumed.subscription.events.getReader().read()).rejects.toThrow('GENERATION_STATE_UNAVAILABLE');
});
