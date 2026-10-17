import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from 'redis';

import {
  createRedisGenerationReplayStore,
  type GenerationSnapshot,
  type RedisGenerationClient,
} from '../src/redis/generation-replay-store';

// Intentionally accepts only an explicitly selected local redis-server binary.
// Never reads REDIS_URL or connects to an existing Redis. A random password and
// PID verification make a loopback port race fail closed before any fixture write.
const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary) || process.argv.length !== 3) {
  throw new Error('用法：node --import tsx scripts/verify-generation-replay-local.ts /absolute/path/to/redis-server');
}
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const address = reservation.address();
assert.ok(address && typeof address === 'object');
const port = address.port;
await new Promise<void>((resolve, reject) => {
  reservation.close((error) => error ? reject(error) : resolve());
});
const password = randomBytes(32).toString('hex');
const directory = await mkdtemp(path.join(tmpdir(), 'maho-replay-protocol-'));
const server = spawn(binary, [
  '--bind', '127.0.0.1', '--port', String(port), '--protected-mode', 'yes', '--requirepass', password,
  '--save', '', '--appendonly', 'no', '--dir', directory,
], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverError: Error | null = null;
let serverLog = '';
for (const stream of [server.stdout, server.stderr]) {
  stream?.on('data', (chunk: Buffer) => { serverLog = (serverLog + chunk.toString()).slice(-4_096); });
}
server.on('error', (error) => { serverError = error; });
const serverExit = once(server, 'exit').catch(() => undefined);
const client = createClient({
  password,
  socket: { host: '127.0.0.1', port, reconnectStrategy: false, connectTimeout: 1_000, socketTimeout: 5_000 },
});
client.on('error', () => undefined);

type EvalCall = { script: string; keys: string[]; arguments: string[]; missingState?: boolean };
type StoredState = Record<string, unknown> & {
  generationId: string;
  reservationKey: string;
  storageVersion?: number;
  snapshot: GenerationSnapshot | null;
  snapshotMeta?: Record<string, unknown> | null;
};
const calls: EvalCall[] = [];
let beforeEval: ((call: EvalCall) => Promise<void>) | null = null;
let afterEval: ((call: EvalCall) => Promise<void>) | null = null;
let beforeXRead: (() => Promise<void>) | null = null;
const wrapped: RedisGenerationClient = {
  eval: async (script, options) => {
    const call: EvalCall = { script, keys: [...options.keys], arguments: [...options.arguments] };
    if (call.keys.length === 4 && call.keys[2] === call.keys[0]) {
      call.missingState = await client.exists(call.keys[0]!) === 0;
    }
    calls.push(call);
    await beforeEval?.(call);
    const result = await client.eval(script, options);
    await afterEval?.(call);
    return result;
  },
  get: (key) => client.get(key),
  xRead: async (streams, options) => {
    const hook = beforeXRead;
    beforeXRead = null;
    await hook?.();
    return client.xRead(streams, options);
  },
};
const keyPrefix = 'localprotocol';
const makeStore = (enableSnapshotSidecar = false, maxEvents = 4) => createRedisGenerationReplayStore({
  getClient: () => wrapped, keyPrefix, enableSnapshotSidecar,
  activeTtlSeconds: 30, terminalTtlSeconds: 20, maxEvents,
});
const A = makeStore(false);
const B = makeStore(true);
type Store = ReturnType<typeof makeStore>;
const actorKey = 'anonymous:synthetic-protocol';
const now = '2026-01-01T00:00:00.000Z';
const expires = '2026-01-01T00:00:10.000Z';
const expiredNow = '2026-01-01T00:00:11.000Z';
const reaperExpires = '2026-01-01T00:00:20.000Z';
const stateKey = (id: string) => `mahoshojo:gen:v1:${keyPrefix}:${id}:state`;
const eventsKey = (id: string) => `mahoshojo:gen:v1:${keyPrefix}:${id}:events`;
const snapshotKey = (id: string) => `mahoshojo:gen:v1:${keyPrefix}:${id}:snapshot`;
const snapshot = (lastEventId: string | null, markdown = 'synthetic body'): GenerationSnapshot => ({
  status: 'running', markdown, reasoning: '', lastEventId, updatedAt: now,
  telemetry: null, terminalResultRef: null,
});
const readRaw = async (id: string): Promise<StoredState> => {
  const raw = await client.get(stateKey(id));
  assert.notEqual(raw, null, `state missing: ${id}`);
  return JSON.parse(raw!) as StoredState;
};
const keysFor = async (id: string) => [stateKey(id), eventsKey(id), (await readRaw(id)).reservationKey, snapshotKey(id)];
const owner = (id: string) => ({ generationId: id, producerToken: id, now });
const reserve = async (store: Store, id: string, requestId = id) => {
  const result = await store.reserve({
    generationId: id, generationRequestId: requestId, actorKey,
    payloadHash: 'synthetic-payload', producerToken: id, now, leaseExpiresAt: expires,
  });
  assert.equal(result.kind, 'created');
};
const append = async (store: Store, id: string, count = 1) => {
  const result = await store.appendEvents({
    ...owner(id), events: Array.from({ length: count }, (_, index) => ({ type: 'markdown', data: { chunk: `chunk-${index}` } })),
  });
  assert.equal(result.owned, true);
  assert.equal(result.events.length, count);
  return result.events;
};
const start = async (store: Store, id: string, withSnapshot = true) => {
  await reserve(store, id);
  assert.equal((await store.markRunning({ ...owner(id), leaseExpiresAt: expires })).owned, true);
  if (withSnapshot) {
    const [event] = await append(store, id);
    assert.equal((await store.writeSnapshot({ ...owner(id), snapshot: snapshot(event!.id) })).owned, true);
  }
};
const shortenTtls = async (id: string) => {
  for (const key of await keysFor(id)) {
    if (await client.exists(key)) await client.pExpire(key, 6_000);
  }
};
const assertTtls = async (id: string, expectedMs: number, expectedKeys = 4) => {
  let found = 0;
  for (const key of await keysFor(id)) {
    const ttl = await client.pTTL(key);
    if (ttl === -2) continue;
    found += 1;
    assert.ok(ttl > expectedMs - 5_000 && ttl <= expectedMs, `${key}: unexpected TTL ${ttl}`);
  }
  assert.equal(found, expectedKeys, `${id}: retained key count`);
};
const terminal = async (store: Store, id: string, clear = false) => {
  const common = {
    ...owner(id), terminal: { status: 'completed' as const },
    terminalEvent: { type: 'complete', data: { synthetic: true } },
  };
  return clear
    ? store.markTerminal({ ...common, clearTerminalSnapshot: true })
    : store.markTerminal({ ...common, terminalSnapshot: { ...snapshot(null, 'complete body'), status: 'completed' } });
};
const mutation = /-- GEN_(?:MARK_RUNNING|CLAIM_FINALIZATION|CLAIM_LEASE_EXPIRY|RELEASE_RESERVATION|HEARTBEAT|APPEND|SNAPSHOT|TERMINAL|CANCEL)_V\d/u;
const degradedError = /REDIS_GENERATION_SNAPSHOT_(?:SIDECAR|METADATA)_INVALID/u;
const invalidVersion = /REDIS_GENERATION_STORAGE_VERSION_INVALID/u;
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, run: () => Promise<void>) => tests.push([name, run]);

