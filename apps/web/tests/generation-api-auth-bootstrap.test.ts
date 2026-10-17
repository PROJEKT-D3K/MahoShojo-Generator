// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authStorage } from '@/lib/auth';
import { AUTH_STORAGE_KEY } from '@/lib/auth-identity';
import { buildGenerationApiHeaders, createGenerationApiIntent } from '@/lib/hono-api-client';
import { honoApiConfig } from '@/config/hono-api';
import { AI_META_REQUEST_HEADER, AI_META_REQUEST_VALUE } from '@/lib/client/read-json-with-ai-meta';

const originalHonoConfig = { ...honoApiConfig };

const verified = {
  success: true,
  authSource: 'better-auth-session',
  authKey: 'synthetic-session-key',
  user: { id: 7, username: 'fixture-session' },
  activityToken: 'synthetic-activity-token',
};

const deferred = <T,>() => {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  localStorage.clear();
  authStorage.clearAuth();
});

afterEach(() => {
  authStorage.clearAuth();
  Object.assign(honoApiConfig, originalHonoConfig);
  vi.unstubAllGlobals();
});

describe('creation channels delegate request identity to the intent', () => {
  const channels = [
    ['/api/generate-magical-girl', false],
    ...['generate-scenario', 'generate-free', 'generate-canshou', 'generate-magical-girl-details', 'creator/generate', 'generate-sublimation']
      .flatMap((path) => [[`/api/${path}`, false], [`/api/${path}-stream?format=sse`, true]]),
  ] as Array<[string, boolean]>;

  it.each(channels)('%s retains its special headers, verifies once and never replays a failed POST', async (path, stream) => {
    honoApiConfig.enabled = false;
    honoApiConfig.routingMode = 'static-next';
    const verify = vi.fn(async () => Response.json({ success: false }, { status: 401 }));
    const business = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: 'synthetic unavailable' }, { status: 503 }));
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => String(input) === '/api/auth/verify' ? verify() : business(input, init)));
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (stream) headers.Accept = 'text/event-stream';
    else if (path !== '/api/generate-magical-girl') headers[AI_META_REQUEST_HEADER] = AI_META_REQUEST_VALUE;
    const intent = createGenerationApiIntent();

    await expect(intent.dispatch(path, { method: 'POST', headers, body: '{"fixture":true}' }))
      .rejects.toMatchObject({ code: 'AMBIGUOUS_OPERATION_OUTCOME' });
    await expect(intent.dispatch(path, { method: 'POST' })).rejects.toMatchObject({ code: 'GENERATION_INTENT_ALREADY_DISPATCHED' });

    expect(verify).toHaveBeenCalledOnce();
    expect(business).toHaveBeenCalledOnce();
    const [target, init] = business.mock.calls[0]!;
    expect(target).toBe(path);
    expect(init?.body).toBe('{"fixture":true}');
    expect(init?.credentials).toBe('same-origin');
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual(Object.fromEntries(new Headers(headers)));
  });
});

const mockVerify = (response: () => Promise<Response>) => {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toBe('/api/auth/verify');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    return response();
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};

