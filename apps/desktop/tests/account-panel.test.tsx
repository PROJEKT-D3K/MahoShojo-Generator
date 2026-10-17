// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ state: {} as any, epoch: 0, refresh: vi.fn(), requestAuth: vi.fn(), cancelLogin: vi.fn(), signOut: vi.fn(), copy: vi.fn(), invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../src/features/account/use-desktop-cloud-session', () => ({ useDesktopCloudSession: () => ({ state: mocks.state, store: {
  getSnapshot: () => mocks.state, getCredentialEpoch: () => mocks.epoch, refresh: mocks.refresh, requestAuth: mocks.requestAuth, cancelLogin: mocks.cancelLogin, signOut: mocks.signOut,
} }) }));
import { buttonClassName } from '@mahoshojo/ui-web/card-library';
import { AccountPanel } from '../src/features/account/AccountPanel';
let root: Root; let container: HTMLDivElement;
const render = () => act(async () => root.render(<AccountPanel />));
const button = (name: string) => [...container.querySelectorAll('button')].find(x => x.textContent === name)!;
beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.state = { account: null, bootstrapped: false, verification: 'idle', authFlow: { kind: 'idle' }, lastError: null };
  mocks.epoch = 0; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.copy } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
it('presents bootstrap, checking, expired and unavailable states without claiming cached identity is verified', async () => {
  await render(); expect(container.textContent).toContain('尚未验证');
  mocks.state = { ...mocks.state, bootstrapped: true, verification: 'checking' }; await render();
  expect(container.textContent).toContain('正在读取'); expect(button('登录账号')).toBeUndefined();
  mocks.state = { ...mocks.state, verification: 'expired' }; await render(); expect(container.textContent).toContain('会话已过期');
  mocks.state = { ...mocks.state, verification: 'unreachable' }; await render(); expect(container.textContent).toContain('服务不可用');
  mocks.state = { ...mocks.state, account: { userId: 1, username: 'A' } }; await render();
  expect(container.textContent).toContain('本机账号 · A'); expect(container.textContent).not.toContain('已登录');
  expect(container.textContent).toContain('服务暂时不可达');
});
it('keeps login, pending copy/cancel, errors and exit receipts in account settings', async () => {
  mocks.state = { ...mocks.state, bootstrapped: true, verification: 'signed-out' }; await render();
  expect(button('检查在线服务')).toBeDefined();
  await render(); await act(async () => button('登录账号').click()); expect(mocks.requestAuth).toHaveBeenCalledOnce();
  mocks.state = { ...mocks.state, authFlow: { kind: 'authenticating', authorizeUrl: 'https://example.test/auth' } }; await render();
  await act(async () => button('复制授权地址').click()); expect(mocks.copy).toHaveBeenCalledWith('https://example.test/auth');
  expect(container.textContent).toContain('已复制'); await act(async () => button('取消登录').click()); expect(mocks.cancelLogin).toHaveBeenCalledOnce();
  mocks.state = { ...mocks.state, authFlow: { kind: 'idle' }, lastError: '授权失败' }; await render(); expect(container.querySelector('[role=alert]')?.textContent).toBe('授权失败');
  mocks.state = { ...mocks.state, lastError: null, account: { userId: 1, username: 'A' }, verification: 'verified' };
  mocks.signOut.mockImplementation(async () => { mocks.epoch++; mocks.state = { ...mocks.state, account: null, verification: 'signed-out' }; return { revoked: false }; });
  await render(); await act(async () => button('退出登录').click()); await render();
  expect(container.textContent).toContain('本地凭据已删除'); expect(container.textContent).toContain('服务端会话未能确认作废');
});

it('uses shared visible actions across session states and preserves native disabled probing', async () => {
  const expectAction = (label: string) => {
    const control = button(label);
    expect(control.type).toBe('button');
    expect(control.className).toBe(buttonClassName());
    control.focus();
    expect(document.activeElement).toBe(control);
    return control;
  };
  mocks.state = { ...mocks.state, bootstrapped: true, verification: 'signed-out' };
  await render(); expectAction('登录账号');
  mocks.state = { ...mocks.state, authFlow: { kind: 'authenticating', authorizeUrl: 'https://example.test/auth' } };
  await render(); expectAction('取消登录'); expectAction('复制授权地址');
  mocks.state = { ...mocks.state, account: { userId: 1, username: 'A' }, verification: 'verified', authFlow: { kind: 'idle' } };
  await render(); expectAction('退出登录');
  let finish!: (value: unknown) => void;
  mocks.invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const probe = expectAction('检查在线服务');
  await act(async () => { probe.click(); });
  expect(probe.disabled).toBe(true);
  expect(probe.textContent).toBe('正在探测…');
  act(() => { probe.click(); });
  expect(mocks.invoke).toHaveBeenCalledOnce();
  await act(async () => { finish({ reachable: true, compatible: true, contractVersion: 'test' }); });
  expect(probe.disabled).toBe(false);
  expect(probe.textContent).toBe('检查在线服务');
});

it.each(['idle', 'checking', 'unreachable'])('still revalidates a %s session with a prior read error on entry', async (verification) => {
  mocks.state = { ...mocks.state, verification, lastError: '会话状态读取失败' };
  await render();
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it.each(['verified', 'signed-out', 'expired'])('preserves an action error for a confirmed %s session on entry', async (verification) => {
  mocks.state = { ...mocks.state, verification, lastError: '授权失败' };
  await render();
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('授权失败');
});
