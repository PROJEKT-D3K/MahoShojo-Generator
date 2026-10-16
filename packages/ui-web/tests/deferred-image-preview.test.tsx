// @vitest-environment jsdom
import { act, StrictMode, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BaseModal } from '../src/modal/BaseModal';
import { ImagePreviewModal } from '../src/modal/ImagePreviewModal';
import { useEscapeLayer } from '../src/modal/escape-stack';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = (node: ReactNode) => act(async () => root.render(node));
const dialog = (title: string) => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
  .find(node => document.getElementById(node.getAttribute('aria-labelledby') ?? '')?.textContent === title);
const press = (key: string, shiftKey = false) => {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  act(() => { (document.activeElement ?? document).dispatchEvent(event); });
  return event;
};

it.each(['image-first', 'modal-first', 'same-commit-image-first', 'same-commit-modal-first'] as const)(
  'defers the image without stealing focus or consuming Escape: %s', async (order) => {
    const imageClose = vi.fn(); const operationClose = vi.fn();
    const mount = (imageOpen: boolean, operationOpen: boolean) => {
      const image = <ImagePreviewModal key="image" isOpen={imageOpen} imageUrl="blob:retained" onClose={imageClose} deferToOtherModals />;
      const operation = <BaseModal key="operation" isOpen={operationOpen} title="云端操作" onClose={operationClose}><button>继续编辑</button></BaseModal>;
      return <><button data-opener>图片入口</button>{order.endsWith('modal-first') ? [operation, image] : [image, operation]}</>;
    };
    await render(mount(false, false));
    const opener = host.querySelector<HTMLButtonElement>('[data-opener]')!; opener.focus();
    if (order === 'image-first') await render(mount(true, false));
    if (order === 'modal-first') await render(mount(false, true));
    await render(mount(true, true));
    const operation = dialog('云端操作')!;
    expect(dialog('图片预览'), '预览让位期间不保留遮罩或 Tab 约束').toBeUndefined();
    expect(operation.contains(document.activeElement)).toBe(true);
    const last = operation.querySelector<HTMLButtonElement>('button:last-child')!;
    last.focus(); press('Tab');
    expect(operation.contains(document.activeElement)).toBe(true);
    press('Escape');
    expect(operationClose).toHaveBeenCalledOnce();
    expect(imageClose).not.toHaveBeenCalled();
    expect(document.documentElement.style.overflow).toBe('hidden');
    await render(mount(true, false));
    const preview = dialog('图片预览')!;
    expect(preview.querySelector('img')?.getAttribute('src')).toBe('blob:retained');
    expect(preview.contains(document.activeElement)).toBe(true);
    press('Escape'); expect(imageClose).toHaveBeenCalledOnce();
    await render(mount(false, false));
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
  },
);

it('does not briefly focus the preview when one modal replaces another in the same commit', async () => {
  const imageClose = vi.fn();
  const mount = (step: number) => <StrictMode>
    <button data-opener>入口</button>
    <ImagePreviewModal isOpen imageUrl="blob:retained" onClose={imageClose} deferToOtherModals />
    <BaseModal isOpen={step === 1} title="选择卡片" onClose={() => {}}>选择</BaseModal>
    <BaseModal isOpen={step === 2} title="确认替换" onClose={() => {}}>确认</BaseModal>
  </StrictMode>;
  await render(mount(1));
  const focused: HTMLElement[] = [];
  const original = HTMLElement.prototype.focus;
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  focus.mockImplementation(function (this: HTMLElement, options) { focused.push(this); original.call(this, options); });
  await render(mount(2));
  expect(dialog('图片预览')).toBeUndefined();
  expect(dialog('确认替换')?.contains(document.activeElement)).toBe(true);
  expect(focused.some(node => node.closest('[role="dialog"]')?.querySelector('img'))).toBe(false);
  press('Escape'); expect(imageClose).not.toHaveBeenCalled();
  await render(null);
  expect(document.body.style.overflow).toBe('');
});

it('keeps an ordinary layer focused if a suspended preview and its opener unmount', async () => {
  const mount = (image: boolean, ordinary: boolean) => <>
    {image && <><button data-opener>图片入口</button><ImagePreviewModal isOpen imageUrl="blob:retained" onClose={() => {}} deferToOtherModals /></>}
    <BaseModal isOpen={ordinary} title="另一个操作" onClose={() => {}}>正文</BaseModal>
  </>;
  await render(mount(true, false));
  await render(mount(true, true));
  const ordinaryFocus = document.activeElement;
  await render(mount(false, true));
  expect(document.activeElement).toBe(ordinaryFocus);
  expect(dialog('另一个操作')?.contains(document.activeElement)).toBe(true);
  expect(document.body.style.overflow).toBe('hidden');
  await render(null);
  expect(document.body.style.overflow).toBe('');
  expect(document.activeElement?.isConnected).toBe(true);
});

