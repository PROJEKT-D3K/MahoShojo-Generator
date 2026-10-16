// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthStorageError, beginAuthIdentityTransition } from '@/lib/auth-identity';
import { dispatchMeProfileAvatarUpdated } from '@/lib/me-profile-events';

/**
 * Web 顶栏适配器测试：`GlobalTopBar` 现在只把 Web 宿主事实注入共享
 * `ProductTopBar`（Next Router、useAuth、消息/头像 hooks、AuthModal）。
 * 展示结构与语义在 `packages/ui-web/tests/topbar.test.tsx` 闭合；
 * 这里守住的是**注入映射**——账号投影、消息摘要、站外能力与 AuthModal 接线。
 */

let authState = {
  user: null as null | { id: number; username: string; prefix?: string | null },
  userBadges: [],
  loading: false,
  isAuthenticated: false,
  logout: async () => undefined,
};

let topBarProfileState = {
  avatarDataUrl: null as string | null,
};

let topBarMessagesState = {
  unreadTotal: 0,
  hasCrowdReviewPending: false,
  loading: false,
  error: null as string | null,
  refresh: async () => undefined,
};

const routerPushMock = vi.fn();
const profileFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  authStorage: { fetch: profileFetchMock },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock }),
}));

vi.mock('@/lib/useAuth', () => ({
  useAuth: () => authState,
}));

vi.mock('@/components/navigation/useTopBarProfile', () => ({
  useTopBarProfile: () => topBarProfileState,
}));

vi.mock('@/components/navigation/useTopBarMessages', () => ({
  useTopBarMessages: () => topBarMessagesState,
}));

vi.mock('@/components/CharManager/AuthModal', () => ({
  default: ({ isOpen, authMessage }: { isOpen: boolean; authMessage?: { text: string } | null }) => (
    <div data-auth-modal="true" data-auth-modal-open={String(isOpen)}>{isOpen ? authMessage?.text : null}</div>
  ),
}));

vi.mock('@/components/UserTitle', () => ({
  default: () => <span data-user-title="true" />,
}));

