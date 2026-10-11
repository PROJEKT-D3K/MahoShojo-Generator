// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), user: null as { id: number; username: string } | null }));
vi.mock('@/lib/auth', () => ({ authStorage: { fetch: mocks.fetch } }));
vi.mock('@/lib/auth-client-store', () => ({ getAuthSnapshot: () => ({ user: mocks.user }), subscribeAuthSnapshot: () => () => {} }));
import { useMeProfile } from '@/components/me/useMeProfile';
import { ME_PROFILE_AVATAR_UPDATED_EVENT } from '@/lib/me-profile-events';

const ORIGINAL = 'data:image/webp;base64,b2xk';
const UPLOADED = 'data:image/webp;base64,bmV3';
const avatarPath = '/api/me/profile/avatar';
const response = (data: unknown) => ({ ok: true, json: async () => data });
const profileResponse = () => response({ success: true, profile: { signature: '保留签名', avatarDataUrl: ORIGINAL } });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
let root: Root; let container: HTMLDivElement; let client: QueryClient;
let userId: number | null; let hook: ReturnType<typeof useMeProfile>;
let releaseRead: (() => void) | undefined;
let pauseRead: boolean;
let avatarEvents: Mock<(event: Event) => void>;
const Harness = () => { const result = useMeProfile(userId); useEffect(() => { hook = result; }); return null; };
const render = () => act(async () => { root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>); await tick(); });
const file = () => new File(['image'], 'avatar.png', { type: 'image/png' });
const run = (kind: 'upload' | 'clear') => kind === 'upload' ? hook.uploadAvatar(file()) : hook.clearAvatar();
const avatarRequests = () => mocks.fetch.mock.calls.filter(([path]) => path === avatarPath);
const switchOwner = async (next: 'B' | 'ABA' | 'same-account-login' | 'logout') => {
  const original = mocks.user;
  userId = next === 'logout' ? null : next === 'same-account-login' ? 1 : 2;
  mocks.user = userId === null ? null : { id: userId, username: next };
  await render();
  if (next === 'ABA') { userId = 1; mocks.user = original; await render(); }
};

beforeEach(() => {
  // Deliberately hostile test default: production does not currently enable mutation retries.
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: 3, retryDelay: 0 } } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  userId = 1; mocks.user = { id: 1, username: 'A' }; pauseRead = false; releaseRead = undefined;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path, init) => path === avatarPath
    ? response(init.method === 'DELETE' ? { success: true } : { success: true, avatarDataUrl: UPLOADED })
    : profileResponse());
  vi.stubGlobal('FileReader', class {
    result = 'data:image/png;base64,aW1hZ2U=';
    onload: (() => void) | null = null;
    readAsDataURL() {
      const complete = () => this.onload?.();
      if (pauseRead) releaseRead = complete; else queueMicrotask(complete);
    }
  });
  vi.stubGlobal('Image', class {
    naturalWidth = 256; naturalHeight = 128;
    onload: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(UPLOADED);
  avatarEvents = vi.fn(); window.addEventListener(ME_PROFILE_AVATAR_UPDATED_EVENT, avatarEvents);
});
afterEach(() => {
  act(() => root.unmount()); container.remove(); client.clear();
  window.removeEventListener(ME_PROFILE_AVATAR_UPDATED_EVENT, avatarEvents); vi.unstubAllGlobals();
});

