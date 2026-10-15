// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DataCardsModal from '@/components/CharManager/DataCardsModal';
import { authStorage } from '@/lib/auth';
import { beginAuthIdentityTransition, captureAuthIdentity } from '@/lib/auth-identity';
import * as list from '@/lib/data-card-list-client';
const session = vi.hoisted(() => ({ epoch: 0, userId: 7 }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ user: { id: session.userId }, identityEpoch: session.epoch }) }));
vi.mock('@/components/DataCardDetailsModal', () => ({ default: () => null }));
const row = { id: 'c', user_id: 7, type: 'character', name: '云端卡', description: '', is_public: 0, review_status: 'approved', usage_count: 0, like_count: 0, favorite_count: 0 };
const target = { id: 'c', type: 'character', name: '最新名称', description: '最新描述', isPublic: 0, reviewStatus: 'approved', hasPendingUpdate: true, version: 'a'.repeat(64) };
const ack = { success: true, id: 'c', ownerUserId: 7, accountFenceVersion: 1, metadataVersion: 1 };
let root: Root; let container: HTMLDivElement; const fetcher = vi.fn(); const saved = vi.fn();
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!;
const click = (label: string) => act(async () => button(label).click());
function Harness() { const [open, setOpen] = useState(true); return <><button onClick={() => setOpen(true)}>重开管理</button><a href="/elsewhere">离开页面</a><DataCardsModal isOpen={open} onClose={() => setOpen(false)} dataCards={[]} summaryOwnerId={session.userId} currentPage={1} onPageChange={() => {}} cardsPerPage={12} onMetadataSaved={saved} /></>; }
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; session.userId = 7; beginAuthIdentityTransition(); session.epoch = captureAuthIdentity().epoch;
  vi.spyOn(authStorage, 'getAuth').mockResolvedValue({ userId: 7, username: 'owner' }); vi.spyOn(authStorage, 'getAuthHeader').mockResolvedValue(null);
  vi.spyOn(list, 'getDataCardSummaryPage').mockResolvedValue({ success: true, cards: [row], total: 1, nextOffset: null } as never);
  vi.spyOn(list, 'loadFullDataCard').mockRejectedValue(new Error('元信息编辑不应加载正文'));
  fetcher.mockReset().mockImplementation(async (url: string) => url.startsWith('/api/data-cards/replace-owned?') ? Response.json({ success: true, ownerUserId: 7, accountFenceVersion: 1, target }) : url === '/api/data-cards/metadata-owned' ? Response.json(ack) : Response.json({ success: true, items: {}, tags: [] }));
  vi.stubGlobal('fetch', fetcher); saved.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('Web真实管理入口共源编辑，取消不写、保存走owned route并刷新，无legacy元信息请求', async () => {
  await act(async () => root.render(<Harness />)); await click('修改信息'); expect(document.querySelector<HTMLInputElement>('[aria-label=名称]')?.value).toBe('最新名称'); await click('取消');
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/data-cards/metadata-owned')).toHaveLength(0);
  await click('修改信息'); await click('保存'); expect(saved).toHaveBeenCalledOnce();
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT'); expect(writes).toHaveLength(1); expect(writes[0][0]).toBe('/api/data-cards/metadata-owned');
  expect(JSON.parse(writes[0][1].body)).toEqual({ expectedUserId: 7, id: 'c', expectedVersion: target.version, name: target.name, description: target.description, isPublic: 0 });
  expect(list.loadFullDataCard).not.toHaveBeenCalled(); expect(list.getDataCardSummaryPage).toHaveBeenCalledTimes(2);
});
it('Web在途关闭、链接导航与刷新受保护；unknown在真实表单可见且无重发', async () => {
  let resolve!: (value: Response) => void; const pending = new Promise<Response>((done) => { resolve = done; });
  const ordinary = fetcher.getMockImplementation()!; fetcher.mockImplementation((url, ...args) => url === '/api/data-cards/metadata-owned' ? pending : ordinary(url, ...args));
  await act(async () => root.render(<Harness />)); await click('修改信息'); await click('保存');
  const navigation = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }); document.querySelector('a[href="/elsewhere"]')!.dispatchEvent(navigation); expect(navigation.defaultPrevented).toBe(true);
  const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); expect(document.querySelector('[role=dialog]')).not.toBeNull();
  await act(async () => resolve(Response.json({}, { status: 503 }))); expect(document.body.textContent).toContain('修改结果不确定'); expect(button('保存').disabled).toBe(true);
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/data-cards/metadata-owned')).toHaveLength(1);
});
it('同账号凭据换代清理旧编辑稿，迟到成功不认领', async () => {
  let resolve!: (value: Response) => void; const pending = new Promise<Response>((done) => { resolve = done; }); const ordinary = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, ...args) => url === '/api/data-cards/metadata-owned' ? pending : ordinary(url, ...args));
  await act(async () => root.render(<Harness />)); await click('修改信息'); await click('保存');
  session.epoch = beginAuthIdentityTransition().identity.epoch; await act(async () => root.render(<Harness />)); await act(async () => resolve(Response.json(ack)));
  expect(saved).not.toHaveBeenCalled(); expect(document.querySelector('[aria-label=名称]')).toBeNull(); expect(document.body.textContent).not.toContain('数据卡信息已更新');
});


it('外部导航卸载后迟到写入回执不认领、不重放或触发旧onSaved', async () => {
  let resolve!: (value: Response) => void; const pending = new Promise<Response>((done) => { resolve = done; }); const ordinary = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, ...args) => url === '/api/data-cards/metadata-owned' ? pending : ordinary(url, ...args));
  await act(async () => root.render(<Harness />)); await click('修改信息'); await click('保存');
  await act(async () => root.render(<p>另一页面</p>)); await act(async () => resolve(Response.json(ack)));
  expect(saved).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain('数据卡信息已更新');
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/data-cards/metadata-owned')).toHaveLength(1);
});


it('Web unknown关闭/重挂载仍保留输入，明确结束才允许新的编辑', async () => {
  const ordinary = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, ...args) => url === '/api/data-cards/metadata-owned' ? Response.json({}, { status: 503 }) : ordinary(url, ...args));
  await act(async () => root.render(<Harness />)); await click('修改信息');
  await act(async () => { const field = document.querySelector<HTMLInputElement>('[aria-label=名称]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '待核对输入'); field.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('保存');
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label=关闭]')!.click()); await click('重开管理');
  expect(document.querySelector<HTMLInputElement>('[aria-label=名称]')?.value).toBe('待核对输入'); expect(button('保存').disabled).toBe(true);
  await act(async () => root.render(null)); await act(async () => root.render(<Harness />));
  expect(document.querySelector<HTMLInputElement>('[aria-label=名称]')?.value).toBe('待核对输入'); expect(button('保存').disabled).toBe(true);
  expect(saved).not.toHaveBeenCalled(); expect(fetcher.mock.calls.filter(([url]) => url === '/api/data-cards/metadata-owned')).toHaveLength(1);
  await click('已知晓，结束本次修改'); expect(document.querySelector('[aria-label=名称]')).toBeNull();
  await click('修改信息'); expect(button('保存').disabled).toBe(false);
});
