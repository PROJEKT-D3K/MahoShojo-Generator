import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Play, RefreshCw, Square, X } from 'lucide-react';
import type { LocalAiLaunchErrorCode } from '@mahoshojo/contracts/local-ai-launch';
import type { DirectProviderProfileV1 } from '@mahoshojo/contracts/provider-profile';
import type { LocalAiDiscoveryService, LocalAiDiscoveryTarget } from '@mahoshojo/contracts/local-ai-discovery';
import { discoverLocalAi } from '../../platform/local-ai-discovery-bridge';
import { PRESET_LM_STUDIO, PRESET_OLLAMA } from '../providers/profile-draft';
import { draftFromProfile, newConnectionId, saveConnectionDraft } from './connection-editor';
import type { UseDesktopAiConfigResult } from './use-desktop-ai-config';
import { useLocalAiLaunch } from './use-local-ai-launch';

/** Display filter only; Native independently validates the complete persisted Profile before any secret/network access. */
export function isLocalDiscoveryProfile(profile: DirectProviderProfileV1): boolean {
  if (profile.adapter !== 'openai-compatible') return false;
  try {
    const url = new URL(profile.baseUrl);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username && !url.password && !url.search && !url.hash &&
      (/^127\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(url.hostname) || url.hostname === '[::1]');
  } catch { return false; }
}
const stateMessage: Record<LocalAiDiscoveryService['state'], string> = {
  reachable: '已取得模型列表。选择模型后可保存并使用。',
  'no-models': '接口已响应，但没有模型。请先在服务软件中准备模型，再检查。',
  'no-compatible-models': '接口已响应，但没有可在本向导使用的模型。已识别的远端模型不能选择。',
  'auth-required': '服务需要认证。请从服务界面复制模型标识，在手动连接中填写模型及凭据，保存后再检查。',
  'auth-rejected': '服务未接受已存凭据，请在连接编辑器检查凭据后重试。',
  'access-denied': '服务拒绝访问，请检查服务权限。',
  unreachable: '未连接到该本机接口。请检查软件是否安装、服务是否启动及端口设置；这不代表软件未安装。',
  'timed-out': '检查已超时，请确认服务状态后手动重试。',
  'unsupported-response': '接口返回了无法识别的模型列表，请检查服务版本或手动配置连接。',
  failed: '本机服务检查未完成，请检查服务设置后重试。',
};

const launchErrorMessage: Record<LocalAiLaunchErrorCode, string> = {
  'invalid-request': '启动请求无效，请重新检查。', busy: '已有启动或清理操作，请先查询本次状态。',
  'unsupported-platform': '本次启动目前仅支持 Windows 官方安装器安装的 Ollama。此设备请在官方应用启动后再检查。',
  'installation-not-found': '未发现支持的 Ollama 安装，不代表没有安装。便携版、WSL 或其他安装方式请自行启动后再检查。',
  'installation-untrusted': '无法验证此 Ollama 程序的官方身份，不会执行。请从官方应用检查安装。',
  'installation-changed': 'Ollama 安装在检查后发生变化，请重新检查再启动。',
  'permission-denied': '没有足够权限核实或启动 Ollama，请在官方应用检查。',
  'existing-process': '此安装已有程序运行，可能尚在初始化或使用其他端口。请在原应用检查，或选择已保存连接。',
  'invalid-operation': '启动票据已失效，请查询本次状态后重新检查。', expired: '启动票据已过期，请重新检查。',
  cancelled: '启动已取消。', 'port-in-use': '默认端口已被占用，不会停止其他程序或更改端口。请检查原服务。',
  'spawn-failed': '无法启动 Ollama，请在官方应用检查。', 'process-exited': '本次 Ollama 进程已退出，请检查后重试。',
  'ownership-unverified': '无法确认服务属于本次启动，不会接管或停止其他服务。请重新检查接口。',
  'timed-out': '本次检查或启动超时，请重新检查。',
  'stop-failed': '尚未确认本次服务已停止，请查询本次状态。', failed: '本次操作未完成，请查询状态后再试。',
};

