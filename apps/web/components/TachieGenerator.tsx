"use client";

import { useState, useEffect, useRef } from "react";
import { generateTachieWithProgress, type TachieGenerationResult, type TachieSource } from "@/lib/tachie/manager";
import { ErrorMessage } from "@/components/ErrorMessage";
import { normalizeModelScopeToken } from "@/lib/tachie/modelscope/error";
import { DEFAULT_NOVELAI_SETTINGS, normalizeNovelAIToken } from '@/lib/tachie/novelai';
import { NovelAISettingsFields } from '@/components/tachie/NovelAISettings';

const MODELSCOPE_SIZE_OPTIONS = [
  { value: "928x1664", label: "16:9 竖屏（928×1664）" },
  { value: "1664x928", label: "16:9 横屏（1664×928）" },
  { value: "1328x1328", label: "正方形（1328×1328）" },
  { value: "1104x1472", label: "4:3 竖屏（1104×1472）" },
  { value: "1472x1104", label: "4:3 横屏（1472×1104）" },
] as const;

type ModelScopePresetSize = (typeof MODELSCOPE_SIZE_OPTIONS)[number]["value"];

const DEFAULT_MODELSCOPE_SIZE: ModelScopePresetSize = "1328x1328";
const NOVELAI_TOKEN_KEY = 'tachie_novelai_token';

const isModelScopePresetSize = (value: unknown): value is ModelScopePresetSize =>
  typeof value === "string" && MODELSCOPE_SIZE_OPTIONS.some((option) => option.value === value);

interface TachieGeneratorProps {
  prompt: string;
  textProviderStorageNamespace?: string;
  recommendedPrompt?: string;
  onUseRecommendedPrompt?: () => void;
  mode?: 'tachie' | 'illustration';
  workflowUuid?: string;
  templateUuid?: string;
  promptNodeId?: number;
  negativePrompt?: string;
  negativePromptNodeId?: number;
  onImageUrlChange?: (imageUrl: string | null) => void;
  onResult?: (result: TachieGenerationResult) => void;
}

