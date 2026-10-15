import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authStorage } from '@/lib/auth';
import { createWebOwnedCardMetadataPort } from '@/lib/owned-card-metadata';
const target = { id: 'c', type: 'character' as const, name: '名称', description: '', isPublic: 0 as const, reviewStatus: 'approved' as const, hasPendingUpdate: false, version: 'a'.repeat(64) };
const ack = { success: true, id: 'c', ownerUserId: 7, accountFenceVersion: 1, metadataVersion: 1 };
let auth = { userId: 7, username: '原名', authKey: 'credential-A', activityToken: 'activity-A' };
let current = true;
const fetcher = vi.fn();
beforeEach(() => {
  auth = { userId: 7, username: '原名', authKey: 'credential-A', activityToken: 'activity-A' }; current = true;
  vi.spyOn(authStorage, 'getAuth').mockImplementation(async () => ({ ...auth }));
  fetcher.mockReset().mockImplementation(async (_url, init) => init.method === 'PUT' ? Response.json(ack) : Response.json({ success: true, ownerUserId: 7, accountFenceVersion: 1, target })); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => vi.unstubAllGlobals());
it('同凭据username/activityToken刷新后可重新读取/保存，写中刷新不误报unknown', async () => {
  const port = createWebOwnedCardMetadataPort(7, { epoch: 1, isCurrent: () => current });
  expect((await port.read('c')).kind).toBe('ready'); auth = { ...auth, username: '新名', activityToken: 'activity-B' };
  expect((await port.read('c')).kind).toBe('ready');
  fetcher.mockImplementationOnce(async () => { auth = { ...auth, activityToken: 'activity-C' }; return Response.json(ack); });
  expect(await port.write(target, { name: '修改名', description: '', isPublic: 0 })).toEqual({ kind: 'saved' });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it.each(['credential', 'account', 'epoch'] as const)('真正%s变化拒绝旧draft，不把旧owner续签给新身份', async (change) => {
  const port = createWebOwnedCardMetadataPort(7, { epoch: 1, isCurrent: () => current }); await port.read('c'); fetcher.mockClear();
  if (change === 'credential') auth = { ...auth, authKey: 'credential-B' }; else if (change === 'account') auth = { ...auth, userId: 8 }; else current = false;
  expect((await port.write(target, { name: '旧稿', description: '', isPublic: 0 })).kind).toBe('conflict'); expect(fetcher).not.toHaveBeenCalled();
});
it('派发后的真实凭据变化保持unknown且不自动重试', async () => {
  const port = createWebOwnedCardMetadataPort(7, { epoch: 1, isCurrent: () => current }); await port.read('c'); fetcher.mockClear();
  fetcher.mockImplementationOnce(async () => { auth = { ...auth, authKey: 'credential-B' }; return Response.json(ack); });
  expect((await port.write(target, { name: '旧稿', description: '', isPublic: 0 })).kind).toBe('uncertain'); expect(fetcher).toHaveBeenCalledOnce();
});


it('同identity重建port共享未确认输入，账号与凭据代次隔离且session不含凭据', () => {
  const identity = { epoch: 1, isCurrent: () => current };
  const first = createWebOwnedCardMetadataPort(7, identity); const again = createWebOwnedCardMetadataPort(7, identity);
  expect(first.session).toBe(again.session);
  first.session!.uncertain = true;
  expect(createWebOwnedCardMetadataPort(8, identity).session).toEqual({ uncertain: false });
  expect(createWebOwnedCardMetadataPort(7, { epoch: 2, isCurrent: () => true }).session).toEqual({ uncertain: false });
  expect(JSON.stringify(first.session)).not.toContain('credential-A');
});