test('mixed flags reserve one generation for one request', async () => {
  const input = {
    actorKey, generationRequestId: 'mixed-request', payloadHash: 'same-payload', now, leaseExpiresAt: expires,
  };
  const results = await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 2 ? A : B).reserve({
    ...input, generationId: `mixed-${index}`, producerToken: `mixed-${index}`,
  })));
  assert.equal(results.filter((result) => result.kind === 'created').length, 1);
  const winner = results.find((result) => result.kind === 'created');
  assert.ok(winner);
  for (const result of results) {
    assert.notEqual(result.kind, 'conflict');
    if (result.kind !== 'conflict') assert.equal(result.generationId, winner.generationId);
  }
  const states = await Promise.all(Array.from({ length: 24 }, (_, index) => client.exists(stateKey(`mixed-${index}`))));
  assert.equal(states.reduce((sum, count) => sum + count, 0), 1);
  assert.equal((await A.reserve({ ...input, generationId: 'conflicting', producerToken: 'conflicting', payloadHash: 'other' })).kind, 'conflict');
});

test('default v1 and v2 both remain readable and writable across flag changes', async () => {
  const defaultStore = createRedisGenerationReplayStore({ getClient: () => wrapped, keyPrefix });
  await reserve(defaultStore, 'default-layout');
  assert.notEqual((await readRaw('default-layout')).storageVersion, 2);
  for (const [creator, reader, id, version] of [[A, B, 'legacy-cross', 1], [B, A, 'sidecar-cross', 2]] as const) {
    await reserve(creator, id);
    const reserved = await reader.readState({ generationId: id, actorKey });
    assert.ok(reserved);
    assert.equal(reserved.status, 'reserved');
    assert.equal(reserved.snapshot, null);
    assert.equal(await reader.readSnapshot({ generationId: id }), null);
    assert.equal(await client.exists(snapshotKey(id)), 0, 'reserved v2 has no snapshot key until its first snapshot');
    await assertTtls(id, 30_000, 2);
    assert.equal((await reader.markRunning({ ...owner(id), leaseExpiresAt: expires })).owned, true);
    const [event] = await append(reader, id);
    const body = 'synthetic '.repeat(8_192);
    assert.equal((await reader.writeSnapshot({ ...owner(id), snapshot: snapshot(event!.id, body) })).owned, true);
    assert.equal((await creator.readSnapshot({ generationId: id }))?.markdown, body);
    assert.equal((await reader.readState({ generationId: id, actorKey }))?.snapshot?.lastEventId, event!.id);
    assert.equal(await reader.readState({ generationId: id, actorKey: 'anonymous:other' }), null);
    const raw = await readRaw(id);
    if (version === 2) {
      assert.equal(raw.storageVersion, 2);
      assert.equal(raw.snapshot, null);
      assert.ok(raw.snapshotMeta);
      assert.equal(raw.snapshotMeta.digest, createHash('sha1').update((await client.get(snapshotKey(id)))!).digest('hex'));
      assert.ok(JSON.stringify(raw).length < 4_096, 'v2 state must not embed full snapshot content');
      assert.equal(JSON.parse((await client.get(snapshotKey(id)))!).markdown, body);
    } else {
      assert.notEqual(raw.storageVersion, 2);
      assert.equal(raw.snapshot?.markdown, body);
      assert.equal(await client.exists(snapshotKey(id)), 0);
    }
    const result = await terminal(reader, id);
    assert.equal(result.applied, true);
    assert.equal((await creator.readState({ generationId: id }))?.snapshot?.lastEventId, result.event!.id);
    assert.equal((await readRaw(id)).storageVersion === 2, version === 2, 'creation flag never migrates existing records');
  }
});

