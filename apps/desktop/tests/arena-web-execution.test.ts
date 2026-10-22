import { describe, expect, it, vi } from 'vitest';
import {
  createWebPackageInstance, createWebPackageOverlayFromBase, digestWebPackageBytes, verifyWebPackage,
} from '@mahoshojo/web-package';
import type { RawInvokeFn, StructuredInvokeFn } from '../src/platform/local-archive-bridge';
import { controlWebPackageWindow } from '../src/platform/webpkg-window-bridge';
import { createDesktopWebReportRuntimeCapability, DesktopWebReportExecution, type DesktopWebReportSource } from '../src/features/arena/web-execution';

const html = '<!doctype html><html><head><title>示例</title></head><body><script>window.works = true</script>正文</body></html>';
const source = (patch: Partial<DesktopWebReportSource> = {}): DesktopWebReportSource => ({ content: html, title: '示例', ready: true, ...patch });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness(options: { available?: boolean; open?: () => Promise<unknown>; control?: (request: Record<string, unknown>) => Promise<unknown> } = {}) {
  let nextId = 0;
  const invoke: StructuredInvokeFn = vi.fn(async (command, args) => {
    const request = args?.request as Record<string, unknown>;
    if (command === 'begin_web_package_instance') return { instanceId: `wpk-${++nextId}` };
    if (command === 'open_web_package_instance') return options.open?.() ?? { label: `webpkg-${request.instanceId}` };
    if (command === 'control_web_package_instance') return options.control?.(request) ?? (request.action === 'close'
      ? { status: 'closed', instanceId: request.instanceId }
      : { status: 'open', instanceId: request.instanceId, fullscreen: request.action === 'set-fullscreen' && request.fullscreen === true });
    throw new Error(`unexpected ${command}`);
  });
  const rawInvoke: RawInvokeFn = vi.fn(async (_command, body, options) => ({ receivedByteLength: Number(options.headers['x-webpkg-offset']) + body.byteLength }));
  const owner = new DesktopWebReportExecution({ invoke, rawInvoke, available: options.available ?? true });
  owner.setSource(source());
  return { owner, invoke: vi.mocked(invoke), rawInvoke: vi.mocked(rawInvoke) };
}
const start = async (owner: DesktopWebReportExecution) => { owner.requestRun(); await owner.confirmRun(); };
const requests = (invoke: ReturnType<typeof harness>['invoke'], action?: string) => invoke.mock.calls
  .filter(([command, args]) => command === 'control_web_package_instance' && (!action || (args?.request as { action: string }).action === action));

