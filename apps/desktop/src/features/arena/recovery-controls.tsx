import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@mahoshojo/ui-web/card-library';
import { copyTextToClipboard } from '@mahoshojo/ui-web/client';
import { DisclosureButton } from '@mahoshojo/ui-web/disclosure';
import { sanitizeArenaHostedErrorCode } from './hosted-error-diagnostic';
import type { DesktopArenaHostedRecoveryHint } from '@mahoshojo/contracts/desktop-arena-hosted';

const connectionLabels: Readonly<Record<string, string>> = {
  prepared: '已保留恢复记录', dispatched: '正在等待服务器回应', connecting: '正在连接服务器',
  generating: '正在生成', recovering_initial: '正在查找上次结果', reconnecting: '正在重新连接',
  resuming: '正在取回上次结果', unknown: '尚未确认上次生成的结果', cancelling: '正在等待服务器确认停止',
  cancelled: '停止请求已受理，最终状态请再查询', cancel_unconfirmed: '尚未确认服务器是否停止', completed: '已收到服务器完成状态',
  failed: '上次生成或交付未完成', interrupted: '连接已中断，结果尚未确认', producer_lost: '生成连接已中断',
};
export const arenaRecoveryStatusLabel = (state: string) => Object.hasOwn(connectionLabels, state) ? connectionLabels[state] : '尚未确认上次生成的结果';

const serverStatuses = ['reserved', 'running', 'finalizing', 'completed', 'failed', 'cancelled', 'producer_lost'];
const outputStatuses = ['pending', 'valid', 'missing-base', 'invalid'];
export type ArenaSafeDiagnosticInput = {
  phase: string;
  location?: 'client' | 'server' | null;
  hosted: { connectionState: string; serverStatus: string | null; outputValidation: string } | null;
  response: { httpStatus: number | null; code: string | null } | null;
};
/** Fixed local copy plus explicitly selected, bounded protocol fields; never serialize session/output. */
export const buildArenaSafeDiagnostic = ({ phase, location, hosted, response }: ArenaSafeDiagnosticInput): string | null => {
  if (phase !== 'failed' && !response) return null;
  if (!hosted) return `生成方式：${location === 'client' ? '客户端' : location === 'server' ? '服务器' : '未记录'}\n状态：未完成\n说明：本次生成未完成；此摘要不包含角色正文、账号或连接密钥。`;
  const httpStatus = response?.httpStatus;
  return [
    '生成方式：服务器',
    `HTTP：${typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : '未记录'}`,
    `错误码：${sanitizeArenaHostedErrorCode(response?.code) ?? '未记录'}`,
    `连接状态：${Object.hasOwn(connectionLabels, hosted.connectionState) ? hosted.connectionState : 'unknown'}`,
    `任务状态：${serverStatuses.includes(hosted.serverStatus ?? '') ? hosted.serverStatus : '未确认'}`,
    `输出校验：${outputStatuses.includes(hosted.outputValidation) ? hosted.outputValidation : '未确认'}`,
    '说明：连接或响应失败不代表服务器任务已停止；找回只查询原任务，不会重新生成。',
  ].join('\n');
};

export type ArenaBackupFeedback = 'download-started' | 'failed' | null;
export function ArenaBackupNotice({ feedback }: { feedback: ArenaBackupFeedback }) {
  return feedback ? <p role={feedback === 'failed' ? 'alert' : 'status'} className="text-sm">
    {feedback === 'download-started'
      ? '已发起下载，请查看系统保存提示或下载目录，文件名为 arena-complete.json。此页面无法确认文件是否已保存。'
      : '未能发起下载，当前内容仍保留。请重试下载会话备份。'}
  </p> : null;
}

type Props = {
  scopeKey: string;
  pointer: { state: string; actor: { kind: 'anonymous' | 'account' } } | null;
  showRecoveryCheck: boolean;
  recoveryError: string | null;
  blocked: boolean;
  disabled: boolean;
  identityReady: boolean;
  diagnosing: boolean;
  hint: DesktopArenaHostedRecoveryHint | null;
  diagnostic: string | null;
  backupFeedback: ArenaBackupFeedback;
  onRestore(): void;
  onDiagnose(): void;
  onDiscard(): void;
  onExport(): void;
};