test('v2 running snapshot cursor must match committed tail; v1 behavior is preserved', async () => {
  for (const [store, id, version] of [[A, 'v1-cursor', 1], [B, 'v2-cursor', 2]] as const) {
    await start(store, id);
    const oldSnapshot = await store.readSnapshot({ generationId: id });
    const [event] = await append(store, id);
    const write = () => store.writeSnapshot({ ...owner(id), snapshot: snapshot(oldSnapshot!.lastEventId, 'stale') });
    if (version === 1) {
      assert.equal((await write()).owned, true);
    } else {
      const rawBefore = await client.get(stateKey(id));
      const sidecarBefore = await client.get(snapshotKey(id));
      await assert.rejects(write, /REDIS_GENERATION_SNAPSHOT_CURSOR_MISMATCH/u);
      assert.equal(await client.get(stateKey(id)), rawBefore);
      assert.equal(await client.get(snapshotKey(id)), sidecarBefore);
      assert.equal((await store.readSnapshot({ generationId: id }))?.lastEventId, oldSnapshot!.lastEventId);
    }
    assert.equal((await store.writeSnapshot({ ...owner(id), snapshot: snapshot(event!.id, 'current') })).owned, true);
  }
});

test('sidecar absence, malformed JSON, invalid shape and metadata mismatch fail closed', async () => {
  const id = 'sidecar-damage';
  await start(B, id);
  const original = (await client.get(snapshotKey(id)))!;
  const originalState = (await client.get(stateKey(id)))!;
  const assertDegraded = async () => {
    for (const store of [A, B]) {
      await assert.rejects(() => store.readSnapshot({ generationId: id }), degradedError);
      await assert.rejects(() => store.readState({ generationId: id, actorKey }), degradedError);
    }
  };
  await client.del(snapshotKey(id));
  await assertDegraded();
  for (const damaged of ['{', 'null', '{}', JSON.stringify({ ...JSON.parse(original), markdown: 42 })]) {
    await client.set(snapshotKey(id), damaged, { PX: 30_000 });
    await assertDegraded();
  }
  for (const change of [{ lastEventId: '0-0' }, { status: 'completed' }, { updatedAt: expiredNow }, { markdown: 'silent corruption' }]) {
    await client.set(snapshotKey(id), JSON.stringify({ ...JSON.parse(original), ...change }), { PX: 30_000 });
    await assertDegraded();
  }
  await client.set(snapshotKey(id), original, { PX: 30_000 });
  for (const change of [{ lastEventId: '0-0' }, { status: 'completed' }, { updatedAt: expiredNow }, { digest: 'bad-digest' }]) {
    const raw = JSON.parse(originalState) as StoredState;
    assert.ok(raw.snapshotMeta);
    raw.snapshotMeta = { ...raw.snapshotMeta, ...change };
    await client.set(stateKey(id), JSON.stringify(raw), { PX: 30_000 });
    await assertDegraded();
  }
  await client.set(stateKey(id), originalState, { PX: 30_000 });
  assert.deepEqual(await A.readSnapshot({ generationId: id }), JSON.parse(original));
});

