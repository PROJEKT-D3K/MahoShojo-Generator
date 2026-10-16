// @vitest-environment jsdom
/**
 * `ImagePreviewModal` 可访问性闭环（G3-r1）：对话框语义、初始焦点、
 * Escape 关闭与焦点恢复全部由 `BaseModal`/escape-stack 提供，
 * 替换此前 Web/Desktop 各自手写的全屏遮罩实现。
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImagePreviewModal } from '../src/modal/ImagePreviewModal';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelectorAll('[role="dialog"]').forEach((element) => element.remove());
});

const render = async (node: ReactNode): Promise<void> => {
  await act(async () => {
    root.render(node);
  });
};

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

describe('ImagePreviewModal a11y (G3-r1)', () => {
  it('portal 渲染对话框语义：role/aria-modal/aria-labelledby + 标题与内容', async () => {
    const onClose = vi.fn();
    await render(
      <ImagePreviewModal isOpen imageUrl="blob:preview" onClose={onClose} />,
    );
    const el = dialog();
    expect(el).not.toBeNull();
    expect(el!.getAttribute('aria-modal')).toBe('true');
    const titleId = el!.getAttribute('aria-labelledby');
    expect(document.getElementById(titleId!)?.textContent).toBe('图片预览');
    expect(document.body.textContent).toContain('长按图片保存到相册');
    expect(document.body.querySelector('img')?.getAttribute('alt')).toBe('生成结果长图');
  });

  it('关闭时不渲染对话框', async () => {
    await render(<ImagePreviewModal isOpen={false} imageUrl="blob:preview" onClose={() => {}} />);
    expect(dialog()).toBeNull();
  });

  it('保留全宽图片、既有层级和关闭标签的入口选项', async () => {
    await render(<ImagePreviewModal
      isOpen imageUrl="blob:full-width" imageWidth="full" imageAlt="角色卡片"
      zIndexClassName="z-[1000]" closeButtonAriaLabel="关闭" onClose={() => {}}
    />);
    const preview = dialog()!;
    expect(preview.querySelector('img')?.classList.contains('w-full')).toBe(true);
    expect(preview.querySelector('img')?.classList.contains('w-1/2')).toBe(false);
    expect(preview.parentElement?.classList.contains('z-[1000]')).toBe(true);
    expect(preview.querySelector('button[aria-label="关闭"]')).toBe(document.activeElement);
    expect(preview.querySelector('img')?.getAttribute('alt')).toBe('角色卡片');
  });

  it('不可点击遮罩的入口仍允许关闭按钮与 Escape，Tab 留在模态框内', async () => {
    const onClose = vi.fn();
    await render(<ImagePreviewModal isOpen imageUrl="blob:preview" closeOnBackdrop={false} onClose={onClose} />);
    const preview = dialog()!;
    const backdrop = preview.previousElementSibling as HTMLButtonElement;
    expect(backdrop.getAttribute('aria-hidden')).toBe('true');
    expect(backdrop.tabIndex).toBe(-1);
    await act(async () => backdrop.click());
    expect(onClose).not.toHaveBeenCalled();
    const closeButton = preview.querySelector<HTMLButtonElement>('button')!;
    const content = preview.querySelector<HTMLElement>('[role="region"]')!;
    content.focus();
    await act(async () => { content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(closeButton);
    await act(async () => { closeButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(content);
    await act(async () => { content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => closeButton.click());
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('既有调用默认保留半宽图片和遮罩关闭', async () => {
    const onClose = vi.fn();
    await render(<ImagePreviewModal isOpen imageUrl="blob:preview" onClose={onClose} />);
    const preview = dialog()!;
    expect(preview.querySelector('img')?.classList.contains('w-1/2')).toBe(true);
    const backdrop = preview.previousElementSibling as HTMLButtonElement;
    await act(async () => backdrop.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('初始焦点落在关闭按钮；Escape 触发 onClose', async () => {
    const onClose = vi.fn();
    await render(<ImagePreviewModal isOpen imageUrl="blob:preview" onClose={onClose} />);
    const closeButton = document.body.querySelector<HTMLElement>('[role="dialog"] button[aria-label="关闭对话框"]');
    expect(document.activeElement).toBe(closeButton);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('关闭后焦点恢复到打开前的元素', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = '打开预览';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const Harness = ({ open }: { open: boolean }) => (
      <ImagePreviewModal isOpen={open} imageUrl="blob:preview" onClose={() => {}} />
    );
    await render(<Harness open />);
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    await render(<Harness open={false} />);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('Tab 焦点约束在对话框内循环', async () => {
    await render(<ImagePreviewModal isOpen imageUrl="blob:preview" onClose={() => {}} />);
    const el = dialog()!;
    const focusables = [...el.querySelectorAll<HTMLElement>('button:not([disabled])')];
    expect(focusables.length).toBeGreaterThan(0);
    // 焦点移到末尾后按 Tab → 回到首个可聚焦元素。
    focusables.at(-1)!.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(focusables[0]);
  });
});
