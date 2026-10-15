import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { AppDrizzleDb } from '@/lib/db/drizzle';
import { getOwnedReplacementVersion, readOwnedReplacementSnapshot, updateOwnedDataCardMetadataAtomically } from '@/lib/db/repositories/data-card-owned-replacement';
import { approvePendingPublicCardIfUnchanged } from '@/lib/db/repositories/data-card-review';
import * as schema from '@/lib/db/schema';

let sqlite: Database;
let db: AppDrizzleDb;
const body = '{ "nativeAllowed": true, "signature": "keep-exact", "nested": { "x": 1 } }';
const metadata = { name: '新名称', description: '新描述', isPublic: 1 as const };
const read = () => readOwnedReplacementSnapshot(db, 'c', 7);
const pending = () => sqlite.exec(`INSERT INTO data_card_updates VALUES ('p','c',7,'待审名',NULL,'{"signature":"pending-exact"}',NULL,'same-second')`);
const state = () => ({ cards: sqlite.prepare('SELECT * FROM data_cards').all(), pending: sqlite.prepare('SELECT * FROM data_card_updates').all() });
beforeEach(() => {
  sqlite = new Database(':memory:'); db = drizzle(sqlite, { schema }) as unknown as AppDrizzleDb;
  sqlite.exec(`CREATE TABLE data_cards (id TEXT PRIMARY KEY,user_id INTEGER,type TEXT,name TEXT,description TEXT,data TEXT,
    is_public INTEGER,public_since TEXT,review_status TEXT,updated_at TEXT,deleted_at TEXT,favorite_count INTEGER,usage_count INTEGER);
    CREATE TABLE data_card_updates (id TEXT PRIMARY KEY,data_card_id TEXT UNIQUE,user_id INTEGER,name TEXT,description TEXT,data TEXT,created_at TEXT,updated_at TEXT);`);
  sqlite.prepare("INSERT INTO data_cards VALUES ('c',7,'questionnaire','名称',NULL,?,0,NULL,'pending','same-second',NULL,0,0)").run(body);
});
afterEach(() => sqlite.close());

