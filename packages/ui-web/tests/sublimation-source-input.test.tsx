// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SublimationSourceInput, type SublimationSourceInputProps } from '../src/sublimation/SublimationSourceInput';

let root: Root;
let container: HTMLDivElement;
const baseProps = (): SublimationSourceInputProps => ({
  accept: '.json', onFileChange: vi.fn(), pasteOpen: true, onPasteOpenChange: vi.fn(),
  pasteValue: '', onPasteValueChange: vi.fn(), onPasteLoad: vi.fn(), loadDisabled: false,
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('forwards file selection unchanged without reading or resetting the host input', () => {
  const props = baseProps();
  act(() => root.render(<SublimationSourceInput {...props} loadedSource={<span>宿主确认的素材</span>} />));
  const input = container.querySelector<HTMLInputElement>('#character-upload')!;
  const read = vi.fn();
  const file = new File(['{}'], 'source.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: read });
  Object.defineProperty(input, 'files', { value: [file] });
  Object.defineProperty(input, 'value', { configurable: true, writable: true, value: 'selected-by-host' });
  act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  expect(props.onFileChange).toHaveBeenCalledTimes(1);
  expect(vi.mocked(props.onFileChange).mock.calls[0]![0].target).toBe(input);
  expect(input.value).toBe('selected-by-host');
  expect(read).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLLabelElement>('label[for="character-upload"]')?.control).toBe(input);
  expect(container.textContent).toContain('宿主确认的素材');
  expect(props.onPasteLoad).not.toHaveBeenCalled();
});

it('keeps controlled text when the accessible paste panel is collapsed and reopened', () => {
  const load = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState('');
    return <SublimationSourceInput {...baseProps()} pasteOpen={open} onPasteOpenChange={setOpen} pasteValue={value} onPasteValueChange={setValue} onPasteLoad={load} />;
  }
  act(() => root.render(<Harness />));
  const toggle = container.querySelector<HTMLButtonElement>('[aria-controls="sublimation-source-paste"]')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('#source-json')).toBeNull();
  act(() => toggle.click());
  const input = container.querySelector<HTMLTextAreaElement>('#source-json')!;
  expect(container.querySelector<HTMLLabelElement>('label[for="source-json"]')?.control).toBe(input);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '{"source":"保留原文"}');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => toggle.click());
  expect(container.querySelector('#source-json')).toBeNull();
  act(() => toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector<HTMLTextAreaElement>('#source-json')!.value).toBe('{"source":"保留原文"}');
  expect(load).not.toHaveBeenCalled();
  act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === '从文本加载设定')!.click());
  expect(load).toHaveBeenCalledTimes(1);
});

it('leaves empty-text handling and busy policy with the host', () => {
  const props = baseProps();
  act(() => root.render(<SublimationSourceInput {...props} />));
  const load = [...container.querySelectorAll('button')].find((button) => button.textContent === '从文本加载设定')!;
  act(() => load.click());
  expect(props.onPasteLoad).toHaveBeenCalledTimes(1);
  act(() => root.render(<SublimationSourceInput {...props} loadDisabled />));
  expect(load.disabled).toBe(true);
  expect(container.querySelector<HTMLInputElement>('#character-upload')!.disabled).toBe(false);
  expect(container.querySelector<HTMLTextAreaElement>('#source-json')!.disabled).toBe(false);
  expect(container.querySelector<HTMLButtonElement>('[aria-controls]')!.disabled).toBe(false);
  act(() => load.click());
  expect(props.onPasteLoad).toHaveBeenCalledTimes(1);
  act(() => root.render(<fieldset disabled><SublimationSourceInput {...props} /></fieldset>));
  expect([...container.querySelectorAll('input, textarea, button')].every((input) => input.matches(':disabled'))).toBe(true);
});