describe('Web avatar mutation ownership and server confirmation', () => {
  it.each(['upload', 'clear'] as const)('publishes confirmed %s without losing the signature', async (kind) => {
    await render(); await act(async () => { await run(kind); await tick(); });
    const avatarDataUrl = kind === 'upload' ? UPLOADED : null;
    expect(client.getQueryData(['me-profile', 1])).toEqual({ success: true, profile: { signature: '保留签名', avatarDataUrl } });
    expect(avatarEvents).toHaveBeenCalledTimes(1);
    expect((avatarEvents.mock.calls[0][0] as CustomEvent).detail).toEqual({ userId: 1, avatarDataUrl });
    expect(avatarRequests()).toHaveLength(1);
    if (kind === 'upload') expect(JSON.parse(avatarRequests()[0][1].body)).toEqual({ avatarWebpBase64: 'bmV3' });
    expect(hook.error).toBeNull();
  });

  it.each(['B', 'ABA'] as const)('does not send an old upload after %s during compression', async (next) => {
    await render(); pauseRead = true;
    let pending!: Promise<unknown>;
    await act(async () => { pending = run('upload').catch((error: unknown) => error); await tick(); });
    expect(releaseRead).toBeTypeOf('function');
    await switchOwner(next);
    await act(async () => { releaseRead!(); await pending; await tick(); });
    expect(await pending).toBeInstanceOf(Error);
    expect(avatarRequests()).toHaveLength(0);
    expect(avatarEvents).not.toHaveBeenCalled();
    expect(hook.isUploadingAvatar).toBe(false);
    expect(hook.error).toBeNull();
  });

  describe.each(['upload', 'clear'] as const)('%s', (kind) => {
    it.each(['B', 'ABA', 'same-account-login', 'logout'] as const)('fences a late result after %s and scopes pending/error state', async (next) => {
      await render(); const request = deferred<ReturnType<typeof response>>();
      mocks.fetch.mockImplementation((path) => path === avatarPath ? request.promise : Promise.resolve(profileResponse()));
      let pending!: Promise<unknown>;
      await act(async () => { pending = run(kind).catch((error: unknown) => error); await tick(); });
      expect(avatarRequests()).toHaveLength(1);
      expect(kind === 'upload' ? hook.isUploadingAvatar : hook.isClearingAvatar).toBe(true);
      await switchOwner(next);
      const nextOwnerPending = hook.isUploadingAvatar || hook.isClearingAvatar;
      await act(async () => { request.resolve(response({ success: true, avatarDataUrl: UPLOADED })); await pending; await tick(); });
      expect(await pending).toBeInstanceOf(Error);
      expect(client.getQueryData(['me-profile', 1])).toMatchObject({ profile: { avatarDataUrl: ORIGINAL } });
      if (next === 'B' || next === 'ABA') expect(client.getQueryData(['me-profile', 2])).toMatchObject({ profile: { avatarDataUrl: ORIGINAL } });
      expect(avatarEvents).not.toHaveBeenCalled(); expect(hook.error).toBeNull();
      expect(nextOwnerPending).toBe(false);
    });

    it('rejects a callback captured before switching accounts', async () => {
      await render(); const { uploadAvatar, clearAvatar } = hook;
      const previous = () => kind === 'upload' ? uploadAvatar(file()) : clearAvatar();
      await switchOwner('B');
      await act(async () => { await expect(previous()).rejects.toThrow('账号已变化'); });
      expect(avatarRequests()).toHaveLength(0); expect(avatarEvents).not.toHaveBeenCalled();
    });

    it('keeps an unknown signature unloaded and refetches the full profile after confirmation', async () => {
      const initial = deferred<ReturnType<typeof response>>(); const refresh = deferred<ReturnType<typeof response>>();
      let reads = 0; let initialSignal: AbortSignal | undefined;
      mocks.fetch.mockImplementation((path, init) => {
        if (path === avatarPath) return Promise.resolve(response({ success: true, avatarDataUrl: UPLOADED }));
        reads += 1;
        if (reads === 1) { initialSignal = init.signal; return initial.promise; }
        return refresh.promise;
      });
      await render(); expect(hook.loaded).toBe(false);
      await act(async () => { await run(kind); await tick(); });
      expect(initialSignal?.aborted).toBe(true);
      expect(hook.loaded).toBe(false); expect(client.getQueryData(['me-profile', 1])).toBeUndefined();
      expect(reads).toBe(2); expect(avatarEvents).toHaveBeenCalledTimes(1);
      const avatarDataUrl = kind === 'upload' ? UPLOADED : null;
      await act(async () => {
        initial.resolve(profileResponse());
        refresh.resolve(response({ success: true, profile: { signature: '非空服务器签名', avatarDataUrl } }));
        await tick();
      });
      expect(hook.loaded).toBe(true); expect(hook.profile).toEqual({ signature: '非空服务器签名', avatarDataUrl });
    });

    it.each(['B', 'ABA'] as const)('fences a late recovery profile read after %s', async (next) => {
      const initial = deferred<ReturnType<typeof response>>(); const refresh = deferred<ReturnType<typeof response>>();
      let reads = 0;
      mocks.fetch.mockImplementation((path) => {
        if (path === avatarPath) return Promise.resolve(response({ success: true, avatarDataUrl: UPLOADED }));
        reads += 1;
        return reads === 1 ? initial.promise : reads === 2 ? refresh.promise : Promise.resolve(profileResponse());
      });
      await render(); await act(async () => { await run(kind); await tick(); });
      await switchOwner(next);
      await act(async () => {
        initial.resolve(profileResponse());
        refresh.resolve(response({ success: true, profile: { signature: '迟到旧资料', avatarDataUrl: UPLOADED } }));
        await tick();
      });
      expect(client.getQueryData(['me-profile', 1])).not.toMatchObject({ profile: { signature: '迟到旧资料' } });
      expect(client.getQueryData(['me-profile', 2])).toMatchObject({ profile: { signature: '保留签名' } });
      expect(avatarEvents).toHaveBeenCalledTimes(1);
    });

    it.each(['network', 'unconfirmed'] as const)('keeps the initial profile read alive after a %s write failure', async (failure) => {
      const initial = deferred<ReturnType<typeof response>>(); let initialSignal: AbortSignal | undefined;
      mocks.fetch.mockImplementation((path, init) => {
        if (path === avatarPath) return failure === 'network' ? Promise.reject(new Error('network')) : Promise.resolve(response({ success: false }));
        initialSignal = init.signal; return initial.promise;
      });
      await render();
      await act(async () => { await expect(run(kind)).rejects.toThrow(failure === 'network' ? 'network' : '未确认'); await tick(); });
      expect(initialSignal?.aborted).toBe(false);
      await act(async () => { initial.resolve(profileResponse()); await tick(); });
      expect(hook.loaded).toBe(true); expect(hook.profile.signature).toBe('保留签名');
      expect(avatarEvents).not.toHaveBeenCalled();
    });

    it('does not let an old callback invalidate a new owner write', async () => {
      await render(); const { uploadAvatar, clearAvatar } = hook;
      const old = () => kind === 'upload' ? uploadAvatar(file()) : clearAvatar();
      await switchOwner('B');
      const request = deferred<ReturnType<typeof response>>(); mocks.fetch.mockReturnValueOnce(request.promise);
      let pending!: Promise<unknown>;
      await act(async () => { pending = run(kind); await tick(); });
      await act(async () => { await expect(old()).rejects.toThrow('账号已变化'); });
      await act(async () => { request.resolve(response({ success: true, avatarDataUrl: UPLOADED })); await pending; await tick(); });
      expect(avatarRequests()).toHaveLength(1);
      expect(client.getQueryData(['me-profile', 2])).toMatchObject({ profile: { avatarDataUrl: kind === 'upload' ? UPLOADED : null } });
      expect(avatarEvents).toHaveBeenCalledTimes(1); expect(hook.error).toBeNull();
    });

    it.each(['unmount', 'auth-before-render'] as const)('ignores the result after %s', async (change) => {
      await render(); const request = deferred<ReturnType<typeof response>>(); mocks.fetch.mockReturnValueOnce(request.promise);
      let pending!: Promise<unknown>;
      await act(async () => { pending = run(kind).catch((error: unknown) => error); await tick(); });
      if (change === 'unmount') await act(async () => root.render(null));
      else mocks.user = { id: 2, username: 'B' };
      await act(async () => { request.resolve(response({ success: true, avatarDataUrl: UPLOADED })); await pending; await tick(); });
      expect(await pending).toBeInstanceOf(Error);
      expect(client.getQueryData(['me-profile', 1])).toMatchObject({ profile: { avatarDataUrl: ORIGINAL } });
      expect(avatarEvents).not.toHaveBeenCalled();
    });

    it.each([false, undefined])('rejects an unconfirmed HTTP200 response with success=%s', async (success) => {
      await render(); mocks.fetch.mockResolvedValueOnce(response({ success, avatarDataUrl: UPLOADED }));
      await act(async () => { await expect(run(kind)).rejects.toThrow('未确认'); await tick(); });
      expect(client.getQueryData(['me-profile', 1])).toMatchObject({ profile: { avatarDataUrl: ORIGINAL } });
      expect(avatarRequests()).toHaveLength(1); expect(avatarEvents).not.toHaveBeenCalled();
      expect(hook.error).toContain('未确认');
    });

    it('does not inherit automatic write retries, and keeps the current error visible', async () => {
      await render(); mocks.fetch.mockImplementation(async (path) => { if (path === avatarPath) throw new Error('network'); return profileResponse(); });
      await act(async () => { await expect(run(kind)).rejects.toThrow('network'); await tick(); });
      expect(avatarRequests()).toHaveLength(1); expect(avatarEvents).not.toHaveBeenCalled(); expect(hook.error).toBe('network');
    });

    it.each(['before', 'during'] as const)('cancels stale profile GETs started %s the write', async (timing) => {
      await render(); const write = deferred<ReturnType<typeof response>>(); const read = deferred<ReturnType<typeof response>>();
      let readSignal: AbortSignal | undefined;
      mocks.fetch.mockImplementation((path, init) => {
        if (path === avatarPath) return write.promise;
        readSignal = init.signal; return read.promise;
      });
      let pending!: Promise<unknown>; let refetch!: ReturnType<typeof hook.refetch>;
      if (timing === 'before') await act(async () => { refetch = hook.refetch(); await tick(); });
      await act(async () => { pending = run(kind); await tick(); });
      if (timing === 'during') await act(async () => { refetch = hook.refetch(); await tick(); });
      await act(async () => { write.resolve(response({ success: true, avatarDataUrl: UPLOADED })); await pending; await tick(); });
      expect(readSignal?.aborted).toBe(true);
      await act(async () => { read.resolve(profileResponse()); await refetch; await tick(); });
      expect(client.getQueryData(['me-profile', 1])).toMatchObject({ profile: { avatarDataUrl: kind === 'upload' ? UPLOADED : null } });
    });
  });

  it('does not send a compressed upload superseded by a newer clear intent', async () => {
    await render(); pauseRead = true;
    let pending!: Promise<unknown>;
    await act(async () => { pending = run('upload').catch((error: unknown) => error); await tick(); });
    await act(async () => { await run('clear'); releaseRead!(); await pending; await tick(); });
    expect(await pending).toBeInstanceOf(Error);
    expect(avatarRequests().map(([, init]) => init.method)).toEqual(['DELETE']);
    expect(client.getQueryData(['me-profile', 1])).toMatchObject({ profile: { avatarDataUrl: null } });
    expect(avatarEvents).toHaveBeenCalledTimes(1); expect(hook.error).toBeNull();
  });

  it.each(['upload', 'clear'] as const)('does not publish a late %s over a newer avatar intent', async (kind) => {
    await render(); const request = deferred<ReturnType<typeof response>>();
    mocks.fetch.mockReturnValueOnce(request.promise);
    let pending!: Promise<unknown>;
    await act(async () => { pending = run(kind).catch((error: unknown) => error); await tick(); });
    const newer = kind === 'upload' ? 'clear' : 'upload';
    await act(async () => { await run(newer); await tick(); });
    await act(async () => { request.resolve(response({ success: true, avatarDataUrl: UPLOADED })); await pending; await tick(); });
    expect(await pending).toBeInstanceOf(Error);
    expect(client.getQueryData(['me-profile', 1])).toMatchObject({ profile: { avatarDataUrl: newer === 'upload' ? UPLOADED : null } });
    expect(avatarEvents).toHaveBeenCalledTimes(1); expect(hook.error).toBeNull();
  });

  it.each([null, 42, undefined, '', 'https://example.com/avatar.webp', 'data:image/webp;base64,'])('rejects malformed uploaded avatar %s', async (avatarDataUrl) => {
    await render(); mocks.fetch.mockResolvedValueOnce(response({ success: true, avatarDataUrl }));
    await act(async () => { await expect(run('upload')).rejects.toThrow('未确认'); });
    expect(avatarEvents).not.toHaveBeenCalled();
    expect(client.getQueryData(['me-profile', 1])).toMatchObject({ profile: { avatarDataUrl: ORIGINAL } });
  });

  it('does not send an upload that finishes compression after unmount', async () => {
    await render(); pauseRead = true;
    let pending!: Promise<unknown>;
    await act(async () => { pending = run('upload').catch((error: unknown) => error); await tick(); });
    await act(async () => root.render(null));
    await act(async () => { releaseRead!(); await pending; });
    expect(await pending).toBeInstanceOf(Error); expect(avatarRequests()).toHaveLength(0); expect(avatarEvents).not.toHaveBeenCalled();
  });

  it('preserves file validation errors without sending an upload', async () => {
    await render();
    await act(async () => { await expect(hook.uploadAvatar(new File(['text'], 'a.txt', { type: 'text/plain' }))).rejects.toThrow('请选择图片文件'); await tick(); });
    expect(avatarRequests()).toHaveLength(0); expect(hook.error).toBe('请选择图片文件');
  });
});