describe('generation request auth bootstrap', () => {
  it.each([401, 503])('无本地身份且 verify 返回 %s 时，一次头构造只校验一次会话', async (status) => {
    const fetcher = mockVerify(async () => Response.json({ success: false }, { status }));

    const headers = await buildGenerationApiHeaders(authStorage, { 'Content-Type': 'application/json' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('x-mahoshojo-activity-token')).toBeNull();
    expect(headers.get('x-mahoshojo-user-id')).toBeNull();
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(await authStorage.getAuth()).toBeNull();
  });

  it('会话请求网络失败仍只探测一次，并保持匿名头', async () => {
    const fetcher = mockVerify(async () => { throw new TypeError('synthetic network failure'); });

    const headers = await buildGenerationApiHeaders(authStorage, undefined);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect([...headers]).toEqual([]);
  });

  it('有效 cookie 会话的两类头共享一次 bootstrap，并保持调用方显式头优先', async () => {
    const fetcher = mockVerify(async () => Response.json(verified));

    const headers = await buildGenerationApiHeaders(authStorage, {
      Authorization: 'Bearer explicit-key',
      'x-mahoshojo-activity-token': 'explicit-activity',
      'Content-Type': 'application/json',
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(headers.get('Authorization')).toBe('Bearer explicit-key');
    expect(headers.get('x-mahoshojo-activity-token')).toBe('explicit-activity');
    expect(headers.get('x-mahoshojo-user-id')).toBe('7');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(await authStorage.getAuth()).toMatchObject({ userId: 7, authKey: verified.authKey });
  });

  it('已有本地凭证直接构造同一账号的头，不发 verify', async () => {
    await authStorage.setAuth({ username: 'fixture-local', userId: 9, authKey: 'synthetic-local-key', activityToken: 'synthetic-local-activity' });
    const fetcher = mockVerify(async () => { throw new Error('unexpected verify'); });

    const headers = await buildGenerationApiHeaders(authStorage, undefined);

    expect(fetcher).not.toHaveBeenCalled();
    expect(Object.fromEntries(headers)).toEqual({
      authorization: 'Bearer synthetic-local-key',
      'x-mahoshojo-activity-token': 'synthetic-local-activity',
      'x-mahoshojo-user-id': '9',
    });
  });

  it('本地只有 A 活动身份而 cookie 校验为 B 时，两类头都使用 B', async () => {
    await authStorage.setAuth({ username: 'fixture-old', userId: 3, activityToken: 'synthetic-old-activity' });
    const fetcher = mockVerify(async () => Response.json(verified));

    const headers = await buildGenerationApiHeaders(authStorage, undefined);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(headers)).toEqual({
      authorization: `Bearer ${verified.authKey}`,
      'x-mahoshojo-activity-token': verified.activityToken,
      'x-mahoshojo-user-id': '7',
    });
  });

  it('独立读取活动头仍会 bootstrap，失败结果不缓存到下一次头构造', async () => {
    const fetcher = mockVerify(async () => Response.json({ success: false }, { status: 401 }));
    expect(await authStorage.getActivityHeaders()).toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(1);

    await buildGenerationApiHeaders(authStorage, undefined);
    expect(fetcher).toHaveBeenCalledTimes(2);

    fetcher.mockImplementationOnce(async () => Response.json(verified));
    expect(await authStorage.getActivityHeaders()).toEqual({
      'x-mahoshojo-activity-token': verified.activityToken,
      'x-mahoshojo-user-id': '7',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('bootstrap 等待期间跨页换账号，旧校验不能返回旧头或覆盖新账号', async () => {
    await authStorage.setAuth({ username: 'fixture-new', userId: 9, authKey: 'synthetic-new-key', activityToken: 'synthetic-new-activity' });
    const newIdentity = localStorage.getItem(AUTH_STORAGE_KEY)!;
    authStorage.clearAuth();
    const gate = deferred<Response>();
    const entered = deferred<void>();
    const fetcher = mockVerify(async () => { entered.resolve(); return gate.promise; });

    const pending = buildGenerationApiHeaders(authStorage, undefined);
    await entered.promise;
    localStorage.setItem(AUTH_STORAGE_KEY, newIdentity);
    window.dispatchEvent(new StorageEvent('storage', { key: AUTH_STORAGE_KEY, newValue: newIdentity, storageArea: localStorage }));
    gate.resolve(Response.json(verified));
    const headers = await pending;

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('x-mahoshojo-activity-token')).not.toBe(verified.activityToken);
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe(newIdentity);
    expect(await authStorage.getAuth()).toMatchObject({ userId: 9, authKey: 'synthetic-new-key' });
  });

  it.each(['auth', 'activity'])('%s 头获取抛错仍拒绝构造请求', async (kind) => {
    const error = new Error(`synthetic ${kind} failure`);
    const readActivity = vi.fn(async () => { if (kind === 'activity') throw error; return {}; });
    await expect(buildGenerationApiHeaders({
      getAuthHeader: async () => { if (kind === 'auth') throw error; return null; },
      getActivityHeaders: readActivity,
    }, undefined)).rejects.toBe(error);
    expect(readActivity).toHaveBeenCalledTimes(kind === 'auth' ? 0 : 1);
  });

  it('无参注入实现仍兼容，且活动头读取发生在认证完成之后', async () => {
    const order: string[] = [];
    const headers = await buildGenerationApiHeaders({
      getAuthHeader: async () => { await Promise.resolve(); order.push('auth'); return 'Bearer injected'; },
      getActivityHeaders: async () => { order.push('activity'); return { 'x-mahoshojo-user-id': '19' }; },
    }, undefined);
    expect(order).toEqual(['auth', 'activity']);
    expect(headers.get('Authorization')).toBe('Bearer injected');
    expect(headers.get('x-mahoshojo-user-id')).toBe('19');
  });
});
