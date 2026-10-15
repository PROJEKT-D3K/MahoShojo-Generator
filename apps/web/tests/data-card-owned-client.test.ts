import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { authStorage, dataCardApi } from '@/lib/auth';
const auth = { userId: 7, username: 'owner', authKey: 'mock-only' };
const guard = { expectedUserId: 7, expectedAuth: auth, isCurrent: () => true };
const target = { id: 'c', type: 'character' as const, name: 'name', description: null, isPublic: 0 as const, reviewStatus: 'pending' as const, hasPendingUpdate: false, version: 'a'.repeat(64) };
const ack = { success: true, id: 'c', accountFenceVersion: 1, ownerUserId: 7, replacementVersion: 1, pendingReview: false };
beforeEach(() => { vi.spyOn(authStorage, 'getAuth').mockResolvedValue(auth); });
afterEach(() => vi.unstubAllGlobals());
describe('owned replacement Web client', () => {
  test('read and mutation use only owned path with frozen owner and no redirect', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ success: true, ownerUserId: 7, accountFenceVersion: 1, target }))
      .mockResolvedValueOnce(Response.json(ack)); vi.stubGlobal('fetch', fetcher);
    expect(await dataCardApi.readOwnedReplacementTarget('c', guard)).toEqual({ success: true, target });
    expect(await dataCardApi.replaceOwnedCard(target, { full: { extension: true } }, guard)).toEqual({ success: true, pendingReview: false });
    for (const [url, init] of fetcher.mock.calls) { expect(url).toContain('/api/data-cards/replace-owned'); expect(init.redirect).toBe('error'); }
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ id: 'c', type: 'character', expectedVersion: target.version, expectedUserId: 7, data: { full: { extension: true } } });
  });
  test.each([
    [200, ack, true, false],
    [200, { ...ack, ownerUserId: 8 }, false, true],
    [200, { ...ack, id: 'other' }, false, true],
    [200, { success: true }, false, true],
    [201, ack, false, true],
    [200, { ...ack, replacementVersion: 2 }, false, true],
    [500, ack, false, true], [503, {}, false, true], [409, { error: 'other' }, false, true],
    [409, { error: 'TARGET_CHANGED' }, false, false], [409, { error: 'ACCOUNT_MISMATCH' }, false, false],
    [400, {}, false, false], [401, {}, false, false], [403, {}, false, false], [404, {}, false, false], [405, {}, false, false], [413, {}, false, false], [429, {}, false, false],
  ])('strict ack or known refusal %s %j', async (status, body, success, uncertain) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(body, { status })); vi.stubGlobal('fetch', fetcher);
    const result = await dataCardApi.replaceOwnedCard(target, {}, guard);
    expect(result.success).toBe(success); expect(Boolean(result.uncertain)).toBe(uncertain); expect(fetcher).toHaveBeenCalledOnce();
  });
  test('network/redirect failure is uncertain and never retries', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('redirect')); vi.stubGlobal('fetch', fetcher);
    expect((await dataCardApi.replaceOwnedCard(target, {}, guard)).uncertain).toBe(true); expect(fetcher).toHaveBeenCalledOnce();
  });
  test('pre-send account or scope changes refuse without network', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect((await dataCardApi.replaceOwnedCard(target, {}, { ...guard, isCurrent: () => false })).success).toBe(false);
    vi.spyOn(authStorage, 'getAuth').mockResolvedValue({ ...auth, userId: 8 });
    expect((await dataCardApi.readOwnedReplacementTarget('c', guard)).success).toBe(false); expect(fetcher).not.toHaveBeenCalled();
  });
  test('late successful ack after account change remains uncertain', async () => {
    const fetcher = vi.fn().mockImplementation(async () => {
      vi.spyOn(authStorage, 'getAuth').mockResolvedValue({ ...auth, userId: 8 });
      return Response.json(ack);
    }); vi.stubGlobal('fetch', fetcher);
    expect(await dataCardApi.replaceOwnedCard(target, {}, guard)).toMatchObject({ success: false, uncertain: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

});

const metadataAck = { success: true, id: 'c', accountFenceVersion: 1, ownerUserId: 7, metadataVersion: 1 };
const metadataDraft = { name: '新名称', description: '描述', isPublic: 1 };
describe('owned metadata Web client', () => {
  test('writes only strict metadata to fixed owned endpoint with frozen owner and version', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(metadataAck)); vi.stubGlobal('fetch', fetcher);
    expect(await dataCardApi.updateOwnedCardMetadata(target, metadataDraft, guard)).toEqual({ success: true });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/data-cards/metadata-owned', expect.objectContaining({ method: 'PUT', redirect: 'error', credentials: 'same-origin' }));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ ...metadataDraft, id: 'c', expectedUserId: 7, expectedVersion: target.version });
  });
  test.each([[200, { ...metadataAck, ownerUserId: 8 }], [200, { ...metadataAck, id: 'other' }], [200, { ...metadataAck, metadataVersion: 2 }], [200, { ...metadataAck, extra: true }], [201, metadataAck], [500, {}], [503, {}], [409, { error: 'other' }]])('ambiguous ack/status %s never auto-replays or falls back', async (status, body) => {
    const fetcher = vi.fn(async () => Response.json(body, { status: status as number })); vi.stubGlobal('fetch', fetcher);
    expect(await dataCardApi.updateOwnedCardMetadata(target, metadataDraft, guard)).toMatchObject({ success: false, uncertain: true }); expect(fetcher).toHaveBeenCalledOnce();
  });
  test.each([400, 401, 403, 404, 405, 413, 429])('known refusal %s retains input without legacy fallback', async (status) => {
    const fetcher = vi.fn(async () => Response.json({}, { status })); vi.stubGlobal('fetch', fetcher);
    expect(await dataCardApi.updateOwnedCardMetadata(target, metadataDraft, guard)).toMatchObject({ success: false }); expect(fetcher).toHaveBeenCalledOnce(); expect(metadataDraft.name).toBe('新名称');
  });
  test('pre-dispatch owner mismatch sends nothing; transport failure is unknown; late owner change cannot acknowledge', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline')); vi.stubGlobal('fetch', fetcher);
    expect(await dataCardApi.updateOwnedCardMetadata(target, metadataDraft, { ...guard, isCurrent: () => false })).toMatchObject({ conflict: true }); expect(fetcher).not.toHaveBeenCalled();
    expect(await dataCardApi.updateOwnedCardMetadata(target, metadataDraft, guard)).toMatchObject({ uncertain: true }); expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockImplementation(async () => { vi.spyOn(authStorage, 'getAuth').mockResolvedValue({ ...auth, userId: 8 }); return Response.json(metadataAck); });
    expect(await dataCardApi.updateOwnedCardMetadata(target, metadataDraft, guard)).toMatchObject({ uncertain: true }); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
