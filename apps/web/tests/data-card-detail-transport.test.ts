// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authStorage } from '@/lib/auth';
import { getDataCardSummaryPage, loadFullDataCard } from '@/lib/data-card-list-client';

const summary = { id: 'card/a', name: '公开角色' };
const full = { ...summary, data: '{"name":"完整正文"}' };
const response = () => Response.json({ success: true, card: full });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
let releases: Array<() => void>;

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  authStorage.clearAuth();
  releases = [];
});
afterEach(async () => {
  releases.forEach((release) => release());
  await Promise.resolve();
  authStorage.clearAuth();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('data card detail transport follows its visibility source', () => {
  it.each(['public', 'favorites'] as const)('%s 正文不等待无响应的会话校验，也不读取本地凭证', async (source) => {
    const verification = deferred<Response>();
    releases.push(() => verification.resolve(Response.json({ success: false })));
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input) === '/api/auth/verify'
      ? verification.promise
      : response());
    vi.stubGlobal('fetch', fetcher);
    const getAuth = vi.spyOn(authStorage, 'getAuthHeader');
    const controller = new AbortController();
    const reading = loadFullDataCard(summary, source, controller.signal);
    releases.push(() => controller.abort());
    void reading.catch(() => undefined);

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      '/api/public-data-cards?id=card%2Fa', expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ), { timeout: 100 });
    expect(await reading).toEqual(full);
    expect(getAuth).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
  });

  it('我的私有卡仍等待认证并只访问所有者接口', async () => {
    const auth = deferred<string | null>();
    const getAuth = vi.spyOn(authStorage, 'getAuthHeader').mockReturnValue(auth.promise);
    releases.push(() => auth.resolve(null));
    const fetcher = vi.fn<typeof fetch>(async () => response());
    vi.stubGlobal('fetch', fetcher);
    const reading = loadFullDataCard(summary, 'my');
    expect(getAuth).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    auth.resolve('Bearer synthetic-owner');
    expect(await reading).toEqual(full);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('/api/data-cards?id=card%2Fa');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer synthetic-owner');
  });

  it('收藏摘要列表仍等待认证，不跟随公开正文绕过身份读取', async () => {
    const auth = deferred<string | null>();
    const getAuth = vi.spyOn(authStorage, 'getAuthHeader').mockReturnValue(auth.promise);
    releases.push(() => auth.resolve(null));
    const page = { success: true, cards: [], total: 0, nextOffset: null };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(page));
    vi.stubGlobal('fetch', fetcher);
    const reading = getDataCardSummaryPage('favorites', {});
    expect(getAuth).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    auth.resolve('Bearer synthetic-owner');
    expect(await reading).toEqual(page);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('/api/favorites?view=summary');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer synthetic-owner');
  });

  it('预先取消的公开详情不发请求，读取期间取消不重试', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    const before = new AbortController(); before.abort();
    await expect(loadFullDataCard(summary, 'public', before.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
    const during = new AbortController();
    const reading = loadFullDataCard(summary, 'public', during.signal);
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    during.abort();
    await rejected;
    await vi.runAllTimersAsync();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('公开正文消费也受30秒上限保护，并只按既有策略重试一次', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
    } as Response));
    vi.stubGlobal('fetch', fetcher);
    const rejected = expect(loadFullDataCard(summary, 'public')).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(60_500);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('404不回退到私有接口，也不把失败伪装为空卡', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: 'PUBLIC_CARD_NOT_FOUND' }, { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(loadFullDataCard(summary, 'public')).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('/api/public-data-cards?id=card%2Fa');
  });

  it.each([
    { success: false, error: '数据卡不存在或无权访问' },
    { success: true, card: summary },
  ])('HTTP成功但正文无效时仍拒绝，不能把摘要当完整卡', async (payload) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(payload));
    vi.stubGlobal('fetch', fetcher);
    await expect(loadFullDataCard(summary, 'public')).rejects.toThrow('数据卡不存在或无权访问');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('暂时失败保留原有有界重试，成功后返回完整卡', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('temporary', { status: 503 }))
      .mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetcher);
    const reading = loadFullDataCard(summary, 'favorites');
    await vi.advanceTimersByTimeAsync(500);
    expect(await reading).toEqual(full);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
