import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { normalizeArenaWebOutput } from '@mahoshojo/ai-core/arena-generation';
import {
  ArenaWebDisplayModeSelectorView, ArenaWebImmersiveButton, ArenaWebNotes, ArenaWebReportActions,
  ArenaWebSourceView, WebReportConsentDialogView, WebPackageRiskSummary, type ArenaWebReportAction,
} from '@mahoshojo/ui-web/arena-report-views';
import type { WebPackageRiskProfile } from '@mahoshojo/web-package/security';
import { DesktopWebReportExecution, type DesktopWebReportSource } from './web-execution';

export type DesktopWebReportChildren = (content: ReactNode | undefined, actions: ReactNode, showingWeb: boolean) => ReactNode;
export type DesktopWebReportProps = Readonly<{
  source: DesktopWebReportSource;
  children: DesktopWebReportChildren;
  actions?: readonly ArenaWebReportAction[];
  status?: ReactNode;
  riskProfile?: WebPackageRiskProfile | null;
  prelude?: string;
  epilogue?: string;
  /** Hosts without a verified package source can still use ordinary display. */
  unavailableReason?: string;
  /** Admission lock; it does not change the result identity or destroy a running work. */
  disabled?: boolean;
  /** Explicit host port, also used by DOM tests; product hosts use the default release capability. */
  execution?: DesktopWebReportExecution;
}>;

/** Trusted controls only. The actual work lives in a separate zero-capability Native window. */
export function DesktopWebReport({ source, children, actions = [], status, riskProfile, prelude = '', epilogue = '', unavailableReason, disabled = false, execution }: DesktopWebReportProps) {
  const [defaultExecution] = useState(() => new DesktopWebReportExecution({
    invoke: (command, args) => invoke(command, args as never),
    rawInvoke: (command, body, options) => invoke(command, body as never, options as never),
  }));
  const owner = execution ?? defaultExecution;
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  useEffect(() => { void owner.initializeAvailability(); }, [owner]);
  useLayoutEffect(() => { owner.setSource(source); return () => owner.clearSource(source); }, [owner, source]);
  useEffect(() => {
    const update = () => { if (owner.getSnapshot().instanceId) void owner.control('status'); };
    window.addEventListener('focus', update);
    return () => window.removeEventListener('focus', update);
  }, [owner]);
  const showingWeb = state.phase === 'opening' || state.phase === 'open' || state.phase === 'uncertain';
  const reason = unavailableReason || (!owner.available ? owner.unavailableReason
    : !source.ready ? '生成完整战报后可使用 Web 显示。'
      : source.instance === null ? 'Web 包尚未通过精确内容校验，暂不能运行。'
        : source.instance === undefined && !normalizeArenaWebOutput(source.content).document ? '未识别完整 HTML，保留安全文本，不能运行。' : undefined);
  const run = () => { if (!reason && !disabled) owner.requestRun(); };
  const runAction: ArenaWebReportAction = { id: 'run-web-report', label: '运行 Web 战报', onClick: run,
    disabled: disabled || !!reason || !owner.canRun() || state.busy };
  const controls: ArenaWebReportAction[] = state.instanceId ? [
    { id: 'web-focus', label: '↗ 聚焦作品窗口', disabled: state.busy || state.phase !== 'open', onClick: () => { void owner.control('focus'); } },
    { id: 'web-reload', label: '↻ 重新加载', title: '重新加载会重置作品内的交互进度', disabled: state.busy || state.phase !== 'open', onClick: () => { void owner.control('reload'); } },
    { id: 'web-check', label: '检查运行状态', disabled: state.busy, onClick: () => { void owner.control('status'); } },
    { id: 'web-close', label: '关闭作品', disabled: state.busy, onClick: () => { void owner.control('close'); } },
  ] : [runAction];
  const content = showingWeb ? <div className="space-y-3 p-4" aria-label="独立 Web 作品窗口">
    <p role="status">{state.message}</p>
    <p className="text-sm">作品在独立隔离窗口中运行，不会在主界面执行网页。作品菜单提供全屏、重新加载与关闭；交互进度不会自动保存。</p>
    <ArenaWebNotes prelude={prelude} epilogue={epilogue} />
  </div> : source.instance !== undefined || !source.ready ? <ArenaWebSourceView source={source.content} /> : undefined;
  const reportActions = <><ArenaWebReportActions actions={[...actions, ...controls]} />
    {state.instanceId && state.phase === 'open' ? <ArenaWebImmersiveButton immersive={state.fullscreen} disabled={state.busy}
      onClick={() => { void owner.control('set-fullscreen', !state.fullscreen); }} /> : null}</>;
  return <section data-testid="arena-web-result" className="space-y-3">
    <ArenaWebDisplayModeSelectorView value={showingWeb ? 'web' : 'ordinary'} disabled={state.busy || disabled} webUnavailableReason={reason}
      webDescription="在独立隔离窗口中运行生成的网页或 Web 包，保留自定义排版和交互。"
      onChange={mode => { if (mode === 'ordinary') void owner.showOrdinary(); else if (state.phase === 'open') void owner.control('focus'); else run(); }} />
    {status}
    {riskProfile ? <WebPackageRiskSummary profile={riskProfile} /> : null}
    {reason ? <p role="status" className="text-sm text-(--app-text-muted)">{reason}</p> : null}
    {!showingWeb && state.message ? <p role="status" className="text-sm text-(--app-text-muted)">{state.message}</p> : null}
    <div aria-label={!showingWeb && content === undefined ? 'Web 战报源码（安全文本）' : undefined}>
      {children(content, reportActions, showingWeb)}
    </div>
    <p className="text-xs text-(--app-text-muted)">导出的 HTML、CSS 或 JavaScript 在外部打开时不受应用隔离保护，可能加载外部资源；作品交互进度不会自动保存。</p>
    <WebReportConsentDialogView open={state.phase === 'confirming' && !disabled} onCancel={() => owner.cancelConfirmation()}
      onAccept={() => { if (!reason && !disabled) void owner.confirmRun(); }}
      executionDescription={`即将打开“${source.title}”的独立作品窗口；每次重新运行都会再次确认。`} />
  </section>;
}
