import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { AppDrizzleDb } from '@/lib/db/drizzle';
import * as schema from '@/lib/db/schema';
import { getOwnedReplacementVersion, readOwnedReplacementSnapshot } from '@/lib/db/repositories/data-card-owned-replacement';
import { approvePendingPublicCardIfUnchanged, rejectPendingPublicCardIfUnchanged } from '@/lib/db/repositories/data-card-review';

const mocks = vi.hoisted(() => ({
  db: null as AppDrizzleDb | null, auth: vi.fn(), quickCheck: vi.fn(), legacy: vi.fn(),
  review: vi.fn(), reviewUpdate: vi.fn(), reset: vi.fn(), metrics: vi.fn(),
  autoReviewEnabled: true, exemptUserPolicy: 'bypass',
}));
vi.mock('@/lib/auth/server', () => ({ requireAuthUser: mocks.auth }));
vi.mock('@/lib/db/drizzle', () => ({ getDrizzleDbFromRuntime: () => mocks.db }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: mocks.quickCheck }));
vi.mock('@/lib/config', () => ({ config: { DEFAULT_DATA_CARD_CAPACITY: 20, DATA_CARD_AUTO_REVIEW: { get enabled() { return mocks.autoReviewEnabled; } } } }));
vi.mock('@/lib/database/data-cards', () => ({ createDataCardWithAuthor: mocks.legacy, getUserDataCards: mocks.legacy, updateDataCard: mocks.legacy, deleteDataCard: mocks.legacy, pruneUserRecycleBin: mocks.legacy, upsertDataCardUpdate: mocks.legacy, getDataCardById: mocks.legacy, getUserUsedSlots: mocks.legacy, updateDataCardContentByIdAndUser: mocks.legacy }));
vi.mock('@/lib/database/users', () => ({ getUserDataCardCapacity: mocks.legacy }));
vi.mock('@/lib/database/arena-ratings', () => ({ resetStrictArenaRatingForDataCard: mocks.reset }));
vi.mock('@/lib/database/data-card-metrics', () => ({ upsertDataCardMetrics: mocks.metrics }));
vi.mock('@/lib/review/auto-data-card-review', () => ({ autoReviewLatestPendingPublicDataCardsForUser: mocks.review, autoReviewLatestPendingPublicDataCardUpdatesForUser: mocks.reviewUpdate }));
vi.mock('@/lib/review/auto-review-engine', () => ({ getAutoReviewPolicy: () => ({ exemptUserPolicy: mocks.exemptUserPolicy }) }));
import { appRouteHandler as handler } from '@/app/api/data-cards/metadata-owned/handler';
import { PUT } from '@/app/api/data-cards/metadata-owned/route';
import { appRouteHandler as readHandler } from '@/app/api/data-cards/replace-owned/handler';
import { OwnedDataCardMetadataAcknowledgementSchema, OwnedDataCardReplacementTargetResponseSchema } from '@mahoshojo/contracts/data-cards';

