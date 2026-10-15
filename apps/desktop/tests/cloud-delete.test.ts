import { describe, expect, it, vi } from 'vitest';
import { createOwnedCardDeleteController, verifyOwnedDeleteResponse } from '@mahoshojo/ui-web/cloud-save';
import { createDesktopOwnedCardDeletePort } from '../src/platform/cloud-delete';
const target = { id: 'owned', version: 'a'.repeat(64), name: '原卡', description: null, type: 'character' };
const preview = { success: true, accountFenceVersion: 1, deleteProtocolVersion: 1, ownerUserId: 7, operation: 'preview-active', targets: [target], total: 1, recycleLimit: 5 };
const input = { operation: 'soft-delete' as const, target: { id: target.id, version: target.version } };
const signal = () => new AbortController().signal;
describe('Desktop confirmed-delete thin adapter', () => {
  it('uses fixed preview route and explicit owner without URL or credentials', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 200, body: preview }); const port = createDesktopOwnedCardDeletePort(invoke, 7, () => true);
    await port.preview('active', target.id, signal()); expect(invoke).toHaveBeenCalledExactlyOnceWith('cloud_card_library_request', { request: { routeId: 'data-cards.delete-preview.query', expectedUserId: 7, query: { scope: 'active', id: target.id } } });
  });
  it('clear carries exact versioned tombstones and continuation', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 409, body: { code: 'TARGET_CHANGED' } }); const port = createDesktopOwnedCardDeletePort(invoke, 7, () => true);
    await port.write({ operation: 'purge-recycle', targets: [{ id: 'old', version: 'b'.repeat(64) }], continuationTarget: input.target }, signal());
    expect(invoke).toHaveBeenCalledExactlyOnceWith('cloud_card_library_request', { request: { routeId: 'data-cards.purge-recycle', expectedUserId: 7, body: { expectedUserId: 7, targets: [{ id: 'old', version: 'b'.repeat(64) }], continuationTarget: input.target } } });
  });
  it.each([404, 405, 500, 503])('HTTP %s never falls back or replays', async status => {
    const invoke = vi.fn().mockResolvedValue({ status, body: null }); const port = createDesktopOwnedCardDeletePort(invoke, 7, () => true);
    const result = await port.write(input, signal()); expect(invoke).toHaveBeenCalledOnce(); expect(verifyOwnedDeleteResponse(result, 7, input)).toBe(status >= 500 ? 'unknown' : 'rejected');
  });
  it.each([{ code: 'not-authenticated', message: 'late epoch' }, { code: 'network-error', message: 'timeout' }, { code: 'bridge-invalid', message: 'malformed acknowledgement' }])('Native exception is unknown after send, never replayed: %s', async error => {
    const invoke = vi.fn().mockResolvedValueOnce({ status: 200, body: preview }).mockRejectedValueOnce(error); const owner = createOwnedCardDeleteController(createDesktopOwnedCardDeletePort(invoke, 7, () => true));
    await owner.beginActive(target.id); await owner.confirm(); await owner.confirm(); expect(owner.getSnapshot().phase).toBe('unknown'); expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('stale epoch before dispatch prevents IPC', async () => {
    const invoke = vi.fn(); const port = createDesktopOwnedCardDeletePort(invoke, 7, () => false); await expect(port.write(input, signal())).rejects.toThrow(); expect(invoke).not.toHaveBeenCalled();
  });
});
