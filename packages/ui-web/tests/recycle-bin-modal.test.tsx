// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { RecycleBinModal, type OwnedRecycleBinReadPort, type RecycleBinModalProps } from '../src/cloud-save';
import { BaseModal } from '../src/modal/BaseModal';
import type { OwnedRecycleBinCardDetail, OwnedRecycleBinPage } from '@mahoshojo/contracts/data-cards';
const row = { id: 'c', name: '删除的卡', description: '描述', type: 'character' as const, is_public: -1 as const, review_status: 'rejected' as const,
  created_at: null, updated_at: null, deleted_at: '2026-10-15T00:00:00Z', usage_count: 0, like_count: 0, isLegacyQuestionnaire: false };
const page: OwnedRecycleBinPage = { success: true, accountFenceVersion: 1, ownerUserId: 7, cards: [row], total: 8, filteredCount: 8, nextOffset: null };
const detail: OwnedRecycleBinCardDetail = { ...row, data: '{ "content": "正文原件" }' };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let root: Root; let element: HTMLDivElement; let port: OwnedRecycleBinReadPort; let props: RecycleBinModalProps;
const text = () => document.body.textContent ?? '';
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((value) => value.textContent === label)!;
const click = async (label: string) => act(async () => { button(label).focus(); button(label).click(); });
const render = async (patch: Partial<RecycleBinModalProps> = {}) => { props = { ...props, ...patch }; await act(async () => root.render(<RecycleBinModal {...props} />)); };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
  port = { isCurrent: () => true, readPage: vi.fn(async () => page), readDetail: vi.fn(async () => detail) };
  props = { isOpen: true, onClose: vi.fn(), limit: 5, port,
    DetailsModal: ({ card, onClose }) => <BaseModal isOpen title="详情" onClose={onClose}><pre>{card.data}</pre></BaseModal> };
});
afterEach(() => { act(() => root.unmount()); element.remove(); });
it('双端真实列表摘要先行，显示原可见性/审核/删除时间，详情按需；无写slots不出现写按钮', async () => {
  await render(); expect(text()).toContain('账号回收站：8/5'); expect(text()).toContain('原可见性：封禁'); expect(text()).toContain('未通过'); expect(text()).toContain('删除于');
  expect(port.readDetail).not.toHaveBeenCalled(); expect(button('恢复')).toBeUndefined(); expect(button('彻底删除')).toBeUndefined();
  await click('查看详情'); expect(port.readDetail).toHaveBeenCalledExactlyOnceWith('c', expect.any(AbortSignal)); expect(text()).toContain(detail.data);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(text()).not.toContain(detail.data); expect(props.onClose).not.toHaveBeenCalled(); expect(document.activeElement).toBe(button('查看详情'));
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(props.onClose).toHaveBeenCalledOnce();
});
it('loading/error不伪装为空，刷新后才显示已确认空态', async () => {
  const pending = deferred<OwnedRecycleBinPage>(); port.readPage = vi.fn(() => pending.promise);
  await render(); expect(text()).toContain('正在加载'); expect(text()).not.toContain('回收站为空'); expect(button('刷新').disabled).toBe(true);
  await act(async () => pending.reject(new Error('存储不可用'))); expect(text()).toContain('存储不可用'); expect(text()).not.toContain('回收站为空');
  port.readPage = vi.fn(async () => ({ ...page, cards: [], total: 0, filteredCount: 0 })); await click('刷新'); expect(text()).toContain('回收站为空');
});
it('按类型分页与账号总数分开，refresh维持页码，空页可以返回上一页', async () => {
  port.readPage = vi.fn(async (query) => ({ ...page, total: 30, filteredCount: 20, cards: query.offset ? [] : [row], nextOffset: query.offset ? null : 12 }));
  await render({ type: 'questionnaire' }); expect(text()).toContain('账号回收站：30/5'); expect(text()).toContain('当前类型 20 个');
  await click('下一页'); expect(port.readPage).toHaveBeenLastCalledWith({ limit: 12, offset: 12, type: 'questionnaire' }, expect.any(AbortSignal)); expect(text()).toContain('当前筛选或分页没有数据卡');
  await click('刷新'); expect(port.readPage).toHaveBeenLastCalledWith({ limit: 12, offset: 12, type: 'questionnaire' }, expect.any(AbortSignal));
  await click('上一页'); expect(text()).toContain('第 1 页');
});
it('关闭重开不认领旧读；原ticket不能释放新操作的busy', async () => {
  const old = deferred<OwnedRecycleBinPage>(), next = deferred<OwnedRecycleBinPage>(); let blocked = false;
  const changes = vi.fn((value: boolean) => { blocked = value; });
  port.readPage = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  await render({ operationGuard: { isBlocked: () => blocked, onBusyChange: changes } });
  const oldSignal = vi.mocked(port.readPage).mock.calls[0]![1]; await render({ isOpen: false }); expect(oldSignal.aborted).toBe(true);
  await render({ isOpen: true }); expect(blocked).toBe(true);
  await act(async () => old.resolve({ ...page, cards: [{ ...row, name: '旧账号正文' }] })); expect(text()).not.toContain('旧账号正文'); expect(blocked).toBe(true);
  await act(async () => next.resolve(page)); expect(blocked).toBe(false); expect(changes.mock.calls.map(([v]) => v)).toEqual([true, false, true, false]);
});
it('详情错误不回退列表正文；账号epoch改变时迟到详情丢弃', async () => {
  const pending = deferred<OwnedRecycleBinCardDetail>(); port.readDetail = vi.fn(() => pending.promise);
  await render(); await click('查看详情'); port.isCurrent = () => false;
  await act(async () => pending.resolve(detail)); expect(text()).not.toContain(detail.data);
  port.isCurrent = () => true; await render({ isOpen: false }); await render({ isOpen: true });
  port.readDetail = vi.fn(async () => { throw new Error('记录已恢复或不存在'); }); await click('查看详情'); expect(text()).toContain('记录已恢复或不存在'); expect(text()).not.toContain(detail.data);
});
it('写slots保持宿主行为，single-flight阻止并发/关闭/Esc，结束刷新摘要', async () => {
  const pending = deferred<void>(); const restore = vi.fn(() => pending.promise); let blocked = false;
  await render({ onRestore: restore, onDelete: vi.fn(), operationGuard: { isBlocked: () => blocked, onBusyChange: (value) => { blocked = value; } } });
  await act(async () => { button('恢复').click(); button('恢复').click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(restore).toHaveBeenCalledOnce(); expect(blocked).toBe(true); expect(props.onClose).not.toHaveBeenCalled(); expect(button('查看详情').disabled).toBe(true);
  await act(async () => pending.resolve()); expect(port.readPage).toHaveBeenCalledTimes(2); expect(blocked).toBe(false);
});
it('外部busy与身份失效均阻断dispatch', async () => {
  await render({ operationGuard: { isBlocked: () => true, onBusyChange: vi.fn() } }); expect(port.readPage).not.toHaveBeenCalled(); expect(text()).toContain('其他云端操作');
  await render({ operationGuard: undefined }); port.isCurrent = () => false; await click('刷新'); expect(port.readPage).not.toHaveBeenCalled();
});

it('父层刷新不能取消在途Web写或释放其guard，写终态后才开始新摘要', async () => {
  const pending = deferred<void>(); let blocked = false;
  await render({ onRestore: () => pending.promise, operationGuard: { isBlocked: () => blocked, onBusyChange: (value) => { blocked = value; } } });
  await click('恢复'); await render({ refreshKey: 1 });
  expect(blocked).toBe(true); expect(port.readPage).toHaveBeenCalledTimes(1); expect(button('刷新').disabled).toBe(true);
  await act(async () => pending.resolve());
  expect(port.readPage).toHaveBeenCalledTimes(2); expect(blocked).toBe(false); expect(button('刷新').disabled).toBe(false);
});

it('外部刷新撤销旧详情读取，迟到详情不能覆盖更新后的列表', async () => {
  const pending = deferred<OwnedRecycleBinCardDetail>(); port.readDetail = vi.fn(() => pending.promise);
  await render(); await click('查看详情'); const oldSignal = vi.mocked(port.readDetail).mock.calls[0]![1];
  await render({ refreshKey: 1 }); expect(oldSignal.aborted).toBe(true); expect(port.readPage).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve(detail)); expect(text()).not.toContain(detail.data); expect(button('刷新').disabled).toBe(false);
});
