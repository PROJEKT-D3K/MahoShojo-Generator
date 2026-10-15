import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { createD1HttpTransport, createHttpD1Client } from '@mahoshojo/hosted-runtime/d1-http-client';
import * as schema from '@/lib/db/schema';
import { OwnedDataCardDeletionPreviewSchema, OwnedRecycleBinPurgeAcknowledgementSchema } from '@mahoshojo/contracts/data-cards';
import { createDeletionFixtureDb, deletionFixture, recycleMigration } from './helpers/owned-deletion-fixture';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), getDb: vi.fn(), limit: 5 }));
vi.mock('@/lib/auth/server', () => ({ requireAuthUser: mocks.auth }));
vi.mock('@/lib/db/drizzle', () => ({ getDrizzleDbFromRuntime: mocks.getDb }));
vi.mock('@/lib/config', () => ({ config: { get RECYCLE_BIN_LIMIT() { return mocks.limit; } } }));
import { GET as preview } from '@/app/api/data-cards/delete-preview-owned/route';
import { POST as soft } from '@/app/api/data-cards/soft-delete-owned/route';
import { POST as purgeActive } from '@/app/api/data-cards/purge-active-owned/route';
import { POST as purgeRecycle } from '@/app/api/data-cards/purge-recycle-owned/route';
let sqlite: InstanceType<typeof Database>;
const get = (scope = 'active', id: string | undefined = scope === 'active' ? 'a' : undefined, extra = '') => preview(new Request(`https://example.test/api/data-cards/delete-preview-owned?expectedUserId=7&scope=${scope}${id ? `&id=${id}` : ''}${extra}`));
const post = (handler: typeof soft, payload: unknown) => handler(new Request('https://example.test/api/data-cards/action', { method: 'POST', body: JSON.stringify(payload) }));
const activeTarget = async () => (await (await get()).json()).targets[0];
const recycleTargets = async () => (await (await get('recycle', undefined)).json()).targets;
const reference = (target: { id: string; version: string }) => ({ id: target.id, version: target.version });
beforeEach(() => {
  vi.clearAllMocks(); mocks.limit = 5;
  sqlite = new Database(':memory:'); sqlite.exec(deletionFixture); sqlite.exec(recycleMigration);
  mocks.getDb.mockReturnValue(createDeletionFixtureDb(sqlite));
  mocks.auth.mockResolvedValue({ user: { id: 7 } });
});
afterEach(() => sqlite.close());

