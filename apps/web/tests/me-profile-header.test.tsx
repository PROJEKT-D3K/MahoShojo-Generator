// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/components/me/useMeProfile', () => ({ useMeProfile: () => mocked.value }));
vi.mock('@/components/UserTitle', () => ({ UserWithTitle: ({ username }: { username: string }) => <span>{username}徽章</span> }));
import { ProfileHeader } from '@/components/me/ProfileHeader';
let root: Root; let container: HTMLDivElement;
const settings = vi.fn(); const card = vi.fn();
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  mocked.value = { profile: { signature: '', avatarDataUrl: null }, loaded: false, error: null, refetch: vi.fn(), uploadAvatar: vi.fn(async () => {}), isUploadingAvatar: false };
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = () => act(async () => root.render(<ProfileHeader user={{ id: 7, username: '名字' }} badges={[]} onOpenSettings={settings} onOpenProfileCard={card} />));
it('does not claim an empty signature before load or on failure and permits a read retry', async () => {
  await render(); expect(container.textContent).not.toContain('还没有个性签名');
  mocked.value = { ...mocked.value, error: '读取失败' }; await render();
  expect(container.textContent).not.toContain('还没有个性签名');
  act(() => [...container.querySelectorAll('button')].find(b => b.textContent === '重新载入资料')!.click());
  expect(mocked.value.refetch).toHaveBeenCalledOnce();
  mocked.value = { ...mocked.value, error: null, loaded: true }; await render();
  expect(container.textContent).toContain('还没有个性签名');
});
it('keeps upload, failure, busy control and both profile actions in the Web adapter', async () => {
  const upload = vi.fn().mockRejectedValue(new Error('上传失败'));
  mocked.value = { ...mocked.value, loaded: true, uploadAvatar: upload, profile: { signature: '已读签名', avatarDataUrl: 'data:image/webp;base64,b2xk' } };
  await render(); const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
  const file = new File(['image'], 'avatar.png', { type: 'image/png' }); Object.defineProperty(input, 'files', { value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  expect(upload).toHaveBeenCalledExactlyOnceWith(file); expect(input.value).toBe('');
  mocked.value = { ...mocked.value, error: '上传失败', isUploadingAvatar: true }; await render();
  expect(container.querySelector<HTMLButtonElement>('[title^="点击上传头像"]')?.disabled).toBe(true);
  expect(container.querySelector('[role=alert]')?.textContent).toBe('上传失败');
  expect(container.textContent).toContain('已读签名'); expect(container.textContent).toContain('名字徽章');
  act(() => [...container.querySelectorAll('button')].find(b => b.textContent === '编辑资料')!.click());
  act(() => [...container.querySelectorAll('button')].find(b => b.textContent === '生成资料卡')!.click());
  expect(settings).toHaveBeenCalledOnce(); expect(card).toHaveBeenCalledOnce();
});
