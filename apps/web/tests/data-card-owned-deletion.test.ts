import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { AppDrizzleDb } from '@/lib/db/drizzle';
import {
  getOwnedDeletionVersion, listOwnedRecycleDeletionIds, purgeOwnedCardsAtomically,
  readOwnedDeletionSnapshot, softDeleteOwnedCardAtomically,
} from '@/lib/db/repositories/data-card-owned-deletion';
import * as schema from '@/lib/db/schema';
import { createDeletionFixtureDb, deletionFixture, recycleMigration } from './helpers/owned-deletion-fixture';
let sqlite: InstanceType<typeof Database>;
let db: AppDrizzleDb;
const read = (id = 'r1', scope: 'active' | 'recycle' = 'recycle') => readOwnedDeletionSnapshot(db, 7, id, scope);
const remaining = () => sqlite.prepare('SELECT id FROM data_cards ORDER BY id').all();
beforeEach(() => {
  sqlite = new Database(':memory:'); sqlite.exec(deletionFixture); sqlite.exec(recycleMigration);
  db = createDeletionFixtureDb(sqlite);
});
afterEach(() => sqlite.close());

describe('confirmed deletion real SQLite CAS', () => {
  test('atomic set removes every confirmed target and cascades, leaving arrivals and other owners alone', async () => {
    sqlite.exec("INSERT INTO data_card_updates VALUES ('p','r1',7,'待审',NULL,'{}',NULL,NULL); INSERT INTO related VALUES ('relation','r2')");
    const rows = [(await read())!, (await read('r2'))!];
    sqlite.exec("INSERT INTO data_cards(id,user_id,type,name,data,deleted_at) VALUES ('new',7,'history','新到','{}','same-second')");
    expect((await purgeOwnedCardsAtomically(db, 7, rows, 'recycle')).sort()).toEqual(['r1', 'r2']);
    expect(remaining()).toEqual([{ id: 'a' }, { id: 'foreign' }, { id: 'new' }]);
    expect(sqlite.prepare('SELECT * FROM data_card_updates').all()).toEqual([]);
    expect(sqlite.prepare('SELECT * FROM related').all()).toEqual([]);
  });
  test.each([
    "UPDATE data_cards SET data='other' WHERE id='r2'", "UPDATE data_cards SET name='other' WHERE id='r2'",
    "UPDATE data_cards SET description='' WHERE id='r2'", "UPDATE data_cards SET is_public=-1 WHERE id='r2'",
    "UPDATE data_cards SET review_status='rejected' WHERE id='r2'", "UPDATE data_cards SET type='character' WHERE id='r2'",
    "UPDATE data_cards SET public_since='changed' WHERE id='r2'", "UPDATE data_cards SET is_recommended=1 WHERE id='r2'",
    "UPDATE data_cards SET created_at='changed' WHERE id='r2'", "UPDATE data_cards SET updated_at='changed' WHERE id='r2'",
    "UPDATE data_cards SET deleted_at=NULL WHERE id='r2'", "UPDATE data_cards SET user_id=8 WHERE id='r2'",
    "INSERT INTO data_card_updates VALUES ('p','r2',7,NULL,NULL,'{}',NULL,NULL)", "DELETE FROM data_cards WHERE id='r2'",
  ])('one changed member leaves the entire set untouched: %s', async (mutation) => {
    const rows = [(await read())!, (await read('r2'))!]; sqlite.exec(mutation);
    const before = remaining();
    expect(await purgeOwnedCardsAtomically(db, 7, rows, 'recycle')).toEqual([]);
    expect(remaining()).toEqual(before);
  });
  test.each(['id', 'data_card_id', 'user_id', 'name', 'description', 'data', 'created_at', 'updated_at'])('complete pending %s snapshot guards deletion', async (column) => {
    sqlite.exec("INSERT INTO data_card_updates VALUES ('p','r1',7,'待审',NULL,'{}',NULL,NULL)");
    const row = (await read())!;
    sqlite.exec(`UPDATE data_card_updates SET ${column}=${column === 'user_id' ? '8' : column === 'data_card_id' ? "'a'" : "'changed'"}`);
    expect(await purgeOwnedCardsAtomically(db, 7, [row], 'recycle')).toEqual([]);
  });
  test('null legacy tombstone and same-second old-A delete/restore/delete invalidate the old confirmation', async () => {
    const initial = (await read())!; const version = await getOwnedDeletionVersion(initial);
    expect(JSON.parse(initial.metadata).at(-1)).toBeNull();
    sqlite.exec("UPDATE data_cards SET deleted_at=NULL WHERE id='r1'; UPDATE data_cards SET deleted_at='same-second' WHERE id='r1'");
    const next = (await read())!;
    expect(JSON.parse(next.metadata).at(-1)).toMatch(/^[a-f0-9]{32}$/);
    expect(await getOwnedDeletionVersion(next)).not.toBe(version);
    expect(await purgeOwnedCardsAtomically(db, 7, [initial], 'recycle')).toEqual([]);
    sqlite.exec("UPDATE data_cards SET deleted_at=NULL WHERE id='r1'");
    const restored = (await read('r1', 'active'))!;
    expect(JSON.parse(restored.metadata).at(-1)).toBe(JSON.parse(next.metadata).at(-1));
    sqlite.exec("UPDATE data_cards SET deleted_at='same-second' WHERE id='r1'");
    expect(JSON.parse((await read())!.metadata).at(-1)).not.toBe(JSON.parse(next.metadata).at(-1));
    expect(await purgeOwnedCardsAtomically(db, 7, [next], 'recycle')).toEqual([]);
  });
  test('new explicit token survives trigger and restore, invalidating stale active confirmation after a roundtrip', async () => {
    const row = (await read('a', 'active'))!;
    expect(await softDeleteOwnedCardAtomically(db, 7, row, 5)).toEqual(['a']);
    const deleted = (await read('a'))!; expect(JSON.parse(deleted.metadata).at(-1)).toMatch(/^[0-9a-f-]{36}$/);
    sqlite.exec("UPDATE data_cards SET deleted_at=NULL WHERE id='a'");
    expect(JSON.parse((await read('a', 'active'))!.metadata).at(-1)).toBe(JSON.parse(deleted.metadata).at(-1));
    expect(await purgeOwnedCardsAtomically(db, 7, [row], 'active')).toEqual([]);
    expect(await softDeleteOwnedCardAtomically(db, 7, row, 5)).toEqual([]);
  });
  test('old writer RETURNING is not treated as the after-trigger generation', () => {
    const result = sqlite.prepare("UPDATE data_cards SET deleted_at='same-second' WHERE id='a' RETURNING recycle_generation").get();
    expect(result).toEqual({ recycle_generation: null });
    expect(sqlite.prepare("SELECT recycle_generation FROM data_cards WHERE id='a'").get()).toMatchObject({ recycle_generation: expect.stringMatching(/^[a-f0-9]{32}$/) });
  });
  test('counter changes do not invalidate content confirmation, and active purge stays a distinct operation', async () => {
    const row = (await read('a', 'active'))!; const version = await getOwnedDeletionVersion(row);
    sqlite.exec("UPDATE data_cards SET usage_count=8,like_count=3,favorite_count=4 WHERE id='a'");
    expect(await getOwnedDeletionVersion((await read('a', 'active'))!)).toBe(version);
    expect(await purgeOwnedCardsAtomically(db, 7, [row], 'active')).toEqual(['a']);
  });
  test('full atomic soft delete does not change any row', async () => {
    const row = (await read('a', 'active'))!;
    expect(await softDeleteOwnedCardAtomically(db, 7, row, 2)).toEqual([]);
    expect((await read('a', 'active'))).toEqual(row);
  });
  test('continuation CAS and projected capacity are checked before any irreversible deletion', async () => {
    const rows = [(await read())!, (await read('r2'))!]; const active = (await read('a', 'active'))!;
    expect(await purgeOwnedCardsAtomically(db, 7, rows, 'recycle', { target: active, limit: 0 })).toEqual([]);
    sqlite.exec("INSERT INTO data_cards(id,user_id,type,name,data,deleted_at) VALUES ('new',7,'history','新到','{}','same-second')");
    expect(await purgeOwnedCardsAtomically(db, 7, rows, 'recycle', { target: active, limit: 1 })).toEqual([]);
    sqlite.exec("UPDATE data_cards SET data='changed' WHERE id='a'");
    expect(await purgeOwnedCardsAtomically(db, 7, rows, 'recycle', { target: active, limit: 5 })).toEqual([]);
    expect(await purgeOwnedCardsAtomically(db, 7, rows, 'recycle')).toEqual(['r1', 'r2']);
  });
  test('continuation success retains the original active snapshot for the separate soft-delete stage', async () => {
    const rows = [(await read())!, (await read('r2'))!]; const active = (await read('a', 'active'))!;
    expect(await purgeOwnedCardsAtomically(db, 7, rows, 'recycle', { target: active, limit: 1 })).toEqual(['r1', 'r2']);
    expect(await softDeleteOwnedCardAtomically(db, 7, active, 1)).toEqual(['a']);
  });
  test('ABORT on a later member rolls back the whole set and cascades', async () => {
    sqlite.exec("INSERT INTO related VALUES ('relation','r1'); CREATE TRIGGER deny_delete BEFORE DELETE ON data_cards WHEN OLD.id='r2' BEGIN SELECT RAISE(ABORT, 'denied'); END");
    const rows = [(await read())!, (await read('r2'))!]; const before = remaining();
    await expect(purgeOwnedCardsAtomically(db, 7, rows, 'recycle')).rejects.toThrow();
    expect(remaining()).toEqual(before); expect(sqlite.prepare('SELECT * FROM related').all()).toHaveLength(1);
  });
  test('all sixteen targets with a continuation use one bounded D1-shaped statement', async () => {
    for (let i = 3; i <= 16; i++) sqlite.prepare("INSERT INTO data_cards(id,user_id,type,name,data,deleted_at) VALUES (?,7,'history','卡','{}','same-second')").run(`r${i}`);
    const ids = await listOwnedRecycleDeletionIds(db, 7);
    const rows = []; for (const id of ids) rows.push((await read(id))!);
    const queries: Array<{ text: string; params: unknown[] }> = [];
    const adapter = drizzleD1({ prepare: (text: string) => ({ bind: (...params: unknown[]) => ({ all: async () => {
      queries.push({ text, params }); const results = sqlite.prepare(text).all(...params);
      return { success: true, results, meta: { changes: (sqlite.prepare('SELECT changes() AS n').get() as { n: number }).n } };
    } }) }) } as never, { schema });
    expect(await purgeOwnedCardsAtomically(adapter, 7, rows, 'recycle', { target: (await read('a', 'active'))!, limit: 5 })).toHaveLength(16);
    expect(queries).toHaveLength(1); expect(queries[0].params.length).toBeLessThanOrEqual(100);
    expect(queries[0].text).toContain('AS MATERIALIZED');
  });
  test('sequential submissions on independent SQLite connections cannot reuse a confirmation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deletion-cas-')); const file = join(dir, 'db.sqlite'); writeFileSync(file, sqlite.serialize());
    const left = new Database(file); const right = new Database(file);
    try {
      const a = createDeletionFixtureDb(left); const b = createDeletionFixtureDb(right);
      const rows = [(await read())!, (await read('r2'))!];
      const outcomes = await Promise.all([purgeOwnedCardsAtomically(a, 7, rows, 'recycle'), purgeOwnedCardsAtomically(b, 7, rows, 'recycle')]);
      expect(outcomes.filter((ids) => ids.length === 2)).toHaveLength(1); expect(outcomes.filter((ids) => ids.length === 0)).toHaveLength(1);
    } finally { left.close(); right.close(); rmSync(dir, { recursive: true }); }
  });
  test('sequential submissions on independent connections cannot overfill the last recycle slot', async () => {
    sqlite.exec("INSERT INTO data_cards(id,user_id,type,name,data) VALUES ('b',7,'history','活动二','{}')");
    const dir = mkdtempSync(join(tmpdir(), 'deletion-capacity-')); const file = join(dir, 'db.sqlite'); writeFileSync(file, sqlite.serialize());
    const left = new Database(file); const right = new Database(file);
    try {
      const a = createDeletionFixtureDb(left); const b = createDeletionFixtureDb(right);
      const first = (await readOwnedDeletionSnapshot(a, 7, 'a', 'active'))!;
      const second = (await readOwnedDeletionSnapshot(b, 7, 'b', 'active'))!;
      const outcomes = await Promise.all([softDeleteOwnedCardAtomically(a, 7, first, 3), softDeleteOwnedCardAtomically(b, 7, second, 3)]);
      expect(outcomes.filter((ids) => ids.length === 1)).toHaveLength(1);
      expect(left.prepare('SELECT COUNT(*) AS n FROM data_cards WHERE user_id=7 AND deleted_at IS NOT NULL').get()).toEqual({ n: 3 });
    } finally { left.close(); right.close(); rmSync(dir, { recursive: true }); }
  });
  test.each(['purge', 'restore'] as const)('worker barrier overlaps set purge with %s on independent connections without partial deletion', async (competitor) => {
    const rows = [(await read())!, (await read('r2'))!];
    const dir = mkdtempSync(join(tmpdir(), 'deletion-worker-race-')); const file = join(dir, 'db.sqlite');
    writeFileSync(file, sqlite.serialize());
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT); const barrier = new Int32Array(gate);
    let readyCount = 0; let ready!: () => void;
    const bothReady = new Promise<void>((resolve) => { ready = resolve; });
    const workers = [0, 1].map(() => new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require(workerData.module); const db = new Database(workerData.file);
      db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000');
      parentPort.on('message', ({ text, params }) => {
        try {
          parentPort.postMessage({ ready: true });
          Atomics.wait(new Int32Array(workerData.gate), 0, 0);
          const results = db.prepare(text).all(...params);
          const { n } = db.prepare('SELECT changes() AS n').get();
          parentPort.postMessage({ receipt: { success: true, results, meta: { changes: n } } });
        } catch (error) { parentPort.postMessage({ error: String(error) }); }
      });
    `, { eval: true, workerData: { module: createRequire(import.meta.url).resolve('better-sqlite3'), file, gate } }));
    const execute = (worker: Worker, text: string, params: unknown[]) => new Promise<unknown>((resolve, reject) => {
      const cleanup = () => { worker.off('error', onError); worker.off('message', onMessage); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onMessage = (message: { ready?: boolean; error?: string; receipt?: unknown }) => {
        if (message.ready) { if (++readyCount === 2) ready(); return; }
        cleanup(); if (message.error) reject(new Error(message.error)); else resolve(message.receipt);
      };
      worker.on('error', onError); worker.on('message', onMessage); worker.postMessage({ text, params });
    });
    const connections = workers.map((worker) => drizzleD1({ prepare: (text: string) => ({ bind: (...params: unknown[]) => ({
      all: () => execute(worker, text, params),
    }) }) } as never, { schema }));
    try {
      const first = purgeOwnedCardsAtomically(connections[0], 7, rows, 'recycle');
      const second = competitor === 'purge' ? purgeOwnedCardsAtomically(connections[1], 7, rows, 'recycle')
        : execute(workers[1], "UPDATE data_cards SET deleted_at=NULL WHERE id='r1' AND user_id=7 AND deleted_at IS NOT NULL RETURNING id", [])
          .then((receipt) => (receipt as { results: Array<{ id: string }> }).results.map((row) => row.id));
      const outcomes = Promise.all([first, second]);
      await Promise.race([bothReady, outcomes]); expect(readyCount).toBe(2);
      Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0);
      const [purged, other] = await outcomes;
      const inspect = new Database(file);
      try {
        const remainingTargets = inspect.prepare("SELECT id, deleted_at FROM data_cards WHERE id IN ('r1','r2') ORDER BY id").all();
        if (purged.length === 2) {
          expect(purged.sort()).toEqual(['r1', 'r2']); expect(other).toEqual([]); expect(remainingTargets).toEqual([]);
        } else {
          expect(purged).toEqual([]);
          if (competitor === 'purge') { expect(other.sort()).toEqual(['r1', 'r2']); expect(remainingTargets).toEqual([]); }
          else { expect(other).toEqual(['r1']); expect(remainingTargets).toEqual([{ id: 'r1', deleted_at: null }, { id: 'r2', deleted_at: 'same-second' }]); }
        }
      } finally { inspect.close(); }
    } finally {
      Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0);
      await Promise.all(workers.map((worker) => worker.terminate())); rmSync(dir, { recursive: true });
    }
  });
  test('UTF-8 binding limits fail before writing, rather than silently truncating a snapshot', async () => {
    sqlite.prepare("UPDATE data_cards SET data=? WHERE id='r1'").run('云'.repeat(700_000));
    const row = (await read())!;
    await expect(getOwnedDeletionVersion(row)).rejects.toThrow('binding limit');
    await expect(purgeOwnedCardsAtomically(db, 7, [row], 'recycle')).rejects.toThrow('binding limit');
    expect(remaining()).toHaveLength(4);
  });
  test('missing migration fails closed without legacy fallback', async () => {
    sqlite.exec('DROP TRIGGER data_cards_recycle_generation; ALTER TABLE data_cards DROP COLUMN recycle_generation');
    await expect(read()).rejects.toThrow(); expect(remaining()).toHaveLength(4);
  });
});
