'use client';

import { ImagePreviewModal } from '@mahoshojo/ui-web/modal';

import React, { useState, useRef, useEffect } from 'react';
import { useGeneratedResultAutoScroll } from '@mahoshojo/ui-web/details-controls';
import { NamePageView } from '@mahoshojo/ui-web/name-generation';
import type {
  MagicalGirlGenerationResult as AIGeneratedMagicalGirl,
} from '@mahoshojo/hosted-api/generate-magical-girl';
import { buildNameGenerationResult, isNameWithinLength, serializeNameGenerationResult, type NameGenerationResult as MagicalGirl } from '@mahoshojo/domain/name-generation';
import Link from 'next/link';
import { useCooldown } from '@/lib/cooldown';
import { getSensitiveWordRedirectTarget } from '@/lib/content-safety/client';
import { useAppRouterAdapter } from '@/lib/app-router-adapter';
import TachieGenerator from '@/components/TachieGenerator';
import Footer from '@/components/Footer';
import { GeneratedByUserBadge } from '@/components/shared/GeneratedByUserBadge';
import { ErrorMessage } from '@/components/ErrorMessage';
import { EncyclopediaLinks } from '@/components/encyclopedia/EncyclopediaLinks';
import { CreatorEntryLink } from '@/components/shared/CreatorEntryLink';
import { readJsonOrTextFromResponse, resolveApiErrorMessage } from '@/lib/client/apiError';
import { formatHttpErrorMessage } from '@/lib/client/httpError';
import { downloadBlob } from '@/lib/client/blobUrl';
import { authStorage } from '@/lib/auth';
import type { GenerationApiIntent } from '@/lib/hono-api-client';
import { useGenerationApiIntentLatch } from '@/lib/use-generation-api-intent-latch';

// 注意：QueueStatus 组件及其相关逻辑已被移除，因为它在Serverless环境下无法正常工作。

const NAME_PREFERENCE_KEY = 'mahoshojo.name.preferences.v1';

type RateLimitError = Error & {
  retryAfterSeconds?: number;
};

// 使用 API 路由生成魔法少女
async function generateMagicalGirl(
  generationIntent: GenerationApiIntent,
  inputName: string,
  language: string,
): Promise<MagicalGirl> {
  try {
    const activityHeaders = await authStorage.getActivityHeaders();
    const response = await generationIntent.dispatch('/api/generate-magical-girl', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...activityHeaders,
      },
      body: JSON.stringify({ name: inputName, language: language }),
    });

      if (!response.ok) {
      const { payload } = await readJsonOrTextFromResponse(response);
      const error = payload && typeof payload === 'object' ? (payload as any) : null;
      // 处理不同的 HTTP 状态码
      if (response.status === 429) {
        const retryAfterRaw = error?.retryAfterSeconds ?? error?.retryAfter ?? response.headers.get('Retry-After') ?? 60;
        const retryAfter = Math.max(1, Number.parseInt(String(retryAfterRaw), 10) || 60);
        const rateLimitError = new Error(`请求过于频繁（HTTP 429）！请等待 ${retryAfter} 秒后再试。`) as RateLimitError;
        rateLimitError.retryAfterSeconds = retryAfter;
        throw rateLimitError;
      } else if (response.status === 524) {
        throw new Error('Cloudflare 超时（HTTP 524），请稍后重试。');
      } else {
        const fallback = response.status >= 500 ? '服务器内部错误' : '生成失败';
        const serverMessage = resolveApiErrorMessage({ payload, fallback });
        throw new Error(formatHttpErrorMessage({ serverMessage, status: response.status, fallback }));
      }
    }

    const aiGenerated: AIGeneratedMagicalGirl = await response.json();

    return buildNameGenerationResult(inputName, aiGenerated);
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new Error('网络连接失败，请检查网络后重试');
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('生成魔法少女时发生未知错误，请重试');
  }
}