test('unknown storage versions are rejected by readers and every mutation', async () => {
  const id = 'unknown-layout';
  await start(B, id);
  const original = (await client.get(stateKey(id)))!;
  const invalid = JSON.stringify({ ...JSON.parse(original), storageVersion: 999 });
  await client.set(stateKey(id), invalid, { PX: 30_000 });
  const operations = [
    () => A.readState({ generationId: id }),
    () => B.readSnapshot({ generationId: id }),
    () => A.markRunning({ ...owner(id), leaseExpiresAt: expires }),
    () => A.heartbeat({ ...owner(id), leaseExpiresAt: expires }),
    () => A.appendEvents({ ...owner(id), events: [{ type: 'markdown', data: 'unreachable' }] }),
    () => A.writeSnapshot({ ...owner(id), snapshot: snapshot(null) }),
    () => A.claimFinalization({ ...owner(id), leaseExpiresAt: expires }),
    () => A.claimLeaseExpiry({ generationId: id, actorKey, reaperToken: 'reaper', now: expiredNow, leaseExpiresAt: reaperExpires }),
    () => A.requestCancel({ generationId: id, actorKey, reason: 'user', now }),
    () => A.releaseReservation({ generationId: id, producerToken: id }),
    () => terminal(A, id),
  ];
  for (const operation of operations) {
    await assert.rejects(operation, invalidVersion);
    assert.equal(await client.get(stateKey(id)), invalid);
  }
  await client.set(stateKey(id), original, { PX: 30_000 });
});

test('all retained keys renew on append, snapshot, heartbeat, cancel and finalization', async () => {
  const id = 'renew-v2';
  await start(B, id);
  const operations = [
    () => A.heartbeat({ ...owner(id), leaseExpiresAt: expires }),
    () => append(A, id),
    async () => A.writeSnapshot({ ...owner(id), snapshot: snapshot((await A.readState({ generationId: id }))!.lastEventId) }),
    () => A.requestCancel({ generationId: id, actorKey, reason: 'content_policy', now }),
    () => A.claimFinalization({ ...owner(id), leaseExpiresAt: expires, terminal: { status: 'completed' } }),
  ];
  for (const operation of operations) {
    await shortenTtls(id);
    await operation();
    await assertTtls(id, 30_000);
  }
  const state = await A.readState({ generationId: id });
  assert.ok(state);
  assert.equal(state.status, 'finalizing');
  assert.equal(state.cancelReason, 'content_policy');
  assert.deepEqual(state.intendedTerminal, { status: 'cancelled', code: 'CONTENT_POLICY_CANCELLED' });
  assert.equal((await A.requestCancel({ generationId: id, actorKey, reason: 'user', now })).kind, 'finalizing');
});

