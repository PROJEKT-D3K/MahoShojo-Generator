// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OwnedCardDeleteDialog, useOwnedCardDelete, createOwnedCardDeleteController, RecycleBinModal, type OwnedCardDeletePort, type DeleteResponse } from '../src/cloud-save';
const active = { id: 'card-1234567890', type: 'character' as const, name: '当前角色', description: null, version: 'a'.repeat(64) };
const targets = [
  { id: 'old-history-123', type: 'history' as const, name: '同名卡', description: null, version: 'b'.repeat(64) },
  { id: 'old-questionnaire-456', type: 'questionnaire' as const, name: '同名卡', description: null, version: 'c'.repeat(64) },
];
const reply = (scope: string, values: unknown[]): DeleteResponse => ({ status: 200, body: { success: true, accountFenceVersion: 1, deleteProtocolVersion: 1, ownerUserId: 7, operation: `preview-${scope}`, targets: values, total: values.length, recycleLimit: 5 } });
let root: Root; let element: HTMLDivElement; let port: OwnedCardDeletePort; let blocked: boolean;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!;
const click = (label: string) => act(async () => { button(label).click(); });
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; blocked = false;
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
  port = { expectedUserId: 7, isCurrent: () => true, isBlocked: () => blocked, onBusyChange: value => { blocked = value; }, preview: vi.fn(async (scope, id) => reply(scope, scope === 'active' ? [active] : id ? [targets[0]] : targets)), write: vi.fn(async () => ({ status: 409, body: { code: 'RECYCLE_BIN_FULL' } })) };
});
afterEach(() => { act(() => root.unmount()); element.remove(); });
it('full offers four actions; permanent delete uses a new irreversible dialog with cancel focus', async () => {
  const owner = createOwnedCardDeleteController(port); const manage = vi.fn();
  await act(async () => { root.render(<OwnedCardDeleteDialog controller={owner} onManageRecycle={manage} />); await owner.beginActive(active.id); });
  expect(document.activeElement?.textContent).toBe('取消'); await click('移入回收站');
  expect(button('永久删除「当前角色」…')).toBeDefined(); expect(button('清空回收站并继续…')).toBeDefined(); expect(button('整理回收站')).toBeDefined();
  await click('永久删除「当前角色」…'); expect(port.write).toHaveBeenCalledTimes(1); expect(document.body.textContent).toContain('无法撤销'); expect(document.body.textContent).toContain('角色'); expect(document.body.textContent).toContain('card-1234567');
  expect(document.activeElement?.textContent).toBe('取消'); await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role=dialog]')).toBeNull(); expect(blocked).toBe(false); expect(port.write).toHaveBeenCalledTimes(1);
});
it('clear confirmation lists actual all-type names/types/IDs and explicit continuation', async () => {
  const owner = createOwnedCardDeleteController(port); await act(async () => { root.render(<OwnedCardDeleteDialog controller={owner} />); await owner.beginActive(active.id); await owner.confirm(); });
  await click('清空回收站并继续…'); expect(document.body.textContent).toContain('叙事历史'); expect(document.body.textContent).toContain('问卷'); expect(document.body.textContent).toContain('old-history-'); expect(document.body.textContent).toContain('old-question'); expect(document.body.textContent).toContain('原卡「当前角色」'); expect(port.write).toHaveBeenCalledTimes(1);
  expect(document.activeElement?.textContent).toBe('取消'); expect(button('永久清空并继续')).toBeDefined();
});
it('manage releases guard before switching to recycle, with no delete request', async () => {
  const owner = createOwnedCardDeleteController(port); const manage = vi.fn(() => expect(blocked).toBe(false)); await act(async () => { root.render(<OwnedCardDeleteDialog controller={owner} onManageRecycle={manage} />); await owner.beginActive(active.id); await owner.confirm(); });
  await click('整理回收站'); expect(manage).toHaveBeenCalledOnce(); expect(owner.getSnapshot().phase).toBe('idle'); expect(port.write).toHaveBeenCalledTimes(1);
});
it('recycle controller acquires guard once, without nesting read/write self-lock', async () => {
  const row = { id: targets[0]!.id, type: 'history' as const, name: '同名卡', description: '', is_public: 0 as const, review_status: null, created_at: null, updated_at: null, deleted_at: 'now', usage_count: 0, like_count: 0, isLegacyQuestionnaire: false };
  const reader = { isCurrent: () => true, readPage: vi.fn(async () => ({ success: true as const, accountFenceVersion: 1 as const, ownerUserId: 7, cards: [row], total: 2, filteredCount: 1, nextOffset: null })), readDetail: vi.fn() };
  const busy = vi.fn(value => { blocked = value; }); port.onBusyChange = busy;
  await act(async () => root.render(<RecycleBinModal isOpen onClose={() => {}} port={reader} deletePort={port} type="history" operationGuard={{ isBlocked: () => blocked, onBusyChange: busy }} />));
  expect(blocked).toBe(false); await click('永久删除…'); expect(port.preview).toHaveBeenCalledExactlyOnceWith('recycle', row.id, expect.any(AbortSignal)); expect(blocked).toBe(true);
  expect(button('刷新').disabled).toBe(true); expect(button('清空全部类型回收站…').disabled).toBe(true);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(blocked).toBe(false); expect(document.querySelectorAll('[role=dialog]')).toHaveLength(1); expect(port.write).not.toHaveBeenCalled();
  await click('清空全部类型回收站…'); expect(port.preview).toHaveBeenLastCalledWith('recycle', undefined, expect.any(AbortSignal)); expect(document.body.textContent).toContain('问卷');
});
it('real shared hook hides a closed host but retains in-flight warning on reopen and remount', async () => {
  const notice = { uncertain: false }; port = { ...port, notice, onChanged: vi.fn() };
  let finish!: (value: DeleteResponse) => void;
  vi.mocked(port.write).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  function Host({ open }: { open: boolean }) {
    const deletion = useOwnedCardDelete(port, open);
    return <><button onClick={() => void deletion.controller?.beginRecycle(targets[0]!.id)}>选择删除</button><OwnedCardDeleteDialog controller={deletion.controller} /></>;
  }
  const render = (open: boolean, key = 'a') => act(async () => root.render(<Host key={key} open={open} />));
  await render(true); await click('选择删除'); await click('确认永久删除');
  expect(blocked).toBe(true);
  await render(false); expect(document.querySelector('[role=dialog]')).toBeNull(); expect(blocked).toBe(false);
  await render(true); expect(document.body.textContent).toContain('删除结果不确定');
  await render(false); await render(true, 'b'); expect(document.body.textContent).toContain('删除结果不确定');
  await act(async () => finish({ status: 200, body: { success: true, accountFenceVersion: 1, deleteProtocolVersion: 1, ownerUserId: 7, operation: 'purge-recycle', ids: [targets[0]!.id] } }));
  expect(port.onChanged).not.toHaveBeenCalled(); expect(port.write).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain('删除结果不确定');
  await click('关闭'); expect(notice.uncertain).toBe(true);
  await render(false); await render(true); expect(document.body.textContent).toContain('删除结果不确定');
  await click('已知晓，结束本次操作'); expect(notice.uncertain).toBe(false);
  await render(false); await render(true); expect(document.querySelector('[role=dialog]')).toBeNull();
  await click('选择删除'); expect(document.body.textContent).toContain('确认永久删除'); expect(port.write).toHaveBeenCalledTimes(1);
});
