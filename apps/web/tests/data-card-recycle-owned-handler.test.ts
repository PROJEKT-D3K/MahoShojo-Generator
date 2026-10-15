import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { OwnedRecycleBinDetailResponseSchema, OwnedRecycleBinPageSchema } from '@mahoshojo/contracts/data-cards';
import { MAX_DATA_CARD_BYTES } from '@mahoshojo/domain/data-card-size';
import type { AppDrizzleDb } from '@/lib/db/drizzle';
import * as schema from '@/lib/db/schema';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), getDb: vi.fn(), legacy: vi.fn(), AccountUnavailable: class extends Error {} }));
vi.mock('@/lib/auth/server', () => ({ requireAuthUser: mocks.auth, AuthAccountUnavailableError: mocks.AccountUnavailable }));
vi.mock('@/lib/db/drizzle', () => ({ getDrizzleDbFromRuntime: mocks.getDb }));
vi.mock('@/lib/database/data-cards', () => ({ getUserDataCards: mocks.legacy, getDataCardById: mocks.legacy, pruneUserRecycleBin: mocks.legacy, deleteDataCard: mocks.legacy, restoreDataCard: mocks.legacy }));
import { GET as listHandler } from '@/app/api/data-cards/recycle-owned/route';
import { GET as detailHandler } from '@/app/api/data-cards/recycle-owned/detail/route';

let sqlite: InstanceType<typeof Database>;
const original = '{ "original": true, "custom": "未规整原件\\u0000" }\n';
const owner = { id: 7, username: 'owner' };
const request = (detail: boolean, query = detail ? 'expectedUserId=7&id=card-14' : 'expectedUserId=7', method = 'GET') =>
  (detail ? detailHandler : listHandler)(new Request(`https://example.test/api/data-cards/recycle-owned${detail ? '/detail' : ''}?${query}`, { method }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { ...owner }, source: 'better-auth-session' });
  sqlite = new Database(':memory:');
  mocks.getDb.mockReturnValue(drizzle(sqlite, { schema }) as unknown as AppDrizzleDb);
  sqlite.exec(`CREATE TABLE data_cards (id TEXT PRIMARY KEY,user_id INTEGER,type TEXT,name TEXT,description TEXT,data TEXT,
    is_public INTEGER,review_status TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,usage_count INTEGER,like_count INTEGER)`);
  const insert = sqlite.prepare(`INSERT INTO data_cards VALUES (?,7,'character','墓碑',NULL,?,1,'approved',NULL,NULL,'2026-10-15',0,0)`);
  for (let i = 0; i < 15; i++) insert.run(`card-${String(i).padStart(2, '0')}`, original);
  sqlite.exec(`INSERT INTO data_cards VALUES ('active',7,'character','未删',NULL,'{}',1,'approved',NULL,NULL,NULL,0,0);
    INSERT INTO data_cards VALUES ('foreign',8,'scenario','他人',NULL,'{}',1,'approved',NULL,NULL,'2026-10-16',0,0)`);
});
afterEach(() => {
  expect(mocks.legacy).not.toHaveBeenCalled();
  sqlite.close();
});

const expectPrivate = (response: Response) => expect(response.headers.get('cache-control')).toBe('private, no-store');