let sqlite: Database;
const owner = { id: 7, username: 'owner', is_admin: 0, is_review_exempt: 0 };
const body = '{ "signature": "exact", "nativeAllowed": true, "body": [1, 2] }';
const put = (payload: unknown) => handler(new Request('https://test/api/data-cards/metadata-owned', { method: 'PUT', body: JSON.stringify(payload) }));
const state = () => ({ cards: sqlite.prepare('SELECT * FROM data_cards').all(), updates: sqlite.prepare('SELECT * FROM data_card_updates').all() });
const prepare = async () => ({
  id: 'c', expectedUserId: 7, expectedVersion: await getOwnedReplacementVersion((await readOwnedReplacementSnapshot(mocks.db!, 'c', 7))!),
  name: ' 新名称 ', description: '新描述', isPublic: 0,
});
beforeEach(() => {
  vi.resetAllMocks(); mocks.autoReviewEnabled = true; mocks.exemptUserPolicy = 'bypass';
  mocks.auth.mockResolvedValue({ user: { ...owner } });
  mocks.quickCheck.mockResolvedValue({ hasSensitiveWords: false }); mocks.review.mockResolvedValue(undefined);
  sqlite = new Database(':memory:'); mocks.db = drizzle(sqlite, { schema }) as unknown as AppDrizzleDb;
  sqlite.exec(`CREATE TABLE data_cards (id TEXT PRIMARY KEY,user_id INTEGER,type TEXT,name TEXT,description TEXT,data TEXT,
    is_public INTEGER,public_since TEXT,review_status TEXT,updated_at TEXT,deleted_at TEXT,favorite_count INTEGER,usage_count INTEGER);
    CREATE TABLE data_card_updates (id TEXT PRIMARY KEY,data_card_id TEXT UNIQUE,user_id INTEGER,name TEXT,description TEXT,data TEXT,created_at TEXT,updated_at TEXT);`);
  sqlite.prepare("INSERT INTO data_cards VALUES ('c',7,'questionnaire','原名称',NULL,?,0,NULL,'pending','same-second',NULL,0,0)").run(body);
});
afterEach(() => sqlite.close());

