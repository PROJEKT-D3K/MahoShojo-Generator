// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameCardFace, CardForgeThemeEditor, ImageCropEditor } from '../src/card-forge';
import { DENY_SNAPDOM_MEDIA, type capturePngBlob } from '../src/client/snapdomCapture';
const face = { cardName: '蔷薇', cardType: 'character' as const, rarity: 'epic' as const, cost: 3, element: 'dark' as const, attack: 2, defense: 1, hp: 3, effects: [{ type: '被动', description: '效果' }], traits: [], flavorText: '', powerLevel: 'A', description: '', themeColor: '#ef4444' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('shared forge real controls and capture lifecycle', () => {
  it('keeps the named native custom picker focusable with a visible wrapper focus treatment', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const onChange = vi.fn();
    try {
      await act(async () => root.render(<CardForgeThemeEditor color="#123456" onChange={onChange} />));
      const custom = container.querySelector<HTMLInputElement>('input[aria-label="自定义主题色"]')!;
      const wrapper = custom.closest('label')!;
      expect(custom.type).toBe('color');
      expect(custom.tabIndex).toBe(0);
      expect(custom.disabled).toBe(false);
      expect(custom.classList.contains('opacity-0')).toBe(true);
      expect(wrapper.classList.contains('opacity-0')).toBe(false);
      expect(wrapper.classList).toContain('focus-within:outline-2');
      expect(wrapper.classList).toContain('focus-within:outline-offset-2');
      expect(wrapper.classList).toContain('focus-within:outline-(--app-accent-strong)');
      for (const value of ['#abcdef', '#123456']) {
        custom.focus(); expect(document.activeElement).toBe(custom);
        act(() => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(custom, value);
          custom.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(onChange).toHaveBeenLastCalledWith(value);
        await act(async () => root.render(<CardForgeThemeEditor color={value} onChange={onChange} />));
        expect(custom.value).toBe(value);
        custom.blur(); expect(document.activeElement).not.toBe(custom);
      }
      expect(onChange.mock.calls).toEqual([['#abcdef'], ['#123456']]);
    } finally { act(() => root.unmount()); container.remove(); }
  });
  it('names every native preset, exposes case-insensitive selection, and leaves custom colors unselected', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const onChange = vi.fn();
    const presets = ['#ff6b9d', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#06b6d4'];
    const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('button')];
    try {
      for (const selected of presets) {
        await act(async () => root.render(<CardForgeThemeEditor color={selected.toUpperCase()} onChange={onChange} />));
        expect(buttons()).toHaveLength(presets.length);
        buttons().forEach((button, index) => {
          expect(button.getAttribute('aria-label')).toBe(`主题色 ${presets[index]}`);
          expect(button.title).toBe(`主题色 ${presets[index]}`);
          expect(button.getAttribute('aria-pressed')).toBe(String(presets[index] === selected));
          expect(button.type).toBe('button');
          expect(button.tabIndex).toBe(0);
          button.focus(); expect(document.activeElement).toBe(button);
          expect(button.classList.contains('border-white')).toBe(presets[index] === selected);
          expect(button.classList.contains('border-transparent')).toBe(presets[index] !== selected);
          expect(button.style.boxShadow !== 'none').toBe(presets[index] === selected);
        });
        const button = buttons()[presets.indexOf(selected)];
        act(() => { button.click(); button.click(); });
        expect(onChange.mock.calls.slice(-2)).toEqual([[selected], [selected]]);
      }
      for (const color of ['#123456', 'not-a-color', '']) {
        await act(async () => root.render(<CardForgeThemeEditor color={color} onChange={onChange} />));
        expect(buttons().every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true);
        expect(buttons().every((button) => button.style.boxShadow === 'none')).toBe(true);
      }
      const custom = container.querySelector<HTMLInputElement>('input[aria-label="自定义主题色"]')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(custom, '#123456');
        custom.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(onChange).toHaveBeenLastCalledWith('#123456');
    } finally { act(() => root.unmount()); container.remove(); }
  });
  it('preserves card/crop DOM, selected preset and canonical control callbacks', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const color = vi.fn(); const ratio = vi.fn();
    try {
      await act(async () => root.render(<><CardForgeThemeEditor color="#ef4444" onChange={color} /><ImageCropEditor imageUrl="data:image/png;base64,aA==" imageAspectRatio="4:3" imageTransform={{ scale: 1, x: 0, y: 0 }} onAspectRatioChange={ratio} onTransformChange={() => {}} onReset={() => {}} /><GameCardFace faceData={face} showSaveButton={false} /></>));
      expect(container.querySelector('.gc-card')).toBeTruthy(); expect(container.querySelector('.gc-name-text')?.textContent).toBe('蔷薇');
      expect(container.querySelector('.card-forge-crop-viewport')).toBeTruthy();
      const colors = [...container.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.style.backgroundColor);
      expect(colors.filter((button) => button.style.boxShadow !== 'none')).toHaveLength(1);
      act(() => colors[0].click()); expect(color).toHaveBeenCalledWith('#ff6b9d');
      const select = container.querySelector('select')!;
      act(() => { select.value = '3:4'; select.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(ratio).toHaveBeenCalledWith('3:4');
    } finally { act(() => root.unmount()); container.remove(); }
  });
  it('single-flights capture, supplies media host, and suppresses late download and callbacks after unmount', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 1; });
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    let resolve!: (blob: Blob) => void;
    const capture = vi.fn<typeof capturePngBlob>(() => new Promise<Blob>((done) => { resolve = done; })); const download = vi.fn(); const busy = vi.fn();
    await act(async () => root.render(<GameCardFace faceData={face} mediaAdapter={DENY_SNAPDOM_MEDIA} captureImage={capture} downloadImage={download} imageSaveMode="download" onExportStateChange={busy} />));
    const button = container.querySelector('button')!;
    await act(async () => { button.click(); button.click(); });
    expect(capture).toHaveBeenCalledTimes(1); expect(capture.mock.calls[0]?.[1]).toMatchObject({ mediaAdapter: DENY_SNAPDOM_MEDIA, scale: 2, dprMax: 3 });
    expect(busy.mock.calls).toEqual([[true]]);
    act(() => root.unmount());
    await act(async () => resolve(new Blob(['png'], { type: 'image/png' })));
    expect(download).not.toHaveBeenCalled(); expect(busy.mock.calls).toEqual([[true]]); container.remove();
  });
  it('reports rejected capture and permits retry; host veto prevents cross-operation capture', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 1; });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div'); const root = createRoot(container);
    const capture = vi.fn().mockRejectedValueOnce(new Error('budget')).mockResolvedValue(new Blob(['png']));
    const error = vi.fn(); const download = vi.fn(); let allowed = false;
    try {
      await act(async () => root.render(<GameCardFace faceData={face} canStartExport={() => allowed} captureImage={capture} downloadImage={download} imageSaveMode="download" onExportError={error} />));
      await act(async () => container.querySelector('button')!.click()); expect(capture).not.toHaveBeenCalled();
      allowed = true; await act(async () => container.querySelector('button')!.click()); expect(error).toHaveBeenCalledTimes(1);
      await act(async () => container.querySelector('button')!.click()); expect(download).toHaveBeenCalledTimes(1);
    } finally { act(() => root.unmount()); }
  });
});
