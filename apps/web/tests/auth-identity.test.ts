// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi, authStorage } from '@/lib/auth';
import { beginAuthIdentityTransition, captureAuthIdentity } from '@/lib/auth-identity';
import { ensureAuthState, getAuthSnapshot, loginAndSyncAuthState, logoutAndSyncAuthState, refreshAuthBadges, registerAndSyncAuthState, resetAuthStoreForTests, subscribeAuthSnapshot } from '@/lib/auth-client-store';

const KEY = 'mahoshojo_auth';
const CHANGE = 'mahoshojo_auth_change';
const a = { username: 'fixture-a', userId: 101, authKey: 'synthetic-a' };
const b = { username: 'fixture-b', userId: 202, authKey: 'synthetic-b' };
const deferred = <T,>() => {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const verified = (auth = a, extra = {}) => ({ success: true, authSource: 'better-auth-session',
  user: { id: auth.userId, username: auth.username }, authKey: auth.authKey, badges: [], ...extra });
let rawA: string;
let rawB: string;
let serverAuth = a;
let stop: (() => void) | undefined;
const releases: Array<() => void> = [];
const switchStorage = (value: string | null, key: string | null = KEY) => {
  const oldValue = localStorage.getItem(KEY);
  if (value === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, value);
  window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue: value, storageArea: localStorage }));
};

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  localStorage.clear();
  resetAuthStoreForTests();
  await authStorage.setAuth(b);
  rawB = localStorage.getItem(KEY)!;
  await authStorage.setAuth(a);
  rawA = localStorage.getItem(KEY)!;
  serverAuth = a;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
    const path = String(input);
    if (path === '/api/auth/verify') return Response.json(verified(serverAuth));
    if (path === '/api/badges/user') return Response.json({ success: true, badges: [] });
    if (path === '/api/auth/sign-out') return Response.json({ success: true });
    throw new Error(`Unexpected fixture path: ${path}`);
  }));
  await ensureAuthState();
});
afterEach(async () => {
  stop?.(); stop = undefined;
  releases.splice(0).forEach((release) => release());
  vi.restoreAllMocks();
  authStorage.clearAuth();
  resetAuthStoreForTests();
  vi.unstubAllGlobals();
});

