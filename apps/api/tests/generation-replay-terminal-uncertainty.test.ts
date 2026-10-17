import { describe, expect, it, vi } from 'vitest';

import { createRedisGenerationReplayStore, type RedisGenerationClient } from '#/redis/generation-replay-store';

const fixture = {
  actorHash: 'actor-hash', reservationKey: 'mahoshojo:gen:v1:req:user:hash:request',
  generationId: 'generation-uncertain', generationRequestId: 'request', payloadHash: 'payload',
  producerToken: 'producer', status: 'completed', lastEventId: '12-0',
  updatedAt: '2026-01-01T00:00:00.000Z', leaseExpiresAt: null, cancelRequested: false,
  terminal: { status: 'completed' },
  snapshot: {
    status: 'completed', markdown: '完整正文', reasoning: '完整推理', lastEventId: '12-0',
    updatedAt: '2026-01-01T00:00:00.000Z', telemetry: null, terminalResultRef: null,
  },
};
const storeFor = (state: unknown) => {
  const raw = JSON.stringify(state);
  const client: RedisGenerationClient = {
    get: vi.fn(async () => raw),
    // Accept both legacy GET and atomic raw-pair transport; semantics are the same.
    eval: vi.fn(async () => [raw, '']),
    xRead: vi.fn(async () => null),
  };
  return createRedisGenerationReplayStore({ getClient: () => client });
};

describe('Redis terminal uncertainty evidence', () => {
  it.each([true, false, undefined])('preserves optional boolean %s without adding it to snapshots', async (value) => {
    const terminal = { ...fixture.terminal, ...(value === undefined ? {} : { replayUncertain: value }) };
    const state = await storeFor({ ...fixture, terminal }).readState({ generationId: fixture.generationId });
    expect(state?.terminal).toEqual(terminal);
    expect(state?.snapshot).not.toHaveProperty('replayUncertain');
  });

  it.each(['true', 1, null])('rejects malformed uncertainty %s rather than coercing it', async (value) => {
    const store = storeFor({ ...fixture, terminal: { ...fixture.terminal, replayUncertain: value } });
    await expect(store.readState({ generationId: fixture.generationId })).rejects.toThrow('STATE_INVALID');
  });

  it.each([
    { snapshot: { malformed: true } },
    { snapshot: { ...fixture.snapshot, lastEventId: '11-0' } },
    { terminal: { ...fixture.terminal, replayUncertain: true, code: 123 } },
  ])('retains the conservative unavailable signal when known-uncertain evidence is corrupt %#', async (corruption) => {
    const store = storeFor({
      ...fixture, terminal: { ...fixture.terminal, replayUncertain: true }, ...corruption,
    });
    await expect(store.readState({ generationId: fixture.generationId }))
      .rejects.toThrow('REDIS_GENERATION_UNCERTAIN_SNAPSHOT_UNAVAILABLE');
  });

  it('keeps an explicit clear snapshot and the terminal marker available to the caller', async () => {
    const store = storeFor({ ...fixture, terminal: { ...fixture.terminal, replayUncertain: true }, snapshot: null });
    await expect(store.readState({ generationId: fixture.generationId })).resolves.toMatchObject({
      status: 'completed', snapshot: null, terminal: { status: 'completed', replayUncertain: true },
    });
  });
});
