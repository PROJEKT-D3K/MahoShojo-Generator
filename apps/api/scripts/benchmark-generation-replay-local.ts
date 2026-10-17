import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from 'redis';

import {
  createRedisGenerationReplayStore,
  type RedisGenerationClient,
} from '../src/redis/generation-replay-store';

// This harness starts its own loopback-only server. It never consumes REDIS_URL.
// A per-run random password and PID check prevent a port race from reaching an
// unrelated instance. All fixtures are synthetic and disposable.
const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary) || process.argv.length !== 3) {
  throw new Error('用法：node --import tsx scripts/benchmark-generation-replay-local.ts /absolute/path/to/redis-server');
}
const portReservation = createServer();
portReservation.listen(0, '127.0.0.1');
await once(portReservation, 'listening');
const address = portReservation.address();
assert.ok(address && typeof address === 'object');
const port = address.port;
await new Promise<void>((resolve, reject) => {
  portReservation.close((error) => error ? reject(error) : resolve());
});
const password = randomBytes(32).toString('hex');
const directory = await mkdtemp(path.join(tmpdir(), 'maho-replay-bench-'));
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
const now = '2026-01-01T00:00:00.000Z';
const leaseExpiresAt = '2027-01-01T00:00:00.000Z';
let evalRequestBytes = 0;
let snapshotArgumentBytes = 0;
let scriptTransport: 'eval' | 'evalsha' = 'eval';
const loadedScripts = new Set<string>();
const respBytes = (parts: string[]): number => Buffer.byteLength(`*${parts.length}\r\n`)
  + parts.reduce((total, part) => {
    const bytes = Buffer.byteLength(part);
    return total + Buffer.byteLength(`$${bytes}\r\n`) + bytes + 2;
  }, 0);