describe('Desktop Web runtime platform qualification', () => {
  it.each(['windows', 'macos', 'linux', 'unknown'])('uses Native %s and initializes once', async os => {
    const pending = deferred<unknown>();
    const invoke = vi.fn<StructuredInvokeFn>(() => pending.promise);
    const capability = createDesktopWebReportRuntimeCapability(invoke, true);
    expect(capability.available).toBe(false);
    const first = capability.initialize(); expect(capability.initialize()).toBe(first);
    expect(invoke.mock.calls).toEqual([['desktop_runtime_info']]);
    pending.resolve({ os, arch: 'x86_64', appVersion: '1.0.0', tauriVersion: '2.12.0', packaged: false });
    await first;
    expect(capability.available).toBe(os === 'windows');
    if (os !== 'windows') expect(capability.reason).toContain('当前平台尚未完成');
    await capability.initialize(); expect(invoke).toHaveBeenCalledOnce();
  });

  it.each(['rejected', 'malformed'])('keeps execution closed when runtime info is %s', async failure => {
    const invoke = vi.fn<StructuredInvokeFn>(async () => { if (failure === 'rejected') throw new Error('IPC unavailable'); return { os: 'windows' }; });
    const capability = createDesktopWebReportRuntimeCapability(invoke, true);
    await capability.initialize(); await capability.initialize();
    expect(capability.available).toBe(false); expect(capability.reason).toContain('无法确认本机运行平台');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('does not query runtime while the release is closed or an explicit test capability is supplied', async () => {
    const invoke = vi.fn<StructuredInvokeFn>();
    const capability = createDesktopWebReportRuntimeCapability(invoke, false);
    await capability.initialize(); expect(capability.available).toBe(false);
    for (const available of [true, false]) {
      const owner = new DesktopWebReportExecution({ invoke, rawInvoke: vi.fn(), available });
      owner.setSource(source()); owner.requestRun(); const before = owner.getSnapshot();
      const first = owner.initializeAvailability(); expect(owner.initializeAvailability()).toBe(first); await first;
      expect(owner.available).toBe(available); expect(owner.getSnapshot()).toBe(before);
    }
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('Desktop Web report execution ownership', () => {
  it('requires a release capability, final document and explicit confirmation before any IPC', async () => {
    const { owner, invoke, rawInvoke } = harness({ available: false });
    await start(owner); expect(invoke).not.toHaveBeenCalled(); expect(rawInvoke).not.toHaveBeenCalled();
    const allowed = harness();
    for (const value of [source({ ready: false }), source({ content: '<html>未完整' }), source({ instance: null })]) {
      allowed.owner.setSource(value); await start(allowed.owner);
    }
    expect(allowed.invoke).not.toHaveBeenCalled();
    allowed.owner.setSource(source()); allowed.owner.requestRun(); allowed.owner.cancelConfirmation(); await allowed.owner.confirmRun();
    expect(allowed.invoke).not.toHaveBeenCalled();
  });

  it('opens free HTML once, and focus/fullscreen/reload keep the same instance without uploading again', async () => {
    const { owner, invoke, rawInvoke } = harness();
    owner.requestRun(); await Promise.all([owner.confirmRun(), owner.confirmRun()]);
    expect(owner.getSnapshot()).toMatchObject({ phase: 'open', instanceId: 'wpk-1', busy: false });
    expect(invoke.mock.calls[0]).toMatchObject(['begin_web_package_instance', { request: { contentKind: 'free-html', entry: 'index.html' } }]);
    expect(new TextDecoder().decode(rawInvoke.mock.calls[0]?.[1])).toBe(html);
    await owner.control('focus'); await owner.control('set-fullscreen', true); expect(owner.getSnapshot().fullscreen).toBe(true);
    await owner.control('reload');
    expect(invoke.mock.calls.filter(([command]) => command === 'begin_web_package_instance')).toHaveLength(1);
    expect(rawInvoke).toHaveBeenCalledOnce();
    expect(requests(invoke).every(([, args]) => (args?.request as { instanceId: string }).instanceId === 'wpk-1')).toBe(true);
    await owner.showOrdinary(); expect(owner.getSnapshot()).toMatchObject({ phase: 'idle', instanceId: null });
    await owner.confirmRun(); expect(invoke.mock.calls.filter(([command]) => command === 'begin_web_package_instance')).toHaveLength(1);
    await start(owner); expect(invoke.mock.calls.filter(([command]) => command === 'begin_web_package_instance')).toHaveLength(2);
  });

  it('materializes the verified package overlay and keeps its stricter content identity', async () => {
    const bytes = new TextEncoder().encode(html);
    const base = await verifyWebPackage({ format: 'mahoshojo-web-package', formatVersion: 1, id: 'test.execution', version: '1.0.0', name: '执行包', entry: 'index.html', capabilities: [],
      generation: { target: 'story.txt', mode: 'replace', mediaType: 'text/plain' },
      files: [{ path: 'index.html', mediaType: 'text/html', size: bytes.byteLength, digest: await digestWebPackageBytes(bytes) }] }, [{ path: 'index.html', bytes }]);
    const instance = await createWebPackageInstance(base, await createWebPackageOverlayFromBase(base, '生成目标'));
    const { owner, invoke, rawInvoke } = harness(); owner.setSource(source({ content: '生成目标', instance })); await start(owner);
    expect(invoke.mock.calls[0]).toMatchObject(['begin_web_package_instance', { request: { contentKind: 'web-package', entry: 'index.html',
      files: [{ path: 'index.html' }, { path: 'story.txt', mediaType: 'text/plain' }] } }]);
    expect(new TextDecoder().decode(rawInvoke.mock.calls[1]?.[1])).toBe('生成目标');
  });

  it('does not clear a pending open fence through ordinary/web toggles', async () => {
    const gate = deferred<unknown>(), { owner, invoke } = harness({ open: () => gate.promise });
    owner.requestRun(); const pending = owner.confirmRun();
    await vi.waitFor(() => expect(invoke.mock.calls.some(([command]) => command === 'open_web_package_instance')).toBe(true));
    await owner.showOrdinary(); owner.requestRun(); await owner.confirmRun();
    expect(owner.getSnapshot()).toMatchObject({ phase: 'opening', busy: true });
    expect(invoke.mock.calls.filter(([command]) => command === 'begin_web_package_instance')).toHaveLength(1);
    gate.reject(new Error('IPC lost')); await pending;
    expect(owner.getSnapshot()).toMatchObject({ phase: 'uncertain', instanceId: 'wpk-1', busy: false });
    owner.requestRun(); await owner.confirmRun();
    expect(invoke.mock.calls.filter(([command]) => command === 'begin_web_package_instance')).toHaveLength(1);
    await owner.control('status'); expect(owner.getSnapshot().phase).toBe('open');
  });

  it('keeps ordinary switching disabled during another control, then closes only the known window', async () => {
    const gate = deferred<unknown>();
    const { owner, invoke } = harness({ control: async request => request.action === 'status' ? gate.promise : { status: 'closed', instanceId: request.instanceId } });
    await start(owner); const pending = owner.control('status'); await owner.showOrdinary();
    expect(requests(invoke, 'close')).toHaveLength(0);
    gate.resolve({ status: 'open', instanceId: 'wpk-1', fullscreen: false }); await pending;
    await owner.showOrdinary(); expect(requests(invoke, 'close')).toHaveLength(1); expect(owner.getSnapshot().phase).toBe('idle');
  });

  it.each(['resolve', 'reject'] as const)('best-effort closes an old open after source replacement when it later %s', async outcome => {
    const gate = deferred<unknown>(), { owner, invoke } = harness({ open: () => gate.promise });
    owner.requestRun(); const pending = owner.confirmRun();
    await vi.waitFor(() => expect(invoke.mock.calls.some(([command]) => command === 'open_web_package_instance')).toBe(true));
    owner.setSource(source({ content: html.replace('正文', '新内容') }));
    if (outcome === 'resolve') gate.resolve({ label: 'webpkg-wpk-1' }); else gate.reject(new Error('unknown'));
    await pending;
    expect(owner.getSnapshot()).toMatchObject({ phase: 'idle', instanceId: null, message: null });
    expect(requests(invoke, 'close')).toMatchObject([['control_web_package_instance', { request: { action: 'close', instanceId: 'wpk-1' } }]]);
  });

  it('checks the captured owner scope before dispatch and after preparation', async () => {
    let current = true;
    const { owner, invoke } = harness(); owner.setSource(source({ captureCurrent: () => () => current }));
    owner.requestRun(); current = false; await owner.confirmRun(); expect(invoke).not.toHaveBeenCalled();
  });

  it('preserves an unknown close and never starts a replacement window until an exact status confirms closed', async () => {
    let fail = true;
    const { owner, invoke } = harness({ control: async request => { if (fail) throw new Error('lost receipt'); return { status: 'closed', instanceId: request.instanceId }; } });
    await start(owner); await owner.showOrdinary(); expect(owner.getSnapshot().phase).toBe('uncertain');
    await start(owner); expect(invoke.mock.calls.filter(([command]) => command === 'begin_web_package_instance')).toHaveLength(1);
    fail = false; await owner.control('status'); expect(owner.getSnapshot().phase).toBe('idle');
  });

  it('rejects malformed or wrong-instance control receipts without accepting state from another window', async () => {
    const invoke = vi.fn(async () => ({ status: 'open', instanceId: 'wpk-2', fullscreen: true }));
    await expect(controlWebPackageWindow(invoke, { instanceId: 'wpk-1', action: 'status' })).rejects.toThrow('不匹配');
    await expect(controlWebPackageWindow(invoke, { instanceId: 'main-ui', action: 'status' })).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce();
  });
});
