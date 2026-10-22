import {
  DesktopBeginWebPackageInstanceResponseSchema,
  type DesktopControlWebPackageInstanceRequest,
  type DesktopWebPackageInstanceId,
} from '@mahoshojo/contracts/desktop-ipc';
import { normalizeArenaWebOutput } from '@mahoshojo/ai-core/arena-generation';
import { createWebPackageResourceSnapshot, type WebPackageInstance } from '@mahoshojo/web-package';
import type { RawInvokeFn, StructuredInvokeFn } from '../../platform/local-archive-bridge';
import { readDesktopRuntimeInfo } from '../../platform/desktop-bridge';
import { controlWebPackageWindow } from '../../platform/webpkg-window-bridge';
import {
  BEGIN_WEB_PACKAGE_INSTANCE_COMMAND, OPEN_WEB_PACKAGE_INSTANCE_COMMAND,
  openFreeHtmlInIsolatedWebview, openWebPackageInstanceInIsolatedWebview,
} from '../../platform/webpkg-instance-bridge';

/** Release capability, not an environment switch. Enable only after the corresponding D4 evidence is accepted. */
export const DESKTOP_WEB_REPORT_WINDOWS_READY: boolean = true;
export const DESKTOP_WEB_REPORT_UNAVAILABLE = '当前环境未开放 Web 隔离运行。普通显示、保存与导出可正常使用。';

/** Platform evidence comes only from the Native runtime. The second argument is an explicit test port. */
export function createDesktopWebReportRuntimeCapability(invoke: StructuredInvokeFn, windowsReady = DESKTOP_WEB_REPORT_WINDOWS_READY) {
  let available = false;
  let reason = windowsReady ? '正在确认本机平台的 Web 运行资格…' : DESKTOP_WEB_REPORT_UNAVAILABLE;
  let initialization: Promise<void> | null = null;
  return {
    get available() { return available; },
    get reason() { return reason; },
    initialize(): Promise<void> {
      return initialization ??= (async () => {
        if (!windowsReady) return;
        try {
          const runtime = await readDesktopRuntimeInfo(invoke);
          available = runtime.os === 'windows';
          reason = available ? '' : '当前平台尚未完成 Web 隔离运行验收；普通显示、保存与导出可正常使用。';
        } catch {
          reason = '无法确认本机运行平台，暂不能运行 Web 战报；普通显示、保存与导出可正常使用。';
        }
      })();
    },
  };
}

export type DesktopWebReportSource = Readonly<{
  content: string;
  title: string;
  ready: boolean;
  /** Absent for free HTML. null means a package result has not passed replay validation. */
  instance?: WebPackageInstance | null;
  /** Capture the source owner's lifetime when this source is installed; later scopes cannot adopt it. */
  captureCurrent?(): () => boolean;
}>;
export type DesktopWebExecutionState = Readonly<{
  phase: 'idle' | 'confirming' | 'opening' | 'open' | 'uncertain' | 'error';
  busy: boolean;
  instanceId: DesktopWebPackageInstanceId | null;
  fullscreen: boolean;
  message: string | null;
}>;
const idle = (): DesktopWebExecutionState => ({ phase: 'idle', busy: false, instanceId: null, fullscreen: false, message: null });

