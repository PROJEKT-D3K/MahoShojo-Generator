// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));

import { AccountPanel } from '../src/features/account/AccountPanel';
import {
  getDesktopCloudSessionStore,
  resetDesktopCloudSessionStoreForTests,
} from '../src/features/account/use-desktop-cloud-session';
import {
  CLOUD_AUTH_STATUS_COMMAND,
  CLOUD_CACHED_ACCOUNT_COMMAND,
  CLOUD_LOGIN_AWAIT_COMMAND,
  CLOUD_LOGIN_BEGIN_COMMAND,
  CLOUD_SIGN_OUT_COMMAND,
} from '../src/platform/cloud-bridge';

const ACCOUNT = { userId: 7, username: 'homura', displayName: 'homura' };
const NEXT_ACCOUNT = { userId: 8, username: 'madoka', displayName: 'madoka' };
const EXPIRES = '2026-10-12T00:00:00.000Z';
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let root: Root;
let container: HTMLDivElement;
let status: unknown;
let signOut: ReturnType<typeof deferred<unknown>>;
const button = (label: string) => [...container.querySelectorAll('button')]
  .find((node) => node.textContent === label)!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetDesktopCloudSessionStoreForTests();
  status = { state: 'active', account: ACCOUNT, sessionExpiresAt: EXPIRES };
  signOut = deferred<unknown>();
  native.invoke.mockReset().mockImplementation(async (command: string) => {
    switch (command) {
      case CLOUD_CACHED_ACCOUNT_COMMAND: return { account: ACCOUNT, sessionExpiresAt: EXPIRES };
      case CLOUD_AUTH_STATUS_COMMAND: return status;
      case CLOUD_SIGN_OUT_COMMAND: return signOut.promise;
      case CLOUD_LOGIN_BEGIN_COMMAND:
        return { flowId: 'flow-1', authorizeUrl: 'https://example.test/auth/desktop?state=s' };
      case CLOUD_LOGIN_AWAIT_COMMAND:
        return { status: 'signed-in', account: NEXT_ACCOUNT, sessionExpiresAt: EXPIRES };
      default: throw new Error(`unexpected command ${command}`);
    }
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  resetDesktopCloudSessionStoreForTests();
});

const mount = async () => {
  const store = getDesktopCloudSessionStore();
  await store.bootstrap();
  await act(async () => { root.render(<AccountPanel />); });
  expect(container.textContent).toContain('已登录 · homura');
  return store;
};

describe('AccountPanel real sign-out receipt ownership', () => {
  it.each(['success', 'failure'] as const)('late %s never announces deletion or overwrites the new account', async (outcome) => {
    const store = await mount();
    const exiting = vi.spyOn(store, 'signOut');
    await act(async () => { button('退出登录').click(); });
    const completion = exiting.mock.results[0]!.value;
    status = { state: 'expired' };
    await act(async () => { await store.requestAuth(); });
    expect(container.textContent).toContain('已登录 · madoka');
    await act(async () => {
      if (outcome === 'success') signOut.resolve({ revoked: false });
      else signOut.reject({ code: 'storage-unavailable', message: 'old exit failed' });
      await completion;
    });
    expect(store.getSnapshot().account).toEqual(NEXT_ACCOUNT);
    expect(container.textContent).toContain('已登录 · madoka');
    expect(container.textContent).not.toContain('已退出登录');
    expect(container.textContent).not.toContain('本地凭据已删除');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('a current local storage failure shows the error while retaining the account', async () => {
    const store = await mount();
    const exiting = vi.spyOn(store, 'signOut');
    await act(async () => { button('退出登录').click(); });
    await act(async () => {
      signOut.reject({ code: 'storage-unavailable', message: '本地凭据删除失败' });
      await exiting.mock.results[0]!.value;
    });
    expect(container.textContent).toContain('已登录 · homura');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('本地凭据删除失败');
    expect(container.textContent).not.toContain('已退出登录');
    expect(container.textContent).not.toContain('本地凭据已删除');
  });

  it.each([true, false])('reports a current revoked=%s receipt, then removes that notice on a new login', async (revoked) => {
    const store = await mount();
    const exiting = vi.spyOn(store, 'signOut');
    await act(async () => { button('退出登录').click(); });
    expect(container.textContent).not.toContain('已退出登录');
    await act(async () => {
      signOut.resolve({ revoked });
      await exiting.mock.results[0]!.value;
    });
    expect(container.textContent).toContain(revoked
      ? '已退出登录，服务端会话已同步作废。'
      : '已退出登录：本地凭据已删除，但服务端会话未能确认作废（可能已过期）。');
    status = { state: 'signed-out' };
    await act(async () => { await store.requestAuth(); });
    expect(container.textContent).toContain('已登录 · madoka');
    expect(container.textContent).not.toContain('已退出登录');
    expect(container.textContent).not.toContain('本地凭据已删除');
  });
});
