import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOwnedCardDeleteController, verifyOwnedDeleteResponse, type OwnedCardDeletePort, type DeleteResponse, type DeleteWrite } from '../src/cloud-save/owned-card-delete';
const active = { id: 'active', version: 'a'.repeat(64), name: '当前卡', type: 'character' as const, description: null };
const recycled = { id: 'recycled', version: 'b'.repeat(64), name: '旧卡', type: 'questionnaire' as const, description: null };
const preview = (scope: 'active' | 'recycle', targets = scope === 'active' ? [active] : [recycled]): DeleteResponse => ({ status: 200, body: { success: true, accountFenceVersion: 1, deleteProtocolVersion: 1, ownerUserId: 7, operation: `preview-${scope}`, targets, total: targets.length, recycleLimit: 5 } });
const success = (input: DeleteWrite): DeleteResponse => ({ status: 200, body: { success: true, accountFenceVersion: 1, deleteProtocolVersion: 1, ownerUserId: 7, operation: input.operation, ...(input.operation === 'purge-recycle' ? { ids: input.targets.map(target => target.id) } : { id: input.target.id }) } });
const full = { status: 409, body: { code: 'RECYCLE_BIN_FULL' } };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let port: OwnedCardDeletePort; let current: boolean; let blocked: boolean;
beforeEach(() => { current = true; blocked = false; port = { expectedUserId: 7, isCurrent: () => current, isBlocked: () => blocked, onBusyChange: vi.fn(value => { blocked = value; }), onChanged: vi.fn(), preview: vi.fn(async scope => preview(scope)), write: vi.fn(async input => success(input)) }; });
const fill = async () => { const owner = createOwnedCardDeleteController(port); vi.mocked(port.write).mockResolvedValueOnce(full); await owner.beginActive(active.id); await owner.confirm(); expect(owner.getSnapshot().phase).toBe('full'); return owner; };
describe('shared confirmed delete lifecycle', () => {
  it('soft deletion previews first, owns the page guard once, and keeps original full version', async () => {
    const owner = createOwnedCardDeleteController(port); await owner.beginActive('active');
    expect(port.write).not.toHaveBeenCalled(); expect(blocked).toBe(true); expect(owner.getSnapshot().phase).toBe('confirm-soft');
    await owner.confirm(); expect(port.write).toHaveBeenCalledExactlyOnceWith({ operation: 'soft-delete', target: { id: active.id, version: active.version } }, expect.any(AbortSignal));
    expect(port.onBusyChange).toHaveBeenNthCalledWith(1, true); expect(port.onBusyChange).toHaveBeenNthCalledWith(2, false); expect(owner.getSnapshot().phase).toBe('success');
  });
  it('full offers a separate active permanent confirmation, never dispatches by choosing', async () => {
    const owner = await fill(); owner.choosePurgeActive(); expect(port.write).toHaveBeenCalledTimes(1); expect(owner.getSnapshot().phase).toBe('confirm-purge-active');
    await owner.confirm(); expect(vi.mocked(port.write).mock.calls[1]?.[0]).toEqual({ operation: 'purge-active', target: { id: active.id, version: active.version } });
  });
  it('clear previews all types without a filter and sends confirmed snapshots plus original continuation', async () => {
    const owner = await fill(); await owner.chooseClear(); expect(port.preview).toHaveBeenLastCalledWith('recycle', undefined, expect.any(AbortSignal));
    expect(port.write).toHaveBeenCalledTimes(1); await owner.confirm();
    expect(vi.mocked(port.write).mock.calls.map(([input]) => input)).toEqual([
      { operation: 'soft-delete', target: { id: active.id, version: active.version } },
      { operation: 'purge-recycle', targets: [{ id: recycled.id, version: recycled.version }], continuationTarget: { id: active.id, version: active.version } },
      { operation: 'soft-delete', target: { id: active.id, version: active.version } },
    ]);
    expect(owner.getSnapshot().message).toBe('本次确认清单中的数据卡已永久删除，原卡已移入回收站'); expect(port.onChanged).toHaveBeenCalledOnce();
  });
  it.each(['RECYCLE_BIN_FULL', 'TARGET_CHANGED'])('clear success followed by %s keeps completed purge distinct', async code => {
    const owner = await fill(); await owner.chooseClear(); vi.mocked(port.write).mockImplementationOnce(async input => success(input)).mockResolvedValueOnce({ status: 409, body: { code } });
    await owner.confirm(); expect(owner.getSnapshot().phase).toBe('rejected'); expect(owner.getSnapshot().message).toContain('本次确认清单中的数据卡已永久删除，但原卡未移入'); expect(port.write).toHaveBeenCalledTimes(3);
  });
  it('phase-two unknown reports only the confirmed purge, never that the current recycle bin is empty', async () => {
    const owner = await fill(); await owner.chooseClear(); vi.mocked(port.write).mockImplementationOnce(async input => success(input)).mockResolvedValueOnce({ status: 503, body: null });
    await owner.confirm(); await owner.confirm(); expect(owner.getSnapshot().phase).toBe('unknown'); expect(owner.getSnapshot().message).toContain('本次确认清单中的数据卡已永久删除；原卡是否移入无法确认');
    expect(owner.getSnapshot().message).not.toContain('回收站已清空'); expect(port.write).toHaveBeenCalledTimes(3); expect(blocked).toBe(true); expect(port.onChanged).toHaveBeenCalledOnce();
  });
  it.each([{ status: 503, body: null }, { status: 200, body: {} }, { status: 200, body: { ...success({ operation: 'purge-recycle', targets: [{ id: 'recycled', version: recycled.version }] }).body as object, ids: ['other'] } }])('unknown phase one never dispatches stage two: %s', async response => {
    const owner = await fill(); await owner.chooseClear(); vi.mocked(port.write).mockResolvedValueOnce(response); await owner.confirm(); await owner.confirm();
    expect(port.write).toHaveBeenCalledTimes(2); expect(owner.getSnapshot().phase).toBe('unknown'); expect(blocked).toBe(true); owner.cancel(); expect(blocked).toBe(false);
  });
  it.each(['RECYCLE_BIN_FULL', 'TARGET_CHANGED'])('phase-one rejects %s without clearing or dispatching stage two', async code => {
    const owner = await fill(); await owner.chooseClear(); vi.mocked(port.write).mockResolvedValueOnce({ status: 409, body: { code } }); await owner.confirm();
    expect(owner.getSnapshot().phase).toBe('rejected'); expect(owner.getSnapshot().message).toContain('回收站未清空，原卡也未移入'); expect(port.write).toHaveBeenCalledTimes(2); expect(port.onChanged).not.toHaveBeenCalled();
  });
  it('transport exception is unknown and no check/empty-read path continues or retries', async () => {
    const owner = await fill(); await owner.chooseClear(); vi.mocked(port.write).mockRejectedValueOnce(new Error('network')); await owner.confirm();
    vi.mocked(port.preview).mockResolvedValueOnce(preview('recycle', [])); await owner.chooseClear(); await owner.confirm(); expect(port.write).toHaveBeenCalledTimes(2); expect(port.preview).toHaveBeenCalledTimes(2);
  });
  it('empty clear preview does not infer prior success or move active card', async () => {
    const owner = await fill(); vi.mocked(port.preview).mockResolvedValueOnce(preview('recycle', [])); await owner.chooseClear(); expect(port.write).toHaveBeenCalledTimes(1); expect(owner.getSnapshot().message).toContain('未继续移动原卡');
  });
  it('over-limit refuses truncated list and directs single-card organization', async () => {
    const owner = await fill(); vi.mocked(port.preview).mockResolvedValueOnce({ status: 409, body: { code: 'RECYCLE_TARGET_LIMIT' } }); await owner.chooseClear(); expect(owner.getSnapshot().message).toContain('逐个整理'); expect(port.write).toHaveBeenCalledTimes(1);
  });
  it('independent recycle delete previews a single tombstone and has no continuation', async () => {
    const owner = createOwnedCardDeleteController(port); await owner.beginRecycle(recycled.id); expect(port.preview).toHaveBeenCalledWith('recycle', recycled.id, expect.any(AbortSignal)); await owner.confirm(); expect(vi.mocked(port.write).mock.calls[0]?.[0]).toEqual({ operation: 'purge-recycle', targets: [{ id: recycled.id, version: recycled.version }] });
  });
  it('duplicate clicks are single-flight and pending write cannot close', async () => {
    const owner = await fill(); await owner.chooseClear(); const pending = deferred<DeleteResponse>(); vi.mocked(port.write).mockReturnValueOnce(pending.promise);
    const first = owner.confirm(); await owner.confirm(); expect(owner.cancel()).toBe(false); expect(port.write).toHaveBeenCalledTimes(2);
    pending.resolve(success({ operation: 'purge-recycle', targets: [recycled] })); await first; expect(port.write).toHaveBeenCalledTimes(3);
  });
  it.each(['invalidate', 'dispose', 'epoch'])('%s after phase-one dispatch prevents phase two and stale UI ownership', async kind => {
    const owner = await fill(); await owner.chooseClear(); const pending = deferred<DeleteResponse>(); vi.mocked(port.write).mockReturnValueOnce(pending.promise); const action = owner.confirm();
    if (kind === 'epoch') current = false; else owner[kind as 'invalidate' | 'dispose']();
    pending.resolve(success({ operation: 'purge-recycle', targets: [recycled] })); await action; expect(port.write).toHaveBeenCalledTimes(2); expect(port.onChanged).not.toHaveBeenCalled();
    expect(owner.getSnapshot().phase).toBe(kind === 'epoch' ? 'unknown' : 'idle');
  });
  it('close during preview aborts it and never claims late target', async () => {
    const pending = deferred<DeleteResponse>(); vi.mocked(port.preview).mockReturnValueOnce(pending.promise); const owner = createOwnedCardDeleteController(port); const action = owner.beginActive('active'); owner.cancel();
    expect(vi.mocked(port.preview).mock.calls[0]?.[2].aborted).toBe(true); pending.resolve(preview('active')); await action; expect(owner.getSnapshot().phase).toBe('idle'); expect(port.write).not.toHaveBeenCalled(); expect(blocked).toBe(false);
  });
  it('new/create/replacement/metadata/recycle busy guard prevents preview', async () => {
    blocked = true; const owner = createOwnedCardDeleteController(port); await owner.beginActive('active'); await owner.beginRecycle(); expect(port.preview).not.toHaveBeenCalled(); expect(port.onBusyChange).not.toHaveBeenCalled();
  });
  it.each([{ ownerUserId: 9 }, { operation: 'preview-recycle' }, { total: 0 }, { targets: [{ ...active, version: 'short' }] }, { targets: [{ ...active, id: 'wrong' }] }])('invalid preview never enables delete: %s', async patch => {
    vi.mocked(port.preview).mockResolvedValueOnce({ status: 200, body: { ...preview('active').body as object, ...patch } }); const owner = createOwnedCardDeleteController(port); await owner.beginActive('active'); await owner.confirm(); expect(owner.getSnapshot().phase).toBe('rejected'); expect(port.write).not.toHaveBeenCalled();
  });
});
describe('strict delete acknowledgements', () => {
  const request: DeleteWrite = { operation: 'purge-recycle', targets: [active, recycled] };
  it.each([{ ownerUserId: 8 }, { deleteProtocolVersion: 0 }, { accountFenceVersion: 2 }, { operation: 'purge-active' }, { ids: ['active'] }, { ids: ['active', 'other'] }, { ids: ['active', 'active'] }, { extra: true }])('malformed success is unknown: %s', patch => {
    expect(verifyOwnedDeleteResponse({ status: 200, body: { ...success(request).body as object, ...patch } }, 7, request)).toBe('unknown');
  });
  it('accepts exact sets in either order, never a subset', () => expect(verifyOwnedDeleteResponse({ status: 200, body: { ...success(request).body as object, ids: ['recycled', 'active'] } }, 7, request)).toBe('success'));
});
