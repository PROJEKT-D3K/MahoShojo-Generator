import { describe, expect, it, vi } from 'vitest';
import { createDesktopOwnedCardRestorePort } from '../src/platform/cloud-restore';
const target = { id: 'owned', version: 'a'.repeat(64) };
const ack = { success: true, accountFenceVersion: 1, restoreProtocolVersion: 1, ownerUserId: 7, operation: 'restore', ...target };
const signal = () => new AbortController().signal;
describe('Desktop restore thin adapter', () => {
  it('uses fixed recycle snapshot and restore routes with frozen owner', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 200, body: ack });
    const port = createDesktopOwnedCardRestorePort(invoke, 7, () => true);
    await port.preview(target.id, signal()); await port.write(target, signal());
    expect(invoke.mock.calls).toEqual([
      ['cloud_card_library_request', { request: { routeId: 'data-cards.delete-preview.query', expectedUserId: 7, query: { scope: 'recycle', id: target.id } } }],
      ['cloud_card_library_request', { request: { routeId: 'data-cards.restore', expectedUserId: 7, body: { expectedUserId: 7, ...target } } }],
    ]);
  });
  it.each([400, 401, 404, 409, 500, 503])('never retries or falls back on HTTP %s', async status => {
    const invoke = vi.fn().mockResolvedValue({ status, body: { code: 'TARGET_CHANGED' } });
    expect(await createDesktopOwnedCardRestorePort(invoke, 7, () => true).write(target, signal())).toEqual({ status, body: { code: 'TARGET_CHANGED' } });
    expect(invoke).toHaveBeenCalledOnce();
  });
  it('rejects extra fields, invalid versions, stale epochs and aborted work before IPC', async () => {
    const invoke = vi.fn(); const port = createDesktopOwnedCardRestorePort(invoke, 7, () => true);
    for (const input of [{ ...target, version: 'bad' }, { ...target, data: {} }]) await expect(port.write(input as never, signal())).rejects.toThrow();
    await expect(createDesktopOwnedCardRestorePort(invoke, 7, () => false).write(target, signal())).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(port.write(target, controller.signal)).rejects.toThrow(); expect(invoke).not.toHaveBeenCalled();
  });
  it('settles abort immediately and discards late same-owner session completion', async () => {
    let resolve!: (response: unknown) => void;
    const invoke = vi.fn(() => new Promise(done => { resolve = done; }));
    let current = true; const port = createDesktopOwnedCardRestorePort(invoke, 7, () => current);
    const controller = new AbortController(); const result = port.write(target, controller.signal); controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' }); resolve({ status: 200, body: ack });
    const late = port.write(target, signal()); current = false; resolve({ status: 200, body: ack });
    await expect(late).rejects.toThrow('账号会话已改变'); expect(invoke).toHaveBeenCalledTimes(2);
  });
  it.each([{ ownerUserId: 8 }, { id: 'other' }, { version: 'b'.repeat(64) }, { operation: 'soft-delete' }, { deleteProtocolVersion: 1 }, { restoreProtocolVersion: 2 }])('rejects mismatched or extra acknowledgement fields %j', async patch => {
    const invoke = vi.fn().mockResolvedValue({ status: 200, body: { ...ack, ...patch } });
    await expect(createDesktopOwnedCardRestorePort(invoke, 7, () => true).write(target, signal())).rejects.toThrow('恢复响应无法验证');
    expect(invoke).toHaveBeenCalledOnce();
  });
  it('sanitizes transport errors without replaying', async () => {
    const invoke = vi.fn().mockRejectedValue({ code: 'network-error', message: 'Cookie: private' });
    await expect(createDesktopOwnedCardRestorePort(invoke, 7, () => true).write(target, signal())).rejects.toThrow('网络连接失败'); expect(invoke).toHaveBeenCalledOnce();
  });
});
