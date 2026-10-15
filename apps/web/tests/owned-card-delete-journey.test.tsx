// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DataCardsModal from '@/components/CharManager/DataCardsModal';
import RecycleBinModal from '@/components/CharManager/RecycleBinModal';
import { authStorage } from '@/lib/auth';
import { captureAuthIdentity, beginAuthIdentityTransition } from '@/lib/auth-identity';
import * as list from '@/lib/data-card-list-client';
const session = vi.hoisted(() => ({ epoch: 0, userId: 7 }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ user: { id: session.userId }, identityEpoch: session.epoch }) }));
vi.mock('@/components/DataCardDetailsModal', () => ({ default: () => null }));
const row = { id: 'active', user_id: 7, type: 'character', name: '列表名称', description: '', is_public: 0, review_status: 'approved', usage_count: 0, like_count: 0, favorite_count: 0 };
const target = { id: row.id, type: row.type, name: '确认时最新名称', description: '', version: 'a'.repeat(64) };
const old = { id: 'old', type: 'questionnaire', name: '旧问卷', description: null, version: 'b'.repeat(64) };
const fence = { success: true, ownerUserId: 7, accountFenceVersion: 1, deleteProtocolVersion: 1 };
let root: Root; let container: HTMLDivElement; let blocked: boolean; const fetcher = vi.fn(); const changed = vi.fn();
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)!;
const click = (label: string) => act(async () => button(label).click());
const writes = () => fetcher.mock.calls.filter(([url, init]) => init?.method === 'POST' && String(url).includes('-owned'));
function Harness({ external = false }: { external?: boolean }) {
  const [open, setOpen] = useState(true); const [recycle, setRecycle] = useState(false);
  const guard = { isBlocked: () => blocked, onBusyChange: (value: boolean) => { blocked = value; } };
  return <><a href="/elsewhere">离开</a><textarea aria-label="本机编辑草稿" defaultValue="必须保留的生成结果" />
    <DataCardsModal isOpen={open} onClose={() => setOpen(false)} dataCards={[]} summaryOwnerId={7} currentPage={1} onPageChange={() => {}} cardsPerPage={12} metadataGuard={external ? guard : undefined} onMetadataSaved={changed}
      onOpenRecycleBin={() => { setOpen(false); setRecycle(true); }} />
    <RecycleBinModal isOpen={recycle} onClose={() => setRecycle(false)} operationGuard={guard} onChanged={changed} />
  </>;
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; blocked = false; beginAuthIdentityTransition(); session.epoch = captureAuthIdentity().epoch;
  vi.spyOn(authStorage, 'getAuth').mockResolvedValue({ userId: 7, username: 'owner' }); vi.spyOn(authStorage, 'getAuthHeader').mockResolvedValue(null);
  vi.spyOn(list, 'getDataCardSummaryPage').mockResolvedValue({ success: true, cards: [row], total: 1, nextOffset: null } as never);
  vi.spyOn(list, 'loadFullDataCard').mockRejectedValue(new Error('删除不能载入或替换编辑器正文'));
  fetcher.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/data-cards/delete-preview-owned?')) {
      const recycle = url.includes('scope=recycle'); return Response.json({ ...fence, operation: recycle ? 'preview-recycle' : 'preview-active', targets: recycle ? [old] : [target], total: 1, recycleLimit: 5 });
    }
    if (url === '/api/data-cards/soft-delete-owned') return Response.json({ code: 'RECYCLE_BIN_FULL' }, { status: 409 });
    if (url === '/api/data-cards/purge-recycle-owned') return Response.json({ ...fence, operation: 'purge-recycle', ids: ['old'] });
    if (url === '/api/data-cards/purge-active-owned') return Response.json({ ...fence, operation: 'purge-active', id: 'active' });
    if (url.startsWith('/api/data-cards/recycle-owned?')) return Response.json({ success: true, ownerUserId: 7, accountFenceVersion: 1, cards: [], total: 0, filteredCount: 0, nextOffset: null });
    if (init?.method === 'POST' && url.includes('owned')) throw new Error(`未知写请求 ${url}`);
    return Response.json({ success: true, items: {}, tags: [] });
  });
  vi.stubGlobal('fetch', fetcher); changed.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('真实Web删除入口先预览最新名称；满额清空原version后失败准确提示且保留草稿', async () => {
  await act(async () => root.render(<Harness external />)); await click('删除'); expect(document.body.textContent).toContain('确认时最新名称'); expect(blocked).toBe(true);
  await click('移入回收站'); await click('清空回收站并继续…'); expect(document.body.textContent).toContain('旧问卷'); expect(document.body.textContent).toContain('问卷');
  await click('永久清空并继续'); expect(document.body.textContent).toContain('本次确认清单中的数据卡已永久删除，但原卡未移入');
  const calls = writes(); expect(calls.map(([url]) => url)).toEqual(['/api/data-cards/soft-delete-owned', '/api/data-cards/purge-recycle-owned', '/api/data-cards/soft-delete-owned']);
  expect(JSON.parse(calls[1]![1].body)).toEqual({ expectedUserId: 7, targets: [{ id: 'old', version: old.version }], continuationTarget: { id: 'active', version: target.version } });
  expect(JSON.parse(calls[2]![1].body).version).toBe(target.version); expect(document.querySelector<HTMLTextAreaElement>('[aria-label="本机编辑草稿"]')?.value).toBe('必须保留的生成结果'); expect(list.loadFullDataCard).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledOnce(); expect(blocked).toBe(false);
});
it('不可逆确认前取消零永久写；整理释放一次guard再读回收站', async () => {
  await act(async () => root.render(<Harness external />)); await click('删除'); await click('移入回收站'); await click('永久删除「确认时最新名称」…'); expect(writes()).toHaveLength(1); expect(document.activeElement?.textContent).toBe('取消');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); expect(blocked).toBe(false);
  await click('删除'); await click('移入回收站'); await click('整理回收站'); expect(blocked).toBe(false); expect(document.body.textContent).toContain('回收站为空'); expect(writes()).toHaveLength(2);
});
it('真实page guard只持一层，unknown保留在前景且禁止phase2，空列表不能推断成功', async () => {
  const ordinary = fetcher.getMockImplementation()!; let resolve!: (response: Response) => void;
  fetcher.mockImplementation((url, init) => url === '/api/data-cards/purge-recycle-owned' ? new Promise<Response>(done => { resolve = done; }) : ordinary(url, init));
  await act(async () => root.render(<Harness />)); await click('删除'); await click('移入回收站'); await click('清空回收站并继续…'); await click('永久清空并继续');
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }); document.querySelector('a[href="/elsewhere"]')!.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  await act(async () => resolve(Response.json({ ...fence, operation: 'purge-recycle', ids: ['unexpected'] })));
  expect(document.body.textContent).toContain('删除结果不确定'); expect(document.body.textContent).toContain('空列表也不能证明'); expect(writes()).toHaveLength(2); expect(changed).not.toHaveBeenCalled();
});
it('same-account epoch change after phase1 dispatch blocks phase2 and stale completion', async () => {
  const ordinary = fetcher.getMockImplementation()!; let resolve!: (response: Response) => void;
  fetcher.mockImplementation((url, init) => url === '/api/data-cards/purge-recycle-owned' ? new Promise<Response>(done => { resolve = done; }) : ordinary(url, init));
  await act(async () => root.render(<Harness />)); await click('删除'); await click('移入回收站'); await click('清空回收站并继续…'); await click('永久清空并继续');
  session.epoch = beginAuthIdentityTransition().identity.epoch; await act(async () => root.render(<Harness />)); await act(async () => resolve(Response.json({ ...fence, operation: 'purge-recycle', ids: ['old'] })));
  expect(writes()).toHaveLength(2); expect(changed).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain('本次确认清单中的数据卡已永久删除');
});

