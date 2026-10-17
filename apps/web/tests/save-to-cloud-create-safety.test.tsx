// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import SaveToCloudButton from '@/components/SaveToCloudButton';
import { beginAuthIdentityTransition } from '@/lib/auth-identity';

const mocks = vi.hoisted(() => ({
  auth: { userId: 7, username: 'owner', authKey: 'mock' },
  user: { id: 7 },
  modal: null as any,
  create: vi.fn(), capacity: vi.fn(), check: vi.fn(), push: vi.fn(), getAuth: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ isAuthenticated: true, user: mocks.user, authSource: 'legacy-bearer' }) }));
vi.mock('@/lib/auth', () => ({ authStorage: { getAuth: mocks.getAuth }, dataCardApi: { getUserCapacity: mocks.capacity, createCard: mocks.create } }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: mocks.check }));
vi.mock('@/components/CharManager/SaveCardModal', () => ({ default: (props: any) => { mocks.modal = props; return props.isOpen ? <div data-modal>{props.supplementaryContent}</div> : null; } }));
vi.mock('@/components/CharManager/DataCardsModal', () => ({ default: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
let root: Root;
let container: HTMLDivElement;
const open = async () => act(async () => { container.querySelector('button')!.click(); });
const submit = async () => act(async () => { await mocks.modal.onSave(); });
beforeEach(() => {
  mocks.user = { id: 7 };
  mocks.getAuth.mockResolvedValue(mocks.auth);
  mocks.capacity.mockResolvedValue({ capacity: 20, usedSlots: 2 });
  mocks.check.mockResolvedValue({ hasSensitiveWords: false });
  mocks.create.mockResolvedValue({ success: true, id: 'new-card' });
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); });

describe.each([undefined, 'generation-result'] as const)('Web explicit create lifecycle (%s)', (presentation) => {
  const render = async (props: any = {}) => act(async () => { root.render(<SaveToCloudButton presentation={presentation} data={{ name: 'result' }} {...props} />); });
  it('opts in to common button hierarchy without changing legacy consumers', async () => {
    await render({ className: 'legacy-cloud-action', style: { color: 'purple' } });
    const [save, replace] = [...container.querySelectorAll('button')];
    if (presentation === 'generation-result') {
      expect(container.querySelector('[data-testid="cloud-card-action-buttons"]')?.children).toHaveLength(2);
      expect(save.classList.contains('ui-web-generation-action--primary')).toBe(true);
      expect(replace.classList.contains('ui-web-generation-action--secondary')).toBe(true);
      expect(replace.getAttribute('style')).toBeNull();
    } else {
      expect(container.querySelector('[data-testid="cloud-card-action-buttons"]')).toBeNull();
      expect(save.className).toBe('legacy-cloud-action');
      expect(replace.style.backgroundImage).toContain('linear-gradient');
    }
  });
  it('guards double open and late getData across source changes', async () => {
    const pending = deferred<any>(); const getData = vi.fn(() => pending.promise);
    await render({ getData });
    await act(async () => { container.querySelector('button')!.click(); container.querySelector('button')!.click(); });
    expect(getData).toHaveBeenCalledTimes(1);
    await render({ data: { name: 'next-result' }, getData });
    await act(async () => pending.resolve({ name: 'old-result' }));
    expect(mocks.modal.isOpen).toBe(false);
    expect(mocks.capacity).not.toHaveBeenCalled();
  });
  it('does not discard drafts because getData callback identity changed', async () => {
    await render({ getData: async () => ({ name: 'prepared' }) }); await open();
    await act(async () => mocks.modal.onNameChange('custom'));
    await render({ getData: async () => ({ name: 'prepared' }) });
    expect(mocks.modal.isOpen).toBe(true); expect(mocks.modal.name).toBe('custom');
  });
  it('freezes form and data, guards double submit and close while saving', async () => {
    const check = deferred<any>(); mocks.check.mockReturnValue(check.promise);
    const data = { name: 'result', nested: { value: 1 } };
    await render({ data }); await open();
    await act(async () => { void mocks.modal.onSave(); void mocks.modal.onSave(); mocks.modal.onClose(); mocks.modal.onNameChange('changed'); });
    expect(mocks.modal.isOpen).toBe(true); expect(mocks.modal.isSaving).toBe(true);
    data.nested.value = 2;
    await act(async () => check.resolve({ hasSensitiveWords: false }));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0].slice(0, 5)).toEqual(['character', 'result', '角色数据卡', { name: 'result', nested: { value: 1 } }, 0]);
  });
  it('ignores old capacity and clears prepared data on source change', async () => {
    const capacity = deferred<any>(); mocks.capacity.mockReturnValueOnce(capacity.promise);
    await render(); await open();
    expect(mocks.modal.userCapacity).toBeUndefined();
    await render({ data: { name: 'new' } }); await open();
    await act(async () => capacity.resolve({ capacity: 999, usedSlots: 998 }));
    expect(mocks.modal.data).toEqual({ name: 'new' }); expect(mocks.modal.userCapacity).toBe(20);
  });
  it('keeps unknown capacity unknown and preserves rejected drafts', async () => {
    mocks.capacity.mockResolvedValue(null); mocks.create.mockResolvedValue({ success: false, error: 'denied' });
    await render(); await open();
    await act(async () => { mocks.modal.onNameChange('draft'); mocks.modal.onDescriptionChange('draft description'); });
    await submit();
    expect(mocks.modal.usedSlots).toBeUndefined(); expect(mocks.modal.userCapacity).toBeUndefined();
    expect(mocks.modal.name).toBe('draft'); expect(mocks.modal.description).toBe('draft description');
    await act(async () => mocks.modal.onClose()); await open(); expect(mocks.modal.name).toBe('draft');
  });
  it('requires checking own cards and explicit decision before retrying uncertainty', async () => {
    mocks.create.mockResolvedValue({ success: false, uncertain: true });
    await render(); await open(); await submit(); await submit();
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.modal.submitDisabled).toBe(true);
    const inspect = container.querySelector('a')!;
    expect(inspect.getAttribute('href')).toBe('/character-manager');
    expect(inspect.target).toBe('_blank'); expect(inspect.rel).toBe('noopener noreferrer');
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('已检查'))!;
    for (const action of [inspect, retry]) expect(action.className.split(' ')).toEqual(expect.arrayContaining(['hover:bg-gray-50', 'focus-visible:ring-2', 'focus-visible:ring-fuchsia-500', 'disabled:opacity-50']));
    expect(retry.disabled).toBe(true);
    await act(async () => mocks.modal.onClose()); await open(); await submit();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    await act(async () => { container.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await act(async () => { Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('已检查'))!.click(); });
    await submit(); expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it('account change during sensitive check cannot submit old data', async () => {
    const check = deferred<any>(); mocks.check.mockReturnValue(check.promise);
    await render(); await open(); await act(async () => { void mocks.modal.onSave(); });
    mocks.user = { id: 8 }; await render();
    await act(async () => check.resolve({ hasSensitiveWords: false }));
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.modal.isOpen).toBe(false);
  });
  it.each([false, true])('同账号同凭据换代阻断旧新建（已重渲染：%s）', async (rerender) => {
    const check = deferred<any>(); mocks.check.mockReturnValueOnce(check.promise);
    await render(); await open(); await act(async () => { void mocks.modal.onSave(); });
    beginAuthIdentityTransition();
    if (rerender) await render();
    await act(async () => check.resolve({ hasSensitiveWords: false }));
    expect(mocks.create).not.toHaveBeenCalled(); expect(window.alert).not.toHaveBeenCalled();
    await render(); expect(mocks.modal.isOpen).toBe(false);
  });
  it('同账号换代不认领已发送新建的迟到成功、不重放', async () => {
    const create = deferred<any>(); mocks.create.mockReturnValueOnce(create.promise);
    await render(); await open(); await act(async () => { void mocks.modal.onSave(); });
    expect(mocks.create).toHaveBeenCalledOnce();
    beginAuthIdentityTransition(); await render();
    await act(async () => create.resolve({ success: true, id: 'old-account-intent' }));
    expect(mocks.create).toHaveBeenCalledOnce(); expect(window.alert).not.toHaveBeenCalled(); expect(mocks.modal.isOpen).toBe(false);
    expect([...container.querySelectorAll('button')].map((button) => button.disabled)).toEqual([false, false]);
    await open(); expect(mocks.modal.isOpen).toBe(true); expect(mocks.create).toHaveBeenCalledOnce();
  });
  it('same-owner credential changes cannot show a stale success', async () => {
    const create = deferred<any>(); mocks.create.mockReturnValue(create.promise);
    await render(); await open(); await act(async () => { void mocks.modal.onSave(); });
    mocks.getAuth.mockResolvedValue({ ...mocks.auth, authKey: 'new-mock' });
    await act(async () => create.resolve({ success: true, id: 'old-created' }));
    expect(window.alert).not.toHaveBeenCalled(); expect(mocks.modal.submitDisabled).toBe(true);
  });
  it('retains host sensitive-word navigation and blocks the create', async () => {
    mocks.check.mockResolvedValue({ hasSensitiveWords: true });
    await render(); await open(); await submit();
    expect(mocks.push).toHaveBeenCalledWith('/arrested'); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('source change during POST suppresses stale success', async () => {
    const create = deferred<any>(); mocks.create.mockReturnValue(create.promise);
    await render(); await open(); await act(async () => { void mocks.modal.onSave(); });
    await render({ data: { name: 'new-result' } });
    await act(async () => create.resolve({ success: true, id: 'old-created' }));
    expect(window.alert).not.toHaveBeenCalled(); expect(mocks.modal.isOpen).toBe(false);
  });

  it('页级回收站/元信息读取guard同步阻断新建准备与既有表单提交', async () => {
  let blocked = true;
  const changes = vi.fn((value: boolean) => { blocked = value; });
  const getData = vi.fn(async () => ({ name: '原件' }));
  await render({ data: { name: 'result' }, getData, operationGuard: { isBlocked: () => blocked, onBusyChange: changes } });
  await open(); expect(getData).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  blocked = false; await render({ data: { name: 'result' }, getData, operationGuard: { isBlocked: () => blocked, onBusyChange: changes } });
  await open(); expect(getData).toHaveBeenCalledOnce();
  blocked = true; await act(async () => { void mocks.modal.onSave(); }); expect(mocks.create).not.toHaveBeenCalled();
  blocked = false; await act(async () => { void mocks.modal.onSave(); }); expect(mocks.create).toHaveBeenCalledOnce();
  expect(changes.mock.calls.map(([value]) => value)).toEqual([true, false, true, false]);
});

it('已派发新建后来源变化不释放page guard，旧ticket终态才释放且不认领旧回执', async () => {
  const pending = deferred<{ success: boolean; id: string }>(); mocks.create.mockReturnValue(pending.promise);
  let blocked = false; const changes = vi.fn((value: boolean) => { blocked = value; });
  const operationGuard = { isBlocked: () => blocked, onBusyChange: changes };
  await render({ data: { name: 'old' }, operationGuard }); await open(); await act(async () => { void mocks.modal.onSave(); });
  expect(mocks.create).toHaveBeenCalledOnce(); expect(blocked).toBe(true);
  await render({ data: { name: 'new' }, operationGuard }); expect(blocked).toBe(true); await open(); expect(mocks.create).toHaveBeenCalledOnce();
  await act(async () => pending.resolve({ success: true, id: 'old-card' })); expect(blocked).toBe(false); expect(mocks.modal.isOpen).toBe(false);
  expect(changes.mock.calls.map(([value]) => value)).toEqual([true, false, true, false]);
});

});
