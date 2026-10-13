'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { AI_PROVIDER_PRESETS, describeAiPresetModelDirectSupport } from '@mahoshojo/ai-core/provider-catalog';
import { useInheritedProviderConfig } from '@/lib/ai/use-inherited-provider-config';
import { getNovelAIPromptProfile, rewriteNovelAIPrompt } from '@/lib/tachie/novelai-prompt';

export function NovelAIPromptOptimizer({ prompt, imageModel, onApply, onBusyChange, disabled, sourceStorageNamespace }: {
  sourceStorageNamespace?: string;
  prompt: string;
  imageModel: string;
  onApply: (value: string) => void;
  onBusyChange: (value: boolean) => void;
  disabled: boolean;
}) {
  const id = useId();
  const [requirements, setRequirements] = useState('');
  const [addQualityTags, setAddQualityTags] = useState(false);
  const config = useInheritedProviderConfig(sourceStorageNamespace);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const profile = getNovelAIPromptProfile(imageModel);
  const provider = AI_PROVIDER_PRESETS.find((item) => item.id === config?.providerId);
  const directSupported = provider && config && describeAiPresetModelDirectSupport(
    provider, config.modelId, new Set(['openai-compatible'] as const),
  ).supported;
  const configIssue = !config || config.providerId === 'system'
    ? '上方尚未配置自备 Key 的文本模型，或正在使用系统模型。请先在上方生成设置中配置模型和 API Key。'
    : !directSupported
      ? '当前文本模型或渠道不支持此处的浏览器直连，请在上方生成设置中选择支持的模型。'
      : !config.apiKey.trim() ? '当前文本模型尚未填写 API Key。' : '';

  useEffect(() => {
    setResult(null); setError(''); setLoading(false);
    return () => {
      request.current?.abort(); request.current = null; onBusyChange(false);
    };
  }, [prompt, imageModel, config, disabled, onBusyChange, requirements, addQualityTags]);

  const optimize = async () => {
    if (!config || configIssue || !profile || request.current || disabled) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); onBusyChange(true); setResult(null); setError('');
    try {
      const output = await rewriteNovelAIPrompt(config, imageModel, prompt, controller.signal, { requirements, addQualityTags });
      if (request.current === controller) setResult(output);
    } catch (cause) {
      if (request.current === controller) setError(cause instanceof Error ? cause.message : '提示词优化失败');
    } finally {
      if (request.current === controller) {
        request.current = null; setLoading(false); onBusyChange(false);
      }
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-pink-100 p-3">
      <p className="text-sm text-gray-600">
        提示词改写使用的文本模型：{provider?.name ?? '尚未选择'} / {config?.modelId || '尚未选择模型'}<br />
      </p>
      {!profile && <p className="text-xs text-amber-700">当前仅支持针对 V4.5 Curated / V5 Curated 优化。</p>}
      {configIssue && <p role="status" className="text-xs text-amber-700">{configIssue}</p>}
      <div>
        <label htmlFor={`${id}-requirements`} className="input-label">补充画面要求（可选）</label>
        <textarea id={`${id}-requirements`} className="input-field" rows={2} maxLength={2000}
          value={requirements} onChange={(event) => setRequirements(event.target.value)}
          placeholder="例如：只描绘交锋前一刻；背面全身构图；保留双方各自的发色与服装" />
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-600">
        <input type="checkbox" checked={addQualityTags} onChange={(event) => setAddQualityTags(event.target.checked)} />
        补充所选模型的质量词（可选）
      </label>
      <button type="button" disabled={disabled || loading || !profile || Boolean(configIssue) || !prompt.trim()}
        onClick={() => void optimize()} className="rounded-lg border border-pink-200 px-3 py-2 text-sm text-pink-700 disabled:opacity-50">
        {loading ? '正在优化提示词…' : '调用文本模型优化'}
      </button>
      {loading && <button type="button" className="ml-3 text-sm text-pink-700 underline" onClick={() => request.current?.abort()}>取消优化</button>}
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      {result !== null && <div className="space-y-2">
        <label htmlFor={`${id}-result`} className="input-label">优化结果（尚未应用）</label>
        <textarea id={`${id}-result`} className="input-field" rows={8} value={result} maxLength={8000}
          onChange={(event) => setResult(event.target.value)} />
        <p className="text-xs text-gray-500">可直接修改后应用。当前 {result.length} 字符。</p>
        <button type="button" disabled={disabled || !result.trim()} className="rounded-lg border border-pink-200 px-3 py-2 text-sm text-pink-700" onClick={() => onApply(result.trim())}>应用到提示词</button>
      </div>}
    </div>
  );
}