test('reserved cancellation, forbidden actor and lease fences remain enforced', async () => {
  const id = 'cancel-reserved';
  await reserve(B, id);
  assert.equal((await A.requestCancel({ generationId: id, actorKey: 'anonymous:other', reason: 'user', now })).kind, 'forbidden');
  assert.equal((await A.requestCancel({ generationId: id, actorKey, reason: 'content_policy', now })).kind, 'accepted');
  await shortenTtls(id);
  assert.deepEqual(await A.markRunning({ ...owner(id), leaseExpiresAt: expires }), {
    owned: true, cancelRequested: true, cancelReason: 'content_policy',
  });
  await assertTtls(id, 30_000, 2);
  assert.equal((await A.readState({ generationId: id }))?.status, 'finalizing');

  const running = 'lease-fences';
  await start(B, running);
  const before = await client.get(stateKey(running));
  const wrong = { ...owner(running), producerToken: 'wrong-token' };
  assert.equal((await A.heartbeat({ ...wrong, leaseExpiresAt: expires })).owned, false);
  assert.equal((await A.appendEvents({ ...wrong, events: [{ type: 'markdown', data: 'forbidden' }] })).owned, false);
  assert.equal((await A.writeSnapshot({ ...wrong, snapshot: snapshot(null) })).owned, false);
  assert.equal((await A.claimFinalization({ ...wrong, leaseExpiresAt: expires })).kind, 'fenced');
  assert.equal((await A.releaseReservation(wrong)).released, false);
  assert.equal((await A.heartbeat({ ...owner(running), now: expiredNow, leaseExpiresAt: reaperExpires })).owned, false);
  assert.equal((await A.appendEvents({ ...owner(running), now: expiredNow, events: [{ type: 'markdown', data: 'expired' }] })).owned, false);
  assert.equal(await client.get(stateKey(running)), before);
});

test('lease reaper preserves finalization intent and fences the old producer', async () => {
  const id = 'reaper-v2';
  await start(B, id);
  assert.equal((await A.claimLeaseExpiry({ generationId: id, actorKey, reaperToken: 'reaper', now, leaseExpiresAt: reaperExpires })).kind, 'not-expired');
  assert.equal((await A.claimLeaseExpiry({ generationId: id, actorKey: 'anonymous:other', reaperToken: 'reaper', now: expiredNow, leaseExpiresAt: reaperExpires })).kind, 'forbidden');
  assert.equal((await A.claimFinalization({ ...owner(id), leaseExpiresAt: expires, terminal: { status: 'completed', resultRef: 'synthetic-result' } })).kind, 'claimed');
  await shortenTtls(id);
  const claim = await A.claimLeaseExpiry({ generationId: id, actorKey, reaperToken: 'reaper', now: expiredNow, leaseExpiresAt: reaperExpires });
  assert.equal(claim.kind, 'claimed');
  if (claim.kind === 'claimed') assert.deepEqual(claim.intendedTerminal, { status: 'completed', resultRef: 'synthetic-result' });
  await assertTtls(id, 30_000);
  assert.equal((await A.appendEvents({ ...owner(id), events: [{ type: 'markdown', data: 'stale' }] })).owned, false);
  assert.equal((await terminal(A, id)).owned, false);
  const result = await A.markTerminal({
    generationId: id, producerToken: 'reaper', now: expiredNow,
    terminal: { status: 'completed', resultRef: 'synthetic-result' },
    terminalEvent: { type: 'complete', data: { synthetic: true } },
    terminalSnapshot: { ...snapshot(null), status: 'completed', terminalResultRef: 'synthetic-result' },
  });
  assert.equal(result.applied, true);
  assert.equal((await B.readState({ generationId: id }))?.snapshot?.lastEventId, result.event!.id);
  await assertTtls(id, 20_000);
  assert.deepEqual(await B.claimLeaseExpiry({ generationId: id, actorKey, reaperToken: 'later', now: expiredNow, leaseExpiresAt: reaperExpires }), { kind: 'terminal', status: 'completed' });
});

test('terminal snapshot or clear is one atomic mutation and duplicate completion adds no event', async () => {
  for (const clear of [false, true]) {
    const id = `terminal-${clear ? 'clear' : 'snapshot'}`;
    await start(B, id);
    const startIndex = calls.length;
    const result = await terminal(A, id, clear);
    assert.equal(result.applied, true);
    assert.equal(calls.slice(startIndex).filter((call) => mutation.test(call.script)).length, 1);
    const state = await B.readState({ generationId: id });
    assert.ok(state);
    assert.equal(state.status, 'completed');
    assert.equal(state.lastEventId, result.event!.id);
    assert.equal(state.leaseExpiresAt, null);
    assert.equal(state.intendedTerminal, null);
    assert.deepEqual(await A.readEvent({ generationId: id, eventId: result.event!.id }), result.event);
    const raw = await readRaw(id);
    assert.equal(raw.snapshot, null);
    if (clear) {
      assert.equal(raw.snapshotMeta, null);
      assert.equal(state.snapshot, null);
      assert.equal(await client.exists(snapshotKey(id)), 0);
    } else {
      assert.equal(state.snapshot?.status, 'completed');
      assert.equal(state.snapshot?.lastEventId, result.event!.id);
      assert.equal(raw.snapshotMeta?.lastEventId, result.event!.id);
    }
    await assertTtls(id, 20_000, clear ? 3 : 4);
    const count = await client.xLen(eventsKey(id));
    assert.equal((await terminal(B, id, clear)).applied, false);
    assert.equal(await client.xLen(eventsKey(id)), count);
    assert.deepEqual(await A.requestCancel({ generationId: id, actorKey, reason: 'user', now }), { kind: 'terminal', status: 'completed' });
    assert.equal((await A.appendEvents({ ...owner(id), events: [{ type: 'markdown', data: 'late' }] })).owned, false);
  }
});

