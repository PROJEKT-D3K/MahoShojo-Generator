import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { AppDrizzleDb } from '@/lib/db/drizzle';
import * as schema from '@/lib/db/schema';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), getAuth: vi.fn(), getSession: vi.fn(), legacy: vi.fn(), heal: vi.fn() }));
vi.mock('@/lib/db/drizzle', () => ({ getDrizzleDbFromRuntime: mocks.getDb }));
vi.mock('@/lib/auth/better-auth-app', () => ({ getBetterAuthInstance: mocks.getAuth }));
vi.mock('@/lib/database/users', () => ({ getUserByAuthKey: mocks.legacy, getUserByEmail: mocks.legacy, getUserById: mocks.legacy, getUserByUsername: mocks.legacy }));
vi.mock('@/lib/auth/user-auth-linking', () => ({ getLinkedBusinessUserByAuthUserId: mocks.heal, ensureAuthUserLink: mocks.heal }));
import { AuthAccountUnavailableError, createAuthServer } from '@/lib/auth/server';

let sqlite: InstanceType<typeof Database>;
const session = { user: { id: 'session-owner', email: 'owner@example.test', name: 'owner' }, session: { userId: 'session-owner' } };
const req = (bearer = '') => new Request('https://example.test/api/data-cards/recycle-owned?expectedUserId=7', { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
const auth = (hasCookie: boolean) => createAuthServer({ hasBetterAuthSessionCookieImpl: () => hasCookie });
const requireStrict = (hasCookie: boolean, bearer = '') => auth(hasCookie).requireAuthUser(req(bearer), { strict: true });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('HONO_AUTH_MODE', '');
  sqlite = new Database(':memory:');
  mocks.getDb.mockReturnValue(drizzle(sqlite, { schema }) as unknown as AppDrizzleDb);
  mocks.getAuth.mockReturnValue({ api: { getSession: mocks.getSession } });
  mocks.getSession.mockResolvedValue(session);
  mocks.legacy.mockResolvedValue(null); mocks.heal.mockResolvedValue(null);
  sqlite.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY,username TEXT,email TEXT,auth_key TEXT,registration_ip TEXT,prefix TEXT,is_banned TEXT,
    is_admin INTEGER,is_review_exempt INTEGER,slot_count INTEGER,signature TEXT,avatar_webp_base64 TEXT,
    created_at TEXT,updated_at TEXT,last_login_at TEXT);
    CREATE TABLE user_auth_links (id INTEGER PRIMARY KEY,auth_user_id TEXT UNIQUE,business_user_id INTEGER,created_at TEXT,updated_at TEXT);
    INSERT INTO users VALUES (7,'owner','owner@example.test','owner-key',NULL,NULL,NULL,1,1,20,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO users VALUES (8,'other','other@example.test','other-key',NULL,NULL,NULL,0,0,20,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO user_auth_links VALUES (1,'session-owner',7,NULL,NULL);`);
});
afterEach(() => { sqlite.close(); vi.unstubAllEnvs(); });

describe('opt-in strict authentication with real business-user SQLite reads', () => {
  test('cookie-only returns linked owner and privileges without legacy reads or self-heal writes', async () => {
    expect(await requireStrict(true)).toMatchObject({ source: 'better-auth-session', user: { id: 7, is_admin: 1, is_review_exempt: 1 } });
    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(mocks.getSession).toHaveBeenCalledWith({ headers: expect.any(Headers), query: { disableCookieCache: true, disableRefresh: true } });
    expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.heal).not.toHaveBeenCalled();
  });

  test('bearer-only uses the throwing repository directly and maps existing privilege fields', async () => {
    expect(await requireStrict(false, 'owner-key')).toMatchObject({ source: 'legacy-bearer', user: { id: 7, is_admin: 1, is_review_exempt: 1 } });
    expect(mocks.getSession).not.toHaveBeenCalled(); expect(mocks.getAuth).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
  });

  test('cookie wins over conflicting bearer; an invalid cookie never silently changes owner', async () => {
    expect(await requireStrict(true, 'other-key')).toMatchObject({ source: 'better-auth-session', user: { id: 7 } });
    mocks.getSession.mockResolvedValueOnce(null);
    const expired = await requireStrict(true, 'other-key');
    expect('response' in expired && expired.response.status).toBe(401);
    expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.heal).not.toHaveBeenCalled();
  });

  test('explicit bearer-only runtime ignores a cookie, even when its session backend is failing', async () => {
    vi.stubEnv('HONO_AUTH_MODE', 'bearer');
    mocks.getSession.mockRejectedValue(new Error('session down'));
    expect(await requireStrict(true, 'other-key')).toMatchObject({ source: 'legacy-bearer', user: { id: 8 } });
    const absent = await requireStrict(true);
    expect('response' in absent && absent.response.status).toBe(401);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  test.each(['missing', 'dangling', 'no-auth-user-id'])('valid session with %s mapping cannot guess owner by matching email or username', async (state) => {
    if (state === 'missing') sqlite.exec('DELETE FROM user_auth_links');
    if (state === 'dangling') sqlite.exec('UPDATE user_auth_links SET business_user_id=99');
    if (state === 'no-auth-user-id') mocks.getSession.mockResolvedValueOnce({ user: { email: 'owner@example.test', name: 'other' } });
    await expect(requireStrict(true, 'other-key')).rejects.toBeInstanceOf(AuthAccountUnavailableError);
    expect(mocks.heal).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
  });

  test('auth-link storage failure propagates and cannot fall through to a same-name business user', async () => {
    sqlite.exec('DROP TABLE user_auth_links');
    await expect(requireStrict(true, 'other-key')).rejects.toThrow();
    expect(mocks.heal).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
  });

  test('missing credentials, expired session, and invalid bearer remain genuine 401', async () => {
    for (const result of [await requireStrict(false), await requireStrict(false, 'missing-key')]) {
      expect('response' in result && result.response.status).toBe(401);
    }
    mocks.getSession.mockResolvedValueOnce(null);
    const expired = await requireStrict(true);
    expect('response' in expired && expired.response.status).toBe(401);
  });

  test.each([true, false])('banned owner cannot bypass via alternate credentials: cookie=%s', async (cookie) => {
    sqlite.exec("UPDATE users SET is_banned='banned' WHERE id=7");
    const result = await requireStrict(cookie, cookie ? 'other-key' : 'owner-key');
    expect('response' in result && result.response.status).toBe(403);
  });

  test.each([true, false])('runtime storage absence and query failure propagate, not unauthorized: cookie=%s', async (cookie) => {
    mocks.getDb.mockReturnValueOnce(null);
    await expect(requireStrict(cookie, 'owner-key')).rejects.toThrow('Authentication storage unavailable');
    sqlite.exec('DROP TABLE users');
    await expect(requireStrict(cookie, 'owner-key')).rejects.toThrow();
    expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.heal).not.toHaveBeenCalled();
  });

  test('session backend absence or failure propagates and never retries using bearer', async () => {
    mocks.getAuth.mockReturnValueOnce(null);
    await expect(requireStrict(true, 'owner-key')).rejects.toThrow('Session authentication unavailable');
    mocks.getSession.mockRejectedValueOnce(new Error('session storage failed'));
    await expect(requireStrict(true, 'owner-key')).rejects.toThrow('session storage failed');
    expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.getDb).not.toHaveBeenCalled();
  });

  test('default callers retain session failure fallback and legacy bearer behavior', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.getSession.mockRejectedValueOnce(new Error('legacy session behavior'));
    mocks.legacy.mockResolvedValueOnce({ id: 8, username: 'other' });
    expect(await auth(true).requireAuthUser(req('other-key'))).toMatchObject({ source: 'legacy-bearer', user: { id: 8 } });
    expect(mocks.legacy).toHaveBeenCalledWith('other-key');
  });
});

async function signedSessionFixture() {
  sqlite.exec(`CREATE TABLE ba_user (id TEXT PRIMARY KEY,name TEXT,email TEXT,email_verified INTEGER,image TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE ba_session (id TEXT PRIMARY KEY,expires_at INTEGER,token TEXT,ip_address TEXT,user_agent TEXT,user_id TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE ba_account (id TEXT PRIMARY KEY,account_id TEXT,provider_id TEXT,user_id TEXT,access_token TEXT,refresh_token TEXT,id_token TEXT,access_token_expires_at INTEGER,refresh_token_expires_at INTEGER,scope TEXT,password TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE ba_verification (id TEXT PRIMARY KEY,identifier TEXT,value TEXT,expires_at INTEGER,created_at INTEGER,updated_at INTEGER);`);
  const localAuth = betterAuth({
    database: drizzleAdapter(drizzle(sqlite, { schema }), { provider: 'sqlite', schema: {
      user: schema.baUsers, session: schema.baSessions, account: schema.baAccounts, verification: schema.baVerifications,
    } }),
    secret: 'local-test-only-better-auth-secret-with-sufficient-length',
    baseURL: 'http://localhost:3000',
    emailAndPassword: { enabled: true },
    session: { cookieCache: { enabled: true, maxAge: 300 } },
  });
  const signup = await localAuth.api.signUpEmail({
    body: { name: 'owner', email: 'owner@example.test', password: 'local-fixture-password' }, asResponse: true,
  });
  expect(signup.status).toBe(200);
  const body = await signup.json() as { user: { id: string } };
  sqlite.prepare('INSERT INTO user_auth_links (auth_user_id,business_user_id) VALUES (?,7)').run(body.user.id);
  const cookies = signup.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
  expect(cookies).toContain('session_data=');
  const request = new Request('http://localhost:3000/api/data-cards/recycle-owned?expectedUserId=7', { headers: { cookie: cookies } });
  mocks.getAuth.mockReturnValue(localAuth);
  return { localAuth, request };
}

describe('strict session options against the installed Better Auth and SQLite adapter', () => {
  test('valid sessions beyond the refresh threshold remain authenticated without extending expiration', async () => {
    const { request } = await signedSessionFixture();
    sqlite.prepare('UPDATE ba_session SET expires_at=?').run(Math.floor(Date.now() / 1000) + 60);
    const before = sqlite.prepare('SELECT * FROM ba_session').get();
    const changesBefore = sqlite.prepare('SELECT total_changes() AS count').get();
    expect(await auth(true).requireAuthUser(request, { strict: true })).toMatchObject({ source: 'better-auth-session', user: { id: 7 } });
    expect(sqlite.prepare('SELECT * FROM ba_session').get()).toEqual(before);
    expect(sqlite.prepare('SELECT total_changes() AS count').get()).toEqual(changesBefore);
    expect(mocks.heal).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
  });

  test('a revoked authoritative session is rejected even while the signed cookie cache remains valid', async () => {
    const { localAuth, request } = await signedSessionFixture();
    sqlite.exec('DELETE FROM ba_session');
    // 证实该缓存确实能被库的默认配置读取，再验证严格路径绕过它。
    expect(await localAuth.api.getSession({ headers: request.headers })).not.toBeNull();
    const result = await auth(true).requireAuthUser(request, { strict: true });
    expect('response' in result && result.response.status).toBe(401);
    expect(mocks.heal).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
  });

  test('expired sessions are refused; the library may still perform its normal expired-session cleanup', async () => {
    const { request } = await signedSessionFixture();
    sqlite.prepare('UPDATE ba_session SET expires_at=?').run(Math.floor(Date.now() / 1000) - 60);
    const result = await auth(true).requireAuthUser(request, { strict: true });
    expect('response' in result && result.response.status).toBe(401);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM ba_session').get()).toEqual({ count: 0 });
    expect(mocks.heal).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
  });
});