export function NamePage() {
  const generationApiIntentLatch = useGenerationApiIntentLatch();
  const [inputName, setInputName] = useState('');
  const [magicalGirl, setMagicalGirl] = useState<MagicalGirl | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showImageModal, setShowImageModal] = useState(false);
  const [savedImageUrl, setSavedImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const beginResultNavigation = useGeneratedResultAutoScroll(resultRef);
  const { isCooldown, startCooldown, remainingTime } = useCooldown('generateMagicalGirlCooldown', 60000);
  const router = useAppRouterAdapter();
  // 多语言支持
  const [languages, setLanguages] = useState<{ code: string; name: string }[]>([]);
  const [selectedLanguage, setSelectedLanguage] = useState('zh-CN');

  useEffect(() => {
    fetch('/languages.json')
      .then(res => res.json())
      .then(data => setLanguages(data))
      .catch(err => console.error("Failed to load languages:", err));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = window.localStorage.getItem(NAME_PREFERENCE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (typeof parsed?.selectedLanguage === 'string') {
        setSelectedLanguage(parsed.selectedLanguage);
      }
    } catch (error) {
      console.warn('读取名称生成偏好失败', error);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const payload = { selectedLanguage };
      window.localStorage.setItem(NAME_PREFERENCE_KEY, JSON.stringify(payload));
    } catch {
      // localStorage 可能不可用，忽略
    }
  }, [selectedLanguage]);

  const handleGenerate = async () => {
    if (isCooldown) {
      setError(`请等待 ${remainingTime} 秒后再生成`);
      return;
    }
    if (!inputName.trim()) return;

    if (!isNameWithinLength(inputName)) {
      setError('名字太长啦，你怎么回事！');
      return;
    }
    const redirectTarget = await getSensitiveWordRedirectTarget(inputName.trim());
    if (redirectTarget) {
      router.push(redirectTarget);
      return;
    }
    const generationIntent = generationApiIntentLatch.tryAcquire();
    if (!generationIntent) return;
    setIsGenerating(true);
    setError(null);
    const revealGeneratedResult = beginResultNavigation(generationIntent);
    let nextCooldownMs = 60000;

    try {
      const result = await generateMagicalGirl(
        generationIntent,
        inputName.trim(),
        selectedLanguage,
      );
      setMagicalGirl(result);
      revealGeneratedResult();
      setError(null); // 成功时清除错误
    } catch (error) {
      revealGeneratedResult.cancel();
      if (error instanceof Error) {
        const errorMessage = error.message;
        // 检查是否是 rate limit 错误
        if (errorMessage.includes('请求过于频繁')) {
          const retryAfterSeconds =
            error && typeof (error as RateLimitError).retryAfterSeconds === 'number'
              ? Math.max(1, Math.ceil((error as RateLimitError).retryAfterSeconds as number))
              : 60;
          nextCooldownMs = retryAfterSeconds * 1000;
          setError(`🚫 请求太频繁了！请等待 ${retryAfterSeconds} 秒后再试吧~`);
        } else if (errorMessage.includes('网络')) {
          setError('🌐 网络连接有问题！请检查网络后重试~');
        } else {
          setError(`✨ 魔法失效了！${errorMessage}`);
        }
      } else {
        setError('✨ 魔法失效了！可能是用的人太多狸！请再生成一次试试吧~');
      }
    } finally {
      setIsGenerating(false);
      startCooldown(nextCooldownMs);
    }
  };

  useEffect(() => () => { if (savedImageUrl) URL.revokeObjectURL(savedImageUrl); }, [savedImageUrl]);

  return (
    <>
      <NamePageView
        inputName={inputName} selectedLanguage={selectedLanguage} languages={languages}
        onNameChange={setInputName} onLanguageChange={setSelectedLanguage} onGenerate={handleGenerate}
        isGenerating={isGenerating} generateDisabled={isCooldown}
        generateLabel={isCooldown ? `请等待 ${remainingTime} 秒` : undefined}
        magicalGirl={magicalGirl} resultRef={resultRef}
        navigation={<>
          <p className="subtitle text-center">或者要不要来试试 <Link href="/details" className="footer-link">奇妙妖精大调查</Link>？</p>
          <EncyclopediaLinks items={[{ slug: 'character-generator', text: '百科：角色生成（/name、/details、/canshou）' }]} />
        </>}
        actions={<>
          <div className="mt-4 text-center"><CreatorEntryLink /></div>
          <div className="text-center" style={{ marginTop: '2rem' }}><button onClick={() => router.push('/')} className="footer-link">返回首页</button></div>
        </>}
        feedback={error && <ErrorMessage message={error} />}
        exportBranding={<GeneratedByUserBadge variant="dark" className="mt-3" />}
        onSaveImage={(blob, result) => {
          if (/Mobi/i.test(window.navigator.userAgent)) {
            setSavedImageUrl(URL.createObjectURL(blob));
            setShowImageModal(true);
          } else downloadBlob(blob, `${result.name || 'magical-girl'}.png`);
        }}
        onSaveJson={(result) => downloadBlob(new Blob([serializeNameGenerationResult(result)], { type: 'application/json' }), `魔法少女_${result.name}.json`)}
        afterResult={magicalGirl && <div className="text-center w-full" style={{ marginTop: '2rem' }}>
          <h3 className="text-lg font-medium text-gray-900" style={{ marginBottom: '1rem' }}>立绘生成</h3>
          <TachieGenerator prompt={`${JSON.stringify(magicalGirl.appearance)} , Xiabanmo, 二次元, 魔法少女`} />
        </div>}
        footer={<Footer />}
      />
        <ImagePreviewModal
          isOpen={showImageModal}
          imageUrl={savedImageUrl}
          imageAlt="魔法少女登记表"
          hint="💫 长按图片保存到相册"
          imageWidth="half"
          closeOnBackdrop={false}
          closeButtonAriaLabel="关闭"
          onClose={() => setShowImageModal(false)}
        />
    </>
  );
}
