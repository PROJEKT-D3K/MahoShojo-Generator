// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RoomGenerationCancelAction } from '../src/arena-room';
let container: HTMLDivElement, root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it('requires an explicit captured confirmation and restores focus on dismissal', async () => {
  const request = vi.fn(), confirm = vi.fn(), dismiss = vi.fn();
  const render = async (confirmation: boolean, disabled = false) => act(async () => root.render(<RoomGenerationCancelAction confirmation={confirmation} disabled={disabled} onRequest={request} onConfirm={confirm} onDismiss={dismiss} />));
  await render(false); expect(confirm).not.toHaveBeenCalled();
  await act(async () => container.querySelector('button')!.click()); expect(request).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled();
  await render(true); const dialog = container.querySelector('[role=alertdialog]')!;
  expect(dialog.getAttribute('aria-label')).toBe('确认停止当前生成'); expect(document.activeElement).toBe(dialog.querySelector('button'));
  await render(true, true); await act(async () => dialog.querySelector('button')!.click()); expect(confirm).not.toHaveBeenCalled();
  await render(true); await act(async () => dialog.querySelector('button')!.click()); expect(confirm).toHaveBeenCalledOnce();
  await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(dismiss).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(container.querySelector('button'));
});
