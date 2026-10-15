import { expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import * as schema from '@/lib/db/schema';
import { restoreDataCardByIdAndUser } from '@/lib/db/repositories/data-cards-core';
import { purgeOwnedCardsAtomically, readOwnedDeletionSnapshot } from '@/lib/db/repositories/data-card-owned-deletion';
import { createDeletionFixtureDb, deletionFixture, recycleMigration } from './helpers/owned-deletion-fixture';

test.each(['restore', 'confirmed-purge'] as const)('两个独立SQLite worker通过barrier争最后一槽/与B2删除竞争：%s', async (competitor) => {
  const dir = mkdtempSync(join(tmpdir(), 'restore-quota-race-'));
  const file = join(dir, 'db.sqlite');
  const inspect = new Database(file);
  inspect.exec(deletionFixture + recycleMigration);
  inspect.exec('CREATE TABLE users (id INTEGER PRIMARY KEY,slot_count INTEGER); INSERT INTO users VALUES (7,2)');
  const snapshots = await Promise.all(['r1', 'r2'].map((id) => readOwnedDeletionSnapshot(createDeletionFixtureDb(inspect), 7, id, 'recycle')));
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const barrier = new Int32Array(gate);
  let readyCount = 0; let ready!: () => void;
  const bothReady = new Promise<void>((resolve) => { ready = resolve; });
  const workers = [0, 1].map(() => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.module); const db = new Database(workerData.file);
    db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000');
    parentPort.on('message', ({ text, params }) => {
      try {
        if (!/^select /i.test(text)) {
          parentPort.postMessage({ ready: true });
          Atomics.wait(new Int32Array(workerData.gate), 0, 0);
        }
        const results = db.prepare(text).all(...params);
        const { n } = db.prepare('SELECT changes() AS n').get();
        parentPort.postMessage({ receipt: { success: true, results, meta: { changes: n } } });
      } catch (error) { parentPort.postMessage({ error: String(error) }); }
    });
  `, { eval: true, workerData: { module: createRequire(import.meta.url).resolve('better-sqlite3'), file, gate } }));
  type Receipt = { success: true; results: Record<string, unknown>[]; meta: { changes: number } };
  const execute = (worker: Worker, text: string, params: unknown[]) => new Promise<Receipt>((resolve, reject) => {
    const cleanup = () => { worker.off('error', onError); worker.off('message', onMessage); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onMessage = (message: { ready?: boolean; error?: string; receipt?: Receipt }) => {
      if (message.ready) { if (++readyCount === 2) ready(); return; }
      cleanup(); if (message.error) reject(new Error(message.error)); else resolve(message.receipt!);
    };
    worker.on('error', onError); worker.on('message', onMessage); worker.postMessage({ text, params });
  });
  const connections = workers.map((worker) => drizzle({ prepare: (text: string) => ({ bind: (...params: unknown[]) => ({
    all: () => execute(worker, text, params),
    raw: async () => (await execute(worker, text, params)).results.map(Object.values),
  }) }) } as never, { schema }));
  try {
    const restoring = restoreDataCardByIdAndUser(connections[0], 'r1', 7, 20);
    if (competitor === 'restore') {
      const outcomes = Promise.all([restoring, restoreDataCardByIdAndUser(connections[1], 'r2', 7, 20)]);
      await Promise.race([bothReady, outcomes]); expect(readyCount).toBe(2);
      Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0);
      expect((await outcomes).map((result) => result.status).sort()).toEqual(['quota_exceeded', 'restored']);
      expect(inspect.prepare('SELECT COUNT(*) AS n FROM data_cards WHERE user_id=7 AND deleted_at IS NULL').get()).toEqual({ n: 2 });
    } else {
      const outcomes = Promise.all([restoring, purgeOwnedCardsAtomically(connections[1], 7, snapshots.map((row) => row!), 'recycle')]);
      await Promise.race([bothReady, outcomes]); expect(readyCount).toBe(2);
      Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0);
      const [restored, deleted] = await outcomes;
      if (restored.status === 'restored') {
        expect(deleted).toEqual([]);
        expect(inspect.prepare("SELECT id,deleted_at FROM data_cards WHERE id IN ('r1','r2') ORDER BY id").all())
          .toEqual([{ id: 'r1', deleted_at: null }, { id: 'r2', deleted_at: 'same-second' }]);
      } else {
        expect(restored.status).toBe('not_found'); expect(deleted.sort()).toEqual(['r1', 'r2']);
        expect(inspect.prepare("SELECT id FROM data_cards WHERE id IN ('r1','r2')").all()).toEqual([]);
      }
    }
    expect(inspect.prepare("SELECT data FROM data_cards WHERE id='a'").get()).toEqual({ data: '{"source":1}' });
  } finally {
    Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0);
    await Promise.all(workers.map((worker) => worker.terminate()));
    inspect.close(); rmSync(dir, { recursive: true });
  }
});