/** Window ownership and the confirmation/open/control lifetime; contains no React or storage. */
export class DesktopWebReportExecution {
  private state = idle();
  private source: DesktopWebReportSource | null = null;
  private sourceCurrent: () => boolean = () => true;
  private epoch = 0;
  private flight: symbol | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly runtimeCapability: ReturnType<typeof createDesktopWebReportRuntimeCapability>;
  private availabilityInitialization: Promise<void> | null = null;
  constructor(private readonly dependencies: {
    invoke: StructuredInvokeFn;
    rawInvoke: RawInvokeFn;
    available?: boolean;
  }) { this.runtimeCapability = createDesktopWebReportRuntimeCapability(dependencies.invoke); }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get available() { return this.dependencies.available ?? this.runtimeCapability.available; }
  get unavailableReason() { return this.dependencies.available === false ? DESKTOP_WEB_REPORT_UNAVAILABLE : this.runtimeCapability.reason; }
  initializeAvailability(): Promise<void> {
    return this.availabilityInitialization ??= (async () => {
      if (this.dependencies.available !== undefined) return;
      await this.runtimeCapability.initialize();
      this.publish({});
    })();
  }
  private publish(patch: Partial<DesktopWebExecutionState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  setSource(source: DesktopWebReportSource | null) {
    if (this.source === source) return;
    const previous = this.state.instanceId;
    this.source = source;
    this.sourceCurrent = source?.captureCurrent?.() ?? (() => true);
    this.epoch += 1;
    this.flight = null;
    this.state = idle();
    this.listeners.forEach(listener => listener());
    if (previous) void this.closeDetached(previous);
  }
  clearSource(source: DesktopWebReportSource) { if (this.source === source) this.setSource(null); }
  private async closeDetached(instanceId: DesktopWebPackageInstanceId) {
    try { await controlWebPackageWindow(this.dependencies.invoke, { instanceId, action: 'close' }); }
    catch { /* An already dispatched open cannot be revoked; Native/OS window cleanup remains available. */ }
  }
  canRun() {
    const source = this.source;
    return this.available && !!source?.ready && this.sourceCurrent() && !this.flight && this.state.phase !== 'uncertain'
      && this.state.phase !== 'open' && (source.instance === undefined ? !!normalizeArenaWebOutput(source.content).document : !!source.instance);
  }
  requestRun() {
    if (!this.canRun()) return;
    this.publish({ phase: 'confirming', message: null });
  }
  cancelConfirmation() { if (this.state.phase === 'confirming') this.publish({ phase: 'idle' }); }
  async showOrdinary(): Promise<void> {
    // Keep a dispatched open and in-flight control fenced until it settles. The selector is disabled too.
    if (this.flight) return;
    if (this.state.instanceId) await this.control('close');
    else this.cancelConfirmation();
  }
  async confirmRun(): Promise<void> {
    if (this.state.phase !== 'confirming' || !this.canRun() || !this.source) return;
    const source = this.source, epoch = this.epoch, flight = Symbol('open-web-report');
    const sourceCurrent = this.sourceCurrent;
    const isCurrent = () => epoch === this.epoch && this.source === source && sourceCurrent();
    if (!isCurrent()) { this.cancelConfirmation(); return; }
    this.flight = flight;
    this.publish({ phase: 'opening', busy: true, message: '正在准备独立作品窗口…' });
    let nativeId: DesktopWebPackageInstanceId | null = null;
    let openDispatched = false;
    const invoke: StructuredInvokeFn = async (command, args) => {
      if (command === OPEN_WEB_PACKAGE_INSTANCE_COMMAND) openDispatched = true;
      try {
        const response = await this.dependencies.invoke(command, args);
        if (command === BEGIN_WEB_PACKAGE_INSTANCE_COMMAND) {
          const begun = DesktopBeginWebPackageInstanceResponseSchema.safeParse(response);
          if (begun.success) nativeId = begun.data.instanceId;
        }
        return response;
      } finally {
        // A transport rejection can also hide a successfully opened window. Never adopt it into a new scope.
        if (command === OPEN_WEB_PACKAGE_INSTANCE_COMMAND && !isCurrent() && nativeId) void this.closeDetached(nativeId);
      }
    };
    try {
      const opened = source.instance
        ? await openWebPackageInstanceInIsolatedWebview(invoke, this.dependencies.rawInvoke,
          createWebPackageResourceSnapshot('desktop-arena-result', source.instance), source.title, isCurrent)
        : await openFreeHtmlInIsolatedWebview(invoke, this.dependencies.rawInvoke, source.content, source.title, isCurrent);
      if (isCurrent()) this.publish({ phase: 'open', instanceId: opened.instanceId, fullscreen: false,
        message: '作品已在独立隔离窗口中运行。切换普通显示将关闭作品，交互进度不会保存。' });
    } catch (error) {
      if (!isCurrent()) return;
      this.publish({ phase: openDispatched ? 'uncertain' : 'error', instanceId: openDispatched ? nativeId : null,
        message: openDispatched
          ? '打开结果尚未确认，窗口可能已建立。请检查运行状态或关闭作品，不会自动重新打开。'
          : `作品未能运行，完整原文仍保留。${error instanceof Error ? error.message : ''}` });
    } finally {
      if (this.flight === flight) {
        this.flight = null;
        if (isCurrent()) this.publish({ busy: false });
      }
    }
  }
  async control(action: DesktopControlWebPackageInstanceRequest['action'], fullscreen?: boolean): Promise<void> {
    const { instanceId } = this.state;
    if (!instanceId || this.flight || !this.source) return;
    const epoch = this.epoch, source = this.source, flight = Symbol('control-web-report');
    const sourceCurrent = this.sourceCurrent;
    if (!sourceCurrent()) return;
    this.flight = flight;
    this.publish({ busy: true });
    try {
      const request: DesktopControlWebPackageInstanceRequest = action === 'set-fullscreen'
        ? { instanceId, action, fullscreen: fullscreen === true } : { instanceId, action };
      const response = await controlWebPackageWindow(this.dependencies.invoke, request);
      if (this.epoch !== epoch || this.source !== source || !sourceCurrent()) return;
      this.publish(response.status === 'closed'
        ? { phase: 'idle', instanceId: null, fullscreen: false, message: '作品窗口已关闭；再次运行需要重新确认。' }
        : { phase: 'open', fullscreen: response.fullscreen, message: '作品正在独立隔离窗口中运行。' });
    } catch (error) {
      if (this.epoch !== epoch || this.source !== source || !sourceCurrent()) return;
      // A failed control does not authorize a second begin/open or pretend that the old window closed.
      this.publish({ phase: 'uncertain', message: `窗口操作结果尚未确认，请检查运行状态。${error instanceof Error ? error.message : ''}` });
    } finally {
      if (this.flight === flight) { this.flight = null; this.publish({ busy: false }); }
    }
  }
}