export function DesktopArenaRecoveryControls(props: Props) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const epoch = useRef(0);
  const copyFlight = useRef<number | null>(null);
  const current = useRef({ scopeKey: props.scopeKey, diagnostic: props.diagnostic });
  current.current = { scopeKey: props.scopeKey, diagnostic: props.diagnostic };
  useLayoutEffect(() => { epoch.current += 1; copyFlight.current = null; setCopyStatus('idle'); setToolsOpen(false); return () => { epoch.current += 1; copyFlight.current = null; }; }, [props.scopeKey]);
  useLayoutEffect(() => { epoch.current += 1; copyFlight.current = null; setCopyStatus('idle'); }, [props.diagnostic]);
  const copy = async () => {
    if (!props.diagnostic || copyFlight.current !== null) return;
    const flight = ++epoch.current, { scopeKey, diagnostic } = props;
    copyFlight.current = flight;
    const isCurrent = () => epoch.current === flight && current.current.scopeKey === scopeKey && current.current.diagnostic === diagnostic;
    setCopyStatus('copying');
    const copied = await copyTextToClipboard(diagnostic, isCurrent);
    if (isCurrent()) { copyFlight.current = null; setCopyStatus(copied ? 'copied' : 'failed'); }
  };
  return <div className="w-full space-y-3 text-sm">
    {props.pointer ? <section aria-label="服务器恢复记录" className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/80 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
      <div className="space-y-1"><h3 className="font-semibold">找回上次战报</h3><p role="status">{arenaRecoveryStatusLabel(props.pointer.state)}</p></div>
      <p>找回只查询同一次生成，取回服务器仍保留的内容，不会重新生成。{props.pointer.actor.kind === 'account' ? '请使用上次生成时的账号。' : '将使用本机保留的上次访问身份。'}</p>
      <Button disabled={props.disabled || !props.identityReady} onClick={props.onRestore}>找回上次战报</Button>
    </section> : null}
    {props.recoveryError ? <div role="alert" className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/80 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
      <p>{props.recoveryError}</p>
      {props.blocked ? <Button variant="danger" size="sm" disabled={props.disabled} onClick={props.onDiscard}>清除损坏的恢复记录</Button> : null}
    </div> : null}
    <section aria-label="会话备份" className="space-y-2 rounded-xl border p-4" style={{ borderColor: 'var(--app-border-strong)', background: 'var(--app-surface-80)' }}>
      <h3 className="font-semibold">保存一份会话备份</h3>
      <p className="text-[color:var(--app-text-muted)]">下载 JSON 文件，保留当前角色、输入草稿、已收到的结果和恢复状态，便于留档或排查问题。备份可能包含私人设定，分享前请检查内容。</p>
      <Button size="sm" onClick={props.onExport}>下载会话备份</Button>
      <ArenaBackupNotice feedback={props.backupFeedback} />
    </section>
    {props.showRecoveryCheck || props.diagnostic ? <section aria-label="问题排查" className="space-y-3">
      <DisclosureButton open={toolsOpen} onToggle={() => setToolsOpen(value => !value)}>问题排查</DisclosureButton>
      {toolsOpen ? <div className="space-y-4 rounded-xl border p-4" style={{ borderColor: 'var(--app-border-strong)', background: 'var(--app-surface-80)' }}>
        {props.diagnostic ? <section aria-label="安全错误摘要" className="space-y-2">
          <p className="text-[color:var(--app-text-muted)]">反馈问题时可复制这份摘要，其中不包含角色正文、账号、请求编号或密钥。</p>
          <pre className="whitespace-pre-wrap break-words text-xs">{props.diagnostic}</pre>
          <Button size="sm" disabled={copyStatus === 'copying'} onClick={() => { void copy(); }}>{copyStatus === 'copying' ? '正在复制…' : '复制错误摘要'}</Button>
          {copyStatus === 'copied' || copyStatus === 'failed' ? <p role={copyStatus === 'failed' ? 'alert' : 'status'}>{copyStatus === 'copied' ? '错误摘要已复制。' : '复制失败，可手动选择上方摘要复制。'}</p> : null}
        </section> : null}
        {props.showRecoveryCheck ? <section aria-label="本机恢复身份诊断" className="space-y-2">
          <p>无法找回时，可检查本机是否还保留上次访问身份。检查不会重新生成，也不会清除已有内容。</p>
          <Button size="sm" disabled={props.disabled || !props.identityReady} onClick={props.onDiagnose}>检查恢复条件</Button>
          {props.diagnosing ? <p role="status">正在检查…</p> : null}
          {props.hint ? <p role="status">{props.hint.state === 'none' ? '本机未找到当前身份的恢复记录，仍不能确定服务器是否保留了任务。'
            : props.hint.state === 'unavailable' ? '暂时无法读取上次访问身份。已有记录已保留，请稍后再试。'
            : props.hint.state === 'expired' ? '上次访问身份已过期，可能无法找回服务器内容。已有记录已保留。'
            : '已找到上次访问身份。能否取回内容还需服务器确认；新建生成前会再次询问是否放弃上次恢复。'}</p> : null}
        </section> : null}
      </div> : null}
    </section> : null}
  </div>;
}