export default function TachieGenerator({
  prompt,
  textProviderStorageNamespace,
  recommendedPrompt,
  onUseRecommendedPrompt,
  mode,
  workflowUuid,
  templateUuid,
  promptNodeId,
  negativePrompt,
  negativePromptNodeId,
  onImageUrlChange,
  onResult,
}: TachieGeneratorProps) {
  const [source, setSource] = useState<TachieSource>("modelscope");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [modelscopeToken, setModelscopeToken] = useState("");
  const [modelscopeModel, setModelscopeModel] = useState("Stonego/XiabanmostyleV3");
  const [modelscopeSize, setModelscopeSize] = useState<ModelScopePresetSize>(DEFAULT_MODELSCOPE_SIZE);
  const [novelaiToken, setNovelaiToken] = useState('');
  const [novelaiStorageError, setNovelaiStorageError] = useState('');
  const [novelaiCustomMode, setNovelaiCustomMode] = useState(false);
  const [novelaiPrompt, setNovelaiPrompt] = useState('');
  const [novelaiSettings, setNovelaiSettings] = useState({ ...DEFAULT_NOVELAI_SETTINGS });
  const generationRef = useRef<AbortController | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isOptimizingPrompt, setIsOptimizingPrompt] = useState(false);
  const [result, setResult] = useState<TachieGenerationResult | null>(null);
  const [rememberCredentials, setRememberCredentials] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressStatus, setProgressStatus] = useState("");
  const normalizedModelScopeToken = normalizeModelScopeToken(modelscopeToken);

  useEffect(() => {
    try { setNovelaiToken(localStorage.getItem(NOVELAI_TOKEN_KEY) ?? ''); }
    catch { setNovelaiStorageError('浏览器不允许读取本地存储，请重新填写 Token。'); }
  }, []);
  const updateNovelaiToken = (value: string) => {
    setNovelaiToken(value);
    try {
      const token = normalizeNovelAIToken(value);
      if (token) localStorage.setItem(NOVELAI_TOKEN_KEY, token);
      else localStorage.removeItem(NOVELAI_TOKEN_KEY);
      setNovelaiStorageError('');
    } catch { setNovelaiStorageError('Token 无法保存到本地存储，本次仍可使用，刷新后需重新填写。'); }
  };
  useEffect(() => () => { generationRef.current?.abort(); generationRef.current = null; }, []);

  // localStorage keys
  const CREDENTIALS_KEY = 'tachie_credentials';
  const REMEMBER_KEY = 'tachie_remember';

  // 组件加载时从localStorage读取凭据
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const shouldRemember = localStorage.getItem(REMEMBER_KEY) === 'true';
      setRememberCredentials(shouldRemember);

      if (shouldRemember) {
        const savedCredentials = localStorage.getItem(CREDENTIALS_KEY);
        if (savedCredentials) {
          try {
            const parsed = JSON.parse(savedCredentials) as Record<string, unknown>;
            if (parsed.source === 'liblib') {
              setSource('liblib');
            } else {
              setSource('modelscope');
            }

            setAccessKey(typeof parsed.accessKey === 'string' ? parsed.accessKey : '');
            setSecretKey(typeof parsed.secretKey === 'string' ? parsed.secretKey : '');
            setModelscopeToken(typeof parsed.modelscopeToken === 'string' ? normalizeModelScopeToken(parsed.modelscopeToken) : '');
            setModelscopeModel(
              typeof parsed.modelscopeModel === 'string' && parsed.modelscopeModel.trim()
                ? parsed.modelscopeModel
                : 'Stonego/XiabanmostyleV3'
            );
            setModelscopeSize(isModelScopePresetSize(parsed.modelscopeSize) ? parsed.modelscopeSize : DEFAULT_MODELSCOPE_SIZE);
          } catch (error) {
            console.error('Failed to parse saved credentials:', error);
          }
        }
      }
    }
  }, []);

  // 保存凭据到localStorage
  const saveCredentials = () => {
    if (source === 'novelai') return;
    if (typeof window !== 'undefined') {
      if (rememberCredentials) {
        localStorage.setItem(CREDENTIALS_KEY, JSON.stringify({
          source,
          accessKey: accessKey.trim(),
          secretKey: secretKey.trim(),
          modelscopeToken: normalizedModelScopeToken,
          modelscopeModel: modelscopeModel.trim() || 'Stonego/XiabanmostyleV3',
          modelscopeSize,
        }));
        localStorage.setItem(REMEMBER_KEY, 'true');
      } else {
        localStorage.removeItem(CREDENTIALS_KEY);
        localStorage.setItem(REMEMBER_KEY, 'false');
      }
    }
  };

  // 清除已保存的凭据
  const clearSavedCredentials = () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(CREDENTIALS_KEY);
      localStorage.setItem(REMEMBER_KEY, 'false');
      setRememberCredentials(false);
      setSource('modelscope');
      setAccessKey('');
      setSecretKey('');
      setModelscopeToken('');
      setModelscopeModel('Stonego/XiabanmostyleV3');
      setModelscopeSize(DEFAULT_MODELSCOPE_SIZE);
    }
  };

  const requiredCredentialsReady = source === 'liblib'
    ? Boolean(accessKey.trim() && secretKey.trim())
    : source === 'novelai' ? Boolean(normalizeNovelAIToken(novelaiToken)) : Boolean(normalizedModelScopeToken);

  const handleGenerate = async () => {
    if (generationRef.current || isOptimizingPrompt) return;
    if (source === 'liblib' && (!accessKey.trim() || !secretKey.trim())) {
      const nextResult = {
        success: false,
        error: "请填写 LibLib Access Key 和 Secret Key",
      } satisfies TachieGenerationResult;
      setResult(nextResult);
      onResult?.(nextResult);
      onImageUrlChange?.(null);
      return;
    }

    if (source === 'modelscope' && !normalizedModelScopeToken) {
      const nextResult = {
        success: false,
        error: "请填写 ModelScope Token",
      } satisfies TachieGenerationResult;
      setResult(nextResult);
      onResult?.(nextResult);
      onImageUrlChange?.(null);
      return;
    }

    const normalizedPrompt = (source === 'novelai' ? novelaiPrompt : prompt).trim();
    if (!normalizedPrompt) {
      const nextResult = {
        success: false,
        error: "立绘提示词为空：请先补全角色外观/正文，或手动填写提示词后再生成。",
      } satisfies TachieGenerationResult;
      setResult(nextResult);
      onResult?.(nextResult);
      onImageUrlChange?.(null);
      return;
    }

    // 保存凭据（如果用户选择记住）
    saveCredentials();

    const controller = new AbortController();
    generationRef.current = controller;

    setIsGenerating(true);
    setResult(null);
    onImageUrlChange?.(null);
    setProgress(0);
    setProgressStatus("正在提交生成任务...");

    try {
      const generationResult = await generateTachieWithProgress({
        source,
        accessKey: accessKey.trim(),
        secretKey: secretKey.trim(),
        modelscopeToken: normalizedModelScopeToken,
        modelscopeModel: modelscopeModel.trim() || undefined,
        modelscopeSize,
        novelaiToken,
        novelaiSettings: novelaiCustomMode ? novelaiSettings : {
          ...DEFAULT_NOVELAI_SETTINGS, model: novelaiSettings.model, baseUrl: novelaiSettings.baseUrl,
        },
        signal: controller.signal,
        prompt: normalizedPrompt,
        mode,
        workflowUuid,
        templateUuid,
        promptNodeId,
        negativePrompt,
        negativePromptNodeId,
      }, (progress, status) => {
        if (generationRef.current !== controller) return;
        setProgress(progress);
        setProgressStatus(status);
      });
      if (generationRef.current !== controller) return;
      setResult(generationResult);
      onResult?.(generationResult);
      onImageUrlChange?.(generationResult.success ? (generationResult.imageUrl ?? null) : null);
    } catch (error) {
      if (generationRef.current !== controller) return;
      const nextResult = {
        success: false,
        error: error instanceof Error ? error.message : "生成失败",
      } satisfies TachieGenerationResult;
      setResult(nextResult);
      onResult?.(nextResult);
      onImageUrlChange?.(null);
    } finally {
      if (generationRef.current === controller) {
        generationRef.current = null;
        setIsGenerating(false);
        setProgress(0);
        setProgressStatus("");
      }
    }
  };

  return (
    <div>
      <div className="input-group">
        <label className="input-label">图片生成来源</label>
        <div className="flex flex-wrap gap-2">
          {(['modelscope', 'liblib', 'novelai'] as const).map((item) => <button
            key={item}
            type="button"
            onClick={() => setSource(item)}
            disabled={isGenerating || isOptimizingPrompt}
            aria-pressed={source === item}
            className={`shrink-0 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pink-500 ${source === item ? 'border-pink-500 bg-pink-500 text-white' : 'border-pink-200 bg-white text-pink-600 hover:bg-pink-50'}`}
          >
            {item === 'modelscope' ? 'ModelScope' : item === 'liblib' ? 'LibLib' : 'NovelAI'}
          </button>)}
        </div>
      </div>

      {source === 'novelai' && <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-semibold">NovelAI 的使用具有一定的门槛，不推荐直接使用默认提示词。</p>
        <p className="mt-1">请自行编写适合所选模型的提示词，或导入角色与剧情后使用「LLM 优化提示词」。仅提供 V4.5 Curated 和 V5 Curated。</p>
      </div>}

      <div style={{ marginBottom: '1.5rem' }}>
        <p className="text-center text-sm text-gray-500 mt-4 leading-relaxed">
          请前往
          {source === 'liblib' ? (
            <>
              &nbsp;
              <a
                href="https://www.liblib.art/apis"
                target="_blank"
                rel="noopener noreferrer"
                className="footer-link"
              >
                LibLib
              </a>
              &nbsp;获取 Access Key 和 Secret Key
            </>
          ) : source === 'novelai' ? (
            <>
              &nbsp;<a href="https://novelai.net" target="_blank" rel="noopener noreferrer" className="footer-link">NovelAI</a>
              &nbsp;的用户设置 → Account → Get Persistent API Token 获取令牌
            </>
          ) : (
            <>
              &nbsp;
              <a
                href="https://modelscope.cn/my/access/token"
                target="_blank"
                rel="noopener noreferrer"
                className="footer-link"
              >
                ModelScope
              </a>
              &nbsp;获取 Token
            </>
          )}
          <br />
          {source === 'novelai' ? '无需填写 NovelAI 账号密码。' : '勾选“记住凭据”后，凭据将保存在此浏览器的本地存储中。'}
        </p>
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        {source === 'liblib' ? (
          <>
            <div className="input-group">
              <label htmlFor="accessKey" className="input-label">
                LibLib Access Key
              </label>
              <input
                id="accessKey"
                type="password"
                value={accessKey}
                onChange={(e) => setAccessKey(e.target.value)}
                placeholder="输入你的 Access Key"
                className="input-field"
                disabled={isGenerating}
              />
            </div>

            <div className="input-group">
              <label htmlFor="secretKey" className="input-label">
                LibLib Secret Key
              </label>
              <input
                id="secretKey"
                type="password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder="输入你的 Secret Key"
                className="input-field"
                disabled={isGenerating}
              />
            </div>
          </>
        ) : source === 'novelai' ? (
          <><NovelAISettingsFields token={novelaiToken} onTokenChange={updateNovelaiToken}
            textProviderStorageNamespace={textProviderStorageNamespace}
            prompt={novelaiPrompt} onPromptChange={setNovelaiPrompt}
            onUseRecommendedPrompt={recommendedPrompt?.trim() ? () => {
              setNovelaiPrompt(recommendedPrompt);
              onUseRecommendedPrompt?.();
            } : undefined}
            customMode={novelaiCustomMode} onCustomModeChange={setNovelaiCustomMode}
            onOptimizerBusyChange={setIsOptimizingPrompt}
            settings={novelaiSettings} onChange={setNovelaiSettings} disabled={isGenerating} />
            {novelaiStorageError && <p role="alert" className="mt-2 text-xs text-amber-700">{novelaiStorageError}</p>}
          </>
        ) : (
          <>
            <div className="input-group">
              <label htmlFor="modelscopeToken" className="input-label">
                ModelScope Token
              </label>
              <input
                id="modelscopeToken"
                type="password"
                value={modelscopeToken}
                onChange={(e) => setModelscopeToken(e.target.value)}
                placeholder="输入你的 ModelScope Token"
                className="input-field"
                disabled={isGenerating}
              />
              <div className="mt-2 text-xs text-gray-500">
                可直接粘贴 Token；若误贴了 <code>Bearer </code> 前缀，系统会自动去除。
              </div>
              <div className="mt-1 text-xs text-gray-500">
                若报 401/403 且提示绑定阿里云或实名认证，请先到 ModelScope 账号设置完成后再重试。
              </div>
            </div>

            <div className="input-group">
              <label htmlFor="modelscopeSize" className="input-label">
                图片尺寸
              </label>
              <select
                id="modelscopeSize"
                value={modelscopeSize}
                onChange={(e) => setModelscopeSize(e.target.value as ModelScopePresetSize)}
                className="input-field"
                disabled={isGenerating}
              >
                {MODELSCOPE_SIZE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>

      {/* 记住凭据选项 */}
      {source !== 'novelai' && <div className="input-group flex items-center justify-between">
        <label className="flex items-center cursor-pointer text-sm text-gray-500">
          <input
            type="checkbox"
            checked={rememberCredentials}
            onChange={(e) => setRememberCredentials(e.target.checked)}
            style={{ marginRight: '0.5rem' }}
          />
          在本地记住我的凭据，方便下次使用
        </label>
        {rememberCredentials && (accessKey || secretKey || modelscopeToken || modelscopeModel || modelscopeSize) && (
          <button
            type="button"
            onClick={clearSavedCredentials}
            className="bg-transparent border-0 text-xs text-pink-600 underline hover:text-pink-500"
          >
            清除已保存的凭据
          </button>
        )}
      </div>}

      <button
        type="button"
        onClick={handleGenerate}
        disabled={isGenerating || isOptimizingPrompt || !requiredCredentialsReady || !(source === 'novelai' ? novelaiPrompt : prompt).trim()}
        className="generate-button"
      >
        {isGenerating ? "立绘生成中，请稍后捏 (≖ᴗ≖)✧✨" : `✨ 使用 ${source === 'liblib' ? 'LibLib' : source === 'novelai' ? 'NovelAI' : 'ModelScope'} 生成立绘 ✨`}
      </button>

      {isGenerating && source === 'novelai' && (
        <button type="button" className="text-sm text-pink-700 underline" onClick={() => generationRef.current?.abort()}>
          取消等待（已提交的任务可能仍会计费）
        </button>
      )}

      {isGenerating && (
        <div role="status" className="mt-4 p-4 rounded-2xl border border-pink-200 bg-white/90 text-center">
          <div style={{ marginBottom: '0.75rem' }}>
            <span className="text-sm font-semibold text-pink-600">
              {progressStatus || "立绘生成中，请稍后捏 (≖ᴗ≖)✧"}
            </span>
          </div>

          {/* 进度条 */}
          <div className="w-full h-2 rounded bg-pink-100/60 overflow-hidden mb-2">
            <div style={{
              width: `${Math.max(progress, 5)}%`, // 最小显示5%，让用户看到有进度
              height: '100%',
              background: 'linear-gradient(90deg, #ff6b6b, #ff8787)',
              borderRadius: '4px',
              transition: 'width 0.3s ease',
              animation: progress === 0 ? 'shimmer 2s infinite' : 'none'
            }}></div>
          </div>

          {/* 进度百分比 */}
          <div className="text-xs text-gray-500">
            {source === 'novelai' ? '等待图片返回，暂无进度百分比' : progress > 0 ? `${progress}%` : "准备中..."}
          </div>
        </div>
      )}

      {result && !isGenerating && (
        <div style={{ marginTop: '1rem' }}>
          {result.success ? (
            <div>
              <div style={{
                padding: '0.75rem',
                background: 'linear-gradient(45deg, #51cf66, #8ce99a)',
                borderRadius: '12px',
                marginBottom: '1rem',
                textAlign: 'center'
              }}>
                <p style={{ fontSize: '0.875rem', color: 'white', fontWeight: '600', margin: 0 }}>
                  ✨ 生成成功！
                </p>
                {result.seed !== undefined && (
                  <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.9)', margin: '0.25rem 0 0 0' }}>
                    种子值: {result.seed}
                  </p>
                )}
              </div>
              {result.imageUrl && (
                <div style={{
                  border: '2px solid rgba(255, 107, 107, 0.3)',
                  borderRadius: '12px',
                  overflow: 'hidden',
                  boxShadow: '0 8px 32px rgba(255, 107, 107, 0.2)'
                }}>
                  <img
                    src={result.imageUrl}
                    alt="生成的立绘"
                    style={{ width: '100%', height: 'auto', display: 'block' }}
                    onError={(e) => {
                      e.currentTarget.src = "";
                      e.currentTarget.alt = "图片加载失败";
                    }}
                  />
                </div>
              )}
              {result.imageUrl?.startsWith('data:image/png;base64,') && (
                <a href={result.imageUrl} download={`novelai-${result.seed ?? 'image'}.png`} className="mt-3 inline-block text-sm text-pink-700 underline">下载 PNG</a>
              )}
            </div>
          ) : (
            <ErrorMessage message={result.error ?? "生成失败"} />
          )}
        </div>
      )}

      <style jsx>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        
        @keyframes shimmer {
          0% { opacity: 0.6; }
          50% { opacity: 1; }
          100% { opacity: 0.6; }
        }
      `}</style>
    </div>
  );
}