describe('recycle-owned strict GET handlers with real SQLite', () => {
  test('list defaults to twelve summaries, captures owner once, and exposes the explicit account fence', async () => {
    const response = await request(false); expectPrivate(response); expect(response.status).toBe(200);
    const body = OwnedRecycleBinPageSchema.parse(await response.json());
    expect(body).toMatchObject({ accountFenceVersion: 1, ownerUserId: 7, total: 15, filteredCount: 15, nextOffset: 12 });
    expect(body.cards).toHaveLength(12); expect(body.cards[0].id).toBe('card-14');
    expect(body.cards.every((card) => !('data' in card))).toBe(true);
    expect(mocks.auth).toHaveBeenCalledOnce(); expect(mocks.auth.mock.calls[0][1]).toEqual({ strict: true });
    expect(mocks.getDb).toHaveBeenCalledOnce();
  });

  test('the authenticated owner is captured before subsequent asynchronous reads', async () => {
    const user = { ...owner };
    mocks.auth.mockResolvedValueOnce({ user, source: 'better-auth-session' });
    const db = drizzle(sqlite, { schema }) as unknown as AppDrizzleDb;
    mocks.getDb.mockImplementationOnce(() => { user.id = 8; return db; });
    const response = await request(false);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ownerUserId: 7, total: 15 });
    expect(mocks.auth).toHaveBeenCalledOnce();
  });

  test('explicit bounded pagination and type filtering preserve total versus filteredCount', async () => {
    const page = await request(false, 'expectedUserId=7&limit=24&offset=12&type=character');
    expectPrivate(page); expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ total: 15, filteredCount: 15, nextOffset: null, cards: expect.any(Array) });
    const empty = await request(false, 'expectedUserId=7&type=scenario');
    expect(await empty.json()).toMatchObject({ total: 15, filteredCount: 0, cards: [], nextOffset: null });
  });

  test('detail is a single original with matching actual owner and no pending overlay', async () => {
    const response = await request(true); expectPrivate(response); expect(response.status).toBe(200);
    const body = OwnedRecycleBinDetailResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ accountFenceVersion: 1, ownerUserId: 7, card: { id: 'card-14', data: original } });
    expect(mocks.auth).toHaveBeenCalledOnce(); expect(mocks.auth.mock.calls[0][1]).toEqual({ strict: true });
  });

  test.each([false, true])('expected owner cannot authorize reading another account: detail=%s', async (detail) => {
    mocks.auth.mockResolvedValue({ user: { ...owner, id: 8 } });
    const response = await request(detail); expectPrivate(response); expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'ACCOUNT_MISMATCH' });
    expect(mocks.auth).toHaveBeenCalledOnce(); expect(mocks.getDb).not.toHaveBeenCalled();
  });

  test.each(['active', 'foreign', 'missing'])('detail rejects non-owned or non-deleted card %s', async (id) => {
    const response = await request(true, `expectedUserId=7&id=${id}`);
    expectPrivate(response); expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'NOT_FOUND' });
  });

  test.each([
    '', 'expectedUserId=', 'expectedUserId=0', 'expectedUserId=-7', 'expectedUserId=07', 'expectedUserId=7.0',
    'expectedUserId=7e0', 'expectedUserId=%207', 'expectedUserId=%2B7', 'expectedUserId=0x7',
    'expectedUserId=NaN', 'expectedUserId=Infinity', 'expectedUserId=9007199254740992',
    'expectedUserId=7&expectedUserId=7', 'expectedUserId=7&ownerUserId=7', 'expectedUserId=7&__proto__=x',
  ])('both endpoints reject noncanonical or ambiguous owner query %s', async (query) => {
    for (const detail of [false, true]) {
      const response = await request(detail, `${query}${detail ? '&id=card-14' : ''}`);
      expectPrivate(response); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'INVALID_QUERY' });
    }
    expect(mocks.auth).toHaveBeenCalledTimes(2); expect(mocks.getDb).not.toHaveBeenCalled();
  });

  test.each([
    'limit=0', 'limit=25', 'limit=-1', 'limit=01', 'limit=1.0', 'limit=1e1', 'limit=', 'limit=%201',
    'limit=9007199254740992', 'limit=1&limit=1', 'offset=-1', 'offset=01', 'offset=0.0', 'offset=1e1',
    'offset=', 'offset=%2B1', 'offset=9007199254740968', 'offset=0&offset=0',
    'type=', 'type=unknown', 'type=character&type=character', 'type=%20character', 'types=character',
    'id=card-14', 'data=x', 'search=x',
  ])('list rejects unsupported or noncanonical query %s', async (query) => {
    const response = await request(false, `expectedUserId=7&${query}`); expectPrivate(response);
    expect(response.status).toBe(400); expect(mocks.auth).toHaveBeenCalledOnce(); expect(mocks.getDb).not.toHaveBeenCalled();
  });

  test.each(['', 'id=', 'id=%20', `id=${'a'.repeat(201)}`, 'id=card-14&id=card-14', 'id=card-14&limit=1', 'id=card-14&type=character', 'id=card-14&data=x'])('detail rejects invalid query %s', async (query) => {
    const response = await request(true, `expectedUserId=7&${query}`); expectPrivate(response);
    expect(response.status).toBe(400); expect(mocks.auth).toHaveBeenCalledOnce(); expect(mocks.getDb).not.toHaveBeenCalled();
  });

  test.each([401, 403])('auth response %s is preserved and uncacheable without storage access', async (status) => {
    for (const detail of [false, true]) {
      mocks.auth.mockResolvedValueOnce({ response: Response.json({ error: 'auth refusal' }, { status, headers: { 'Cache-Control': 'public, max-age=99' } }) });
      const response = await request(detail); expectPrivate(response); expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: 'auth refusal' });
    }
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  test.each([false, true])('auth exceptions and unavailable auth are explicit 503: detail=%s', async (detail) => {
    mocks.auth.mockRejectedValueOnce(new Error('auth storage failure'));
    const failure = await request(detail); expectPrivate(failure); expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({ error: 'AUTH_UNAVAILABLE' });
    mocks.auth.mockResolvedValueOnce({ response: Response.json({ error: 'failure' }, { status: 500 }) });
    const unavailable = await request(detail); expectPrivate(unavailable); expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: 'AUTH_UNAVAILABLE' });
    mocks.auth.mockRejectedValueOnce(new mocks.AccountUnavailable());
    const noAccount = await request(detail); expectPrivate(noAccount); expect(noAccount.status).toBe(503);
    expect(await noAccount.json()).toEqual({ error: 'ACCOUNT_UNAVAILABLE' });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  test.each([false, true])('missing and failing storage cannot masquerade as an empty bin: detail=%s', async (detail) => {
    mocks.getDb.mockReturnValueOnce(null);
    const unavailable = await request(detail); expectPrivate(unavailable); expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: 'STORAGE_UNAVAILABLE' });
    mocks.getDb.mockImplementationOnce(() => { throw new Error('storage initialization failed'); });
    const failedInit = await request(detail); expectPrivate(failedInit); expect(failedInit.status).toBe(503);
    sqlite.exec('DROP TABLE data_cards');
    const failedQuery = await request(detail); expectPrivate(failedQuery); expect(failedQuery.status).toBe(503);
    expect(await failedQuery.json()).toEqual({ error: 'STORAGE_UNAVAILABLE' });
  });

  test('oversized original fails detail explicitly while summary remains bounded and original is never truncated', async () => {
    const oversized = '文'.repeat(Math.floor(MAX_DATA_CARD_BYTES / 3) + 1);
    sqlite.prepare('UPDATE data_cards SET data=? WHERE id=?').run(oversized, 'card-14');
    const response = await request(true); expectPrivate(response); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'STORAGE_UNAVAILABLE' });
    expect((await request(false)).status).toBe(200);
    expect(sqlite.prepare('SELECT data FROM data_cards WHERE id=?').get('card-14')).toEqual({ data: oversized });
  });

  test.each([false, true])('non-GET is a private 405 and causes neither authentication nor writes: detail=%s', async (detail) => {
    const response = await request(detail, 'expectedUserId=7', 'DELETE'); expectPrivate(response); expect(response.status).toBe(405);
    expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.getDb).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM data_cards').get()).toEqual({ count: 17 });
  });
});