test('release cleans all generation keys without requiring a reserved snapshot', async () => {
  for (const orphan of [false, true]) {
    const id = `release-${orphan ? 'orphan' : 'empty'}`;
    await reserve(B, id);
    const keys = await keysFor(id);
    if (orphan) {
      await client.set(snapshotKey(id), JSON.stringify(snapshot(null)), { PX: 30_000 });
      await client.xAdd(eventsKey(id), '*', { type: 'fixture', data: '{}' });
    }
    assert.equal((await A.releaseReservation({ generationId: id, producerToken: 'wrong' })).released, false);
    assert.equal((await A.releaseReservation({ generationId: id, producerToken: id })).released, true);
    for (const key of keys) assert.equal(await client.exists(key), 0);
    assert.equal((await B.releaseReservation({ generationId: id, producerToken: id })).released, false);
    await reserve(A, `${id}-replacement`, id);
  }
});

test('exact trim, exact event reads and blocked-reader window recheck', async () => {
  const id = 'trim-v2';
  await start(B, id, false);
  assert.equal((await A.readAfter({ generationId: id, after: null, blockMs: 1 })).kind, 'stream-missing');
  const events = await append(B, id, 7);
  assert.equal(await client.xLen(eventsKey(id)), 4);
  assert.equal(await A.readEvent({ generationId: id, eventId: events[0]!.id }), null);
  assert.deepEqual(await A.readEvent({ generationId: id, eventId: events[3]!.id }), events[3]);
  assert.equal((await A.readAfter({ generationId: id, after: events[0]!.id, blockMs: 1 })).kind, 'window-lost');
  assert.deepEqual((await A.readAfter({ generationId: id, after: events[3]!.id, blockMs: 1 })).events, events.slice(4));
  assert.deepEqual((await A.readAfter({ generationId: id, after: null, blockMs: 1 })).events, events.slice(3));
  beforeXRead = async () => { await append(B, id, 6); };
  assert.equal((await A.readAfter({ generationId: id, after: events.at(-1)!.id, blockMs: 1 })).kind, 'window-lost');
  assert.equal(beforeXRead, null, 'test must exercise the XREAD branch');
  await terminal(A, id, true);
  assert.equal(await client.xLen(eventsKey(id)), 4);
});

test('lost append replies propagate without an implicit retry', async () => {
  for (const committed of [false, true]) {
    const id = `lost-reply-${committed}`;
    await start(B, id);
    const before = await client.xLen(eventsKey(id));
    const callIndex = calls.length;
    const fail = async (call: EvalCall) => {
      if (!call.script.includes('GEN_APPEND_')) return;
      beforeEval = null;
      afterEval = null;
      throw new Error('SYNTHETIC_APPEND_REPLY_LOST');
    };
    if (committed) afterEval = fail;
    else beforeEval = fail;
    await assert.rejects(() => A.appendEvents({ ...owner(id), events: [{ type: 'markdown', data: 'once' }] }), /SYNTHETIC_APPEND_REPLY_LOST/u);
    assert.equal(calls.slice(callIndex).filter((call) => call.script.includes('GEN_APPEND_')).length, 1);
    assert.equal(await client.xLen(eventsKey(id)), before + Number(committed));
  }
});