it('does not make deferred previews suspend each other or change ordinary modal defaults', async () => {
  function View() {
    const [ordinary, setOrdinary] = useState(false);
    return <>
      <ImagePreviewModal isOpen imageUrl="blob:first" title="预览一" onClose={() => {}} deferToOtherModals />
      <ImagePreviewModal isOpen imageUrl="blob:second" title="预览二" onClose={() => {}} deferToOtherModals />
      <BaseModal isOpen={ordinary} title="普通弹窗" onClose={() => setOrdinary(false)}>正文</BaseModal>
      <button onClick={() => setOrdinary(true)}>打开普通弹窗</button>
    </>;
  }
  await render(<StrictMode><View /></StrictMode>);
  expect(dialog('预览一')).toBeDefined(); expect(dialog('预览二')).toBeDefined();
  act(() => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(dialog('预览一')).toBeUndefined(); expect(dialog('预览二')).toBeUndefined();
  press('Escape');
  expect(dialog('普通弹窗')).toBeUndefined();
  expect(dialog('预览一')).toBeDefined(); expect(dialog('预览二')).toBeDefined();
});


it.each(['image-first', 'modal-first'] as const)('never focuses an image during an initial same-commit modal open: %s', async order => {
  const imageFocusEvents: EventTarget[] = [];
  const observe = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement && event.target.closest('[role="dialog"]')?.querySelector('img')) imageFocusEvents.push(event.target);
  };
  document.addEventListener('focusin', observe);
  try {
    const preview = <ImagePreviewModal key="image" isOpen imageUrl="blob:pending" onClose={() => {}} deferToOtherModals />;
    const operation = <BaseModal key="operation" isOpen title="普通操作" onClose={() => {}}>正文</BaseModal>;
    await render(<>{order === 'image-first' ? [preview, operation] : [operation, preview]}</>);
    expect(dialog('普通操作')?.contains(document.activeElement)).toBe(true);
    expect(dialog('图片预览')).toBeUndefined();
    expect(imageFocusEvents).toHaveLength(0);
  } finally { document.removeEventListener('focusin', observe); }
});


it('restores the lower deferred preview, then the page opener, when both first open together', async () => {
  const mount = (first: boolean, second: boolean) => <>
    <button data-opener>入口</button>
    <ImagePreviewModal isOpen={first} title="预览一" imageUrl="blob:first" onClose={() => {}} deferToOtherModals />
    <ImagePreviewModal isOpen={second} title="预览二" imageUrl="blob:second" onClose={() => {}} deferToOtherModals />
  </>;
  await render(mount(false, false));
  const opener = host.querySelector<HTMLButtonElement>('[data-opener]')!; opener.focus();
  await render(mount(true, true));
  expect(dialog('预览二')?.contains(document.activeElement)).toBe(true);
  await render(mount(true, false));
  expect(dialog('预览一')?.contains(document.activeElement)).toBe(true);
  expect(document.body.style.overflow).toBe('hidden');
  await render(mount(false, false));
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe('');
});

it('does not steal initial focus from a later non-trapping Escape layer', async () => {
  const closePopup = vi.fn(); const closeImage = vi.fn();
  function Popup({ open }: { open: boolean }) {
    const ref = useRef<HTMLButtonElement>(null);
    useEscapeLayer({ active: open, onEscape: () => { closePopup(); return true; } });
    useEffect(() => { if (open) ref.current?.focus(); }, [open]);
    return open ? <button ref={ref} data-popup>下拉选项</button> : null;
  }
  const mount = (open: boolean) => <>
    <ImagePreviewModal isOpen={open} imageUrl="blob:preview" onClose={closeImage} deferToOtherModals />
    <Popup open={open} />
  </>;
  await render(mount(false));
  await render(mount(true));
  expect(document.activeElement).toBe(host.querySelector('[data-popup]'));
  expect(dialog('图片预览')).toBeDefined();
  press('Escape'); expect(closePopup).toHaveBeenCalledOnce(); expect(closeImage).not.toHaveBeenCalled();
});


it('preserves the lower return chain when a middle deferred preview unmounts first', async () => {
  const mount = (first: boolean, middle: boolean, last: boolean, includeMiddle = true) => <>
    <button data-opener>入口</button>
    <ImagePreviewModal isOpen={first} title="预览一" imageUrl="blob:first" onClose={() => {}} deferToOtherModals />
    {includeMiddle && <ImagePreviewModal isOpen={middle} title="中间预览" imageUrl="blob:middle" onClose={() => {}} deferToOtherModals />}
    <ImagePreviewModal isOpen={last} title="最后预览" imageUrl="blob:last" onClose={() => {}} deferToOtherModals />
  </>;
  await render(mount(false, false, false));
  const opener = host.querySelector<HTMLButtonElement>('[data-opener]')!; opener.focus();
  await render(mount(true, true, true));
  expect(dialog('最后预览')?.contains(document.activeElement)).toBe(true);
  await render(mount(true, false, true, false));
  expect(dialog('最后预览')?.contains(document.activeElement)).toBe(true);
  await render(mount(true, false, false, false));
  expect(dialog('预览一')?.contains(document.activeElement)).toBe(true);
  await render(mount(false, false, false));
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe('');
});
