// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ state: {} as any, epoch: 0, refresh: vi.fn(), requestAuth: vi.fn(), cancelLogin: vi.fn(), signOut: vi.fn(), copy: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../src/features/account/use-desktop-cloud-session', () => ({ useDesktopCloudSession: () => ({ state: mocks.state, store: {
  getSnapshot: () => mocks.state, getCredentialEpoch: () => mocks.epoch, refresh: mocks.refresh, requestAuth: mocks.requestAuth, cancelLogin: mocks.cancelLogin, signOut: mocks.signOut,
} }) }));
import { AccountPanel } from '../src/features/account/AccountPanel';
let root: Root; let container: HTMLDivElement;
const render = (presentation: 'summary' | 'full' = 'summary') => act(async () => root.render(<AccountPanel presentation={presentation} />));
const button = (name: string) => [...container.querySelectorAll('button')].find(x => x.textContent === name)!;
beforeEach(() => {
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
it('keeps login, pending copy/cancel, errors and exit receipt actions identical in summary and full', async () => {
  mocks.state = { ...mocks.state, bootstrapped: true, verification: 'signed-out' }; await render();
  const summary = [...container.querySelectorAll('button')].map(x => x.textContent);
  await render('full'); expect([...container.querySelectorAll('button')].map(x => x.textContent)).toEqual([...summary, '检查在线服务']);
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
