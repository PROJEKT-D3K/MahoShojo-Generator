// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MePageFrame, MeProfileHeaderView, MeRetentionNotice } from '../src/me/index';
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
it('distinguishes unknown from confirmed empty signature and preserves long text', () => {
  const name = '很长的名字'.repeat(80); const signature = '无空格长签名'.repeat(80) + '\n第二行';
  act(() => root.render(<MeProfileHeaderView userId={7} displayName={name} signature={undefined} />));
  expect(container.textContent).not.toContain('还没有个性签名');
  expect(container.textContent).toContain(name);
  expect(container.querySelector('.min-w-0')).not.toBeNull();
  act(() => root.render(<MeProfileHeaderView userId={7} displayName={name} signature="" />));
  expect(container.textContent).toContain('还没有个性签名');
  act(() => root.render(<MeProfileHeaderView userId={7} displayName={name} signature={signature} />));
  expect(container.querySelector('.whitespace-pre-wrap')?.textContent).toBe(signature);
  expect(container.querySelector('.h-16.w-16.rounded-2xl')).not.toBeNull();
  expect(container.querySelector('section')?.classList.contains('bg-white')).toBe(true);
  expect(container.querySelector('section')?.classList.contains('text-gray-900')).toBe(true);
});
it('keeps slots and optional avatar actions owned by the host', () => {
  const upload = vi.fn();
  act(() => root.render(<MePageFrame navigation={<a href="/settings">设置</a>} sessionStatus="验证中" notice={<MeRetentionNotice>宿主留档说明</MeRetentionNotice>} footer={<footer>页脚</footer>}
    profile={<MeProfileHeaderView userId={7} displayName="名字" identityAdornment={<strong>称号名字徽章</strong>} signature="签名" avatarAction={{ onClick: upload, title: '上传头像' }} actions={<button>编辑资料</button>} feedback={<p role="alert">读取失败</p>} />}><h2>战报</h2></MePageFrame>));
  expect(container.querySelector('h1')?.textContent).toBe('个人页');
  expect(container.querySelector('nav a')?.getAttribute('href')).toBe('/settings');
  expect(container.querySelector('footer')?.closest('.card')).toBeNull();
  expect(container.textContent).toContain('不保证长期保存');
  expect(container.textContent).toContain('宿主留档说明');
  expect(container.querySelector('.border-yellow-200')?.parentElement?.nextElementSibling?.textContent).toBe('战报');
  expect(container.textContent).toContain('验证中'); expect(container.textContent).toContain('称号名字徽章');
  act(() => container.querySelector<HTMLButtonElement>('[title="上传头像"]')!.click()); expect(upload).toHaveBeenCalledOnce();
});
