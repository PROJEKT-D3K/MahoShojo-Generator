import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DirectProviderProfileV1 } from '@mahoshojo/contracts/provider-profile';
import type { LocalAiDiscoveryService, LocalAiDiscoveryTarget } from '@mahoshojo/contracts/local-ai-discovery';
import { discoverLocalAi } from '../../platform/local-ai-discovery-bridge';
import { PRESET_LM_STUDIO, PRESET_OLLAMA } from '../providers/profile-draft';
import { draftFromProfile, newConnectionId, saveConnectionDraft } from './connection-editor';
import type { UseDesktopAiConfigResult } from './use-desktop-ai-config';

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

  const cancel = () => {
    active.current?.abort(); active.current = null;
    setBusy(false);
  };
  useEffect(() => {
    // A changed Profile snapshot invalidates even a same-id request. Do not couple this to save flags.
    active.current?.abort(); active.current = null;
    setBusy(false); setResult(null); setModelId('');
    return () => { active.current?.abort(); active.current = null; };
  }, [identity]);

  const check = async () => {
    if (blocked || active.current || (target.kind === 'profile' && !profile)) return;
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
    if (blocked || busy || savingNow.current || !service || !selectable.some(model => model.id === modelId)) return;
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
      <p className="battle-lite-muted-text text-xs">只读取所选接口的版本与模型列表，不扫描设备、不启动或下载软件、不发送推理请求。</p>
      <label className="flex flex-col gap-1">检查目标
        <select className="input-field" aria-label="本机服务检查目标" value={targetKey} disabled={blocked}
          onChange={event => { cancel(); setTargetKey(event.target.value); setResult(null); setMessage(''); draftId.current = null; savedDraftSnapshot.current = null; }}>
          <option value="candidate:ollama">Ollama 默认接口（127.0.0.1:11434）</option>
          <option value="candidate:lm-studio">LM Studio 默认接口（127.0.0.1:1234）</option>
          {profiles.map(item => <option key={item.id} value={`profile:${item.id}`}>已保存连接：{item.name}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="battle-lite-link underline" disabled={blocked || busy} onClick={() => void check()}>检查所选服务</button>
        {busy && <button type="button" className="battle-lite-link underline" onClick={() => { cancel(); setMessage('已停止等待检查结果；若取消早于任务注册，原生任务将在检查时限内结束。'); }}>取消检查</button>}
        {target.kind === 'candidate' && <button type="button" className="battle-lite-link underline" disabled={blocked || busy}
          onClick={() => onManualConfigure(candidate)}>手动配置此服务</button>}
      </div>
      {busy && <p role="status">正在检查本机接口…</p>}
      {service && <>
        <p role="status">{stateMessage[service.state]}</p>
        {service.version && <p className="text-xs">接口报告版本：{service.version}</p>}
        <p className="battle-lite-muted-text text-xs">仅确认本机接口响应，未验证软件身份、推理位置、离线能力或费用；本机接口也可能转发到远端。</p>
        {service.models.length > 0 && <label className="flex flex-col gap-1">可接入模型
          <select className="input-field" aria-label="发现的模型" value={modelId} disabled={blocked || busy} onChange={event => setModelId(event.target.value)}>
            <option value="" disabled>请选择模型</option>
            {service.models.map(model => <option key={model.id} value={model.id} disabled={model.execution === 'remote-indicated'}>
              {model.label ?? model.id}{model.execution === 'remote-indicated' ? '（远端模型，不可选）' : model.loaded === 'no' ? '（尚未加载）' : ''}
            </option>)}
          </select>
        </label>}
        {selectable.length > 0 && <button type="button" className="battle-lite-link text-left underline"
          disabled={blocked || busy || !modelId} onClick={() => void save()}>保存所选模型并使用</button>}
      </>}
      {message && <p role="status">{message}</p>}
    </>}
  </section>;
}
