// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollapsibleSection } from '../src/creator/CollapsibleSection';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it.each([false, true, 'after-open'] as const)('preserves the %s mount policy across uncontrolled open/close', mode => {
  const mounted = vi.fn(), unmounted = vi.fn();
  function Content() {
    useEffect(() => { mounted(); return () => { unmounted(); }; }, []);
    return <input aria-label="draft" defaultValue="original" />;
  }
  act(() => root.render(<CollapsibleSection title="Toggle" defaultOpen={false} keepMounted={mode}><Content /></CollapsibleSection>));
  expect(mounted).toHaveBeenCalledTimes(mode === true ? 1 : 0);
  expect(container.querySelector('input') === null).toBe(mode !== true);
  const toggle = () => act(() => container.querySelector('button')!.click());
  toggle();
  expect(mounted).toHaveBeenCalledTimes(1);
  const input = container.querySelector('input')!; input.value = 'unsaved draft';
  toggle();
  expect(unmounted).toHaveBeenCalledTimes(mode === false ? 1 : 0);
  expect(container.querySelector('input') === null).toBe(mode === false);
  toggle();
  expect(mounted).toHaveBeenCalledTimes(mode === false ? 2 : 1);
  expect(container.querySelector('input')!.value).toBe(mode === false ? 'original' : 'unsaved draft');
});

it('after-open follows controlled state without opening on an unaccepted toggle request', () => {
  const changed = vi.fn();
  const render = (open: boolean) => act(() => root.render(
    <CollapsibleSection title="Controlled" open={open} onOpenChange={changed} keepMounted="after-open"><input aria-label="controlled draft" defaultValue="retained" /></CollapsibleSection>,
  ));
  render(false); expect(container.querySelector('input')).toBeNull();
  act(() => container.querySelector('button')!.click());
  expect(changed).toHaveBeenCalledWith(true); expect(container.querySelector('input')).toBeNull();
  render(true); const input = container.querySelector('input')!;
  render(false); expect(container.querySelector('input')).toBe(input); expect(input.closest('[hidden]')).not.toBeNull();
  render(true); expect(container.querySelector('input')).toBe(input); expect(input.closest('[hidden]')).toBeNull();
});