const wrapped: RedisGenerationClient = {
  eval: async (script, options) => {
    const sha = createHash('sha1').update(script).digest('hex');
    if (scriptTransport === 'evalsha' && !loadedScripts.has(sha)) {
      await client.scriptLoad(script);
      loadedScripts.add(sha);
    }
    evalRequestBytes += respBytes([
      scriptTransport.toUpperCase(), scriptTransport === 'eval' ? script : sha,
      String(options.keys.length), ...options.keys, ...options.arguments,
    ]);
    if (script.includes('GEN_SNAPSHOT_V1')) {
      snapshotArgumentBytes += Buffer.byteLength(options.arguments[1]!);
    }
    return scriptTransport === 'eval' ? client.eval(script, options) : client.evalSha(sha, options);
  },
  get: (key) => client.get(key),
  xRead: async () => { throw new Error('基准不运行订阅读取'); },
};
const store = createRedisGenerationReplayStore({ getClient: () => wrapped, keyPrefix: 'localbench' });
const stateKey = (id: string): string => `mahoshojo:gen:v1:localbench:${id}:state`;
const eventKey = (id: string): string => `mahoshojo:gen:v1:localbench:${id}:events`;
const snapshot = (markdown: string, lastEventId: string | null) => ({
  status: 'running' as const, markdown, reasoning: '', lastEventId, updatedAt: now,
  telemetry: null, terminalResultRef: null,
});
const reserve = async (generationId: string) => {
  await store.reserve({
    generationId, actorKey: 'anonymous:synthetic', generationRequestId: generationId,
    payloadHash: 'synthetic', producerToken: generationId, now, leaseExpiresAt,
  });
  assert.equal((await store.markRunning({
    generationId, producerToken: generationId, now, leaseExpiresAt,
  })).owned, true);
};
const evalStats = async () => {
  const info = await client.info('commandstats');
  const match = new RegExp(`^cmdstat_${scriptTransport}:calls=(\\d+),usec=(\\d+),`, 'mu').exec(info);
  return { calls: Number(match?.[1] ?? 0), usec: Number(match?.[2] ?? 0) };
};
const summarize = (samples: number[]) => {
  const ordered = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * p) - 1)]!;
  return { p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: ordered.at(-1)! };
};

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
  assert.equal(Number(/^process_id:(\d+)\r?$/mu.exec(info)?.[1]), server.pid, '拒绝对非本次启动的Redis执行基准');
  console.log(JSON.stringify({
    kind: 'environment', redisVersion: /^redis_version:(.+)$/mu.exec(info)?.[1]?.trim(),
    transport: 'private-loopback-tcp', persistence: 'disabled', productionData: false,
    caveat: '本地合成微基准，不是生产延迟或完整分离实现的正确性/容量证明',
  }));

  // Both groups execute the exact production append Lua. The small-state control
  // keeps the same content in a separate fixture key, isolating embedded-JSON cost.
  // It intentionally is NOT a deployable adapter or a migration implementation.
  for (const transport of ['eval', 'evalsha'] as const) {
    scriptTransport = transport;
    for (const bodyBytes of [0, 64 * 1024, 256 * 1024, 1024 * 1024, 2 * 1024 * 1024 - 1024]) {
      for (const layout of ['inline', 'small-state-control'] as const) {
        const generationId = `${transport.padEnd(7, '_')}-${layout}-${bodyBytes}`;
        await reserve(generationId);
        const value = snapshot('x'.repeat(bodyBytes), null);
        if (layout === 'inline') {
          assert.equal((await store.writeSnapshot({
            generationId, producerToken: generationId, snapshot: value, now,
          })).owned, true);
        } else {
          await client.set(`${stateKey(generationId)}:synthetic-snapshot`, JSON.stringify(value), { PX: 3_600_000 });
        }
        // Warm up cjson and the script cache before recording server CPU and RTT.
        for (let index = 0; index < 8; index += 1) {
          await store.appendEvents({ generationId, producerToken: generationId, now,
            events: [{ type: 'markdown', data: { chunk: 'x'.repeat(512) } }],
          });
        }
        evalRequestBytes = 0;
        const before = await evalStats();
        const durations: number[] = [];
        for (let index = 0; index < 64; index += 1) {
          const started = performance.now();
          const result = await store.appendEvents({
            generationId, producerToken: generationId, now,
            events: [{ type: 'markdown', data: { chunk: 'x'.repeat(512) } }],
          });
          assert.equal(result.owned, true);
          durations.push(performance.now() - started);
        }
        const after = await evalStats();
        const storedBytes = await client.strLen(stateKey(generationId));
        assert.equal(after.calls - before.calls, durations.length);
        assert.equal(await client.xLen(eventKey(generationId)), durations.length + 8);
        assert.ok(await client.pTTL(stateKey(generationId)) > 0);
        console.log(JSON.stringify({
          kind: 'append-size-scaling', transport, layout, bodyBytes, calls: durations.length,
          serverEvalMeanUs: (after.usec - before.usec) / durations.length,
          ...summarize(durations), evalRequestBytes,
          stateSetValueBytesPerAppend: storedBytes,
          note: 'SET值字节来自测后STRLEN；不包含Redis分配/复制协议、AOF或副本实测',
        }));
      }
    }
  }
  // Explicit synthetic snapshot policy, driven by virtual 100ms chunk arrival.
  // The measured operation is real, but no sleep or provider/network is modeled.
  for (const chunks of [256, 512]) {
    for (const transport of ['eval', 'evalsha'] as const) {
      scriptTransport = transport;
      const generationId = `growing-${chunks}-${transport.padEnd(7, '_')}`;
      await reserve(generationId);
      evalRequestBytes = 0;
      snapshotArgumentBytes = 0;
      let markdown = '';
      let pendingSnapshotBytes = 0;
      let lastSnapshotMs: number | null = null;
      let snapshots = 0;
      let storedSnapshotBytes = 0;
      let embeddedSnapshotRewriteBytes = 0;
      let lastEventId: string | null = null;
      let snapshotCursor: string | null = null;
      const before = await evalStats();
      for (let index = 0; index < chunks; index += 1) {
        markdown += 'x'.repeat(512);
        const result = await store.appendEvents({
          generationId, producerToken: generationId, now,
          events: [{ type: 'markdown', data: { chunk: 'x'.repeat(512) } }],
        });
        assert.equal(result.owned, true);
        lastEventId = result.events.at(-1)!.id;
        embeddedSnapshotRewriteBytes += storedSnapshotBytes;
        pendingSnapshotBytes += 512;
        const virtualMs = index * 100;
        if (lastSnapshotMs === null || virtualMs - lastSnapshotMs >= 250 || pendingSnapshotBytes >= 4096) {
          const value = snapshot(markdown, lastEventId);
          assert.equal((await store.writeSnapshot({
            generationId, producerToken: generationId, now, snapshot: value,
          })).owned, true);
          snapshotCursor = lastEventId;
          storedSnapshotBytes = Buffer.byteLength(JSON.stringify(value));
          snapshots += 1;
          pendingSnapshotBytes = 0;
          lastSnapshotMs = virtualMs;
        }
      }
      const after = await evalStats();
      const readback = await store.readState({ generationId });
      assert.equal(readback?.lastEventId, lastEventId);
      assert.equal(readback?.snapshot?.lastEventId, snapshotCursor);
      assert.ok(markdown.startsWith(readback!.snapshot!.markdown));
      console.log(JSON.stringify({
        kind: 'growing-synthetic-policy', transport, chunks, chunkBytes: 512, virtualChunkIntervalMs: 100,
        snapshotFlushIntervalMs: 250, snapshotFlushBytes: 4096,
        scope: 'append-and-running-snapshots-only; excludes setup, terminal, subscribers and replies',
        finalBodyBytes: Buffer.byteLength(markdown), snapshots, evalCalls: after.calls - before.calls,
        serverEvalTotalUs: after.usec - before.usec, evalRequestBytes, snapshotArgumentBytes,
        embeddedSnapshotRewriteBytesEstimate: embeddedSnapshotRewriteBytes,
        independentSnapshotSameCadenceArgumentBytes: snapshotArgumentBytes,
        note: '拆key只消除append复制旧snapshot；相同节奏继续发送全量snapshot时，客户端上传字节不下降，仍为平方增长',
      }));
    }
  }
} finally {
  if (client.isOpen) client.destroy();
  server.kill('SIGTERM');
  const killTimeout = setTimeout(() => server.kill('SIGKILL'), 2_000);
  killTimeout.unref();
  await serverExit;
  clearTimeout(killTimeout);
  await rm(directory, { recursive: true, force: true });
}
