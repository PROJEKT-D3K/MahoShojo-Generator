import { useEffect, useState } from 'react';
import { AI_PROVIDER_PRESETS, CUSTOM_AI_MODEL_OPTION_VALUE, findAiProviderPreset, resolveAIProviderModel } from '@mahoshojo/ai-core/provider-catalog';
import { getModelGenerationCapabilities } from '@mahoshojo/ai-core/generation-settings';
import { DesktopRoomPresetConfigSchema } from '@mahoshojo/contracts/desktop-room-session';
import type { DesktopHostedPresetConfig } from '@mahoshojo/contracts/desktop-cloud';
import { AdvancedGenerationSettings, AiProviderCustomSelect, AiProviderModelIdInput, AiProviderSelectorForm } from '@mahoshojo/ui-web/ai-provider';
import type { DesktopAiConfigState, DesktopAiConfigStore } from '../ai-config/desktop-ai-config-store';

/** Room-only, ephemeral and non-secret. Never write the ordinary AI overlay. */
export type DesktopRoomFunding = { presetConfig?: DesktopHostedPresetConfig };
export const roomFundingLabel = (funding: DesktopRoomFunding): string => {
  const config = funding.presetConfig;
  if (!config) return '服务器系统默认';
  const provider = findAiProviderPreset(config.providerId);
  return `服务器 BYOK · ${provider?.name ?? config.providerId} · ${provider ? resolveAIProviderModel(provider, config.modelId)?.modelId ?? config.modelId : config.modelId}`;
};
export const roomFundingBlockedReason = (funding: DesktopRoomFunding, state: DesktopAiConfigState, store: DesktopAiConfigStore): string | null => {
  const config = funding.presetConfig;
  if (!config) return null;
  if (!DesktopRoomPresetConfigSchema.safeParse(config).success || !findAiProviderPreset(config.providerId)) return '请选择有效的内置供应商和模型 ID。';
  if (state.savingCredential || state.savingConnection || state.deletingConnection) return '请等待凭据操作完成后重新确认。';
  if (store.getPresetKeyDraft(config.providerId)) return '所选供应商有尚未保存的 API Key 草稿，请到设置明确保存后重新确认。';
  const status = state.presetSecretStatus[config.providerId];
  return status === 'present' ? null : status === 'error' ? '凭据状态读取失败，请刷新或到设置检查。' : status === 'absent' ? '所选供应商尚未保存 API Key，请到设置保存后重新确认。' : '正在确认所选供应商的已保存凭据。';
};

export function DesktopRoomGenerationFunding({ value, onChange, state, store, disabled }: {
  value: DesktopRoomFunding; onChange: (value: DesktopRoomFunding) => void;
  state: DesktopAiConfigState; store: DesktopAiConfigStore; disabled: boolean;
}) {
  const [customModel, setCustomModel] = useState(false);
  const config = value.presetConfig, preset = config ? findAiProviderPreset(config.providerId) : null;
  const providerId = config?.providerId;
  useEffect(() => { if (providerId) void store.refreshPresetSecret(providerId); }, [providerId, store]);
  const effectiveModel = preset && config ? resolveAIProviderModel(preset, config.modelId)?.modelId : null;
  const capabilities = preset && effectiveModel ? getModelGenerationCapabilities(preset.id, effectiveModel) : undefined;
  const blocked = roomFundingBlockedReason(value, state, store);
  const modelOptions = preset?.models.filter(item => item.value !== CUSTOM_AI_MODEL_OPTION_VALUE).map(item => ({ value: item.value, label: item.label, description: item.description, kind: 'model' })) ?? [];
  if (config?.modelId && !modelOptions.some(item => item.value === config.modelId)) modelOptions.unshift({ value: config.modelId, label: config.modelId, description: '自定义模型 ID', kind: 'model' });
  const updateModel = (modelId: string) => { if (!disabled && config) onChange({ presetConfig: { providerId: config.providerId, modelId } }); };
  return <fieldset disabled={disabled} className="min-w-0 border-0 p-0" aria-label="本次房间服务器生成选择">
    <p>本次使用服务器生成，房间选择仅在本页保留；普通模型及参数保持不变。</p>
    <AiProviderSelectorForm label="本次房间 AI 提供商"
      providerSelect={<AiProviderCustomSelect placeholder="选择供应商" value={providerId ?? 'system'} disabled={disabled} onChange={id => {
        if (disabled) return;
        const selected = findAiProviderPreset(id); setCustomModel(false);
        if (id === 'system') onChange({});
        else if (selected) onChange({ presetConfig: { providerId: id, modelId: selected.models.find(item => item.value !== CUSTOM_AI_MODEL_OPTION_VALUE)?.value ?? '' } });
      }} options={[{ value: 'system', label: '服务器系统默认', kind: 'builtin' }, ...AI_PROVIDER_PRESETS.filter(item => !state.hiddenPresetIds.has(item.id)).map(item => ({ value: item.id, label: item.name, description: item.description, kind: 'preset' }))]} />}
      modelSelect={config && preset ? <AiProviderCustomSelect value={config.modelId} disabled={disabled} placeholder="选择模型"
        options={modelOptions}
        onChange={id => { updateModel(id); setCustomModel(false); }} actions={[{ id: 'custom-model', label: '自定义模型 ID' }]}
        onAction={() => { if (!disabled) setCustomModel(true); }} /> : undefined}
      customModelId={config && customModel ? { label: '自定义模型 ID', input: <AiProviderModelIdInput value={config.modelId} disabled={disabled} onValueChange={updateModel} />, hint: '固定供应商下使用此模型 ID，最多 200 字符；服务器仍会校验支持情况。' } : undefined}
      apiKey={config ? { content: <p>{state.presetSecretStatus[config.providerId] === 'present' ? '已保存 API Key' : '尚未确认已保存的 API Key'} <button type="button" disabled={disabled} className="underline" onClick={() => { void store.refreshPresetSecret(config.providerId); }}>刷新凭据状态</button></p>, hint: '项目生成服务会使用本机已保存的所选供应商 Key 转发本次输入。本页不输入或保存 Key；请在现有设置中管理凭据。' } : undefined}
      advancedSettings={config && preset ? <AdvancedGenerationSettings value={config.generationOverrides ?? {}} onChange={generationOverrides => { if (!disabled) onChange({ presetConfig: { providerId: config.providerId, modelId: config.modelId, ...(generationOverrides ? { generationOverrides: JSON.parse(JSON.stringify(generationOverrides)) } : {}) } }); }}
        temperatureSupported={capabilities?.temperature.support !== 'unsupported'} temperatureMax={capabilities?.temperature.max} maxOutputTokensMax={capabilities?.maxOutputTokens.max}
        thinkingSupport={capabilities?.thinking.support ?? 'unknown'} thinkingEfforts={capabilities?.thinking.efforts} canDisableThinking={capabilities?.thinking.support === 'supported' && capabilities.thinking.canDisable !== false} /> : undefined} />
    <p>{roomFundingLabel(value)}</p>{blocked ? <p role="status">{blocked}</p> : null}
  </fieldset>;
}
