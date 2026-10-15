// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
import { createDesktopRouter } from '../src/app/router';
import { getDesktopCloudSessionStore, resetDesktopCloudSessionStoreForTests } from '../src/features/account/use-desktop-cloud-session';
import { CLOUD_AUTH_STATUS_COMMAND, CLOUD_CACHED_ACCOUNT_COMMAND } from '../src/platform/cloud-bridge';

const account = { userId: 7, username: 'homura', displayName: 'homura' };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  HTMLElement.prototype.scrollTo = vi.fn();
  resetDesktopCloudSessionStoreForTests();
  window.location.hash = '#/';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetDesktopCloudSessionStoreForTests();
  vi.restoreAllMocks();
});

it.each(['active', 'unreachable', 'signed-out'])('assembles the homepage account entry for %s identity', async (state) => {
  native.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === CLOUD_CACHED_ACCOUNT_COMMAND) return state === 'signed-out' ? null : { account, sessionExpiresAt: '2099-01-01T00:00:00.000Z' };
    if (command === CLOUD_AUTH_STATUS_COMMAND) return state === 'active'
      ? { state: 'active', account, sessionExpiresAt: '2099-01-01T00:00:00.000Z' }
      : { state };
    throw new Error(`Unavailable native command: ${command}`);
  });
  await getDesktopCloudSessionStore().bootstrap();
  const router = createDesktopRouter();
  await router.load();
  await act(async () => { root.render(<RouterProvider router={router} />); });
  const home = container.querySelector('[data-testid="page-home"]')!;
  expect(home.textContent).toContain('本机工具');
  const welcome = home.querySelector('[data-testid="home-account-welcome"]');
  if (state === 'signed-out') {
    expect(welcome).toBeNull();
    return;
  }
  expect(welcome?.querySelector('.font-semibold')?.textContent).toBe('homura');
  const me = welcome?.querySelector<HTMLAnchorElement>('a[href="#/me"]')!;
  expect(me.textContent).toBe('个人页：战报记录（测试版）');
  const modified = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  act(() => me.dispatchEvent(modified));
  expect(modified.defaultPrevented).toBe(false);
  expect(router.state.location.pathname).toBe('/');
  await act(async () => { me.click(); });
  expect(router.state.location.pathname).toBe('/me');
});
