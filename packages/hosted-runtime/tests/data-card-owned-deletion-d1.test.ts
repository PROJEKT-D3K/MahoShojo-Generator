import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { createDrizzleDb, type AppDrizzleDb } from '../src/db/drizzle';
import {
  assertOwnedDeletionSchema, getOwnedDeletionVersion, purgeOwnedCardsAtomically, readOwnedDeletionSnapshot,
  softDeleteOwnedCardAtomically,
} from '../src/db/data-card-owned-deletion';
import type { AdminDatabase } from '../src/admin/database';
import { validateD1ReturningResult } from '../src/d1-http-client';

const create = `CREATE TABLE data_cards (
 id TEXT PRIMARY KEY,user_id INTEGER,type TEXT,name TEXT,description TEXT,data TEXT,is_public INTEGER,
 public_since TEXT,review_status TEXT,is_recommended INTEGER,created_at TEXT,updated_at TEXT,deleted_at TEXT
)`;
const pending = `CREATE TABLE data_card_updates (
 id TEXT PRIMARY KEY,data_card_id TEXT UNIQUE REFERENCES data_cards(id) ON DELETE CASCADE,
 user_id INTEGER,name TEXT,description TEXT,data TEXT,created_at TEXT,updated_at TEXT
)`;
describe('confirmed deletion native D1 atomicity', () => {
  let runtime: Miniflare; let native: AdminDatabase; let db: AppDrizzleDb;
  beforeAll(async () => {
    runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'owned-delete-fixture', modules: true,
      script: 'export default { fetch() { return new Response("fixture"); } };',
      compatibilityDate: '2026-08-01', d1Databases: ['DB'] }] }));
    native = await runtime.getD1Database('DB') as unknown as AdminDatabase; db = createDrizzleDb(native);
    const migration = readFileSync(new URL('../../../drizzle/0019_data_card_recycle_generation.sql', import.meta.url), 'utf8');
    await native.batch([create, pending, ...migration.split('--> statement-breakpoint')].map((query) => native.prepare(query)));
    await assertOwnedDeletionSchema(db);
  }, 30_000);
  beforeEach(async () => {
    await native.prepare('DROP TRIGGER IF EXISTS deny_delete').run();
    await native.prepare('DELETE FROM data_cards').run();
    await native.prepare(`INSERT INTO data_cards(id,user_id,type,name,data,is_public,updated_at,deleted_at)
      VALUES ('a',7,'character','活动','{}',0,'same-second',NULL),
      ('r1',7,'scenario','墓碑一','{}',1,'same-second','same-second'),
      ('r2',7,'questionnaire','墓碑二','{}',0,'same-second','same-second')`).run();
  });
  afterAll(async () => { await runtime?.dispose(); });
  const read = (id: string, scope: 'active' | 'recycle' = 'recycle') => readOwnedDeletionSnapshot(db, 7, id, scope);
  const snapshots = async () => [(await read('r1'))!, (await read('r2'))!];

  it('materializes the set guard once and deletes both confirmed rows plus dependent records', async () => {
    await native.prepare("INSERT INTO data_card_updates VALUES ('p','r1',7,NULL,NULL,'{}',NULL,NULL)").run();
    const rows = await snapshots();
    expect((await purgeOwnedCardsAtomically(db, 7, rows, 'recycle')).sort()).toEqual(['r1', 'r2']);
    expect(await native.prepare('SELECT COUNT(*) AS n FROM data_card_updates').first()).toEqual({ n: 0 });
    expect(await read('a', 'active')).not.toBeNull();
  });
  it('native D1 reports strict zero, triggered and cascading RETURNING receipts without assuming count equality', async () => {
    const zero = await native.prepare("DELETE FROM data_cards WHERE id='absent' RETURNING id").all();
    expect(validateD1ReturningResult(zero)).toMatchObject({ results: [], meta: { changes: 0 } });
    const triggered = await native.prepare("UPDATE data_cards SET deleted_at='same-second' WHERE id='a' RETURNING id").all();
    expect(validateD1ReturningResult(triggered).results).toEqual([{ id: 'a' }]);
    expect(triggered.meta!.changes).toBeGreaterThanOrEqual(1);
    await native.prepare("INSERT INTO data_card_updates VALUES ('p','r1',7,NULL,NULL,'{}',NULL,NULL)").run();
    const cascade = await native.prepare("DELETE FROM data_cards WHERE id='r1' RETURNING id").all();
    expect(validateD1ReturningResult(cascade).results).toEqual([{ id: 'r1' }]);
    expect(cascade.meta!.changes).toBeGreaterThanOrEqual(1);
    expect(await native.prepare('SELECT COUNT(*) AS n FROM data_card_updates').first()).toEqual({ n: 0 });
  });
  it('refuses all members if one has a same-second pending or body change', async () => {
    const rows = await snapshots();
    await native.prepare("UPDATE data_cards SET data='changed' WHERE id='r2'").run();
    expect(await purgeOwnedCardsAtomically(db, 7, rows, 'recycle')).toEqual([]);
    expect(await read('r1')).not.toBeNull(); expect(await read('r2')).not.toBeNull();
  });
  it('old writer trigger prevents same-second ABA, while explicit new generation and restore retain identity correctly', async () => {
    const old = (await read('r1'))!;
    await native.prepare("UPDATE data_cards SET deleted_at=NULL WHERE id='r1'").run();
    await native.prepare("UPDATE data_cards SET deleted_at='same-second' WHERE id='r1'").run();
    const current = (await read('r1'))!;
    expect(await getOwnedDeletionVersion(current)).not.toBe(await getOwnedDeletionVersion(old));
    expect(await purgeOwnedCardsAtomically(db, 7, [old], 'recycle')).toEqual([]);
    const active = (await read('a', 'active'))!;
    expect(await softDeleteOwnedCardAtomically(db, 7, active, 5)).toEqual(['a']);
    const generation = JSON.parse((await read('a'))!.metadata).at(-1);
    expect(generation).toMatch(/^[a-f0-9-]{36}$/);
    await native.prepare("UPDATE data_cards SET deleted_at=NULL WHERE id='a'").run();
    expect(JSON.parse((await read('a', 'active'))!.metadata).at(-1)).toBe(generation);
    expect(await purgeOwnedCardsAtomically(db, 7, [active], 'active')).toEqual([]);
  });
  it('continuation target and projected capacity prevent an unnecessary irreversible clear', async () => {
    const rows = await snapshots(); const active = (await read('a', 'active'))!;
    expect(await purgeOwnedCardsAtomically(db, 7, rows, 'recycle', { target: active, limit: 0 })).toEqual([]);
    await native.prepare("INSERT INTO data_cards(id,user_id,type,name,data,deleted_at) VALUES ('late',7,'history','新到','{}','same-second')").run();
    expect(await purgeOwnedCardsAtomically(db, 7, rows, 'recycle', { target: active, limit: 1 })).toEqual([]);
    await native.prepare("UPDATE data_cards SET name='changed' WHERE id='a'").run();
    expect(await purgeOwnedCardsAtomically(db, 7, rows, 'recycle', { target: active, limit: 5 })).toEqual([]);
    expect((await purgeOwnedCardsAtomically(db, 7, rows, 'recycle')).sort()).toEqual(['r1', 'r2']);
    expect(await read('late')).not.toBeNull();
  });
  it('ABORT rolls back earlier rows and their cascade effects', async () => {
    await native.prepare("INSERT INTO data_card_updates VALUES ('p','r1',7,NULL,NULL,'{}',NULL,NULL)").run();
    const rows = await snapshots();
    await native.prepare("CREATE TRIGGER deny_delete BEFORE DELETE ON data_cards WHEN OLD.id='r2' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END").run();
    await expect(purgeOwnedCardsAtomically(db, 7, rows, 'recycle')).rejects.toThrow();
    expect(await read('r1')).not.toBeNull(); expect(await read('r2')).not.toBeNull();
    expect(await native.prepare('SELECT COUNT(*) AS n FROM data_card_updates').first()).toEqual({ n: 1 });
  });
  it('accepts sixteen-target set with continuation below D1 actual parameter limits', async () => {
    for (let i = 3; i <= 16; i++) await native.prepare("INSERT INTO data_cards(id,user_id,type,name,data,deleted_at) VALUES (?,7,'history','卡',?,'same-second')").bind(`r${i}`, 'x'.repeat(32_768)).run();
    const rows = []; for (let i = 1; i <= 16; i++) rows.push((await read(`r${i}`))!);
    expect(await purgeOwnedCardsAtomically(db, 7, rows, 'recycle', { target: (await read('a', 'active'))!, limit: 5 })).toHaveLength(16);
  });
  it('binds two large bodies separately rather than constructing a too-large JSON parameter', async () => {
    const body = 'x'.repeat(1_100_000);
    await native.prepare("UPDATE data_cards SET data=? WHERE id='r1'").bind(body).run();
    await native.prepare("INSERT INTO data_card_updates VALUES ('p','r1',7,NULL,NULL,?,NULL,NULL)").bind(body).run();
    const row = (await read('r1'))!;
    expect(row.data.length + row.pending_data!.length).toBe(2_200_000);
    expect(await purgeOwnedCardsAtomically(db, 7, [row], 'recycle')).toEqual(['r1']);
  });
});