describe('shared Web auth identity ownership', () => {
  it('合法 own commit 续签仅当前操作，旧 guard 与同账号旧凭据不会复活', async () => {
    const original = captureAuthIdentity();
    const marker = localStorage.getItem(CHANGE);
    const owner = beginAuthIdentityTransition();
    const beforeCommit = owner.identity;
    expect(original.isCurrent()).toBe(false);
    expect(localStorage.getItem(CHANGE)).toBe(marker);
    await authStorage.setAuth({ ...a, authKey: 'synthetic-a-rotated' }, owner);
    expect(owner.identity.isCurrent()).toBe(true);
    expect(beforeCommit.isCurrent()).toBe(false);
    expect(localStorage.getItem(CHANGE)).not.toBe(marker);
    expect((await authStorage.getAuth())?.authKey).toBe('synthetic-a-rotated');
  });

  it('跨页 storage.clear 与同字节 A→null→A 都撤销共享快照和旧 guard', async () => {
    const original = captureAuthIdentity();
    switchStorage(null, null);
    expect(getAuthSnapshot().user).toBeNull();
    switchStorage(rawA);
    expect(original.isCurrent()).toBe(false);
    expect(getAuthSnapshot().user).toBeNull();
    await ensureAuthState();
    expect(getAuthSnapshot().user?.id).toBe(101);
    expect(original.isCurrent()).toBe(false);
  });

  it.each([true, false])('旧 verify success=%s 迟到不覆盖或清除新账号', async (success) => {
    const gate = deferred<Response>();
    const entered = deferred<void>();
    releases.push(() => gate.resolve(Response.json({ success: false })));
    vi.mocked(fetch).mockImplementationOnce(async () => { entered.resolve(); return gate.promise; });
    resetAuthStoreForTests();
    const checking = ensureAuthState();
    await entered.promise;
    serverAuth = b;
    switchStorage(rawB);
    await ensureAuthState();
    const newRaw = localStorage.getItem(KEY);
    gate.resolve(Response.json(success ? verified(a) : { success: false }));
    await checking;
    expect(getAuthSnapshot().user?.id).toBe(202);
    expect(getAuthSnapshot().loading).toBe(false);
    expect(localStorage.getItem(KEY)).toBe(newRaw);
    expect((await authStorage.getAuth())?.userId).toBe(202);
  });

  it('旧徽章回执不能覆盖已验证的新账号', async () => {
    const gate = deferred<Response>();
    const entered = deferred<void>();
    releases.push(() => gate.resolve(Response.json({ success: true, badges: [] })));
    vi.mocked(fetch).mockImplementationOnce(async () => { entered.resolve(); return gate.promise; });
    const checking = refreshAuthBadges();
    await entered.promise;
    serverAuth = b;
    switchStorage(rawB);
    await ensureAuthState();
    gate.resolve(Response.json({ success: true, badges: [{ id: 'old-a' }] }));
    await checking;
    expect(getAuthSnapshot()).toMatchObject({ user: { id: 202 }, userBadges: [], badgesLoading: false });
  });

  it('旧 bootstrap 迟到不能复活 A 或返回 A header', async () => {
    authStorage.clearAuth();
    const gate = deferred<Response>();
    const entered = deferred<void>();
    releases.push(() => gate.resolve(Response.json({ success: false })));
    vi.mocked(fetch).mockImplementationOnce(async () => { entered.resolve(); return gate.promise; });
    const reading = authStorage.getAuthHeader();
    await entered.promise;
    serverAuth = b;
    switchStorage(rawB);
    gate.resolve(Response.json(verified(a)));
    expect(await reading).toBeNull();
    expect(localStorage.getItem(KEY)).toBe(rawB);
    expect((await authStorage.getAuth())?.userId).toBe(202);
  });

  it('旧 decrypt 完成不会污染新账号缓存', async () => {
    // 强制 A 密文走实际解密，而非先前 setAuth 的明文缓存。
    await authStorage.setAuth(b);
    switchStorage(rawA);
    const gate = deferred<void>();
    const entered = deferred<void>();
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    releases.push(() => gate.resolve());
    vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => {
      entered.resolve(); await gate.promise; return decrypt(...args);
    });
    const reading = authStorage.getAuth();
    await entered.promise;
    switchStorage(rawB);
    expect((await authStorage.getAuth())?.userId).toBe(202);
    gate.resolve();
    expect(await reading).toBeNull();
    expect((await authStorage.getAuth())?.userId).toBe(202);
  });

  it('旧加密写入 await 后不能覆盖 B', async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    releases.push(() => gate.resolve());
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
      entered.resolve(); await gate.promise; return encrypt(...args);
    });
    const saving = authStorage.setAuth({ ...a, authKey: 'synthetic-a-new' });
    await entered.promise;
    switchStorage(rawB);
    gate.resolve();
    await saving;
    expect(localStorage.getItem(KEY)).toBe(rawB);
    expect((await authStorage.getAuth())?.userId).toBe(202);
  });

  it('外部通知触发的 verify 不重写相同凭据，普通完全相同 verify 也保持原密文', async () => {
    // beforeEach 的原输入字段顺序与 verify 组装顺序不同，但值完全相同。
    expect(localStorage.getItem(KEY)).toBe(rawA);
    const stored = localStorage.getItem(KEY);
    const marker = localStorage.getItem(CHANGE);
    await authApi.verify();
    expect(localStorage.getItem(KEY)).toBe(stored);
    stop = subscribeAuthSnapshot(() => undefined);
    vi.mocked(fetch).mockImplementation(async () => Response.json(verified(a, { activityToken: 'synthetic-renewed' })));
    switchStorage(stored);
    await ensureAuthState();
    expect(getAuthSnapshot().user?.id).toBe(101);
    expect(localStorage.getItem(KEY)).toBe(stored);
    expect(localStorage.getItem(CHANGE)).toBe(marker);
  });

  it('cookie-only 登录完成与退出广播 nonce；首 await 只撤销本页', async () => {
    authStorage.clearAuth();
    const loginGate = deferred<Response>();
    releases.push(() => loginGate.resolve(Response.json({ success: false })));
    vi.mocked(fetch).mockImplementationOnce(async () => loginGate.promise);
    const marker = localStorage.getItem(CHANGE);
    const loggingIn = loginAndSyncAuthState('fixture', 'synthetic-password', 'synthetic-turnstile');
    expect(getAuthSnapshot().user).toBeNull();
    expect(localStorage.getItem(CHANGE)).toBe(marker);
    loginGate.resolve(Response.json({ success: true, authMode: 'better-auth', user: { id: 101, username: a.username } }));
    await loggingIn;
    const completed = localStorage.getItem(CHANGE);
    expect(completed).not.toBe(marker);
    expect(getAuthSnapshot().user?.id).toBe(101);
    await logoutAndSyncAuthState();
    expect(localStorage.getItem(CHANGE)).not.toBe(completed);
    expect(getAuthSnapshot()).toMatchObject({ user: null, loading: false });
  });

  it.each(['login', 'logout'] as const)('auth 原值一直为 null 时 %s 完成仍广播且令原 guard 失效', async (action) => {
    authStorage.clearAuth();
    const original = captureAuthIdentity();
    const marker = localStorage.getItem(CHANGE);
    if (action === 'login') {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: true, authMode: 'better-auth', user: { id: 101, username: a.username } }));
      await authApi.login('fixture', 'synthetic-password', 'synthetic-turnstile');
    } else {
      await authApi.logout();
    }
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(CHANGE)).not.toBe(marker);
    expect(original.isCurrent()).toBe(false);
  });

  it('只收到无秘密完成 nonce 的别页也同步清除旧身份', async () => {
    const original = captureAuthIdentity();
    const oldValue = localStorage.getItem(CHANGE);
    localStorage.setItem(CHANGE, 'synthetic-completed-other-tab');
    window.dispatchEvent(new StorageEvent('storage', { key: CHANGE, oldValue, newValue: 'synthetic-completed-other-tab', storageArea: localStorage }));
    expect(getAuthSnapshot().user).toBeNull();
    expect(original.isCurrent()).toBe(false);
    expect(localStorage.getItem(KEY)).toBe(rawA);
    await ensureAuthState();
    expect(getAuthSnapshot().user?.id).toBe(101);
  });

  it('同账号重新登录首 await 撤销旧 guard，期间新 ensure 不抢占合法操作', async () => {
    const gate = deferred<Response>();
    releases.push(() => gate.resolve(Response.json({ success: false })));
    vi.mocked(fetch).mockImplementationOnce(async () => gate.promise);
    const original = captureAuthIdentity();
    const loggingIn = loginAndSyncAuthState('fixture', 'synthetic-password', 'synthetic-turnstile');
    expect(original.isCurrent()).toBe(false);
    expect(getAuthSnapshot()).toMatchObject({ user: null, loading: true });
    await ensureAuthState();
    expect(fetch).toHaveBeenCalledTimes(2); // beforeEach verify + 登录；没有并发旧身份 verify。
    gate.resolve(Response.json({ ...verified(a), authMode: 'better-auth' }));
    await loggingIn;
    expect(getAuthSnapshot()).toMatchObject({ user: { id: 101 }, loading: false });
    expect(original.isCurrent()).toBe(false);
  });

  it('失败登录重新验证旧身份且结束 loading；不发送未完成 begin 广播', async () => {
    const marker = localStorage.getItem(CHANGE);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: false, error: 'fixture denied' }));
    await loginAndSyncAuthState('fixture', 'synthetic-password', 'synthetic-turnstile');
    expect(getAuthSnapshot()).toMatchObject({ user: { id: 101 }, loading: false });
    expect(localStorage.getItem(CHANGE)).toBe(marker);
  });

  it('storage 读取异常 fail-closed，不保留身份或永久 loading', async () => {
    const original = captureAuthIdentity();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('synthetic storage denied'); });
    await ensureAuthState();
    expect(original.isCurrent()).toBe(false);
    expect(getAuthSnapshot()).toMatchObject({ user: null, loading: false, userBadges: [] });
    expect(await authStorage.getAuthHeader()).toBeNull();
  });

  it.each(['login', 'register'] as const)('操作开始时 storage 不可读，%s 返回明确本机失败且零请求', async (operation) => {
    const calls = vi.mocked(fetch).mock.calls.length;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('synthetic storage read denied'); });
    const result = operation === 'login'
      ? await loginAndSyncAuthState('fixture', 'synthetic-password', 'synthetic-turnstile')
      : await registerAndSyncAuthState('fixture', 'fixture@example.test', 'synthetic-turnstile', 'synthetic-password');
    expect(result).toMatchObject({ success: false, error: '本机登录信息更新失败，请检查浏览器存储设置后重试' });
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(getAuthSnapshot()).toMatchObject({ user: null, loading: false, userBadges: [] });
  });

  it('操作开始时 storage 不可读，logout 拒绝而非假报退出完成且零 signout', async () => {
    const calls = vi.mocked(fetch).mock.calls.length;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('synthetic storage read denied'); });
    await expect(logoutAndSyncAuthState()).rejects.toThrow('本机登录信息更新失败');
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(getAuthSnapshot()).toMatchObject({ user: null, loading: false, userBadges: [] });
  });

  it('signout await 期间 storage 才不可读，也拒绝本地清除且结束 loading', async () => {
    const gate = deferred<Response>();
    const entered = deferred<void>();
    releases.push(() => gate.resolve(Response.json({ success: true })));
    vi.mocked(fetch).mockImplementationOnce(async () => { entered.resolve(); return gate.promise; });
    const pending = logoutAndSyncAuthState();
    await entered.promise;
    expect(getAuthSnapshot().loading).toBe(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('synthetic storage read denied'); });
    const remove = vi.spyOn(Storage.prototype, 'removeItem');
    gate.resolve(Response.json({ success: true }));
    await expect(pending).rejects.toThrow('本机登录信息更新失败');
    expect(remove).not.toHaveBeenCalled();
    expect(getAuthSnapshot()).toMatchObject({ user: null, loading: false });
  });

  it('加密 await 期间 storage 才不可读，提交拒绝且不能假报保存完成', async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    releases.push(() => gate.resolve());
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
      entered.resolve(); await gate.promise; return encrypt(...args);
    });
    const pending = authStorage.setAuth({ ...a, authKey: 'synthetic-a-new' });
    await entered.promise;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('synthetic storage read denied'); });
    const write = vi.spyOn(Storage.prototype, 'setItem');
    gate.resolve();
    await expect(pending).rejects.toThrow('本机登录信息更新失败');
    expect(write).not.toHaveBeenCalled();
    expect(getAuthSnapshot()).toMatchObject({ user: null, loading: false });
  });

  it('登录等待徽章期间切号，最终回执也不能返回 A 成功', async () => {
    const gate = deferred<Response>();
    const entered = deferred<void>();
    releases.push(() => gate.resolve(Response.json({ success: true, badges: [] })));
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/auth/login') return Response.json({ ...verified(a), authMode: 'better-auth' });
      if (String(input) === '/api/badges/user') { entered.resolve(); return gate.promise; }
      return fallback(input, init);
    });
    const loggingIn = loginAndSyncAuthState('fixture', 'synthetic-password', 'synthetic-turnstile');
    await entered.promise;
    serverAuth = b;
    switchStorage(rawB);
    await ensureAuthState();
    gate.resolve(Response.json({ success: true, badges: [] }));
    expect(await loggingIn).toMatchObject({ success: false, error: '登录身份已变化，请重试' });
    expect(getAuthSnapshot().user?.id).toBe(202);
    expect(localStorage.getItem(KEY)).toBe(rawB);
  });

  it.each(['register', 'cookie-login'] as const)('%s 等待 verify 期间切号，最终回执不返回旧成功', async (operation) => {
    const gate = deferred<Response>();
    const entered = deferred<void>();
    releases.push(() => gate.resolve(Response.json({ success: false })));
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json(operation === 'register' ? verified(a) : { success: true, user: verified(a).user, authMode: 'better-auth' }))
      .mockImplementationOnce(async () => { entered.resolve(); return gate.promise; });
    const pending = operation === 'register'
      ? registerAndSyncAuthState('fixture', 'fixture@example.test', 'synthetic-turnstile', 'synthetic-password')
      : loginAndSyncAuthState('fixture', 'synthetic-password', 'synthetic-turnstile');
    await entered.promise;
    serverAuth = b;
    switchStorage(rawB);
    await ensureAuthState();
    gate.resolve(Response.json(verified(a)));
    expect(await pending).toMatchObject({ success: false, error: '登录身份已变化，请重试' });
    expect(getAuthSnapshot().user?.id).toBe(202);
    expect(localStorage.getItem(KEY)).toBe(rawB);
  });

  it.each(['login-badges', 'register-verify', 'cookie-login-verify'] as const)('%s 最终等待期间不可读，返回受控失败并结束 loading', async (operation) => {
    const gate = deferred<Response>();
    const entered = deferred<void>();
    releases.push(() => gate.resolve(Response.json({ success: false })));
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json(operation === 'cookie-login-verify'
        ? { success: true, user: verified(a).user, authMode: 'better-auth' }
        : { ...verified(a), authMode: 'better-auth' }))
      .mockImplementationOnce(async () => { entered.resolve(); return gate.promise; });
    const pending = operation === 'register-verify'
      ? registerAndSyncAuthState('fixture', 'fixture@example.test', 'synthetic-turnstile', 'synthetic-password')
      : loginAndSyncAuthState('fixture', 'synthetic-password', 'synthetic-turnstile');
    await entered.promise;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('synthetic storage read denied'); });
    gate.resolve(Response.json(operation === 'login-badges' ? { success: true, badges: [] } : verified(a)));
    expect(await pending).toMatchObject({ success: false, error: '本机登录信息更新失败，请检查浏览器存储设置后重试' });
    expect(getAuthSnapshot()).toMatchObject({ user: null, loading: false, userBadges: [], badgesLoading: false });
  });

  it('已被 B 取代的 owner 不把后续读取异常认领为自己的 IO 失败', async () => {
    const owner = beginAuthIdentityTransition();
    await authStorage.setAuth(b);
    const calls = vi.mocked(fetch).mock.calls.length;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('synthetic storage read denied'); });
    await expect(authApi.logout(owner)).resolves.toBeUndefined();
    expect(owner.failure).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it('认证原值与 nonce 两次写之间出现 B，不能将 B 的 raw 续签给 A', async () => {
    const owner = beginAuthIdentityTransition();
    const setItem = Storage.prototype.setItem;
    let inserted = false;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      setItem.call(this, key, value);
      if (key === KEY && !inserted) {
        inserted = true;
        setItem.call(this, KEY, rawB);
        setItem.call(this, CHANGE, 'synthetic-peer-commit');
        serverAuth = b;
      }
    });
    await authStorage.setAuth({ ...a, authKey: 'synthetic-a-rotated' }, owner);
    expect(owner.identity.isCurrent()).toBe(false);
    expect(localStorage.getItem(KEY)).toBe(rawB);
    await ensureAuthState();
    expect(getAuthSnapshot().user?.id).toBe(202);
    expect((await authStorage.getAuth())?.userId).toBe(202);
  });

  it('真实本地保存失败明确返回失败，不把服务端登录成功当本机已保存', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ...verified(a), authMode: 'better-auth' }));
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key === KEY) throw new Error('synthetic storage write denied');
      return setItem.call(this, key, value);
    });
    const result = await loginAndSyncAuthState('fixture', 'synthetic-password', 'synthetic-turnstile');
    expect(result).toMatchObject({ success: false, error: '本机登录信息更新失败，请检查浏览器存储设置后重试' });
    expect(getAuthSnapshot()).toMatchObject({ user: null, loading: false });
  });

  it('本地清除失败不得假报成功，也不声称服务器未登出', async () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('synthetic storage clear denied'); });
    await expect(logoutAndSyncAuthState()).rejects.toThrow('本机登录信息更新失败');
    expect(getAuthSnapshot()).toMatchObject({ user: null, loading: false });
    expect(localStorage.getItem(KEY)).toBe(rawA);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === '/api/auth/sign-out')).toBe(true);
  });

  it('旧 owner 的 clear 不清新账号，并非存储 IO 错误', async () => {
    const owner = beginAuthIdentityTransition();
    switchStorage(rawB);
    expect(() => authStorage.clearAuth(owner)).not.toThrow();
    expect(localStorage.getItem(KEY)).toBe(rawB);
  });

  it('旧 legacy 记录无 userId，但服务端明确验证本次 bearer 时保留该 key', async () => {
    await authStorage.setAuth({ username: a.username, authKey: a.authKey });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: true, authSource: 'legacy-bearer', authKey: null,
      user: { id: 101, username: a.username }, badges: [] }));
    await authApi.verify();
    expect(await authStorage.getAuth()).toEqual(a);
  });

  it('verify 另一账号缺少 key 时不能沿用 A 的 key', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: true, user: { id: 202, username: 'fixture-b' }, badges: [] }));
    await authApi.verify();
    expect(await authStorage.getAuth()).toEqual({ username: 'fixture-b', userId: 202 });
  });
});
