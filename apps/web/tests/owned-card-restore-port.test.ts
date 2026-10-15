import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createOwnedCardRestoreController } from '@mahoshojo/ui-web/cloud-save';
const auth = vi.hoisted(() => ({ getAuth: vi.fn(), getAuthHeader: vi.fn(), clearAuth: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authStorage: auth }));
import { createWebOwnedCardRestorePort } from '@/lib/owned-card-restore';
const target = { id: 'card', version: 'a'.repeat(64) };
const preview = { success: true, accountFenceVersion: 1, deleteProtocolVersion: 1, ownerUserId: 7, operation: 'preview-recycle', targets: [{ ...target, type: 'history', name: '卡', description: null }], total: 1, recycleLimit: 5 };
const ack = { success: true, accountFenceVersion: 1, restoreProtocolVersion: 1, ownerUserId: 7, operation: 'restore', ...target };
let current: boolean; const fetcher = vi.fn();
const port = () => createWebOwnedCardRestorePort(7, { epoch: 1, isCurrent: () => current });
beforeEach(() => { current = true; fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); auth.getAuth.mockResolvedValue({ userId: 7, authKey: 'saved' }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('one click internal preview and exact fixed POST, cookie-only no bootstrap', async () => {
  auth.getAuth.mockResolvedValue(null); fetcher.mockResolvedValueOnce(Response.json(preview)).mockResolvedValueOnce(Response.json(ack));
  const owner = createOwnedCardRestoreController(port()); await owner.restore('card');
  expect(owner.getSnapshot().phase).toBe('success'); expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][0]).toBe('/api/data-cards/delete-preview-owned?expectedUserId=7&scope=recycle&id=card');
  expect(fetcher.mock.calls[1][0]).toBe('/api/data-cards/restore-owned');
  expect(fetcher.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store' }));
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ expectedUserId: 7, ...target });
  expect(auth.getAuthHeader).not.toHaveBeenCalled(); expect(auth.clearAuth).not.toHaveBeenCalled();
});
it.each([200, 201, 404, 409, 500, 503])('malformed HTTP %s never implies success/rejection or fallback', async status => {
  fetcher.mockResolvedValueOnce(Response.json(preview)).mockResolvedValueOnce(new Response('html', { status }));
  const owner = createOwnedCardRestoreController(port()); await owner.restore('card'); await owner.restore('card');
  expect(owner.getSnapshot().phase).toBe('unknown'); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('bounded response, abort timeout and network failure do not retry', async () => {
  fetcher.mockResolvedValueOnce(Response.json(preview)).mockResolvedValueOnce(new Response('x'.repeat(128 * 1024 + 1)));
  const owner = createOwnedCardRestoreController(port()); await owner.restore('card'); expect(owner.getSnapshot().phase).toBe('unknown'); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('late same-account session completion cannot refresh or release another generation guard', async () => {
  let resolve!: (value: Response) => void;
  fetcher.mockResolvedValueOnce(Response.json(preview)).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
  const changes = vi.fn(), refresh = vi.fn(); const owner = createOwnedCardRestoreController({ ...port(), onBusyChange: changes, onChanged: refresh });
  const pending = owner.restore('card'); while (!resolve) await Promise.resolve();
  current = false; owner.invalidate(); resolve(Response.json(ack)); await pending;
  expect(refresh).not.toHaveBeenCalled(); expect(changes.mock.calls).toEqual([[true]]);
});
it('invalid owner rejected before any request', async () => {
  auth.getAuth.mockResolvedValue({ userId: 8 }); const owner = createOwnedCardRestoreController(port()); await owner.restore('card');
  expect(owner.getSnapshot().phase).toBe('rejected'); expect(fetcher).not.toHaveBeenCalled();
});