it('同tick删除与元信息事件互斥，不读取替换预览或覆盖草稿', async () => {
  await act(async () => root.render(<Harness />));
  const edit = button('修改信息'); const remove = button('删除');
  await act(async () => { remove.click(); edit.click(); });
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('replace-owned'))).toHaveLength(0);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('delete-preview-owned'))).toHaveLength(1);
  expect(document.querySelector('[aria-label=名称]')).toBeNull();
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="本机编辑草稿"]')?.value).toBe('必须保留的生成结果');
});
it.each([undefined, 'questionnaire' as const])('真实Web回收站宿主一键恢复使用共享port并刷新：%s', async type => {
  const summary = { id: old.id, type: 'questionnaire', name: old.name, description: null, is_public: 0, review_status: 'approved', created_at: null, updated_at: null, deleted_at: 'now', usage_count: 0, like_count: 0, isLegacyQuestionnaire: false };
  const ordinary = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith('/api/data-cards/recycle-owned?')) return Promise.resolve(Response.json({ success: true, ownerUserId: 7, accountFenceVersion: 1, cards: [summary], total: 1, filteredCount: 1, nextOffset: null }));
    if (url === '/api/data-cards/restore-owned') return Promise.resolve(Response.json({ success: true, ownerUserId: 7, accountFenceVersion: 1, restoreProtocolVersion: 1, operation: 'restore', id: old.id, version: old.version }));
    return ordinary(url, init);
  });
  await act(async () => root.render(<RecycleBinModal isOpen onClose={() => {}} type={type} operationGuard={{ isBlocked: () => blocked, onBusyChange: value => { blocked = value; } }} onChanged={changed} />));
  await act(async () => { button('恢复').click(); button('永久删除…').click(); button('恢复').click(); });
  expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe('/api/data-cards/restore-owned');
  expect(JSON.parse(writes()[0][1].body)).toEqual({ expectedUserId: 7, id: old.id, version: old.version });
  expect(changed).toHaveBeenCalledOnce(); expect(document.body.textContent).toContain('数据卡已恢复');
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/api/data-card-recycle'))).toBe(false);
});
it('真实Web宿主卸载后同identity保留删除提示，迟到清空回执不继续原卡', async () => {
  const ordinary = fetcher.getMockImplementation()!; let finish!: (response: Response) => void;
  fetcher.mockImplementation((url, init) => url === '/api/data-cards/purge-recycle-owned' ? new Promise<Response>(resolve => { finish = resolve; }) : ordinary(url, init));
  await act(async () => root.render(<Harness key="a" />)); await click('删除'); await click('移入回收站'); await click('清空回收站并继续…'); await click('永久清空并继续');
  await act(async () => root.render(<Harness key="b" />)); expect(document.body.textContent).toContain('删除结果不确定');
  await act(async () => finish(Response.json({ ...fence, operation: 'purge-recycle', ids: ['old'] })));
  expect(changed).not.toHaveBeenCalled(); expect(writes()).toHaveLength(2); expect(document.body.textContent).toContain('删除结果不确定');
  await click('关闭'); await act(async () => root.render(<Harness key="c" />)); expect(document.body.textContent).toContain('删除结果不确定');
  await click('已知晓，结束本次操作'); await act(async () => root.render(<Harness key="d" />)); expect(document.body.textContent).not.toContain('删除结果不确定'); expect(writes()).toHaveLength(2);
});