describe('owned metadata real SQLite CAS', () => {
  test('updates only metadata and derived timestamps, preserving original bytes and pending rows', async () => {
    pending(); const snapshot = (await read())!;
    const pendingBefore = state().pending;
    expect(await updateOwnedDataCardMetadataAtomically(db, snapshot, metadata)).toBe(true);
    expect(sqlite.prepare('SELECT name,description,is_public,data,type,review_status FROM data_cards').get()).toEqual({
      name: metadata.name, description: metadata.description, is_public: 1, data: body, type: 'questionnaire', review_status: 'pending',
    });
    expect(state().pending).toEqual(pendingBefore);
    expect(await updateOwnedDataCardMetadataAtomically(db, snapshot, { ...metadata, name: '过期' })).toBe(false);
  });
  test.each([
    [0, 1, null, 'now'], [1, 0, 'published', null], [1, -1, 'published', null],
    [1, 1, 'published', 'published'], [0, 0, null, null], [-1, -1, null, null],
    [-1, 0, null, null], [-1, 1, null, null],
  ] as const)('visibility %s -> %s keeps the original public_since semantics', async (before, requested, since, expected) => {
    sqlite.prepare('UPDATE data_cards SET is_public=?, public_since=?').run(before, since);
    expect(await updateOwnedDataCardMetadataAtomically(db, (await read())!, { ...metadata, isPublic: requested })).toBe(true);
    const result = sqlite.prepare('SELECT is_public,public_since,updated_at FROM data_cards').get() as { is_public: number; public_since: string | null; updated_at: string };
    expect(result.is_public).toBe(before === -1 ? -1 : requested);
    expect(result.public_since).toBe(expected === 'now' ? result.updated_at : expected);
  });
  test.each([
    `UPDATE data_cards SET name='其他名称'`, `UPDATE data_cards SET description=''`,
    `UPDATE data_cards SET data='{"signature":"other"}'`, `UPDATE data_cards SET type='character'`,
    `UPDATE data_cards SET user_id=8`, `UPDATE data_cards SET is_public=-1`,
    `UPDATE data_cards SET review_status='approved'`, `UPDATE data_cards SET review_status='rejected'`,
    `UPDATE data_cards SET updated_at='new-time'`, `UPDATE data_cards SET deleted_at='deleted'`, `DELETE FROM data_cards`,
    `INSERT INTO data_card_updates VALUES ('p','c',7,'pending',NULL,'{}',NULL,NULL)`,
  ])('same-second concurrent main/absence change refuses the entire write: %s', async (mutation) => {
    const snapshot = (await read())!; sqlite.exec(mutation); const before = state();
    expect(await updateOwnedDataCardMetadataAtomically(db, snapshot, metadata)).toBe(false);
    expect(state()).toEqual(before);
  });
  test.each([
    `DELETE FROM data_card_updates`, `UPDATE data_card_updates SET id='other'`,
    `UPDATE data_card_updates SET user_id=8`, `UPDATE data_card_updates SET name='other'`,
    `UPDATE data_card_updates SET description=''`, `UPDATE data_card_updates SET data='{}'`,
    `UPDATE data_card_updates SET created_at='other'`, `UPDATE data_card_updates SET updated_at='other'`,
  ])('concurrent existing pending changes refuse the entire write: %s', async (mutation) => {
    pending(); const snapshot = (await read())!; const version = await getOwnedReplacementVersion(snapshot);
    sqlite.exec(mutation); const before = state();
    expect(await getOwnedReplacementVersion((await read())!)).not.toBe(version);
    expect(await updateOwnedDataCardMetadataAtomically(db, snapshot, metadata)).toBe(false);
    expect(state()).toEqual(before);
  });
  test('engagement changes do not invalidate edits and remain intact', async () => {
    const snapshot = (await read())!; sqlite.exec('UPDATE data_cards SET favorite_count=9,usage_count=11');
    expect(await updateOwnedDataCardMetadataAtomically(db, snapshot, metadata)).toBe(true);
    expect(sqlite.prepare('SELECT favorite_count,usage_count FROM data_cards').get()).toEqual({ favorite_count: 9, usage_count: 11 });
  });
  test('actual main-card review and metadata writes guard each other in both orders', async () => {
    sqlite.exec('UPDATE data_cards SET is_public=1');
    const snapshot = (await read())!;
    const reviewSnapshot = { id: snapshot.id, name: snapshot.name, description: snapshot.description, data: snapshot.data, type: snapshot.type, updatedAt: snapshot.updated_at };
    expect(await approvePendingPublicCardIfUnchanged(db, 7, reviewSnapshot)).toBe(true);
    expect(await updateOwnedDataCardMetadataAtomically(db, snapshot, metadata)).toBe(false);
    sqlite.exec("UPDATE data_cards SET review_status='pending'");
    const current = (await read())!;
    expect(await updateOwnedDataCardMetadataAtomically(db, current, metadata)).toBe(true);
    expect(await approvePendingPublicCardIfUnchanged(db, 7, { ...reviewSnapshot, updatedAt: current.updated_at })).toBe(false);
    expect((await read())!.data).toBe(body);
  });
  test('one bounded D1 statement uses RETURNING and never SETs content or review fields', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const d1 = drizzleD1({ prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({
      all: async () => { queries.push({ sql, params }); return { success: true, results: sqlite.prepare(sql).all(...params) }; },
    }) }) } as never, { schema });
    expect(await updateOwnedDataCardMetadataAtomically(d1, (await read())!, metadata)).toBe(true);
    expect(queries).toHaveLength(1); expect(queries[0].params.length).toBeLessThan(100);
    const set = queries[0].sql.split('WHERE')[0];
    expect(set).not.toMatch(/\b(data|type|review_status)\s*=/); expect(set).toContain('public_since');
  });
  test('a failed constraint leaves metadata, original content and pending rows intact', async () => {
    pending(); const snapshot = (await read())!; const before = state();
    sqlite.exec("CREATE TRIGGER fail_metadata BEFORE UPDATE ON data_cards BEGIN SELECT RAISE(ABORT, 'fail'); END;");
    await expect(updateOwnedDataCardMetadataAtomically(db, snapshot, metadata)).rejects.toThrow();
    expect(state()).toEqual(before);
  });
  test.each([
    `UPDATE data_cards SET name='concurrent'`,
    `UPDATE data_cards SET review_status='approved'`,
    `UPDATE data_cards SET is_public=-1`,
    `UPDATE data_cards SET deleted_at='deleted'`,
    `DELETE FROM data_cards`,
    `UPDATE data_card_updates SET data='{"signature":"new-pending"}'`,
    `DELETE FROM data_card_updates`,
  ])('a second SQLite connection can change the snapshot before the metadata writer: %s', async (mutation) => {
    pending();
    const dir = mkdtempSync(join(tmpdir(), 'metadata-interleave-'));
    const path = join(dir, 'race.sqlite'); writeFileSync(path, sqlite.serialize());
    const left = new Database(path); const right = new Database(path);
    const leftDb = drizzle(left, { schema }) as unknown as AppDrizzleDb;
    try {
      const snapshot = (await readOwnedReplacementSnapshot(leftDb, 'c', 7))!;
      right.exec(mutation);
      const cards = right.prepare('SELECT * FROM data_cards').all();
      const updates = right.prepare('SELECT * FROM data_card_updates').all();
      expect(await updateOwnedDataCardMetadataAtomically(leftDb, snapshot, metadata)).toBe(false);
      expect(left.prepare('SELECT * FROM data_cards').all()).toEqual(cards);
      expect(left.prepare('SELECT * FROM data_card_updates').all()).toEqual(updates);
    } finally { left.close(); right.close(); rmSync(dir, { recursive: true }); }
  });
  test('simultaneous worker connections allow exactly one claimant of the same real SQLite snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metadata-cas-'));
    const path = join(dir, 'race.sqlite'); writeFileSync(path, sqlite.serialize());
    const gate = new SharedArrayBuffer(4);
    const workers: Worker[] = [];
    const modulePath = createRequire(import.meta.url).resolve('better-sqlite3');
    const concurrentDb = () => drizzleD1({ prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({
      all: () => new Promise((resolve, reject) => {
        const worker = new Worker(`
          const { parentPort, workerData } = require('node:worker_threads');
          const Database = require(workerData.modulePath);
          const sqlite = new Database(workerData.path);
          sqlite.pragma('busy_timeout = 5000');
          const gate = new Int32Array(workerData.gate);
          Atomics.add(gate, 0, 1); Atomics.notify(gate, 0);
          while (Atomics.load(gate, 0) < 2) Atomics.wait(gate, 0, 1);
          try { parentPort.postMessage({ success: true, results: sqlite.prepare(workerData.sql).all(...workerData.params) }); }
          finally { sqlite.close(); }
        `, { eval: true, workerData: { sql, params, path, gate, modulePath } });
        workers.push(worker); worker.once('message', resolve); worker.once('error', reject);
      }),
    }) }) } as never, { schema });
    try {
      const snapshot = (await read())!;
      const results = await Promise.all([
        updateOwnedDataCardMetadataAtomically(concurrentDb(), snapshot, metadata),
        updateOwnedDataCardMetadataAtomically(concurrentDb(), snapshot, { ...metadata, name: '另一编辑' }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const result = new Database(path);
      try {
        expect(result.prepare('SELECT name,data,type FROM data_cards').get()).toEqual({
          name: results[0] ? metadata.name : '另一编辑', data: body, type: 'questionnaire',
        });
      } finally { result.close(); }
    } finally { await Promise.all(workers.map((worker) => worker.terminate())); rmSync(dir, { recursive: true }); }
  });
});
