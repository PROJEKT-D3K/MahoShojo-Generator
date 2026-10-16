// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SaveJsonButton } from '../src/details-controls/SaveJsonButton';

const card = { templateId: '通用情景', title: '雨后', content: '# 雨后\n\n原始正文', metadata: { signature: 'keep-signature' } };
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let container: HTMLDivElement;
let root: Root;
let originalExecCommand: PropertyDescriptor | undefined;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove();
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand);
  else Reflect.deleteProperty(document, 'execCommand');
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it('downloads once through the injected host with the complete JSON and resolved filename', () => {
  const downloadJson = vi.fn();
  const createObjectURL = vi.fn();
  vi.stubGlobal('URL', { createObjectURL });
  act(() => root.render(<SaveJsonButton data={card} mode="download" recommendedMode="download" resolveFileName={(data) => `通用情景_${data.title}.json`} downloadJson={downloadJson} />));
  expect(container.querySelectorAll('button')).toHaveLength(1);
  expect(downloadJson).not.toHaveBeenCalled();
  act(() => container.querySelector('button')!.click());
  expect(downloadJson).toHaveBeenCalledExactlyOnceWith('通用情景_雨后.json', JSON.stringify(card, null, 2));
  expect(createObjectURL).not.toHaveBeenCalled();
});

it('retains the default Web Blob download and its 10-second URL lifetime', () => {
  vi.useFakeTimers();
  const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:https://example.com/json');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('情景_雨后.json');
    expect(this.isConnected).toBe(true);
  });
  act(() => root.render(<SaveJsonButton data={card} mode="download" recommendedMode="download" resolveFileName={() => '情景_雨后.json'} />));
  act(() => container.querySelector('button')!.click());
  expect(click).toHaveBeenCalledOnce();
  expect(createObjectURL).toHaveBeenCalledOnce();
  const blob = createObjectURL.mock.calls[0][0] as Blob;
  expect(blob.type).toBe('application/json');
  expect(blob.size).toBe(new TextEncoder().encode(JSON.stringify(card, null, 2)).byteLength);
  expect(document.querySelector('a[download]')).toBeNull();
  vi.advanceTimersByTime(9_999);
  expect(revokeObjectURL).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:https://example.com/json');
});

it('keeps text-mode selection and copy with unchanged data without invoking a download host', async () => {
  const downloadJson = vi.fn();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  act(() => root.render(<SaveJsonButton data={card} mode="text" recommendedMode="text" resolveFileName={() => '雨后.json'} downloadJson={downloadJson} />));
  const text = container.querySelector('textarea')!;
  expect(text.value).toBe(JSON.stringify(card, null, 2));
  expect(text.readOnly).toBe(true);
  act(() => text.click());
  expect(text.selectionStart).toBe(0);
  expect(text.selectionEnd).toBe(text.value.length);
  await act(async () => container.querySelector('button')!.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith(JSON.stringify(card, null, 2));
  expect(container.textContent).toContain('JSON 已复制到剪贴板');
  expect(downloadJson).not.toHaveBeenCalled();
});

it('allows the experimental download mode when copy is recommended, with one host invocation', () => {
  const downloadJson = vi.fn();
  act(() => root.render(<SaveJsonButton data={card} mode="download" recommendedMode="text" resolveFileName={() => '雨后.json'} downloadJson={downloadJson} />));
  expect(container.querySelector('button')?.textContent).toBe('🧪 尝试直接下载 JSON');
  act(() => container.querySelector('button')!.click());
  expect(downloadJson).toHaveBeenCalledExactlyOnceWith('雨后.json', JSON.stringify(card, null, 2));
});

it('copies the already displayed JSON without repeating serialization', async () => {
  const toJSON = vi.fn().mockReturnValueOnce(card).mockReturnValue({ title: '不应重新序列化' });
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  act(() => root.render(<SaveJsonButton data={{ toJSON }} mode="text" recommendedMode="text" resolveFileName={() => '结果.json'} />));
  const displayed = container.querySelector('textarea')!.value;
  await act(async () => container.querySelector('button')!.click());
  expect(toJSON).toHaveBeenCalledTimes(1);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(displayed);
});

const renderCopy = (data = card, mode: 'text' | 'download' = 'text') => act(() => {
  root.render(<SaveJsonButton data={data} mode={mode} recommendedMode="text" resolveFileName={() => '结果.json'} />);
});
const clickCopy = () => act(async () => { container.querySelector('button')!.click(); });
const fallbackCopy = () => {
  const fallback = vi.fn(() => true);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: fallback });
  return fallback;
};

it.each(['missing', 'rejected'] as const)('copies exact JSON through the existing fallback when the Clipboard API is %s', async (kind) => {
  const writeText = vi.fn().mockRejectedValue(new Error('unavailable'));
  vi.stubGlobal('navigator', kind === 'missing' ? {} : { clipboard: { writeText } });
  let copied = '';
  const fallback = fallbackCopy().mockImplementation(() => {
    copied = [...document.querySelectorAll('textarea')].find((item) => item.style.position === 'fixed')?.value ?? '';
    return true;
  });
  renderCopy(); await clickCopy();
  expect(fallback).toHaveBeenCalledExactlyOnceWith('copy');
  expect(copied).toBe(JSON.stringify(card, null, 2));
  expect(container.textContent).toContain('JSON 已复制到剪贴板');
  expect(document.querySelector('textarea[style]')).toBeNull();
});

it('reports a failed fallback and permits a later explicit retry', async () => {
  vi.stubGlobal('navigator', {});
  const fallback = fallbackCopy().mockReturnValueOnce(false);
  renderCopy(); await clickCopy();
  expect(container.textContent).toContain('复制失败');
  await clickCopy();
  expect(fallback).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain('JSON 已复制到剪贴板');
});

it.each(['success', 'failure'] as const)('ignores late %s after a different result and never starts an obsolete fallback', async (outcome) => {
  const pending = deferred();
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => pending.promise) } });
  const fallback = fallbackCopy();
  renderCopy(); await clickCopy();
  renderCopy({ ...card, title: '新结果' });
  await act(async () => { if (outcome === 'success') pending.resolve(); else pending.reject(new Error('late')); });
  expect(fallback).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('JSON 已复制到剪贴板');
  expect(container.textContent).not.toContain('复制失败');
});

it('retires a pending copy when its result unmounts', async () => {
  vi.useFakeTimers();
  const pending = deferred();
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => pending.promise) } });
  const fallback = fallbackCopy();
  renderCopy(); await clickCopy();
  act(() => root.render(null));
  await act(async () => pending.reject(new Error('late')));
  expect(fallback).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('newer copies own feedback and older failures cannot overwrite the clipboard by fallback', async () => {
  const old = deferred();
  const writeText = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const fallback = fallbackCopy();
  renderCopy(); await clickCopy(); await clickCopy();
  expect(container.textContent).toContain('JSON 已复制到剪贴板');
  await act(async () => old.reject(new Error('older write failed')));
  expect(fallback).not.toHaveBeenCalled();
  expect(container.textContent).toContain('JSON 已复制到剪贴板');
  expect(container.textContent).not.toContain('复制失败');
});

it('clears old reset timers and retires feedback when copy mode changes', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  renderCopy(); await clickCopy();
  act(() => vi.advanceTimersByTime(1_000));
  await clickCopy();
  act(() => vi.advanceTimersByTime(1_000));
  expect(container.textContent).toContain('JSON 已复制到剪贴板');
  renderCopy(card, 'download'); renderCopy(card);
  expect(container.textContent).not.toContain('JSON 已复制到剪贴板');
  expect(vi.getTimerCount()).toBe(0);
});
