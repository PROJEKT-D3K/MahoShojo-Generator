// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const account = vi.hoisted(() => ({ state: { account: { userId: 7 }, verification: 'verified', authFlow: { kind: 'idle' } } }));
vi.mock('../src/features/account/use-desktop-cloud-session', () => ({ useDesktopCloudSession: () => ({ state: account.state, store: { getSnapshot: () => account.state, getCredentialEpoch: () => 0 } }) }));
vi.mock('../src/features/cloud-save/owned-cards-modal', () => ({ DesktopOwnedCardsModal: () => null }));
import { CombatantUpdatesPresentation } from '@mahoshojo/ui-web/arena-report';
import { DesktopArenaRoleUpdateActions, useArenaResultActionLocks } from '../src/features/arena/role-update-actions';

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; });

it('多个表单的关闭/unknown 与 Native 请求寿命独立，旧表单清理不能提前解锁', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let release!: () => void;
  const invoke = vi.fn(async () => new Promise<void>(resolve => { release = resolve; }));
  let locks!: ReturnType<typeof useArenaResultActionLocks>;
  function Harness() { locks = useArenaResultActionLocks(invoke); return null; }
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(<Harness />));
  let closeA!: () => void, closeUnknownB!: () => void;
  await act(async () => { closeA = locks.retainSourceIntent(); closeUnknownB = locks.retainSourceIntent(); });
  expect(locks.sourceLocked).toBe(true); expect(locks.busy).toBe(false);
  await act(async () => closeA());
  expect(locks.isSourceLocked()).toBe(true); expect(locks.isBusy()).toBe(false);
  const a = Symbol(), b = Symbol();
  await act(async () => { locks.setFormBusy(a, true); locks.setFormBusy(b, true); locks.setFormBusy(a, false); });
  expect(locks.busy).toBe(true);
  let request!: Promise<unknown>;
  await act(async () => { request = locks.invokeTracked('fixture-command'); });
  await act(async () => { closeUnknownB(); locks.setFormBusy(b, false); });
  expect(locks.isSourceLocked()).toBe(true); expect(locks.isBusy()).toBe(true);
  await act(async () => { release(); await request; });
  expect(locks.isSourceLocked()).toBe(false); expect(locks.isBusy()).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(1);
});


it('真实逐卡云表单未知结果持续保留源锁，关闭另一个表单不解锁也不重发', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
    const request = args!.request as { routeId: string };
    return request.routeId === 'user-capacity.query'
      ? { status: 200, body: { success: true, capacity: 10, usedSlots: 0 } }
      : { status: 503, body: {} };
  });
  let locks!: ReturnType<typeof useArenaResultActionLocks>;
  const session = { canSaveCharacter: () => false, saveCharacter: vi.fn(async () => false) };
  const cards = [{ name: '甲', content: '甲结果' }, { name: '乙', content: '乙结果' }];
  function Harness() {
    locks = useArenaResultActionLocks(invoke);
    return <CombatantUpdatesPresentation keepMounted defaultOpen={false} itemDefaultOpen={false} items={cards.map((data, index) => ({ key: String(index), displayName: data.name, impact: data.content }))}
      renderMarkdown={content => content} renderActions={item => <section data-fixture-card={item.key}>
        <DesktopArenaRoleUpdateActions key={item.key} data={cards[Number(item.key)]!} selection={null} session={session} locks={locks} disabled={false}
          isBlocked={() => false} guard={{ ready: true, message: null }} onDownload={() => undefined} />
      </section>} />;
  }
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const findButton = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!;
  const click = async (button: HTMLButtonElement) => act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => root!.render(<Harness />));
  expect(invoke).not.toHaveBeenCalled();
  expect(container.querySelector('[data-fixture-card]')).toBeNull();
  await click(findButton(container, '角色更新'));
  expect(container.querySelector('[data-fixture-card]')).toBeNull();
  await click(findButton(container, '甲'));
  expect(container.querySelector('[data-fixture-card="1"]')).toBeNull();
  await click(findButton(container, '乙'));
  await click(findButton(container.querySelector('[data-fixture-card="0"]')!, '保存到云端'));
  await click(findButton(container.querySelector('[data-fixture-card="1"]')!, '保存到云端'));
  const dialogs = [...document.querySelectorAll('[role="dialog"]')];
  expect(dialogs).toHaveLength(2); expect(locks.sourceLocked).toBe(true); expect(locks.busy).toBe(false);
  await click(findButton(dialogs[1]!, '保存'));
  expect(dialogs[1]!.textContent).toContain('结果不确定');
  await click(findButton(dialogs[0]!, '取消'));
  expect(locks.sourceLocked).toBe(true); expect(locks.busy).toBe(false);
  await click(findButton(dialogs[1]!, '取消'));
  expect(locks.sourceLocked).toBe(true);
  // 内外折叠只隐藏内容，不销毁未知结果和显式重试保护。
  await click(findButton(container, '乙')); expect(locks.sourceLocked).toBe(true);
  await click(findButton(container, '乙')); expect(locks.sourceLocked).toBe(true);
  await click(findButton(container, '角色更新')); expect(locks.sourceLocked).toBe(true);
  await click(findButton(container, '角色更新')); expect(locks.sourceLocked).toBe(true);
  await click(findButton(container.querySelector('[data-fixture-card="1"]')!, '保存到云端'));
  const reopened = document.querySelector('[role="dialog"]')!;
  expect(reopened.textContent).toContain('结果不确定');
  expect(findButton(reopened, '保存').disabled).toBe(true);
  expect(invoke.mock.calls.filter(([, args]) => (args!.request as { routeId: string }).routeId === 'data-cards.create')).toHaveLength(1);
  expect(session.saveCharacter).not.toHaveBeenCalled();
});

it('真实逐卡组件卸载时只释放表单，挂起 Native 写请求仍保持锁直到返回', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let finish!: (result: unknown) => void;
  const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
    const request = args!.request as { routeId: string };
    if (request.routeId === 'user-capacity.query') return { status: 200, body: { success: true, capacity: 10, usedSlots: 0 } };
    return new Promise(resolve => { finish = resolve; });
  });
  let locks!: ReturnType<typeof useArenaResultActionLocks>;
  let show = true;
  const session = { canSaveCharacter: () => false, saveCharacter: vi.fn(async () => false) };
  const data = { name: '甲', content: '完整结果' };
  function Harness() {
    locks = useArenaResultActionLocks(invoke);
    return show ? <DesktopArenaRoleUpdateActions data={data} selection={null} session={session} locks={locks} disabled={false}
      isBlocked={() => false} guard={{ ready: true, message: null }} onDownload={() => undefined} /> : null;
  }
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)!;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  await act(async () => root!.render(<Harness />));
  await act(async () => { button('保存到云端').click(); await settle(); });
  await act(async () => { button('保存').click(); await settle(); });
  expect(locks.isBusy()).toBe(true);
  show = false; await act(async () => root!.render(<Harness />));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(locks.isSourceLocked()).toBe(true); expect(locks.isBusy()).toBe(true);
  await act(async () => { finish({ status: 201, body: { success: true, id: 'copy', ownerUserId: 7, accountFenceVersion: 1 } }); await settle(); });
  expect(locks.isSourceLocked()).toBe(false); expect(locks.isBusy()).toBe(false);
  expect(invoke.mock.calls.filter(([, args]) => (args!.request as { routeId: string }).routeId === 'data-cards.create')).toHaveLength(1);
  expect(session.saveCharacter).not.toHaveBeenCalled();
});
