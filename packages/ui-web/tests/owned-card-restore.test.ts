import { expect, test, vi } from 'vitest';
import { createOwnedCardRestoreController, verifyOwnedRestoreResponse, type OwnedCardRestorePort } from '../src/cloud-save/owned-card-restore';
const target = { id: 'r1', version: 'a'.repeat(64) };
const ack = { success: true, accountFenceVersion: 1, restoreProtocolVersion: 1, ownerUserId: 7, operation: 'restore', ...target };
function setup(overrides: Partial<OwnedCardRestorePort> = {}) {
  const port: OwnedCardRestorePort = { expectedUserId: 7, isCurrent: () => true,
    preview: vi.fn(async () => ({ status: 200, body: { success: true, accountFenceVersion: 1, deleteProtocolVersion: 1, ownerUserId: 7, operation: 'preview-recycle', targets: [{ ...target, type: 'character', name: 'r1', description: null }], total: 1, recycleLimit: 10 } })),
    write: vi.fn(async () => ({ status: 200, body: ack })), onBusyChange: vi.fn(), onChanged: vi.fn(), ...overrides };
  return { port, controller: createOwnedCardRestoreController(port) };
}
test('one click reads fresh snapshot, holds guard synchronously and emits one precise success', async () => {
  const { port, controller } = setup(); const first = controller.restore('r1'); void controller.restore('r1');
  expect(port.onBusyChange).toHaveBeenCalledWith(true); await first;
  expect(port.preview).toHaveBeenCalledTimes(1); expect(port.write).toHaveBeenCalledTimes(1);
  expect(port.write).toHaveBeenCalledWith(target, expect.any(AbortSignal)); expect(port.onChanged).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().phase).toBe('success');
});
test.each([{ ...ack, version: 'b'.repeat(64) }, { ...ack, ownerUserId: 8 }, { ...ack, id: 'r2' }, { ...ack, extra: true }])('wrong ack remains unknown', body => {
  expect(verifyOwnedRestoreResponse({ status: 200, body }, 7, target)).toBe('unknown');
});
test('unknown holds fence without retry, explicit dismissal enables a new fresh operation', async () => {
  const { port, controller } = setup({ write: vi.fn(async () => { throw Error('network'); }) });
  await controller.restore('r1'); await controller.restore('r1'); expect(controller.getSnapshot().phase).toBe('unknown');
  expect(port.write).toHaveBeenCalledTimes(1); expect(port.onBusyChange).not.toHaveBeenCalledWith(false); expect(port.onChanged).not.toHaveBeenCalled();
  controller.dismiss(); await controller.restore('r1'); expect(port.preview).toHaveBeenCalledTimes(2);
});
test('read failure never dispatches and stale completion never refreshes', async () => {
  const { port, controller } = setup({ preview: vi.fn(async () => ({ status: 503, body: {} })) });
  await controller.restore('r1'); expect(controller.getSnapshot().phase).toBe('rejected'); expect(port.write).not.toHaveBeenCalled();
  let resolve!: (value: { status: number; body: unknown }) => void;
  const deferred = { promise: new Promise<{ status: number; body: unknown }>(yes => { resolve = yes; }), resolve: (value: { status: number; body: unknown }) => resolve(value) }; const second = setup({ write: () => deferred.promise });
  const task = second.controller.restore('r1'); await Promise.resolve(); second.controller.invalidate(); deferred.resolve({ status: 200, body: ack }); await task;
  expect(second.port.onChanged).not.toHaveBeenCalled(); expect(second.controller.getSnapshot().phase).toBe('idle');
});
test('unverified errors cannot prove rejection', () => {
  expect(verifyOwnedRestoreResponse({ status: 409, body: {} }, 7, target)).toBe('unknown');
  expect(verifyOwnedRestoreResponse({ status: 409, body: { error: 'CAPACITY_EXCEEDED', code: 'CAPACITY_EXCEEDED' } }, 7, target)).toBe('capacity');
});
test('unmount during write preserves a session notice; same-session remount cannot replay or claim late success', async () => {
  let resolve!: (value: { status: number; body: unknown }) => void;
  const notice = { uncertain: false }; const pending = new Promise<{ status: number; body: unknown }>(yes => { resolve = yes; });
  const first = setup({ notice, write: () => pending }); const task = first.controller.restore('r1'); await Promise.resolve(); first.controller.suspend();
  const second = setup({ notice }); expect(second.controller.getSnapshot().phase).toBe('unknown'); await second.controller.restore('r1'); expect(second.port.write).not.toHaveBeenCalled();
  resolve({ status: 200, body: ack }); await task; expect(first.port.onChanged).not.toHaveBeenCalled();
  expect(second.controller.getSnapshot().phase).toBe('unknown'); second.controller.dismiss(); expect(notice.uncertain).toBe(false);
});
test('replacement render before old effect cleanup still inherits possible-dispatch notice', async () => {
  const notice = { uncertain: false }; let resolve!: (value: { status: number; body: unknown }) => void;
  const pending = new Promise<{ status: number; body: unknown }>(yes => { resolve = yes; });
  const first = setup({ notice, write: () => pending }); const task = first.controller.restore('r1'); await Promise.resolve();
  const replacement = setup({ notice }); expect(replacement.controller.getSnapshot().phase).toBe('unknown');
  first.controller.suspend(); await replacement.controller.restore('r1'); expect(replacement.port.write).not.toHaveBeenCalled();
  resolve({ status: 200, body: ack }); await task; expect(notice.uncertain).toBe(true);
});
test('unrelated idle cleanup cannot erase another controller unknown notice', async () => {
  const notice = { uncertain: false }; const idle = setup({ notice });
  const writer = setup({ notice, write: async () => { throw Error('lost'); } }); await writer.controller.restore('r1');
  expect(notice.uncertain).toBe(true); idle.controller.suspend(); expect(notice.uncertain).toBe(true);
  await idle.controller.restore('r1'); expect(idle.port.write).not.toHaveBeenCalled();
});
test('old unknown dismissal and cleanup cannot erase or resurrect a newer operation notice', async () => {
  const notice = { uncertain: false }; const first = setup({ notice, write: async () => { throw Error('lost'); } }); await first.controller.restore('r1');
  const stale = setup({ notice }); first.controller.dismiss(); stale.controller.suspend(); expect(notice.uncertain).toBe(false);
  const next = setup({ notice, write: async () => { throw Error('lost again'); } }); await next.controller.restore('r1');
  stale.controller.dismiss(); expect(notice.uncertain).toBe(true);
});
test('already mounted idle controller activates shared notice and offers an explicit exit', async () => {
  const notice = { uncertain: false }; const idle = setup({ notice }); const writer = setup({ notice, write: async () => { throw Error('lost'); } });
  await writer.controller.restore('r1'); idle.controller.activate(); expect(idle.controller.getSnapshot().phase).toBe('unknown');
  idle.controller.dismiss(); expect(notice.uncertain).toBe(false);
});
