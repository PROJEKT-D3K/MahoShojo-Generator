import { beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ getAuth: vi.fn(), getAuthHeader: vi.fn(), clearAuth: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authStorage: auth }));
import { createWebRecycleBinPort } from '@/lib/owned-recycle-bin';
const row = { id: 'c', name: 'n', description: null, type: 'character', is_public: 1, review_status: 'pending', created_at: null, updated_at: null, deleted_at: 'now', usage_count: 0, like_count: 0, isLegacyQuestionnaire: false };
const page = { success: true, accountFenceVersion: 1, ownerUserId: 7, cards: [row], total: 8, filteredCount: 1, nextOffset: null };
const fetcher = vi.fn();
let current: boolean;
const signal = () => new AbortController().signal;
const port = () => createWebRecycleBinPort(7, { epoch: 1, isCurrent: () => current });
beforeEach(() => { current = true; vi.stubGlobal('fetch', fetcher); fetcher.mockReset(); auth.getAuth.mockResolvedValue({ userId: 7, authKey: ' saved-bearer ' }); });
describe('Web owned recycle read adapter', () => {
  it.each([{ userId: 7, authKey: null }, null])('cookie-only uses one fixed GET, no bootstrap/verify/clear: %s', async (stored) => {
    auth.getAuth.mockResolvedValue(stored); fetcher.mockResolvedValue(Response.json(page));
    await expect(port().readPage({ limit: 12, offset: 0 }, signal())).resolves.toEqual(page);
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0]?.[0]).toContain('/api/data-cards/recycle-owned?');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: {} });
    expect(auth.getAuthHeader).not.toHaveBeenCalled(); expect(auth.clearAuth).not.toHaveBeenCalled();
  });
  it('only detail request carries selected id; raw source retained and bounded success ack required', async () => {
    const data = '{ "content": "原始正文" }'; fetcher.mockResolvedValue(Response.json({ success: true, accountFenceVersion: 1, ownerUserId: 7, card: { ...row, data } }));
    expect((await port().readDetail('c', signal())).data).toBe(data);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/data-cards/recycle-owned/detail?id=c&expectedUserId=7');
    expect(fetcher.mock.calls[0]?.[1].headers).toEqual({ Authorization: 'Bearer saved-bearer' });
  });
  it.each([401, 403, 404, 405, 503])('HTTP %s does not become empty or fallback/clear auth', async (status) => {
    fetcher.mockResolvedValue(new Response('', { status }));
    await expect(port().readPage({ limit: 12, offset: 0 }, signal())).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce(); expect(auth.clearAuth).not.toHaveBeenCalled();
  });
  it.each([{ ...page, ownerUserId: 8 }, { ...page, cards: [{ ...row, data: '{}' }] }, { ...page, accountFenceVersion: 2 },
    { ...page, nextOffset: 0 }, { ...page, filteredCount: 20 }, { ...page, cards: [{ ...row, deleted_at: null }] }])('rejects malformed or cross-owner page', async (body) => {
    fetcher.mockResolvedValue(Response.json(body)); await expect(port().readPage({ limit: 12, offset: 0 }, signal())).rejects.toThrow();
  });
  it('stale success/401 after identity change are discarded without affecting new account', async () => {
    let resolve!: (response: Response) => void; fetcher.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
    const result = port().readPage({ limit: 12, offset: 0 }, signal()); await Promise.resolve(); await Promise.resolve(); current = false; resolve(new Response('', { status: 401 }));
    await expect(result).rejects.toThrow('登录状态已改变'); expect(auth.clearAuth).not.toHaveBeenCalled();
  });
  it('rejects over-limit streamed bytes instead of parsing/truncating or falling back', async () => {
    fetcher.mockResolvedValue(new Response(' '.repeat(4 * 1024 * 1024 + 1))); await expect(port().readPage({ limit: 12, offset: 0 }, signal())).rejects.toThrow('响应过大'); expect(fetcher).toHaveBeenCalledOnce();
  });
});