describe('owned delete endpoints fail closed', () => {
  test('preview returns only identity and version, strict captured owner and private caching', async () => {
    const owner = { id: 7 }; mocks.auth.mockResolvedValue({ user: owner });
    const db = createDeletionFixtureDb(sqlite); mocks.getDb.mockImplementation(() => { owner.id = 8; return db; });
    const result = await get(); expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('private, no-store');
    const body = OwnedDataCardDeletionPreviewSchema.parse(await result.json());
    expect(body).toMatchObject({ ownerUserId: 7, deleteProtocolVersion: 1, operation: 'preview-active', total: 1, recycleLimit: 5 });
    expect(body.targets[0].version).toMatch(/^[a-f0-9]{64}$/); expect(body.targets[0]).not.toHaveProperty('data');
    expect(mocks.auth.mock.calls[0][1]).toEqual({ strict: true }); expect(mocks.auth).toHaveBeenCalledOnce();
  });
  test('full recycle preview includes every type and single-card preview remains available for large bins', async () => {
    const body = await (await get('recycle', undefined)).json();
    expect(body.targets.map((target: { type: string }) => target.type).sort()).toEqual(['questionnaire', 'scenario']);
    const observed: unknown[] = [];
    const realDb = createDeletionFixtureDb(sqlite);
    mocks.getDb.mockReturnValue({ all: async (query: Parameters<typeof realDb.all>[0]) => {
      observed.push(query); return realDb.all(query);
    } });
    for (let i = 0; i < 15; i++) sqlite.prepare("INSERT INTO data_cards(id,user_id,type,name,data,deleted_at) VALUES (?,7,'history','旧卡','body','old')").run(`old${i}`);
    const tooLarge = await get('recycle', undefined); expect(tooLarge.status).toBe(409); expect(await tooLarge.json()).toMatchObject({ error: 'RECYCLE_TARGET_LIMIT' });
    expect(observed).toHaveLength(3);
    const single = await get('recycle', 'r1'); expect(single.status).toBe(200); expect((await single.json()).total).toBe(1);
  });
  test.each(['&unknown=yes', '&id=a', '&expectedUserId=8'])('rejects unknown and duplicate query values: %s', async (extra) => {
    expect((await get('active', 'a', extra)).status).toBe(400); expect(mocks.getDb).not.toHaveBeenCalled();
  });
  test('rejects missing active id, foreign/deleted target and account mismatch', async () => {
    expect((await get('active', '')).status).toBe(400);
    expect((await get('active', 'r1')).status).toBe(404); expect((await get('recycle', 'foreign')).status).toBe(404);
    mocks.auth.mockResolvedValue({ user: { id: 8 } }); expect((await get()).status).toBe(409);
  });
  test('soft deletion reports exact actual ID and full is a known non-mutating conflict', async () => {
    const target = reference(await activeTarget());
    mocks.limit = 2; const full = await post(soft, { expectedUserId: 7, ...target });
    expect(full.status).toBe(409); expect(await full.json()).toMatchObject({ error: 'RECYCLE_BIN_FULL' });
    expect(sqlite.prepare("SELECT deleted_at FROM data_cards WHERE id='a'").get()).toEqual({ deleted_at: null });
    mocks.limit = 5; const response = await post(soft, { expectedUserId: 7, ...target }); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, accountFenceVersion: 1, deleteProtocolVersion: 1, ownerUserId: 7, operation: 'soft-delete', id: 'a' });
    expect((await post(soft, { expectedUserId: 7, ...target })).status).toBe(409);
  });
  test('active purge is distinct and rejects a later recycle generation even if card returns active', async () => {
    const target = reference(await activeTarget());
    sqlite.exec("UPDATE data_cards SET deleted_at='same-second' WHERE id='a'; UPDATE data_cards SET deleted_at=NULL WHERE id='a'");
    expect((await post(purgeActive, { expectedUserId: 7, ...target })).status).toBe(409);
    const latest = reference(await activeTarget());
    const response = await post(purgeActive, { expectedUserId: 7, ...latest }); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operation: 'purge-active', id: 'a' });
  });
  test('recycle purge requires exact versions and no universal force/wildcard/duplicate payload', async () => {
    const targets = (await recycleTargets()).map(reference);
    for (const payload of [
      { expectedUserId: 7, ids: ['r1'] }, { expectedUserId: 7, targets, force: true },
      { expectedUserId: 7, targets: [targets[0], targets[0]] }, { expectedUserId: 7, targets: [] },
      { expectedUserId: 7, targets: [{ id: '*', version: '0'.repeat(64) }] },
    ]) expect((await post(purgeRecycle, payload)).status).toBe(payload.targets?.[0]?.id === '*' ? 409 : 400);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM data_cards').get()).toEqual({ n: 4 });
    const response = await post(purgeRecycle, { expectedUserId: 7, targets });
    expect(response.status).toBe(200); expect(OwnedRecycleBinPurgeAcknowledgementSchema.parse(await response.json()).ids.sort()).toEqual(['r1', 'r2']);
  });
  test('continuation precondition refuses changed active target or impossible projected capacity without clearing', async () => {
    const targets = (await recycleTargets()).map(reference); const continuationTarget = reference(await activeTarget());
    mocks.limit = 0;
    expect((await post(purgeRecycle, { expectedUserId: 7, targets, continuationTarget })).status).toBe(409);
    mocks.limit = 5; sqlite.exec("UPDATE data_cards SET name='changed' WHERE id='a'");
    expect((await post(purgeRecycle, { expectedUserId: 7, targets, continuationTarget })).status).toBe(409);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM data_cards WHERE user_id=7 AND deleted_at IS NOT NULL").get()).toEqual({ n: 2 });
  });
  test('a successful clear does not authorize refreshing the active snapshot for the next stage', async () => {
    const targets = (await recycleTargets()).map(reference); const continuationTarget = reference(await activeTarget());
    expect((await post(purgeRecycle, { expectedUserId: 7, targets, continuationTarget })).status).toBe(200);
    sqlite.exec("UPDATE data_cards SET data='changed' WHERE id='a'");
    expect((await post(soft, { expectedUserId: 7, ...continuationTarget })).status).toBe(409);
    expect(sqlite.prepare("SELECT deleted_at FROM data_cards WHERE id='a'").get()).toEqual({ deleted_at: null });
  });
  test('a malformed actual write receipt is unknown even if the database really changed', async () => {
    const target = reference(await activeTarget());
    mocks.getDb.mockReturnValue(createDeletionFixtureDb(sqlite, (sql, receipt) => sql.includes('RETURNING id')
      ? { ...receipt, results: [{ id: 'wrong-receipt' }] } : receipt));
    const response = await post(soft, { expectedUserId: 7, ...target });
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: 'DELETE_OUTCOME_UNKNOWN' });
    expect(sqlite.prepare("SELECT deleted_at FROM data_cards WHERE id='a'").get()).not.toEqual({ deleted_at: null });
  });
  test.each([
    ['null rows', { results: [null], meta: { changes: 2 } }],
    ['number rows', { results: [3], meta: { changes: 2 } }],
    ['raw rows', { results: { rows: [['r1'], ['r2']], columns: ['id'] }, meta: { changes: 2 } }],
    ['empty positive changes', { results: [], meta: { changes: 2 } }],
    ['empty missing changes', { results: [], meta: {} }],
    ['missing results', { meta: { changes: 2 } }],
  ])('HTTP D1 actual clear followed by %s remains unknown with no replay or implicit continuation', async (_name, corrupted) => {
    const targets = (await recycleTargets()).map(reference); const continuationTarget = reference(await activeTarget());
    let writes = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const { sql, params } = JSON.parse(String(init?.body)) as { sql: string; params: unknown[] };
      const results = sqlite.prepare(sql).all(...params);
      const { n } = sqlite.prepare('SELECT changes() AS n').get() as { n: number };
      const receipt = sql.includes('RETURNING id')
        ? (writes++, { success: true, ...corrupted }) : { success: true, results, meta: { changes: n } };
      return Response.json({ success: true, result: [receipt] });
    });
    const transport = createD1HttpTransport({ kind: 'cloudflare-api', queryUrl: 'https://d1.example.test/query', rawUrl: 'https://d1.example.test/raw', fetch: fetcher });
    mocks.getDb.mockReturnValue(drizzle(createHttpD1Client(transport) as never, { schema }));
    const response = await post(purgeRecycle, { expectedUserId: 7, targets, continuationTarget });
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: 'DELETE_OUTCOME_UNKNOWN' });
    expect(writes).toBe(1);
    expect(sqlite.prepare("SELECT id FROM data_cards WHERE id IN ('r1','r2')").all()).toEqual([]);
    expect(sqlite.prepare("SELECT deleted_at FROM data_cards WHERE id='a'").get()).toEqual({ deleted_at: null });
  });
  test('a half-applied migration never offers even an empty-bin confirmation', async () => {
    sqlite.exec("DROP TRIGGER data_cards_recycle_generation; DELETE FROM data_cards WHERE deleted_at IS NOT NULL");
    const result = await get('recycle', undefined);
    expect(result.status).toBe(503); expect(await result.json()).toMatchObject({ error: 'STORAGE_UNAVAILABLE' });
  });
  test('missing migration and auth/storage failures do not call legacy routes', async () => {
    mocks.auth.mockRejectedValueOnce(new Error('auth down'));
    expect((await get()).status).toBe(503); expect(mocks.getDb).not.toHaveBeenCalled();
    mocks.auth.mockResolvedValue({ response: new Response('auth down', { status: 500 }) }); expect((await get()).status).toBe(503);
    mocks.auth.mockResolvedValue({ user: { id: 7 } });
    const target = reference(await activeTarget());
    sqlite.exec('DROP TRIGGER data_cards_recycle_generation; ALTER TABLE data_cards DROP COLUMN recycle_generation');
    expect((await get()).status).toBe(503); expect((await post(soft, { expectedUserId: 7, ...target })).status).toBe(503);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM data_cards').get()).toEqual({ n: 4 });
  });
});
