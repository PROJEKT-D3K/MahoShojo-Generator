import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { AppDrizzleDb } from '@/lib/db/drizzle';
import * as schema from '@/lib/db/schema';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), getAuth: vi.fn(), getSession: vi.fn(), legacy: vi.fn(), heal: vi.fn() }));
vi.mock('@/lib/db/drizzle', () => ({ getDrizzleDbFromRuntime: mocks.getDb }));
vi.mock('@/lib/auth/better-auth-app', () => ({ getBetterAuthInstance: mocks.getAuth }));
vi.mock('@/lib/database/users', () => ({ getUserByAuthKey: mocks.legacy, getUserByEmail: mocks.legacy, getUserById: mocks.legacy, getUserByUsername: mocks.legacy }));
vi.mock('@/lib/auth/user-auth-linking', () => ({ getLinkedBusinessUserByAuthUserId: mocks.heal, ensureAuthUserLink: mocks.heal }));
import handler from '@/app/api/data-cards/handler';

let sqlite: InstanceType<typeof Database>;
const session = { user: { id: 'session-owner', email: 'owner@example.test', name: 'owner' }, session: { userId: 'session-owner' } };
const request = ({ cookie = true, bearer = 'other-key', id = 'owner-card' } = {}) => new Request(`https://example.test/api/data-cards?id=${id}`, {
  method: 'DELETE', headers: { ...(cookie ? { cookie: 'better-auth.session_token=test-session' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
});
const state = () => sqlite.prepare('SELECT id, deleted_at, data FROM data_cards ORDER BY id').all();
const changes = () => sqlite.prepare('SELECT total_changes() AS count').get();

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
    CREATE TABLE data_cards (id TEXT PRIMARY KEY,user_id INTEGER,type TEXT,deleted_at TEXT,data TEXT);
    INSERT INTO users VALUES (7,'owner','owner@example.test','owner-key',NULL,NULL,NULL,1,1,20,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO users VALUES (8,'other','other@example.test','other-key',NULL,NULL,NULL,0,0,20,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO user_auth_links VALUES (1,'session-owner',7,NULL,NULL);
    INSERT INTO data_cards VALUES ('owner-card',7,'character',NULL,'{"owner":7}');
    INSERT INTO data_cards VALUES ('other-card',8,'character',NULL,'{"owner":8}');`);
});
afterEach(() => { sqlite.close(); vi.unstubAllEnvs(); });

describe('普通删除 opt-in 严格鉴权与真实账号映射', () => {
  test('cookie 对应的真实 link 优先于其他 bearer，只删除 cookie owner 卡', async () => {
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, message: '数据卡已移入回收站' });
    expect(state()).toEqual([
      { id: 'other-card', deleted_at: null, data: '{"owner":8}' },
      { id: 'owner-card', deleted_at: expect.any(String), data: '{"owner":7}' },
    ]);
    expect(mocks.getSession).toHaveBeenCalledWith({ headers: expect.any(Headers), query: { disableCookieCache: true, disableRefresh: true } });
    expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.heal).not.toHaveBeenCalled();
  });

  test('存在但失效的 cookie 不转用另一 bearer，返回真实 401 并零数据卡写入', async () => {
    mocks.getSession.mockResolvedValue(null);
    const before = state(), beforeChanges = changes();
    const response = await handler(request({ id: 'other-card' }));
    expect(response.status).toBe(401);
    expect(state()).toEqual(before); expect(changes()).toEqual(beforeChanges);
    expect(mocks.getDb).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.heal).not.toHaveBeenCalled();
  });

  test.each(['session-failure', 'runtime-missing', 'link-query-failure', 'missing-link', 'dangling-link'])('鉴权故障 %s 返回 503，零写入且不fallback或自愈', async (failure) => {
    if (failure === 'session-failure') mocks.getSession.mockRejectedValue(new Error('session storage down'));
    if (failure === 'runtime-missing') mocks.getDb.mockReturnValue(null);
    if (failure === 'link-query-failure') sqlite.exec('DROP TABLE user_auth_links');
    if (failure === 'missing-link') sqlite.exec('DELETE FROM user_auth_links');
    if (failure === 'dangling-link') sqlite.exec('UPDATE user_auth_links SET business_user_id=99');
    const before = state(), beforeChanges = changes();
    const response = await handler(request({ id: 'other-card' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'AUTH_UNAVAILABLE', error: '身份验证服务暂不可用，请稍后重试' });
    expect(state()).toEqual(before); expect(changes()).toEqual(beforeChanges);
    expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.heal).not.toHaveBeenCalled();
  });

  test('无 cookie 时有效 bearer 使用真实 owner 查询并正常删除', async () => {
    const response = await handler(request({ cookie: false, bearer: 'owner-key' }));
    expect(response.status).toBe(200);
    expect(sqlite.prepare('SELECT deleted_at FROM data_cards WHERE id=?').get('owner-card')).toEqual({ deleted_at: expect.any(String) });
    expect(mocks.getSession).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
  });

  test('显式 bearer-only runtime 保持有效 bearer 行为，不探测失败的 cookie 后端', async () => {
    vi.stubEnv('HONO_AUTH_MODE', 'bearer');
    mocks.getSession.mockRejectedValue(new Error('session storage down'));
    const response = await handler(request({ id: 'other-card' }));
    expect(response.status).toBe(200);
    expect(sqlite.prepare('SELECT deleted_at FROM data_cards WHERE id=?').get('owner-card')).toEqual({ deleted_at: null });
    expect(mocks.getSession).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
  });

  test('bearer 账号库失败也是 503，不能表现为未登录', async () => {
    sqlite.exec('DROP TABLE users');
    const before = state(), beforeChanges = changes();
    const response = await handler(request({ cookie: false, bearer: 'owner-key' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'AUTH_UNAVAILABLE' });
    expect(state()).toEqual(before); expect(changes()).toEqual(beforeChanges);
  });
});