describe('metadata-owned real route + SQLite', () => {
  test('Next registers PUT only; existing read target supplies the exact version', async () => {
    expect(PUT).toBe(handler);
    const read = await readHandler(new Request('https://test/api/data-cards/replace-owned?id=c&expectedUserId=7'));
    const target = OwnedDataCardReplacementTargetResponseSchema.parse(await read.json()).target;
    expect(target).not.toHaveProperty('data'); expect(read.headers.get('cache-control')).toBe('private, no-store');
    const request = { ...await prepare(), expectedVersion: target.version }; mocks.auth.mockClear();
    const response = await put(request); expect(response.status).toBe(200);
    expect(OwnedDataCardMetadataAcknowledgementSchema.parse(await response.json())).toEqual({ success: true, id: 'c', accountFenceVersion: 1, ownerUserId: 7, metadataVersion: 1 });
    expect(mocks.auth).toHaveBeenCalledOnce(); expect(mocks.quickCheck).toHaveBeenCalledWith('新名称 新描述 ');
    expect(sqlite.prepare('SELECT name,description,data,type,review_status FROM data_cards').get()).toEqual({
      name: '新名称', description: '新描述', data: body, type: 'questionnaire', review_status: 'pending',
    });
    expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.metrics).not.toHaveBeenCalled(); expect(mocks.reset).not.toHaveBeenCalled();
  });
  test.each(['GET', 'POST', 'DELETE'])('refuses method %s before authentication', async (method) => {
    expect((await handler(new Request('https://test/api/data-cards/metadata-owned', { method }))).status).toBe(405);
    expect(mocks.auth).not.toHaveBeenCalled();
  });
  test('passes through auth failure and returns unavailable storage without a fallback', async () => {
    const request = await prepare();
    mocks.auth.mockResolvedValueOnce({ response: Response.json({ error: 'not-authenticated' }, { status: 401 }) });
    expect((await put(request)).status).toBe(401);
    mocks.db = null; expect((await put(request)).status).toBe(503); expect(mocks.legacy).not.toHaveBeenCalled();
  });
  test.each([null, '7', 0, 7.5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid owner %j before mutation', async (expectedUserId) => {
    const before = state(); expect((await put({ expectedUserId })).status).toBe(400);
    expect(state()).toEqual(before); expect(mocks.quickCheck).not.toHaveBeenCalled();
  });
  test('server identity wins over expectedUserId and remains frozen through checks', async () => {
    const request = await prepare(); mocks.auth.mockResolvedValueOnce({ user: { ...owner, id: 8 } });
    expect(await (await put(request)).json()).toEqual({ error: 'ACCOUNT_MISMATCH' });
    const authUser = { ...owner }; mocks.auth.mockResolvedValueOnce({ user: authUser });
    mocks.quickCheck.mockImplementationOnce(async () => { authUser.id = 8; return { hasSensitiveWords: false }; });
    expect(await (await put(request)).json()).toMatchObject({ success: true, ownerUserId: 7 });
  });
  test.each(['data', 'type', 'review_status', 'signature', 'nativeAllowed'])('strict route refuses injected %s', async (field) => {
    const before = state(); expect((await put({ ...await prepare(), [field]: 'injection' })).status).toBe(400);
    expect(state()).toEqual(before); expect(mocks.quickCheck).not.toHaveBeenCalled();
  });
  test.each([`UPDATE data_cards SET user_id=8`, `UPDATE data_cards SET deleted_at='deleted'`, 'DELETE FROM data_cards'])('rejects absent or foreign targets: %s', async (mutation) => {
    const request = await prepare(); sqlite.exec(mutation); expect((await put(request)).status).toBe(404);
    expect(mocks.quickCheck).not.toHaveBeenCalled();
  });
  test('rejects foreign pending ownership and stale versions before sensitive checks', async () => {
    const request = await prepare(); expect((await put({ ...request, expectedVersion: '0'.repeat(64) })).status).toBe(409);
    sqlite.exec("INSERT INTO data_card_updates VALUES ('p','c',8,'pending',NULL,'{}',NULL,NULL)");
    expect((await put(await prepare())).status).toBe(409); expect(mocks.quickCheck).not.toHaveBeenCalled();
  });
  test.each([-1, 0, 1])('banned cards remain banned for requested visibility %s', async (isPublic) => {
    sqlite.exec('UPDATE data_cards SET is_public=-1');
    expect((await put({ ...await prepare(), isPublic })).status).toBe(200);
    expect(sqlite.prepare('SELECT is_public,public_since,data FROM data_cards').get()).toEqual({ is_public: -1, public_since: null, data: body });
    expect(mocks.review).not.toHaveBeenCalled();
  });
  test.each([
    `UPDATE data_cards SET name='concurrent'`, `UPDATE data_cards SET is_public=-1`,
    `UPDATE data_cards SET review_status='approved'`, `UPDATE data_cards SET deleted_at='deleted'`, 'DELETE FROM data_cards',
    `INSERT INTO data_card_updates VALUES ('p','c',7,'pending',NULL,'{}',NULL,NULL)`,
  ])('CAS catches changes made during validation: %s', async (mutation) => {
    const request = await prepare(); let afterMutation: ReturnType<typeof state>;
    mocks.quickCheck.mockImplementationOnce(async () => { sqlite.exec(mutation); afterMutation = state(); return { hasSensitiveWords: false }; });
    const response = await put(request); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'TARGET_CHANGED' });
    expect(state()).toEqual(afterMutation!); expect(mocks.review).not.toHaveBeenCalled(); expect(mocks.reviewUpdate).not.toHaveBeenCalled();
  });
  test('sensitive text refusal leaves all original state unchanged', async () => {
    const request = await prepare(); const before = state(); mocks.quickCheck.mockResolvedValueOnce({ hasSensitiveWords: true });
    const response = await put(request); expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'SENSITIVE_WORD_DETECTED', redirect: '/arrested' });
    expect(state()).toEqual(before); expect(mocks.review).not.toHaveBeenCalled();
  });
  test.each([
    ['pending', 1, 0, 0, 'bypass', true, true], ['pending', 0, 0, 0, 'bypass', true, false],
    ['approved', 1, 0, 0, 'bypass', true, false], ['rejected', 1, 0, 0, 'bypass', true, false],
    [null, 1, 0, 0, 'bypass', true, false],
    ['pending', 1, 1, 0, 'bypass', true, false], ['pending', 1, 0, 1, 'bypass', true, false],
    ['pending', 1, 0, 1, 'skip', true, false], ['pending', 1, 0, 1, 'review', true, true],
    ['pending', 1, 0, 0, 'bypass', false, false],
  ] as const)('preserves legacy main-card review trigger %s/%s/admin=%s/exempt=%s/%s/enabled=%s', async (status, isPublic, admin, exempt, policy, enabled, expected) => {
    sqlite.prepare('UPDATE data_cards SET review_status=?').run(status);
    sqlite.exec("INSERT INTO data_card_updates VALUES ('p','c',7,'pending',NULL,'{}',NULL,NULL)");
    const pendingBefore = state().updates;
    mocks.auth.mockResolvedValue({ user: { ...owner, is_admin: admin, is_review_exempt: exempt } });
    mocks.exemptUserPolicy = policy; mocks.autoReviewEnabled = enabled;
    expect((await put({ ...await prepare(), isPublic })).status).toBe(200);
    expect(mocks.review).toHaveBeenCalledTimes(expected ? 1 : 0);
    if (expected) expect(mocks.review).toHaveBeenCalledWith(7);
    expect(mocks.reviewUpdate).not.toHaveBeenCalled(); expect(state().updates).toEqual(pendingBefore);
    expect(sqlite.prepare('SELECT data,review_status FROM data_cards').get()).toEqual({ data: body, review_status: status });
  });
  test.each(['approve', 'reject'])('existing main-card %s review never applies pending content or re-signs', async (verdict) => {
    sqlite.exec("INSERT INTO data_card_updates VALUES ('p','c',7,'pending',NULL,'{\"signature\":\"pending\"}',NULL,NULL)");
    const pendingBefore = state().updates;
    mocks.review.mockImplementationOnce(async () => {
      const snapshot = (await readOwnedReplacementSnapshot(mocks.db!, 'c', 7))!;
      const review = { id: snapshot.id, name: snapshot.name, description: snapshot.description, data: snapshot.data, type: snapshot.type, updatedAt: snapshot.updated_at };
      expect(await (verdict === 'approve' ? approvePendingPublicCardIfUnchanged : rejectPendingPublicCardIfUnchanged)(mocks.db!, 7, review)).toBe(true);
    });
    expect((await put({ ...await prepare(), isPublic: 1 })).status).toBe(200);
    expect(sqlite.prepare('SELECT data,review_status FROM data_cards').get()).toEqual({ data: body, review_status: verdict === 'approve' ? 'approved' : 'rejected' });
    expect(state().updates).toEqual(pendingBefore); expect(mocks.reviewUpdate).not.toHaveBeenCalled();
  });
  test('an auto-review failure returns 500 after committed metadata without touching content or pending rows', async () => {
    sqlite.exec("INSERT INTO data_card_updates VALUES ('p','c',7,'pending',NULL,'{\"signature\":\"pending\"}',NULL,NULL)");
    const pendingBefore = state().updates;
    const request = { ...await prepare(), isPublic: 1 };
    const failure = new Error('review unavailable after metadata commit');
    mocks.review.mockRejectedValueOnce(failure);
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await put(request);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: '更新数据卡元信息失败' });
    expect(mocks.review).toHaveBeenCalledWith(7);
    expect(logError).toHaveBeenCalledWith('Owned metadata update failed:', failure);
    expect(sqlite.prepare('SELECT name,description,is_public,data,type,review_status FROM data_cards').get()).toEqual({
      name: '新名称', description: '新描述', is_public: 1, data: body, type: 'questionnaire', review_status: 'pending',
    });
    const snapshot = (await readOwnedReplacementSnapshot(mocks.db!, 'c', 7))!;
    expect(await getOwnedReplacementVersion(snapshot)).not.toBe(request.expectedVersion);
    expect(state().updates).toEqual(pendingBefore);
    expect(mocks.reviewUpdate).not.toHaveBeenCalled();
    expect(mocks.metrics).not.toHaveBeenCalled(); expect(mocks.reset).not.toHaveBeenCalled();
  });
});
