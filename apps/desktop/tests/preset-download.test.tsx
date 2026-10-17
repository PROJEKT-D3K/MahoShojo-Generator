// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESET_LIST } from '@mahoshojo/domain/presets';
import { useArenaPresetDownload } from '../src/features/arena/use-preset-download';
import { deferred } from './helpers/story-fixture';

const mocks = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('../src/platform/download-text-file', () => ({ downloadTextFile: mocks.download }));
let root: Root, container: HTMLDivElement, controls: ReturnType<typeof useArenaPresetDownload>;
function Harness() { controls = useArenaPresetDownload(); return <p>{controls.feedback?.message}</p>; }
beforeEach(async () => { (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true; mocks.download.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); await act(async () => root.render(<Harness />)); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const preset = PRESET_LIST[0]!;
const raw = '{ "signature": "synthetic-original", "name": "合成原件", "extra": { "keep": true } }\n';

describe('bundled character preset downloads', () => {
  it('keeps one read in flight, preserves exact text and reports only download initiation', async () => {
    const gate = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(() => gate.promise));
    let first!: Promise<void>;
    await act(async () => { first = controls.download(preset); void controls.download(preset); });
    expect(fetch).toHaveBeenCalledTimes(1); expect(controls.downloading).toBe(true);
    expect(fetch).toHaveBeenCalledWith(`/presets/${preset.filename}`, expect.objectContaining({ credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal) }));
    await act(async () => { gate.resolve(new Response(raw)); await first; });
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(preset.filename, raw, 'application/json');
    expect(controls.downloading).toBe(false); expect(controls.feedback?.kind).toBe('started');
    expect(container.textContent).toContain('已发起'); expect(container.textContent).not.toContain('已保存');
  });
  it('does not initiate a late download after its page has unmounted', async () => {
    const gate = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(() => gate.promise));
    let pending!: Promise<void>; await act(async () => { pending = controls.download(preset); });
    const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
    await act(async () => root.render(null)); expect(signal.aborted).toBe(true);
    await act(async () => { gate.resolve(new Response(raw)); await pending; });
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it('shows read or download-port failures without success, releases the flight and permits retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })).mockImplementation(async () => new Response(raw)));
    await act(async () => controls.download(preset)); expect(controls.feedback?.kind).toBe('error'); expect(mocks.download).not.toHaveBeenCalled();
    mocks.download.mockImplementationOnce(() => { throw new Error('合成下载失败'); });
    await act(async () => controls.download(preset)); expect(controls.feedback).toEqual({ kind: 'error', message: '合成下载失败' }); expect(controls.downloading).toBe(false);
    await act(async () => controls.download(preset)); expect(controls.feedback?.kind).toBe('started');
  });
  it('rejects a filename outside the existing preset catalog before reading or downloading', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await act(async () => controls.download({ ...preset, filename: '../private.json' }));
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled(); expect(controls.feedback?.kind).toBe('error');
  });
});
