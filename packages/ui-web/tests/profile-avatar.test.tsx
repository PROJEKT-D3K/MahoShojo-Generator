// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileAvatarField, type ProfileAvatarFieldProps } from '../src/settings';

const ORIGINAL = 'data:image/webp;base64,b2xk';
let root: Root;
let container: HTMLDivElement;
let props: ProfileAvatarFieldProps;
const render = () => act(async () => root.render(<ProfileAvatarField {...props} />));
const input = () => container.querySelector('input')!;
const clearButton = () => container.querySelector('button')!;
const select = async (file?: File) => {
  Object.defineProperty(input(), 'files', { configurable: true, value: file ? [file] : [] });
  Object.defineProperty(input(), 'value', { configurable: true, writable: true, value: file ? `C:\\fakepath\\${file.name}` : '' });
  await act(async () => input().dispatchEvent(new Event('change', { bubbles: true })));
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  props = { avatarDataUrl: ORIGINAL, uploadAvatar: vi.fn(async () => {}), clearAvatar: vi.fn(async () => {}),
    isUploadingAvatar: false, isClearingAvatar: false };
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('controlled profile avatar field', () => {
  it('keeps the Web preview, size hint and accessible file label', async () => {
    await render();
    expect(input().accept).toBe('image/*');
    expect(input().labels?.[0]?.textContent).toBe('头像');
    const hint = document.getElementById(input().getAttribute('aria-describedby')!);
    expect(hint?.textContent).toContain('浏览器会裁剪并压缩');
    expect(hint?.textContent).toContain(`当前约：${ORIGINAL.length} B`);
    expect(container.querySelector('img')?.alt).toBe('头像预览');
    expect(container.querySelector('img')?.src).toBe(ORIGINAL);
    expect(clearButton().textContent).toBe('清除头像');
    expect(clearButton().disabled).toBe(false);
  });

  it('ignores a canceled picker and resets the input for the same file selection', async () => {
    await render(); await select();
    expect(props.uploadAvatar).not.toHaveBeenCalled();
    const file = new File(['image'], 'avatar.png', { type: 'image/png' });
    await select(file); expect(input().value).toBe('');
    await select(file); expect(input().value).toBe('');
    expect(props.uploadAvatar).toHaveBeenCalledTimes(2);
    expect(props.uploadAvatar).toHaveBeenNthCalledWith(1, file);
    expect(props.uploadAvatar).toHaveBeenNthCalledWith(2, file);
    expect(props.clearAvatar).not.toHaveBeenCalled();
  });

  it.each(['isUploadingAvatar', 'isClearingAvatar'] as const)('disables both actions while %s', async (busyProp) => {
    props[busyProp] = true; await render();
    expect(input().disabled).toBe(true); expect(clearButton().disabled).toBe(true);
    expect(container.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('true');
    await select(new File(['image'], 'avatar.png', { type: 'image/png' }));
    act(() => clearButton().click());
    expect(props.uploadAvatar).not.toHaveBeenCalled(); expect(props.clearAvatar).not.toHaveBeenCalled();
    props[busyProp] = false; await render();
    expect(input().disabled).toBe(false); expect(clearButton().disabled).toBe(false);
  });

  it('waits for host-confirmed preview changes and disables clear for an empty avatar', async () => {
    await render(); await act(async () => clearButton().click());
    expect(props.clearAvatar).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.src).toBe(ORIGINAL);
    props.avatarDataUrl = null; await render();
    expect(container.querySelector('img')).toBeNull(); expect(clearButton().disabled).toBe(true);
    expect(container.textContent).not.toContain('当前约：'); expect(input().disabled).toBe(false);
  });

  it('leaves failed action feedback and retries to the host', async () => {
    props.uploadAvatar = vi.fn().mockRejectedValue(new Error('上传失败'));
    props.clearAvatar = vi.fn().mockRejectedValue(new Error('清除失败'));
    await render(); await select(new File(['image'], 'avatar.png', { type: 'image/png' }));
    await act(async () => clearButton().click()); await render();
    expect(props.uploadAvatar).toHaveBeenCalledTimes(1); expect(props.clearAvatar).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.src).toBe(ORIGINAL); expect(input().value).toBe('');
  });
});
