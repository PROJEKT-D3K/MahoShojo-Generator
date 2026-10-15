import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOwnedCardDeleteController, verifyOwnedDeleteResponse, type DeleteWrite } from '@mahoshojo/ui-web/cloud-save';
const auth = vi.hoisted(() => ({ getAuth: vi.fn(), getAuthHeader: vi.fn(), clearAuth: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authStorage: auth }));
import { createWebOwnedCardDeletePort } from '@/lib/owned-card-delete';
const target = { id: 'card', version: 'a'.repeat(64), type: 'history', name: '叙事历史', description: null };
const preview = { success: true, accountFenceVersion: 1, deleteProtocolVersion: 1, ownerUserId: 7, operation: 'preview-active', targets: [target], total: 1, recycleLimit: 5 };
let current: boolean; const fetcher = vi.fn();
const port = () => createWebOwnedCardDeletePort(7, { epoch: 1, isCurrent: () => current });
const signal = () => new AbortController().signal;
beforeEach(() => { current = true; fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); auth.getAuth.mockResolvedValue({ userId: 7, authKey: 'saved' }); });
describe('Web owned delete transport', () => {
  it.each([null, { userId: 7, authKey: null }])('cookie-only preview has frozen owner and no auth bootstrap: %s', async value => {
    auth.getAuth.mockResolvedValue(value); fetcher.mockResolvedValue(Response.json(preview)); await port().preview('active', 'card', signal());
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/data-cards/delete-preview-owned?expectedUserId=7&scope=active&id=card', expect.objectContaining({ method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: {} }));
    expect(auth.getAuthHeader).not.toHaveBeenCalled(); expect(auth.clearAuth).not.toHaveBeenCalled();
  });
  it('single write sends exact owner/id/version only and never uses legacy endpoint', async () => {
    fetcher.mockResolvedValue(Response.json({ success: true })); await port().write({ operation: 'purge-active', target: { id: target.id, version: target.version } }, signal());
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/data-cards/purge-active-owned', expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: target.id, version: target.version, expectedUserId: 7 }) }));
  });
  it('clear preserves explicit targets and continuationTarget with no filter', async () => {
    fetcher.mockResolvedValue(Response.json({})); await port().write({ operation: 'purge-recycle', targets: [{ id: 'old', version: 'b'.repeat(64) }], continuationTarget: { id: target.id, version: target.version } }, signal());
    const body = JSON.parse(fetcher.mock.calls[0]![1].body); expect(body).toEqual({ expectedUserId: 7, targets: [{ id: 'old', version: 'b'.repeat(64) }], continuationTarget: { id: target.id, version: target.version } });
  });
  it.each([404, 405, 409, 500, 503])('HTTP %s remains one fixed request with no fallback/retry', async status => {
    fetcher.mockResolvedValue(new Response('<html>unavailable</html>', { status })); const input: DeleteWrite = { operation: 'soft-delete', target: { id: target.id, version: target.version } };
    const result = await port().write(input, signal()); expect(result).toEqual({ status, body: null }); expect(fetcher).toHaveBeenCalledOnce(); expect(verifyOwnedDeleteResponse(result, 7, input)).toBe(status >= 500 ? 'unknown' : 'rejected');
  });
  it('malformed2xx through the real transport becomes unknown and cannot replay', async () => {
    fetcher.mockResolvedValueOnce(Response.json(preview)).mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const owner = createOwnedCardDeleteController(port()); await owner.beginActive('card'); await owner.confirm(); await owner.confirm(); expect(owner.getSnapshot().phase).toBe('unknown'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('identity change while write pending is unknown rather than false rejection', async () => {
    let resolve!: (value: Response) => void; fetcher.mockResolvedValueOnce(Response.json(preview)).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const owner = createOwnedCardDeleteController(port()); await owner.beginActive('card'); const write = owner.confirm(); await Promise.resolve(); current = false; resolve(Response.json({ success: true })); await write;
    expect(owner.getSnapshot().phase).toBe('unknown'); expect(auth.clearAuth).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('wrong owner and invalid payload fail before fetch', async () => {
    auth.getAuth.mockResolvedValue({ userId: 8 }); await expect(port().preview('active', 'card', signal())).rejects.toThrow();
    expect(() => port().write({ operation: 'purge-recycle', targets: [] }, signal())).toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
});
it('new Web ports in the same captured identity retain deletion warnings; new identities do not', () => {
  const identity = { epoch: 1, isCurrent: () => true };
  const first = createWebOwnedCardDeletePort(7, identity); first.notice!.uncertain = true;
  const next = createWebOwnedCardDeletePort(7, identity);
  expect(next.notice).toBe(first.notice); expect(createOwnedCardDeleteController(next).getSnapshot().phase).toBe('unknown');
  expect(createWebOwnedCardDeletePort(8, identity).notice!.uncertain).toBe(false);
  expect(createWebOwnedCardDeletePort(7, { epoch: 2, isCurrent: () => true }).notice!.uncertain).toBe(false);
});