test('Lua revalidates identity after a preflight read and cannot touch a substituted request key', async () => {
  const actions: Array<[string, boolean, (id: string) => Promise<unknown>]> = [
    ['MARK_RUNNING', true, (id) => A.markRunning({ ...owner(id), leaseExpiresAt: expires })],
    ['RELEASE_RESERVATION', true, (id) => A.releaseReservation(owner(id))],
    ['HEARTBEAT', false, (id) => A.heartbeat({ ...owner(id), leaseExpiresAt: expires })],
    ['APPEND', false, (id) => A.appendEvents({ ...owner(id), events: [{ type: 'markdown', data: 'blocked' }] })],
    ['SNAPSHOT', false, async (id) => A.writeSnapshot({ ...owner(id), snapshot: snapshot((await A.readState({ generationId: id }))!.lastEventId) })],
    ['CLAIM_FINALIZATION', false, (id) => A.claimFinalization({ ...owner(id), leaseExpiresAt: expires })],
    ['CLAIM_LEASE_EXPIRY', false, (id) => A.claimLeaseExpiry({ generationId: id, actorKey, reaperToken: 'reaper', now: expiredNow, leaseExpiresAt: reaperExpires })],
    ['CANCEL', false, (id) => A.requestCancel({ generationId: id, actorKey, reason: 'user', now })],
    ['TERMINAL', false, (id) => terminal(A, id)],
  ];
  const canary = `mahoshojo:gen:v1:${keyPrefix}:canary-request`;
  await client.set(canary, 'untouched');
  for (const [tag, reserved, action] of actions) {
    const id = `identity-${tag.toLowerCase()}`;
    if (reserved) await reserve(B, id);
    else await start(B, id);
    const original = await readRaw(id);
    const originalSidecar = await client.get(snapshotKey(id));
    const originalEvents = await client.xLen(eventsKey(id));
    let injected = false;
    beforeEval = async (call) => {
      if (!call.script.includes(`GEN_${tag}_`)) return;
      beforeEval = null;
      injected = true;
      await client.set(stateKey(id), JSON.stringify({ ...original, reservationKey: canary }), { PX: 30_000 });
    };
    await assert.rejects(() => action(id), /REDIS_GENERATION_IDENTITY_CHANGED/u);
    assert.equal(injected, true, `${tag}: identity race must occur immediately before Lua`);
    assert.equal(await client.get(canary), 'untouched');
    assert.equal(await client.pTTL(canary), -1, 'Lua must not PEXPIRE a key supplied by corrupt state');
    assert.equal(await client.get(snapshotKey(id)), originalSidecar);
    assert.equal(await client.xLen(eventsKey(id)), originalEvents);
  }
  for (const reserved of [false, true]) {
    const id = `request-owner-${reserved ? 'release' : 'heartbeat'}`;
    if (reserved) await reserve(B, id);
    else await start(B, id);
    const originalState = await client.get(stateKey(id));
    const identityKey = (await readRaw(id)).reservationKey;
    const replacement = JSON.stringify({ generationId: `${id}-new-owner`, payloadHash: 'synthetic-payload' });
    beforeEval = async (call) => {
      if (!call.script.includes(reserved ? 'GEN_RELEASE_RESERVATION_' : 'GEN_HEARTBEAT_')) return;
      beforeEval = null;
      await client.set(identityKey, replacement, { PX: 6_000 });
    };
    await assert.rejects(() => reserved
      ? A.releaseReservation(owner(id))
      : A.heartbeat({ ...owner(id), leaseExpiresAt: expires }), /REDIS_GENERATION_IDENTITY_CHANGED/u);
    assert.equal(await client.get(stateKey(id)), originalState);
    assert.equal(await client.get(identityKey), replacement);
    const ttl = await client.pTTL(identityKey);
    assert.ok(ttl > 0 && ttl <= 6_000, 'request value identity changes must not renew or delete the new owner');
  }
  const id = 'identity-cold-sentinel';
  const cold = makeStore(false);
  let insertedKeys: string[] = [];
  let insertedState: string | null = null;
  let insertedRequest: string | null = null;
  beforeEval = async (call) => {
    if (!call.script.includes('GEN_RELEASE_RESERVATION_')) return;
    beforeEval = null;
    assert.equal(call.keys[2], stateKey(id), 'cold discovery must have returned the missing-state sentinel');
    await reserve(B, id);
    await client.set(snapshotKey(id), 'synthetic orphan sidecar', { PX: 6_000 });
    await client.xAdd(eventsKey(id), '*', { type: 'fixture', data: '{}' });
    insertedKeys = await keysFor(id);
    for (const key of insertedKeys) await client.pExpire(key, 6_000);
    insertedState = await client.get(stateKey(id));
    insertedRequest = await client.get(insertedKeys[2]!);
  };
  await assert.rejects(() => cold.releaseReservation(owner(id)), /REDIS_GENERATION_IDENTITY_CHANGED/u);
  assert.equal(insertedKeys.length, 4);
  assert.equal(await client.get(stateKey(id)), insertedState);
  assert.equal(await client.get(insertedKeys[2]!), insertedRequest);
  assert.equal(await client.get(snapshotKey(id)), 'synthetic orphan sidecar');
  assert.equal(await client.xLen(eventsKey(id)), 1);
  for (const key of insertedKeys) {
    const ttl = await client.pTTL(key);
    assert.ok(ttl > 0 && ttl <= 6_000, 'cold sentinel mutation must not extend any newly created key');
  }
});

