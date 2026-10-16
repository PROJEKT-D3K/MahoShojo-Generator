// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResultJsonCopyButton } from '../src/details-controls/ResultJsonCopyButton';

const card = { name: '原件', content: '完整 JSON', extra: { retained: true } };
const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let root: Root, host: HTMLDivElement;
let originalClipboard: PropertyDescriptor | undefined, originalExec: PropertyDescriptor | undefined;
const feedback = vi.fn();
const render = (data: unknown = card, visible = true) => act(() => root.render(<StrictMode>{visible && <ResultJsonCopyButton data={data} onResult={feedback} className="host-style" />}</StrictMode>));
const click = () => act(async () => { host.querySelector('button')!.click(); });
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  originalExec = Object.getOwnPropertyDescriptor(document, 'execCommand');
  feedback.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.useRealTimers();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard); else Reflect.deleteProperty(navigator, 'clipboard');
  if (originalExec) Object.defineProperty(document, 'execCommand', originalExec); else Reflect.deleteProperty(document, 'execCommand');
});

it.each(['success', 'failure'] as const)('unmounting a hidden button retires late %s even when the same result is shown again', async (outcome) => {
  const old = deferred(), writeText = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const fallback = vi.fn(() => true); Object.defineProperty(document, 'execCommand', { configurable: true, value: fallback });
  render(); await click(); render(card, false); render(); await click();
  expect(feedback).toHaveBeenCalledExactlyOnceWith(true);
  await act(async () => { if (outcome === 'success') old.resolve(); else old.reject(new Error('late')); });
  expect(feedback).toHaveBeenCalledTimes(1); expect(fallback).not.toHaveBeenCalled();
  expect(writeText).toHaveBeenNthCalledWith(2, JSON.stringify(card, null, 2));
  expect(host.querySelector('button')?.className).toBe('host-style');
  expect(host.querySelector('button')?.type).toBe('button');
});

it('an identical serialized replacement still retires the original result identity', async () => {
  const old = deferred();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(() => old.promise) } });
  const fallback = vi.fn(() => true); Object.defineProperty(document, 'execCommand', { configurable: true, value: fallback });
  render(); await click(); render({ ...card });
  await act(async () => old.reject(new Error('old result')));
  expect(feedback).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
});

it('serialization failure is reported only on click without breaking rendering or writing clipboard', async () => {
  const circular: { self?: unknown } = {}; circular.self = circular;
  const writeText = vi.fn(), fallback = vi.fn();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: fallback });
  render(circular); expect(feedback).not.toHaveBeenCalled();
  await click(); expect(feedback).toHaveBeenCalledExactlyOnceWith(false);
  expect(writeText).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
  expect(host.textContent).toBe('复制到剪贴板');
});

it('StrictMode retains one successful explicit write and clears its timer on unmount', async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(); expect(writeText).not.toHaveBeenCalled(); await click();
  expect(feedback).toHaveBeenCalledExactlyOnceWith(true); expect(writeText).toHaveBeenCalledTimes(1);
  render(card, false); expect(vi.getTimerCount()).toBe(0);
});
