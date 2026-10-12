// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), refresh: vi.fn(), state: {} as any, epoch: 0, ready: true, busy: (() => false) as () => boolean, confirmLeave: (() => false) as () => boolean }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../src/features/account/use-desktop-cloud-session', () => {
  const store = { getSnapshot: () => mocks.state, getCredentialEpoch: () => mocks.epoch, refresh: mocks.refresh };
  return { useDesktopCloudSession: () => ({ state: mocks.state, store }) };
});
vi.mock('../src/app/useLeaveGuard', () => ({ useLeaveGuard: (busy: () => boolean, _message: string, _failure: string, confirmLeave: () => boolean) => {
  mocks.busy = busy; mocks.confirmLeave = confirmLeave; return { ready: mocks.ready, message: null };
} }));
import { ProfileSignaturePanel } from '../src/features/account/ProfileSignaturePanel';
import { getCachedMyProfile, getTopbarAvatar, invalidateTopbarAvatar, resetTopbarAvatarForTests, useTopbarAvatar } from '../src/features/account/use-topbar-avatar';
const oldAvatar = 'data:image/webp;base64,QUJD'; const newAvatar = 'data:image/webp;base64,bmV3';
let root: Root; let container: HTMLDivElement; let mounted: boolean;
let deferRead = false; let reads: (() => void)[] = [];
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const TopbarProbe = () => { const avatar = useTopbarAvatar(mocks.state.account, { credentialEpoch: mocks.epoch, onSessionRejected: mocks.refresh }); return avatar ? <img data-testid="topbar-avatar" src={avatar} /> : <span data-testid="topbar-fallback">A</span>; };
const render = () => act(async () => { root.render(<><ProfileSignaturePanel /><TopbarProbe /></>); await flush(); });
const select = (file = new File(['image'], 'avatar.png', { type: 'image/png' })) => act(async () => {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  Object.defineProperty(input, 'value', { configurable: true, writable: true, value: 'selected' });
  input.dispatchEvent(new Event('change', { bubbles: true })); await flush();
});
const button = (text: string) => [...container.querySelectorAll('button')].find((node) => node.textContent === text)!;
const click = (text: string) => act(async () => { button(text).click(); await flush(); });
const edit = (value: string) => act(() => { const textarea = container.querySelector('textarea')!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
const writes = () => mocks.invoke.mock.calls.filter(([command]) => command === 'cloud_save_me_profile_avatar' || command === 'cloud_clear_me_profile_avatar');
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  resetTopbarAvatarForTests(); mocks.epoch = 0; mocks.ready = true; mocks.refresh.mockReset();
  mocks.state = { account: { userId: 1, username: 'A' }, verification: 'verified', authFlow: { kind: 'idle' } };
  deferRead = false; reads = [];
  vi.stubGlobal('FileReader', class { result = 'data:image/png;base64,aW1n'; onload: (() => void) | null = null; readAsDataURL() { const done = () => this.onload?.(); if (deferRead) reads.push(done); else queueMicrotask(done); } });
  vi.stubGlobal('Image', class { naturalWidth = 256; naturalHeight = 128; onload: (() => void) | null = null; set src(_value: string) { queueMicrotask(() => this.onload?.()); } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(newAvatar);
  mocks.invoke.mockReset(); mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'cloud_me_profile') return { userId: mocks.state.account.userId, signature: '线上签名', avatarDataUrl: oldAvatar };
    if (command === 'cloud_save_me_profile_signature') return { userId: args.request.expectedUserId, signature: args.request.signature };
    return { userId: args.request.expectedUserId, avatarDataUrl: command === 'cloud_save_me_profile_avatar' ? newAvatar : null };
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); mounted = true;
});
afterEach(() => { if (mounted) act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Desktop shared avatar field host', () => {
  it('uploads and clears through narrow commands, updating profile and topbar only after confirmation', async () => {
    await render(); const pending = deferred<unknown>(); mocks.invoke.mockReturnValueOnce(pending.promise);
    await select(); expect(getTopbarAvatar(1)).toBe(oldAvatar); expect(mocks.busy()).toBe(true); expect(mocks.confirmLeave()).toBe(false);
    expect(writes()).toEqual([['cloud_save_me_profile_avatar', { request: { expectedUserId: 1, avatarWebpBase64: 'bmV3' } }]]);
    await act(async () => pending.resolve({ userId: 1, avatarDataUrl: newAvatar }));
    expect(container.querySelector('[data-testid="topbar-avatar"]')?.getAttribute('src')).toBe(newAvatar);
    expect(getCachedMyProfile(1)?.signature).toBe('线上签名'); expect(container.textContent).toContain('头像已更新'); expect(mocks.busy()).toBe(false);
    await click('清除头像'); expect(writes()[1]).toEqual(['cloud_clear_me_profile_avatar', { request: { expectedUserId: 1 } }]);
    expect(getTopbarAvatar(1)).toBeNull(); expect(container.querySelector('[data-testid="topbar-fallback"]')).not.toBeNull(); expect(container.textContent).toContain('头像已清除');
  });
  it.each(['unreachable', 'checking', 'idle'])('refuses writes for %s identity, including synthetic events', async (verification) => {
    mocks.state.verification = verification; await render(); expect(container.querySelector('fieldset')?.disabled).toBe(true);
    await select(); await click('清除头像'); expect(writes()).toHaveLength(0); expect(reads).toHaveLength(0);
  });
  it('refuses writes before close protection is ready or during authorization', async () => {
    mocks.ready = false; await render(); await select(); expect(writes()).toHaveLength(0);
    mocks.ready = true; mocks.state.authFlow = { kind: 'authenticating' }; await render(); await select(); expect(writes()).toHaveLength(0);
  });
  it('upload and clear are mutually exclusive even before compression settles, and rechecks verification', async () => {
    await render(); deferRead = true; await select(); await select(); await click('清除头像');
    expect(reads).toHaveLength(1); expect(writes()).toHaveLength(0); expect(mocks.confirmLeave()).toBe(false);
    mocks.state.verification = 'unreachable'; await render(); await act(async () => { reads[0](); await flush(); });
    expect(writes()).toHaveLength(0); expect(container.textContent).toContain('请验证后重新选择'); expect(mocks.busy()).toBe(false);
    mocks.state.verification = 'verified'; deferRead = false; await render(); expect(writes()).toHaveLength(0);
    await select(); expect(writes()).toHaveLength(1);
  });
  it('cancelled selection does nothing; repeated selection of the same file is available after settling', async () => {
    await render(); const input = container.querySelector('input')!; Object.defineProperty(input, 'files', { configurable: true, value: [] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); expect(writes()).toHaveLength(0);
    const file = new File(['x'], 'same.png', { type: 'image/png' }); await select(file); expect(input.value).toBe(''); await select(file); expect(writes()).toHaveLength(2);
  });
  it('compression failure never invokes Native or claims uncertain success', async () => {
    await render(); await select(new File(['text'], 'text.txt', { type: 'text/plain' }));
    expect(writes()).toHaveLength(0); expect(container.textContent).toContain('请选择图片文件'); expect(container.textContent).not.toContain('读取线上头像'); expect(mocks.busy()).toBe(false);
  });
  it('uncertain writes retain the last avatar, do not replay, and allow explicit readback without losing a signature draft', async () => {
    await render(); edit('本地草稿'); mocks.invoke.mockRejectedValueOnce({ code: 'network-error', message: '连接中断' }); await select();
    expect(getTopbarAvatar(1)).toBe(oldAvatar); expect(container.textContent).not.toContain('头像已更新'); await render(); expect(writes()).toHaveLength(1);
    mocks.invoke.mockResolvedValueOnce({ userId: 1, signature: '远端签名', avatarDataUrl: newAvatar }); await click('读取线上头像');
    expect(writes()).toHaveLength(1); expect(getTopbarAvatar(1)).toBe(newAvatar); expect(container.querySelector('textarea')?.value).toBe('本地草稿');
    await select(); expect(writes()).toHaveLength(2);
  });
  it.each(['avatar-first', 'signature-first'])('both fields remain confirmed after concurrent %s completion', async (order) => {
    await render(); const avatar = deferred<unknown>(); const signature = deferred<unknown>();
    mocks.invoke.mockImplementation((command) => command === 'cloud_save_me_profile_avatar' ? avatar.promise : signature.promise);
    edit('新签名'); await click('保存'); await select(); expect(mocks.invoke).toHaveBeenCalledTimes(3);
    const settleAvatar = () => act(async () => avatar.resolve({ userId: 1, avatarDataUrl: newAvatar }));
    const settleSignature = () => act(async () => signature.resolve({ userId: 1, signature: '新签名' }));
    if (order === 'avatar-first') { await settleAvatar(); await settleSignature(); } else { await settleSignature(); await settleAvatar(); }
    expect(getCachedMyProfile(1)).toEqual({ userId: 1, signature: '新签名', avatarDataUrl: newAvatar }); expect(container.querySelector('textarea')?.value).toBe('新签名'); expect(mocks.busy()).toBe(false);
  });
  it('avatar success before initial GET keeps signature unknown and triggers one fresh read', async () => {
    const old = deferred<unknown>(); const fresh = deferred<unknown>(); let gets = 0;
    mocks.invoke.mockImplementation((command) => command === 'cloud_me_profile' ? (++gets === 1 ? old.promise : fresh.promise) : Promise.resolve({ userId: 1, avatarDataUrl: newAvatar }));
    await render(); await select(); expect(getCachedMyProfile(1)?.signature).toBeUndefined(); expect(container.querySelector('textarea')?.disabled).toBe(true); expect(gets).toBe(2);
    await act(async () => old.resolve({ userId: 1, signature: 'stale', avatarDataUrl: oldAvatar })); expect(container.querySelector('textarea')?.disabled).toBe(true);
    await act(async () => fresh.resolve({ userId: 1, signature: 'real', avatarDataUrl: newAvatar })); expect(container.querySelector('textarea')?.value).toBe('real'); expect(gets).toBe(2);
  });
  it.each(['success', 'error'])('isolates late upload %s after A→B→A', async (outcome) => {
    await render(); const pending = deferred<unknown>(); mocks.invoke.mockReturnValueOnce(pending.promise); await select();
    mocks.epoch += 1; act(() => invalidateTopbarAvatar(1)); mocks.state.account = { userId: 2, username: 'B' }; await render();
    mocks.epoch += 1; act(() => invalidateTopbarAvatar(1)); mocks.state.account = { userId: 1, username: 'A-new' }; await render();
    await act(async () => outcome === 'success' ? pending.resolve({ userId: 1, avatarDataUrl: newAvatar }) : pending.reject(new Error('old-error')));
    expect(getTopbarAvatar(1)).toBe(oldAvatar); expect(container.textContent).not.toContain('old-error'); expect(container.textContent).not.toContain('头像已更新'); expect(mocks.busy()).toBe(false);
  });
  it.each(['relogin', 'logout'])('does not dispatch old compression after %s', async (kind) => {
    await render(); deferRead = true; await select(); mocks.epoch += 1; act(() => invalidateTopbarAvatar(1));
    if (kind === 'logout') mocks.state.account = null;
    await render(); await act(async () => { reads[0](); await flush(); }); expect(writes()).toHaveLength(0);
  });
  it('unmount prevents a late upload from publishing success or stale cache', async () => {
    await render(); const pending = deferred<unknown>(); mocks.invoke.mockReturnValueOnce(pending.promise); await select();
    act(() => root.unmount()); mounted = false; await act(async () => pending.resolve({ userId: 1, avatarDataUrl: newAvatar })); expect(getTopbarAvatar(1)).toBe(oldAvatar);
  });
  it('old owner GET rejection never refreshes the new session', async () => {
    const old = deferred<unknown>(); mocks.invoke.mockReturnValueOnce(old.promise); await render();
    mocks.epoch += 1; mocks.state.account = { userId: 2, username: 'B' }; await render();
    await act(async () => old.reject({ code: 'not-authenticated', message: 'old' })); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('an explicit readback callback is inert after the owning panel unmounts', async () => {
    await render(); mocks.invoke.mockRejectedValueOnce({ code: 'network-error', message: 'unknown' }); await select();
    const read = deferred<unknown>(); mocks.invoke.mockReturnValueOnce(read.promise); await click('读取线上头像');
    act(() => root.unmount()); mounted = false;
    await act(async () => read.reject({ code: 'not-authenticated', message: 'late-readback' })); expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('a surviving topbar joins the fresh GET when the profile panel leaves after avatar confirmation', async () => {
    const old = deferred<unknown>(); const fresh = deferred<unknown>(); let gets = 0;
    mocks.invoke.mockImplementation((command) => command === 'cloud_me_profile' ? (++gets === 1 ? old.promise : fresh.promise) : Promise.resolve({ userId: 1, avatarDataUrl: newAvatar }));
    await render(); await select(); expect(gets).toBe(2);
    await act(async () => { root.render(<>{null}<TopbarProbe /></>); await flush(); });
    await act(async () => fresh.reject({ code: 'not-authenticated', message: 'current' }));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    await act(async () => old.reject({ code: 'not-authenticated', message: 'stale' })); expect(mocks.refresh).toHaveBeenCalledOnce();
  });

});
