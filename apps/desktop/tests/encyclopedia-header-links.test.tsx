// @vitest-environment jsdom
import { act } from 'react';
import {
  Outlet,
  RouterProvider,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useBlocker,
} from '@tanstack/react-router';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopEncyclopediaEntry, DesktopEncyclopediaIndex } from '../src/app/encyclopedia-pages';
import { ExternalLinksProvider } from '../src/features/external-links/external-links-provider';

const pages = [
  { path: '/encyclopedia', testId: 'encyclopedia-index' },
  { path: '/encyclopedia/site-guide', testId: 'encyclopedia-entry' },
] as const;
const links = [
  { href: '/', text: '返回首页', className: 'footer-link' },
  { href: '/arena', text: '竞技场', className: 'text-blue-600 hover:underline' },
  { href: '/ranking', text: '排行榜', className: 'text-blue-600 hover:underline' },
] as const;

let container: HTMLDivElement;
let root: Root;
let history: ReturnType<typeof createHashHistory>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('# 标题\n\n正文。', { status: 200 })));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  history?.destroy();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settle = async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
};

// Render the real Desktop page adapters and shared views. Only destination content is a sentinel;
// the host owns this test guard and real hash router. This is DOM/router coverage, not WebView or visual QA.
const mount = async (path: string, guarded = false) => {
  window.history.replaceState(null, '', `/#${path}`);
  const Host = () => {
    const { status, proceed, reset } = useBlocker({
      shouldBlockFn: () => guarded,
      withResolver: true,
      enableBeforeUnload: false,
    });
    return (
      <ExternalLinksProvider>
        <span data-testid="blocker-status">{status}</span>
        <button type="button" data-testid="proceed" onClick={proceed}>继续</button>
        <button type="button" data-testid="reset" onClick={reset}>取消</button>
        <Outlet />
      </ExternalLinksProvider>
    );
  };
  const rootRoute = createRootRoute({ component: Host });
  const index = createRoute({
    getParentRoute: () => rootRoute, path: '/encyclopedia', component: DesktopEncyclopediaIndex,
  });
  const entry = createRoute({
    getParentRoute: () => rootRoute, path: '/encyclopedia/$slug', component: DesktopEncyclopediaEntry,
  });
  const destinations = links.map(({ href }) => createRoute({
    getParentRoute: () => rootRoute,
    path: href,
    component: () => <div data-testid="destination">{href}</div>,
  }));
  history = createHashHistory();
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, entry, ...destinations]), history, defaultPreload: false,
  });
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
  await settle();
  return router;
};

const headerLinks = () => {
  const header = container.querySelector('[data-testid="encyclopedia-page-card"] > header');
  const home = header?.querySelector('a[href="#/"]');
  expect(home, '百科页头应保留返回首页入口').not.toBeNull();
  return home!.parentElement!;
};

const click = async (element: Element, detail = 1) => {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail });
  await act(async () => { element.dispatchEvent(event); });
  await settle();
  return event;
};

describe.each(pages)('Desktop encyclopedia header on $path', ({ path, testId }) => {
  it('renders the shared links with hash hrefs and navigates all three through the host router', async () => {
    const router = await mount(path);
    expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
    const group = headerLinks();
    expect(group.className).toBe('flex items-center gap-4 text-sm');
    expect([...group.querySelectorAll('a')].map((anchor) => ({
      href: anchor.getAttribute('href'), text: anchor.textContent, className: anchor.className,
    }))).toEqual(links.map((link) => ({ ...link, href: `#${link.href}` })));
    if (testId === 'encyclopedia-index') {
      expect(container.textContent).toContain('随应用离线可用');
      expect(container.textContent).not.toContain('欢迎提交 PR');
    }

    for (const { href } of links) {
      const anchor = headerLinks().querySelector(`a[href="#${href}"]`)!;
      expect((await click(anchor)).defaultPrevented).toBe(true);
      expect(router.state.location.pathname).toBe(href);
      expect(window.location.hash).toBe(`#${href}`);
      expect(window.location.pathname).toBe('/');
      expect(container.querySelector('[data-testid="destination"]')?.textContent).toBe(href);
      await act(async () => { await router.navigate({ to: path }); });
      await settle();
    }
  });

  it.each(links)('respects host cancellation and acceptance when leaving for $href', async ({ href }) => {
    const router = await mount(path, true);
    const activate = async () => {
      // detail=0 exercises synthesized activation semantics, without claiming a real keyboard run.
      const event = await click(headerLinks().querySelector(`a[href="#${href}"]`)!, 0);
      expect(event.defaultPrevented).toBe(true);
      expect(container.querySelector('[data-testid="blocker-status"]')?.textContent).toBe('blocked');
      expect(router.state.location.pathname).toBe(path);
      expect(window.location.hash).toBe(`#${path}`);
      expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
      expect(container.querySelector('[data-testid="destination"]')).toBeNull();
    };

    await activate();
    await click(container.querySelector('[data-testid="reset"]')!);
    expect(container.querySelector('[data-testid="blocker-status"]')?.textContent).toBe('idle');
    expect(router.state.location.pathname).toBe(path);
    expect(window.location.hash).toBe(`#${path}`);
    expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();

    await activate();
    await click(container.querySelector('[data-testid="proceed"]')!);
    expect(router.state.location.pathname).toBe(href);
    expect(window.location.hash).toBe(`#${href}`);
    expect(container.querySelector('[data-testid="destination"]')?.textContent).toBe(href);
    expect(container.querySelector(`[data-testid="${testId}"]`)).toBeNull();
  });
});
