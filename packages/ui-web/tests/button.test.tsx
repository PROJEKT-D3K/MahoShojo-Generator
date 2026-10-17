// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Button, buttonClassName } from '../src/card-library/Button';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('provides visible default, hover, focus and disabled styles for both account action sizes', () => {
  for (const size of ['sm', 'md'] as const) {
    const classes = buttonClassName({ size }).split(' ');
    expect(classes).toEqual(expect.arrayContaining([
      'border-gray-300', 'bg-white', 'text-gray-800', 'hover:bg-gray-50',
      'dark:border-gray-600', 'dark:bg-gray-900', 'dark:text-gray-100', 'dark:hover:bg-gray-800',
      'focus-visible:ring-2', 'focus-visible:ring-fuchsia-500', 'focus-visible:ring-offset-2',
      'disabled:cursor-not-allowed', 'disabled:opacity-50', 'motion-reduce:transition-none',
      size === 'sm' ? 'min-h-8' : 'min-h-10',
    ]));
  }
});

it('retains button naming, focus, non-submit behavior and native disabled activation', () => {
  const click = vi.fn(); const submit = vi.fn();
  const render = (disabled: boolean) => act(() => root.render(
    <form onSubmit={submit}><Button disabled={disabled} onClick={click}>退出登录</Button></form>,
  ));
  render(false);
  const control = container.querySelector('button')!;
  expect(control.type).toBe('button');
  expect(control.textContent).toBe('退出登录');
  control.focus(); expect(document.activeElement).toBe(control);
  act(() => control.click()); expect(click).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
  render(true); act(() => control.click());
  expect(control.disabled).toBe(true); expect(click).toHaveBeenCalledOnce();
});