describe('GlobalTopBar adapter', () => {
  beforeEach(() => {
    authState = {
      user: null,
      userBadges: [],
      loading: false,
      isAuthenticated: false,
      logout: async () => undefined,
    };
    topBarProfileState = { avatarDataUrl: null };
    topBarMessagesState = {
      unreadTotal: 0,
      hasCrowdReviewPending: false,
      loading: false,
      error: null,
      refresh: async () => undefined,
    };
  });

  test('renders logo, grouped nav, theme, messages and the signed-out CTA', async () => {
    const { GlobalTopBar } = await import('@/components/navigation/GlobalTopBar');
    const html = renderToStaticMarkup(<GlobalTopBar pathname="/battle" />);

    expect(html).toContain('MahoShojo');
    expect(html).toContain('src="/favicon.svg"');
    expect(html).toContain('data-logo-fallback="true"');
    expect(html).toContain('href="/"');
    for (const label of ['创作', '竞技', '角色', '百科', '简洁竞技场', '完整竞技场']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('外观');
    expect(html).toContain('消息');
    expect(html).toContain('href="/messages"');
    expect(html).toContain('登录 / 注册');
    // 共享 DOM 由 `<a>` 渲染：不再出现 next/link 的 prefetch 行为。
    expect(html).not.toContain('data-prefetch');
  });

  test('marks only the covered active group while keeping other entries as links', async () => {
    const { GlobalTopBar } = await import('@/components/navigation/GlobalTopBar');
    const html = renderToStaticMarkup(<GlobalTopBar pathname="/creator" />);

    expect(html).toContain('data-active-group="creative"');
    expect(html).toContain('href="/ranking"');
    expect(html).toContain('href="/encyclopedia"');
    expect(html).toContain('href="/name"');
  });

  test('keeps external entries openable on Web via the native new-tab path', async () => {
    const { GlobalTopBar } = await import('@/components/navigation/GlobalTopBar');
    const html = renderToStaticMarkup(<GlobalTopBar pathname="/" />);

    expect(html).toContain('href="https://wantu-waystation.pages.dev/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test('maps the signed-in projection with avatar, title slot and account links', async () => {
    authState = {
      ...authState,
      user: { id: 7, username: '小圆' },
      isAuthenticated: true,
    };
    topBarProfileState = { avatarDataUrl: 'data:image/webp;base64,topbar-avatar' };
    const { GlobalTopBar } = await import('@/components/navigation/GlobalTopBar');
    const html = renderToStaticMarkup(<GlobalTopBar pathname="/" />);

    expect(html).toContain('小圆');
    expect(html).toContain('src="data:image/webp;base64,topbar-avatar"');
    expect(html).toContain('alt="小圆的头像"');
    expect(html).toContain('data-user-title="true"');
    expect(html).toContain('个人页');
    expect(html).toContain('角色管理');
    expect(html).toContain('退出登录');
    expect(html).toContain('href="/me"');
    expect(html).toContain('href="/character-manager"');
  });

  test('maps the loading projection to the neutral user chip', async () => {
    authState = { ...authState, loading: true };
    const { GlobalTopBar } = await import('@/components/navigation/GlobalTopBar');
    const html = renderToStaticMarkup(<GlobalTopBar pathname="/" />);

    expect(html).toContain('用户');
    expect(html).not.toContain('登录 / 注册');
  });

  test('injects the unread badge only while authenticated', async () => {
    topBarMessagesState = { ...topBarMessagesState, unreadTotal: 5 };
    const { GlobalTopBar } = await import('@/components/navigation/GlobalTopBar');

    const signedOutHtml = renderToStaticMarkup(<GlobalTopBar pathname="/" />);
    expect(signedOutHtml).not.toContain('5 条未读');

    authState = {
      ...authState,
      user: { id: 7, username: '小圆' },
      isAuthenticated: true,
    };
    const signedInHtml = renderToStaticMarkup(<GlobalTopBar pathname="/" />);
    expect(signedInHtml).toContain('5 条未读');
  });

  test('keeps the shared accessible labels and renders no unsupported menu roles', async () => {
    const { GlobalTopBar } = await import('@/components/navigation/GlobalTopBar');
    const html = renderToStaticMarkup(<GlobalTopBar pathname="/arena" />);

    for (const label of ['返回首页', '全站主导航', '外观设置', '消息中心', '打开导航菜单']) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('aria-haspopup="menu"');
  });

  test('renders exactly one theme menu and one message entry across breakpoints', async () => {
    const { GlobalTopBar } = await import('@/components/navigation/GlobalTopBar');
    const html = renderToStaticMarkup(<GlobalTopBar pathname="/arena" />);

    expect(html.match(/aria-label="外观设置"/g)?.length ?? 0).toBe(1);
    expect(html.match(/aria-label="消息中心"/g)?.length ?? 0).toBe(1);
  });

  test('renders the mobile drawer after the header', async () => {
    const { GlobalTopBar } = await import('@/components/navigation/GlobalTopBar');
    const html = renderToStaticMarkup(<GlobalTopBar pathname="/arena" defaultMobileOpen={true} />);

    const headerEnd = html.indexOf('</header>');
    const drawerDialog = html.indexOf('role="dialog"');

    expect(headerEnd).toBeGreaterThan(-1);
    expect(drawerDialog).toBeGreaterThan(headerEnd);
    expect(html).toContain('移动端导航');
    expect(html).toContain('关闭导航');
  });

  test('defers AuthModal until auth is requested', async () => {
    const { GlobalTopBar } = await import('@/components/navigation/GlobalTopBar');
    const html = renderToStaticMarkup(<GlobalTopBar pathname="/" />);

    expect(html).not.toContain('data-auth-modal');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<GlobalTopBar pathname="/" />));
      expect(container.querySelector('[data-auth-modal]')).toBeNull();

      const requestAuthButton = [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === '登录 / 注册');
      expect(requestAuthButton).toBeDefined();
      await act(async () => requestAuthButton!.click());
      for (let attempt = 0; attempt < 20 && !container.querySelector('[data-auth-modal]'); attempt++) {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
      }

      expect(container.querySelector('[data-auth-modal-open="true"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test.each([false, true])('本地退出清除失败复用错误区；已换代=%s 时不打扰新身份', async (stale) => {
    const { GlobalTopBar } = await import('@/components/navigation/GlobalTopBar');
    const failure = new AuthStorageError();
    let reject!: (_error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
    authState = { ...authState, user: { id: 7, username: 'A' }, isAuthenticated: true, logout: () => pending };
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<GlobalTopBar pathname="/" />));
      const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === '退出登录');
      expect(button).toBeDefined();
      await act(async () => button!.click());
      if (stale) {
        beginAuthIdentityTransition();
        authState = { ...authState, user: { id: 8, username: 'B' } };
        await act(async () => root.render(<GlobalTopBar pathname="/" />));
      }
      await act(async () => reject(failure));
      if (stale) {
        expect(container.textContent).not.toContain('本机登录信息清除失败');
        expect(authState.user?.id).toBe(8);
      } else {
        expect(container.textContent).toContain('本机登录信息清除失败，请检查浏览器存储设置后重试');
        expect(container.querySelector('[data-auth-modal-open="true"]')).not.toBeNull();
        expect(container.textContent).not.toContain('服务器登出失败');
      }
    } finally {
      reject(failure);
      await act(async () => root.unmount()); container.remove();
    }
  });

  test('leaves modifier clicks on internal links to native anchor semantics', async () => {
    // D5.0d-r1：共源前 Web 用 next/link——Ctrl/Cmd/Shift+Click 走浏览器
    // 新标签/新窗口，客户端导航回调不执行。adapter 只能接管普通主键点击；
    // modifier click 被 preventDefault + push 是一次真实行为回归。
    const { GlobalTopBar } = await import('@/components/navigation/GlobalTopBar');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<GlobalTopBar pathname="/" />);
      });
      const link = container.querySelector<HTMLAnchorElement>('a[href="/character-manager"]');
      expect(link).not.toBeNull();

      for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }] as const) {
        const event = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: 0,
          ...init,
        });
        await act(async () => {
          link?.dispatchEvent(event);
        });
        expect(routerPushMock).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
      }

      // 对照组：普通主键点击仍由 Next Router 接管并阻止默认整页导航。
      const plainClick = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      await act(async () => {
        link?.dispatchEvent(plainClick);
      });
      expect(routerPushMock).toHaveBeenCalledWith('/character-manager');
      expect(plainClick.defaultPrevented).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe('useTopBarProfile request and event cache ownership', () => {
  const originalAvatar = 'data:image/webp;base64,old-avatar';
  const updatedAvatar = 'data:image/webp;base64,new-avatar';
  const response = (avatarDataUrl: string | null) => ({
    ok: true,
    json: async () => ({ success: true, profile: { avatarDataUrl } }),
  });
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
  };
  let useTopBarProfile: typeof import('@/components/navigation/useTopBarProfile').useTopBarProfile;
  let root: Root;
  let container: HTMLDivElement;
  let nextUserId = 100;
  let userId: number;
  const Harness = ({ id, enabled }: { id: number | null; enabled: boolean }) => {
    const { avatarDataUrl } = useTopBarProfile(id, enabled);
    return <output>{avatarDataUrl ?? 'no-avatar'}</output>;
  };
  const render = (id: number | null = userId, enabled = true) => act(async () => {
    root.render(<Harness id={id} enabled={enabled} />);
  });
  const unmount = () => act(async () => { root.render(null); });
  const expectAvatar = (value: string | null) => expect(container.textContent).toBe(value ?? 'no-avatar');

  beforeEach(async () => {
    // Exercise the real hook and its module cache without changing the adapter mock above.
    ({ useTopBarProfile } = await vi.importActual('@/components/navigation/useTopBarProfile'));
    userId = nextUserId;
    nextUserId += 2;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    profileFetchMock.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  test.each([updatedAvatar, null])('keeps event avatar %s cached after an older GET and remount', async (avatarDataUrl) => {
    const initial = deferred<ReturnType<typeof response>>();
    profileFetchMock.mockReturnValue(initial.promise);
    await render();
    expect(profileFetchMock).toHaveBeenCalledWith('/api/me/profile', expect.objectContaining({ method: 'GET', cache: 'no-store' }));
    await act(async () => { dispatchMeProfileAvatarUpdated({ userId, avatarDataUrl }); });
    expectAvatar(avatarDataUrl);
    await act(async () => { initial.resolve(response(originalAvatar)); });
    expectAvatar(avatarDataUrl);
    await unmount();
    await render();
    expectAvatar(avatarDataUrl);
    expect(profileFetchMock).toHaveBeenCalledTimes(1);
  });

  test('keeps the event avatar when the old GET is still parsing JSON', async () => {
    const body = deferred<Awaited<ReturnType<ReturnType<typeof response>['json']>>>();
    profileFetchMock.mockResolvedValue({ ok: true, json: () => body.promise });
    await render();
    await act(async () => { dispatchMeProfileAvatarUpdated({ userId, avatarDataUrl: updatedAvatar }); });
    await act(async () => { body.resolve({ success: true, profile: { avatarDataUrl: originalAvatar } }); });
    await unmount();
    await render();
    expectAvatar(updatedAvatar);
    expect(profileFetchMock).toHaveBeenCalledTimes(1);
  });

  test('keeps the event avatar when an older GET fails', async () => {
    const initial = deferred<{ ok: false; status: number }>();
    profileFetchMock.mockReturnValue(initial.promise);
    await render();
    await act(async () => { dispatchMeProfileAvatarUpdated({ userId, avatarDataUrl: updatedAvatar }); });
    await act(async () => { initial.resolve({ ok: false, status: 503 }); });
    expectAvatar(updatedAvatar);
    await unmount();
    await render();
    expectAvatar(updatedAvatar);
    expect(profileFetchMock).toHaveBeenCalledTimes(1);
  });

  test.each(['unmount', 'disable', 'account switch'] as const)('does not seed the cache from a GET cancelled by %s', async (change) => {
    const initial = deferred<ReturnType<typeof response>>();
    profileFetchMock.mockReturnValueOnce(initial.promise).mockResolvedValue(response(updatedAvatar));
    await render();
    const signal = profileFetchMock.mock.calls[0][1].signal as AbortSignal;
    if (change === 'unmount') await unmount();
    else await render(change === 'account switch' ? userId + 1 : userId, change !== 'disable');
    expect(signal.aborted).toBe(true);
    await act(async () => { initial.resolve(response(originalAvatar)); });
    if (change === 'account switch') expectAvatar(updatedAvatar);
    if (change === 'disable') expectAvatar(null);
    await render();
    expectAvatar(updatedAvatar);
    expect(profileFetchMock).toHaveBeenCalledTimes(change === 'account switch' ? 3 : 2);
  });

  test.each([originalAvatar, null])('reuses a normal GET cache value %s and ignores another account event', async (avatarDataUrl) => {
    profileFetchMock.mockResolvedValue(response(avatarDataUrl));
    await render();
    expectAvatar(avatarDataUrl);
    await act(async () => { dispatchMeProfileAvatarUpdated({ userId: userId + 1, avatarDataUrl: updatedAvatar }); });
    expectAvatar(avatarDataUrl);
    await unmount();
    await render();
    expectAvatar(avatarDataUrl);
    expect(profileFetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not fetch or listen while disabled or signed out', async () => {
    await render(userId, false);
    await act(async () => { dispatchMeProfileAvatarUpdated({ userId, avatarDataUrl: updatedAvatar }); });
    expectAvatar(null);
    await render(null);
    expectAvatar(null);
    expect(profileFetchMock).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
