// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArenaWebDisplayModeSelectorView, ArenaWebViewer, useArenaWebImmersive, type ArenaWebDisplayMode } from '../src/arena-report/views';
import { popEscapeLayer, pushEscapeLayer, setEscapeFallback } from '../src/modal/escape-stack';

let root: Root;
let container: HTMLDivElement;
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label)!;
const click = async (label: string) => act(async () => button(label).click());
const escape = () => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
};
function Sample({ active = true, identity = 'one' }: { active?: boolean; identity?: string }) {
  const { immersive, enterImmersive, exitImmersive } = useArenaWebImmersive({ active });
  return <ArenaWebViewer contentIdentity={identity} immersive={immersive} onToggleImmersive={immersive ? exitImmersive : enterImmersive}
    aiModel="共享模型" aiUsage={{ promptTokens: 10, reasoningTokens: 5, completionTokens: 13 }}>
    <input aria-label="运行内容" defaultValue="原内容" />
  </ArenaWebViewer>;
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.useRealTimers(); vi.restoreAllMocks();
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
  delete (document as unknown as Record<string, unknown>).exitFullscreen;
  delete (HTMLDivElement.prototype as unknown as Record<string, unknown>).requestFullscreen;
});

describe('shared Web report viewer', () => {
  it('disables only unavailable Web display while keeping ordinary reading selectable', async () => {
    const changed = vi.fn();
    function Mode() {
      const [mode, setMode] = useState<ArenaWebDisplayMode>('web');
      return <ArenaWebDisplayModeSelectorView value={mode} webUnavailableReason="隔离窗口暂不可用" onChange={value => { changed(value); setMode(value); }} />;
    }
    await act(async () => root.render(<Mode />));
    expect(button('Web 显示').disabled).toBe(true);
    expect(button('普通显示').disabled).toBe(false);
    await click('普通显示');
    expect(changed).toHaveBeenCalledExactlyOnceWith('ordinary');
    expect(button('普通显示').getAttribute('aria-pressed')).toBe('true');
  });

  it('preserves content DOM and input state through CSS immersion; Escape consumes only this layer', async () => {
    const parentClose = vi.fn(() => true);
    const id = Symbol('parent'); pushEscapeLayer({ id, onEscape: parentClose });
    try {
      await act(async () => root.render(<Sample />));
      const input = container.querySelector('input')!; input.value = '保留交互';
      await click('沉浸体验');
      expect(container.querySelector('input')).toBe(input);
      expect(document.body.style.overflow).toBe('hidden');
      await act(async () => { expect(escape().defaultPrevented).toBe(true); });
      expect(container.querySelector('[data-testid="arena-web-immersive"]')).toBeNull();
      expect(input.value).toBe('保留交互'); expect(parentClose).not.toHaveBeenCalled();
      expect(document.body.style.overflow).toBe('');
      await act(async () => { escape(); });
      expect(parentClose).toHaveBeenCalledOnce();
    } finally { popEscapeLayer(id); }
  });

  it('lets the browser exit native fullscreen without also closing outer layers or the fallback', async () => {
    let full: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => full });
    const request = vi.fn(function(this: HTMLDivElement) { full = this; return Promise.resolve(); });
    HTMLDivElement.prototype.requestFullscreen = request;
    const parent = vi.fn(() => true), fallback = vi.fn(() => true);
    const id = Symbol('parent'); pushEscapeLayer({ id, onEscape: parent });
    const removeFallback = setEscapeFallback(fallback);
    try {
      await act(async () => root.render(<Sample />));
      await click('沉浸体验');
      await act(async () => { expect(escape().defaultPrevented).toBe(false); });
      expect(parent).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
      await act(async () => { full = null; document.dispatchEvent(new Event('fullscreenchange')); });
      expect(container.querySelector('[data-testid="arena-web-immersive"]')).toBeNull();
    } finally { popEscapeLayer(id); removeFallback(); }
  });

  it('cleans up late fullscreen requests after result availability changes', async () => {
    let full: Element | null = null, complete!: () => void;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => full });
    HTMLDivElement.prototype.requestFullscreen = function() { return new Promise<void>(resolve => { complete = () => { full = this; resolve(); }; }); };
    document.exitFullscreen = vi.fn(async () => { full = null; });
    await act(async () => root.render(<Sample />));
    await click('沉浸体验');
    await act(async () => root.render(<Sample active={false} />));
    await act(async () => complete());
    expect(document.exitFullscreen).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="arena-web-immersive"]')).toBeNull();
  });

  it('auto-hides the toolbar, restores keyboard focus and retains children on identity changes', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<Sample />));
    const input = container.querySelector('input')!;
    const header = container.querySelector('[data-testid="arena-web-header"]')!;
    await act(async () => vi.advanceTimersByTime(3000));
    expect(header.hasAttribute('inert')).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="展开 Web 战报工具栏"]')!.click());
    expect(document.activeElement).toBe(button('沉浸体验'));
    await act(async () => vi.advanceTimersByTime(5000));
    expect(header.hasAttribute('inert')).toBe(false);
    await act(async () => input.focus());
    await act(async () => vi.advanceTimersByTime(3000));
    expect(header.hasAttribute('inert')).toBe(true);
    await act(async () => root.render(<Sample identity="two" />));
    expect(header.hasAttribute('inert')).toBe(false);
    expect(container.querySelector('input')).toBe(input);
    expect(container.textContent).toContain('输出 8');
  });
});