test('every mutation declares all four keys explicitly', async () => {
  const mutated = calls.filter((call) => mutation.test(call.script));
  assert.ok(mutated.length > 0);
  for (const call of mutated) {
    const tag = mutation.exec(call.script)?.[0];
    assert.equal(call.keys.length, 4, `${tag}: mutation must declare state/events/request/snapshot`);
    assert.ok(call.keys[0]!.endsWith(':state'), `${tag}: state key must be KEYS[1]`);
    const base = call.keys[0]!.slice(0, -':state'.length);
    assert.equal(call.keys[1], `${base}:events`);
    assert.ok(call.keys[2]!.startsWith(`mahoshojo:gen:v1:${keyPrefix}:req:`)
      || (call.keys[2] === call.keys[0] && call.missingState === true));
    assert.equal(call.keys[3], `${base}:snapshot`);
  }
  for (const call of calls.filter((entry) => entry.script.includes('GEN_RESERVE_'))) {
    assert.equal(call.keys.length, 3, 'reserve explicitly declares request, state and orphan sidecar');
    assert.ok(call.keys[0]!.startsWith(`mahoshojo:gen:v1:${keyPrefix}:req:`));
    assert.ok(call.keys[1]!.endsWith(':state'));
    assert.equal(call.keys[2], `${call.keys[1]!.slice(0, -':state'.length)}:snapshot`);
  }
});

try {
  for (let attempt = 0; ; attempt += 1) {
    if (serverError) throw serverError;
    if (server.exitCode !== null) throw new Error(`本地 Redis 提前退出：${server.exitCode}\n${serverLog}`);
    try { await client.connect(); break; } catch (error) {
      if (attempt >= 100) throw error;
      await delay(50);
    }
  }
  const info = await client.info('server');
  assert.equal(Number(/^process_id:(\d+)\r?$/mu.exec(info)?.[1]), server.pid, '拒绝对非本次启动的 Redis 执行验证');
  assert.equal((await client.configGet('save')).save, '');
  assert.equal((await client.configGet('appendonly')).appendonly, 'no');
  console.log(JSON.stringify({
    kind: 'environment', redisVersion: /^redis_version:(.+)$/mu.exec(info)?.[1]?.trim(),
    transport: 'private-loopback-tcp', persistence: 'disabled', productionData: false,
  }));
  const failures: string[] = [];
  for (const [name, run] of tests) {
    try {
      await run();
      console.log(JSON.stringify({ kind: 'pass', test: name }));
    } catch (error) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      failures.push(`${name}: ${detail}`);
      console.error(JSON.stringify({ kind: 'fail', test: name, detail }));
    } finally {
      beforeEval = null;
      afterEval = null;
      beforeXRead = null;
    }
  }
  console.log(JSON.stringify({
    kind: 'summary', passed: tests.length - failures.length, failed: failures.length,
    rollback: 'Disabling creation keeps existing v2 records readable and writable; an old binary without v2 readers is not a compatible rollback.',
    reserved: 'A reserved v2 record has snapshotMeta=null and no sidecar until its first snapshot; absence alone is not corruption.',
  }));
  assert.equal(failures.length, 0, failures.join('\n'));
} finally {
  beforeEval = null;
  afterEval = null;
  beforeXRead = null;
  if (client.isOpen) client.destroy();
  server.kill('SIGTERM');
  const killTimeout = setTimeout(() => server.kill('SIGKILL'), 2_000);
  killTimeout.unref();
  await serverExit;
  clearTimeout(killTimeout);
  await rm(directory, { recursive: true, force: true });
}