export function LocalAiDiscoverySection({ aiConfig, onManualConfigure }: {
  aiConfig: UseDesktopAiConfigResult;
  onManualConfigure: (candidate: 'ollama' | 'lm-studio') => void;
}) {
  const { state, store } = aiConfig;
  const [targetKey, setTargetKey] = useState('candidate:ollama');
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ identity: string; service: LocalAiDiscoveryService } | null>(null);
  const [modelId, setModelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const active = useRef<AbortController | null>(null);
  const draftId = useRef<string | null>(null);
  const savedDraftSnapshot = useRef<string | null>(null);
  const savingNow = useRef(false);
  const profiles = state.profiles.filter(isLocalDiscoveryProfile);
  const profile = targetKey.startsWith('profile:') ? state.profiles.find(item => item.id === targetKey.slice(8)) : undefined;
  const candidate = targetKey === 'candidate:lm-studio' ? 'lm-studio' : 'ollama';
  const target: LocalAiDiscoveryTarget = targetKey.startsWith('profile:')
    ? { kind: 'profile', profileId: targetKey.slice(8) } : { kind: 'candidate', candidateId: candidate };
  const identity = JSON.stringify([targetKey, profile ?? null, open]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const blocked = state.overlayState !== 'ready' || state.generationActive || state.savingCredential ||
    state.savingConnection || state.deletingConnection || saving;
  const service = result?.identity === identity ? result.service : null;
  const selectable = service?.models.filter(model => model.execution !== 'remote-indicated') ?? [];
  const launch = useLocalAiLaunch(identity, open && targetKey === 'candidate:ollama', nextService => {
    setResult(nextService ? { identity, service: nextService } : null);
    setModelId(previous => nextService?.models.some(model => model.id === previous && model.execution !== 'remote-indicated')
      ? previous : nextService?.models.find(model => model.execution !== 'remote-indicated')?.id ?? '');
  });

  const cancel = () => {
    active.current?.abort(); active.current = null;
    launch.cancelPending(); setBusy(false);
  };
  useEffect(() => {
    // A changed Profile snapshot invalidates even a same-id request. Do not couple this to save flags.
    active.current?.abort(); active.current = null;
    setBusy(false); setResult(null); setModelId('');
    return () => { active.current?.abort(); active.current = null; };
  }, [identity]);

  const check = async () => {
    if (blocked || active.current || launch.busy || launch.hasPending || (target.kind === 'profile' && !profile)) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true); setMessage(''); setResult(null); setModelId('');
    const startedIdentity = identity;
    try {
      const response = await discoverLocalAi(invoke, {
        contractVersion: 1, requestId: `local_${crypto.randomUUID()}`, target,
      }, controller.signal);
      if (active.current !== controller || currentIdentity.current !== startedIdentity) return;
      if (response.outcome === 'completed') {
        setResult({ identity: startedIdentity, service: response.service });
        setModelId(response.service.models.find(model => model.execution !== 'remote-indicated')?.id ?? '');
        if (target.kind === 'candidate' && target.candidateId === 'ollama' && response.service.state === 'unreachable') {
          await launch.prepare();
        }
      }
    } catch (cause) {
      if (active.current === controller && currentIdentity.current === startedIdentity && !controller.signal.aborted) {
        setMessage(cause instanceof Error ? cause.message : '本机服务检查失败');
      }
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  };

  const save = async () => {
    if (blocked || busy || launch.busy || savingNow.current || !service || !selectable.some(model => model.id === modelId)) return;
    if (target.kind === 'profile' && (!profile || JSON.stringify(store.getSnapshot().profiles.find(item => item.id === profile.id)) !== JSON.stringify(profile))) {
      setMessage('连接已变化，请重新检查。'); return;
    }
    draftId.current ??= newConnectionId();
    if (!profile && savedDraftSnapshot.current !== null &&
      JSON.stringify(store.getSnapshot().profiles.find(item => item.id === draftId.current) ?? null) !== savedDraftSnapshot.current) {
      setMessage('已保存连接发生变化，请重新检查后创建连接，或在连接列表中编辑原连接。');
      setResult(null); setModelId(''); draftId.current = null; savedDraftSnapshot.current = null; return;
    }
    const preset = candidate === 'ollama' ? PRESET_OLLAMA : PRESET_LM_STUDIO;
    const draft = profile ? { ...draftFromProfile(profile), modelId } : { ...preset, id: draftId.current, modelId };
    savingNow.current = true; setSaving(true); setMessage('');
    try {
      await saveConnectionDraft(store, draft, { activate: true, activateModelId: modelId });
      setResult(null); setModelId(''); draftId.current = null; savedDraftSnapshot.current = null;
      setMessage('连接已保存并设为当前，可在生成页开始使用。尚未发送推理请求。');
    } catch (cause) {
      savedDraftSnapshot.current = JSON.stringify(store.getSnapshot().profiles.find(item => item.id === draft.id) ?? null);
      setMessage(cause instanceof Error ? cause.message : '保存连接失败');
    } finally { savingNow.current = false; setSaving(false); }
  };

  return <section className="flex flex-col gap-2 rounded-lg border border-(--app-border) p-3 text-sm" aria-label="本机 AI 服务发现">
    <button type="button" className="battle-lite-link text-left underline" aria-expanded={open}
      disabled={saving} onClick={() => { cancel(); setResult(null); setModelId(''); setOpen(!open); setMessage(''); }}>
      {open ? '收起本机服务检查' : '检查本机 AI 服务'}
    </button>
    {open && <>
      <p className="battle-lite-muted-text text-xs">检查所选本机接口与模型；Ollama 未响应时会检查支持的安装。不会自动启动或发送推理请求。</p>
      <label className="flex flex-col gap-1">检查目标
        <select className="input-field" aria-label="本机服务检查目标" value={targetKey} disabled={blocked}
          onChange={event => { cancel(); setTargetKey(event.target.value); setResult(null); setMessage(''); draftId.current = null; savedDraftSnapshot.current = null; }}>
          <option value="candidate:ollama">Ollama 默认接口（127.0.0.1:11434）</option>
          <option value="candidate:lm-studio">LM Studio 默认接口（127.0.0.1:1234）</option>
          {profiles.map(item => <option key={item.id} value={`profile:${item.id}`}>已保存连接：{item.name}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="battle-lite-link underline" disabled={blocked || busy || launch.busy || launch.hasPending} onClick={() => void check()}>检查所选服务</button>
        {busy && <button type="button" className="battle-lite-link underline" onClick={() => { cancel(); setMessage('已取消等待检查结果。'); }}>取消检查</button>}
        {target.kind === 'candidate' && <button type="button" className="battle-lite-link underline" disabled={blocked || busy}
          onClick={() => onManualConfigure(candidate)}>手动配置此服务</button>}
      </div>
      {busy && launch.phase === 'idle' && <p role="status">正在检查…</p>}
      {targetKey === 'candidate:lm-studio' && <p className="battle-lite-muted-text text-xs">LM Studio 请先在官方应用的开发者界面开启本地服务，再检查；此处不会代为启动或停止。</p>}
      {targetKey === 'candidate:ollama' && ((launch.snapshot !== null && launch.snapshot.state !== 'idle') || (launch.phase !== 'idle' && launch.phase !== 'recovering')) && <div className="flex flex-col gap-2" aria-label="本次 Ollama 启动">
        <p className="battle-lite-muted-text text-xs">启动已安装的 Ollama，仅在本机供本次使用；退出生成器时停止。不会安装软件或下载模型。</p>
        <p className="battle-lite-muted-text text-xs">目前仅支持 Windows 官方安装器版本。关闭设置不会停止已就绪服务。</p>
        <details className="battle-lite-muted-text text-xs"><summary>启动说明</summary>启动会产生 Ollama 自身的日志与状态。</details>
        {launch.snapshot?.installation && <p>已核实 Ollama 安装（{launch.snapshot.installation.source === 'default-location' ? '默认安装位置' : '官方注册的安装位置'}）。</p>}
        {launch.phase === 'preparing' && <p role="status">正在检查安装…</p>}
        {launch.phase === 'starting' && <p role="status">正在启动…</p>}
        {launch.phase === 'cancelling' && <p role="status">正在取消…</p>}
        {(launch.phase === 'stopping' || launch.snapshot?.state === 'stopping') && <p role="status">{launch.snapshot?.installation ? '正在停止…' : '正在结束本次操作…'}</p>}
        {launch.snapshot?.state === 'prepared' && <button type="button" className="battle-lite-link inline-flex items-center gap-1 text-left underline" disabled={blocked || launch.busy}
          onClick={() => { if (!blocked && !store.getSnapshot().generationActive) void launch.start(); }}><Play size={14} aria-hidden="true" />为本次使用启动 Ollama</button>}
        {(launch.snapshot?.state === 'ready' || launch.snapshot?.state === 'stopping') && <p className="battle-lite-muted-text text-xs">停止可能中断其他程序的请求；请先完成或取消正在进行的生成。</p>}
        {launch.snapshot?.state === 'ready' && <>
          <p role="status">Ollama 已就绪。</p>
          <button type="button" className="battle-lite-link inline-flex items-center gap-1 text-left underline" disabled={blocked || launch.busy}
            onClick={() => { if (!blocked && !store.getSnapshot().generationActive) void launch.stop(); }}><Square size={14} aria-hidden="true" />停止本次启动的服务</button>
        </>}
        {launch.snapshot?.state === 'stopping' && <button type="button" className="battle-lite-link inline-flex items-center gap-1 text-left underline" disabled={blocked || launch.phase !== 'idle'}
          onClick={() => { if (!blocked && !store.getSnapshot().generationActive) void launch.stop(); }}><Square size={14} aria-hidden="true" />{launch.snapshot.installation ? '重试停止本次服务' : '重试结束本次操作'}</button>}
        {launch.snapshot?.state === 'external' && <p role="status">已有服务正在运行，可直接接入；本应用不会停止它。</p>}
        {launch.snapshot?.state === 'cancelled' && <p role="status">本次启动已取消。</p>}
        {launch.snapshot?.state === 'stopped' && <p role="status">本次服务已停止。</p>}
        {launch.snapshot?.state === 'failed' && <p role="status">{launchErrorMessage[launch.snapshot.errorCode!]}</p>}
        {(launch.hasPending || launch.phase === 'preparing' || launch.phase === 'starting') && launch.snapshot?.state !== 'stopping' && <button type="button" className="battle-lite-link inline-flex items-center gap-1 text-left underline"
          disabled={launch.phase === 'cancelling'} onClick={() => launch.cancelPending()}><X size={14} aria-hidden="true" />取消本次启动</button>}
        {launch.notice && <p role="status">{launch.notice}</p>}
        <button type="button" className="battle-lite-link inline-flex items-center gap-1 text-left underline" disabled={launch.phase === 'recovering'}
          onClick={() => void launch.refresh()}><RefreshCw size={14} aria-hidden="true" />查询本次启动状态</button>
      </div>}
      {service && <>
        <p role="status">{service.state === 'unreachable' && launch.snapshot?.state === 'prepared' ? '已找到可启动的 Ollama，请点击上方按钮。' : service.state === 'no-models' && launch.snapshot?.state === 'ready' ? '服务已启动，但本次未发现模型。' : stateMessage[service.state]}</p>
        {service.state === 'no-models' && launch.snapshot?.state === 'ready' && <p className="battle-lite-muted-text text-xs">若曾在 Ollama 界面中改过模型位置，本次启动可能找不到这些模型。请在官方应用检查，不必重复下载。</p>}
        {service.version && <p className="text-xs">接口报告版本：{service.version}</p>}
        <p className="battle-lite-muted-text text-xs">{launch.snapshot?.state === 'ready' ? '本次启动不代表模型离线运行或免费；已标记的远端模型不可选。' : '仅确认本机接口响应，未验证软件身份、推理位置、离线能力或费用；本机接口也可能转发到远端。'}</p>
        {service.models.length > 0 && <label className="flex flex-col gap-1">可接入模型
          <select className="input-field" aria-label="发现的模型" value={modelId} disabled={blocked || busy} onChange={event => setModelId(event.target.value)}>
            <option value="" disabled>请选择模型</option>
            {service.models.map(model => <option key={model.id} value={model.id} disabled={model.execution === 'remote-indicated'}>
              {model.label ?? model.id}{model.execution === 'remote-indicated' ? '（远端模型，不可选）' : model.loaded === 'no' ? '（尚未加载）' : ''}
            </option>)}
          </select>
        </label>}
        {selectable.length > 0 && <button type="button" className="battle-lite-link text-left underline"
          disabled={blocked || busy || launch.busy || !modelId} onClick={() => void save()}>保存所选模型并使用</button>}
      </>}
      {message && <p role="status">{message}</p>}
    </>}
  </section>;
}
