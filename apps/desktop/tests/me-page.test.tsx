// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), state: {} as any, epoch: 0, refresh: vi.fn(), navigate: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ navigate: mocks.navigate }), Link: ({ to, children }: any) => <a href={to}>{children}</a> }));
vi.mock('../src/features/account/use-desktop-cloud-session', () => {
  const store = { getSnapshot: () => mocks.state, getCredentialEpoch: () => mocks.epoch, refresh: mocks.refresh };
  return { useDesktopCloudSession: () => ({ state: mocks.state, store }) };
});
vi.mock('../src/features/account/AccountPanel', () => ({ AccountPanel: ({ presentation }: { presentation: string }) => <div>会话：{presentation}</div> }));
vi.mock('../src/features/battle-reports/BattleReportHistoryPanel', () => ({ BattleReportHistoryPanel: () => <section><h2>战报记录</h2></section> }));
vi.mock('../src/features/external-links/external-links-provider', () => ({ useExternalLinks: () => ({ openFixed: vi.fn() }) }));
import { DesktopMe } from '../src/app/me-page';
import { acceptSavedProfileAvatar, beginMyProfileMutation, invalidateTopbarAvatar, resetTopbarAvatarForTests } from '../src/features/account/use-topbar-avatar';
let root: Root; let container: HTMLDivElement;
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const render = () => act(async () => { root.render(<DesktopMe />); });
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  resetTopbarAvatarForTests(); mocks.epoch = 0; mocks.refresh.mockReset(); mocks.navigate.mockReset().mockResolvedValue(undefined); vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  mocks.state = { account: { userId: 1, username: 'A' }, verification: 'verified' };
  mocks.invoke.mockReset().mockImplementation(async () => ({ userId: mocks.state.account.userId, signature: '签名' }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); resetTopbarAvatarForTests(); });
it('does not fetch private profile or mount an editor while signed out', async () => {
  mocks.state = { ...mocks.state, account: null, verification: 'signed-out' }; await render();
  expect(mocks.invoke).not.toHaveBeenCalled(); expect(container.querySelector('[aria-label="个人资料"]')).toBeNull();
  expect(container.querySelector('textarea')).toBeNull(); expect(container.textContent).toContain('战报记录');
});
it('assembles the common page with one battle title and routes editing to account settings', async () => {
  await render(); expect(container.querySelector('h1')?.textContent).toBe('个人页');
  expect(container.textContent).toContain('签名');
  expect(container.querySelector('.border-yellow-200')?.textContent).toContain('不保证长期保存');
  expect(container.querySelector('.border-yellow-200')?.textContent).toContain('此页不保存本地副本'); expect(container.textContent).toContain('会话：summary');
  expect([...container.querySelectorAll('h2')].filter(x => x.textContent === '战报记录')).toHaveLength(1);
  expect(container.querySelector('textarea')).toBeNull();
  act(() => [...container.querySelectorAll('button')].find(x => x.textContent === '编辑资料')!.click());
  expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/settings', search: { section: 'account' } }));
});
it('keeps unknown signature after avatar-only receipt and shows read failure with retry', async () => {
  const read = deferred<unknown>(); mocks.invoke.mockReturnValueOnce(read.promise);
  act(() => { acceptSavedProfileAvatar(1, 'data:image/webp;base64,QUJD', beginMyProfileMutation(1, 'avatar')); });
  await render(); expect(container.textContent).not.toContain('还没有个性签名');
  expect(container.textContent).toContain('尚未取得完整资料');
  expect([...container.querySelectorAll('button')].some(x => x.textContent === '载入资料')).toBe(true);
  await act(async () => read.reject({ code: 'network-error', message: 'offline' }));
  expect(container.textContent).toContain('资料未能载入'); expect(container.textContent).not.toContain('还没有个性签名');
  mocks.invoke.mockResolvedValueOnce({ userId: 1 });
  await act(async () => [...container.querySelectorAll('button')].find(x => x.textContent === '重新载入资料')!.click());
  expect(container.textContent).toContain('还没有个性签名');
});
it.each(['switch', 'relogin'] as const)('ignores late profile 401 after %s and retains current profile', async (change) => {
  const old = deferred<unknown>(); mocks.invoke.mockReturnValueOnce(old.promise); await render();
  act(() => invalidateTopbarAvatar(1)); mocks.epoch++;
  mocks.state = { ...mocks.state, account: { userId: change === 'switch' ? 2 : 1, username: 'B' } };
  mocks.invoke.mockResolvedValueOnce({ userId: mocks.state.account.userId, signature: '新签名' }); await render();
  await act(async () => old.reject({ code: 'not-authenticated', message: 'old 401' }));
  expect(container.textContent).toContain('新签名'); expect(mocks.refresh).not.toHaveBeenCalled();
});
