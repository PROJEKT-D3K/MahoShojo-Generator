import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { restoreDataCardByIdAndUser } from '@/lib/db/repositories/data-cards-core';
import { readOwnedDeletionSnapshot, getOwnedDeletionVersion } from '@/lib/db/repositories/data-card-owned-deletion';
import { createDeletionFixtureDb, deletionFixture, recycleMigration } from './helpers/owned-deletion-fixture';
let sqlite: InstanceType<typeof Database>;
beforeEach(() => { sqlite = new Database(':memory:'); sqlite.exec(deletionFixture + recycleMigration + 'CREATE TABLE users (id INTEGER PRIMARY KEY, slot_count INTEGER); INSERT INTO users VALUES (7,2)'); });
afterEach(() => sqlite.close());
test.each(['data', 'name', 'pending', 'generation'])('full tombstone CAS rejects changed %s', async change => {
  const db = createDeletionFixtureDb(sqlite); const snapshot = (await readOwnedDeletionSnapshot(db, 7, 'r1', 'recycle'))!;
  if (change === 'pending') sqlite.exec("INSERT INTO data_card_updates(id,data_card_id,user_id,data) VALUES ('p','r1',7,'new')");
  else sqlite.exec(`UPDATE data_cards SET ${change === 'generation' ? 'recycle_generation' : change}='changed' WHERE id='r1'`);
  expect((await restoreDataCardByIdAndUser(db, 'r1', 7, 20, snapshot)).status).toBe('conflict');
  expect(sqlite.prepare("SELECT deleted_at FROM data_cards WHERE id='r1'").get()).toEqual({ deleted_at: 'same-second' });
});
const runtime = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db/drizzle', () => ({ getDrizzleDbFromRuntime: () => runtime.db }));
vi.mock('@/lib/auth/server', () => ({ requireAuthUser: async () => ({ user: { id: 7 } }) }));
import { appRouteHandler } from '@/app/api/data-cards/restore-owned/handler';
const post = (body: unknown) => appRouteHandler(new Request('https://example.test/api/data-cards/restore-owned', { method: 'POST', body: JSON.stringify(body) }));
test('precise accepted version receipt; active state cannot supply another success', async () => {
  const db = createDeletionFixtureDb(sqlite); runtime.db = db;
  const version = await getOwnedDeletionVersion((await readOwnedDeletionSnapshot(db, 7, 'r1', 'recycle'))!);
  const body = { expectedUserId: 7, id: 'r1', version };
  const response = await post(body); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true, accountFenceVersion: 1, restoreProtocolVersion: 1, ownerUserId: 7, operation: 'restore', id: 'r1', version });
  expect((await post(body)).status).toBe(404);
});
test.each(['owner', 'extra', 'version', 'pending-owner', 'migration'])('reject before write: %s', async fault => {
  const db = createDeletionFixtureDb(sqlite); runtime.db = db;
  const version = await getOwnedDeletionVersion((await readOwnedDeletionSnapshot(db, 7, 'r1', 'recycle'))!);
  const body: Record<string, unknown> = { expectedUserId: 7, id: 'r1', version };
  if (fault === 'owner') body.expectedUserId = 8;
  if (fault === 'extra') body.data = '{}';
  if (fault === 'version') body.version = 'invalid';
  if (fault === 'pending-owner') sqlite.exec("INSERT INTO data_card_updates(id,data_card_id,user_id,data) VALUES ('p','r1',8,'{}')");
  if (fault === 'migration') sqlite.exec('DROP TRIGGER data_cards_recycle_generation');
  const response = await post(body); expect(response.status).toBe(fault === 'migration' ? 503 : fault === 'owner' || fault === 'pending-owner' ? 409 : 400);
  expect(sqlite.prepare("SELECT deleted_at FROM data_cards WHERE id='r1'").get()).toEqual({ deleted_at: 'same-second' });
});
test.each(['wrong-id', 'empty-with-changes', 'nonempty-with-zero', 'malformed', 'throw'])('lost or malformed committed receipt stays unknown: %s', async fault => {
  const db = createDeletionFixtureDb(sqlite); const version = await getOwnedDeletionVersion((await readOwnedDeletionSnapshot(db, 7, 'r1', 'recycle'))!);
  runtime.db = createDeletionFixtureDb(sqlite, (sql, receipt) => {
    if (!/^update /i.test(sql)) return receipt;
    if (fault === 'throw') throw Error('lost receipt');
    if (fault === 'wrong-id') return { ...receipt, results: [{ id: 'r2' }] };
    if (fault === 'empty-with-changes') return { ...receipt, results: [] };
    if (fault === 'nonempty-with-zero') return { ...receipt, meta: { changes: 0 } };
    return {};
  });
  const response = await post({ expectedUserId: 7, id: 'r1', version }); expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'RESTORE_OUTCOME_UNKNOWN', code: 'RESTORE_OUTCOME_UNKNOWN' });
  expect(sqlite.prepare("SELECT deleted_at FROM data_cards WHERE id='r1'").get()).toEqual({ deleted_at: null });
});
test('same-second re-deletion replaces generation, old restore snapshot cannot restore again', async () => {
  const db = createDeletionFixtureDb(sqlite); const snapshot = (await readOwnedDeletionSnapshot(db, 7, 'r1', 'recycle'))!;
  expect((await restoreDataCardByIdAndUser(db, 'r1', 7, 20, snapshot)).status).toBe('restored');
  sqlite.exec("UPDATE data_cards SET deleted_at='same-second',updated_at='same-second' WHERE id='r1'");
  expect((await restoreDataCardByIdAndUser(db, 'r1', 7, 20, snapshot)).status).toBe('conflict');
});
