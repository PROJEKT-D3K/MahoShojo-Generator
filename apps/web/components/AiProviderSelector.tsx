// Web 侧 AI Provider 选择器薄封装。
//
// 全部展示/状态/持久化逻辑已共源到 `@mahoshojo/ui-web/ai-provider`（D5.0b）；
// 本文件只注入 Web 宿主端口：localStorage、`/api/ai/channel-availability`、
// `mahoshojo:set-ai-provider-config` CustomEvent、Next `<Link>` 文档入口。
// 对外契约不变：默认导出 + `UserAIProviderConfig` re-export。

import React, { useCallback } from 'react';
import Link from 'next/link';

import {
  AI_PROVIDER_SYNC_EVENT,
  DEFAULT_AI_PROVIDER_STORAGE_NAMESPACE,
  AiProviderSelectorView,
  type AiChannelAvailabilityEntry,
  type AiProviderStoragePort,
  type AiProviderSyncDetail,
} from '@mahoshojo/ui-web/ai-provider';
import type { AIProviderOption } from '@/lib/ai/constants';
import { ChannelAvailabilityBadge } from '@/components/ChannelAvailabilityBadge';
import type { UserAIProviderConfig } from '@/lib/ai/custom-provider';
import { AI_PROVIDER_CONFIG_CHANGED, type AiProviderConfigChangedDetail } from '@/lib/ai/use-inherited-provider-config';

export type { UserAIProviderConfig } from '@/lib/ai/custom-provider';

interface AiProviderSelectorProps {
    onConfigChange: (config: UserAIProviderConfig | null) => void;
    storageNamespace?: string;
    providers?: readonly AIProviderOption[];
    allowSystemProvider?: boolean;
    label?: string;
    requestMode?: 'hosted' | 'direct';
    showAdvancedSettings?: boolean;
}

const webLocalStoragePort: AiProviderStoragePort = {
    getItem: (key) => (typeof window === 'undefined' ? null : window.localStorage.getItem(key)),
    setItem: (key, value) => {
        if (typeof window === 'undefined') return;
        window.localStorage.setItem(key, value);
    },
    removeItem: (key) => {
        if (typeof window === 'undefined') return;
        window.localStorage.removeItem(key);
    },
};

const loadChannelAvailability = async (): Promise<AiChannelAvailabilityEntry[] | null> => {
    try {
        const res = await fetch('/api/ai/channel-availability');
        if (!res.ok) return null;
        const data = await res.json();
        return (data?.entries ?? null) as AiChannelAvailabilityEntry[] | null;
    } catch {
        return null;
    }
};

const subscribeSync = (handler: (detail: AiProviderSyncDetail) => void) => {
    if (typeof window === 'undefined') return;
    const listener = (event: Event) => {
        handler((event as CustomEvent<AiProviderSyncDetail | undefined>).detail ?? {});
    };
    window.addEventListener(AI_PROVIDER_SYNC_EVENT, listener as EventListener);
    return () => window.removeEventListener(AI_PROVIDER_SYNC_EVENT, listener as EventListener);
};

const renderDocsLink = (provider: AIProviderOption) => (
    <div className="mt-4">
        <Link
            href={provider.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center rounded-lg bg-pink-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-transform hover:-translate-y-0.5 hover:bg-pink-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pink-500"
        >
            前往获取 API Key
        </Link>
    </div>
);

const AiProviderSelector: React.FC<AiProviderSelectorProps> = ({
    onConfigChange,
    storageNamespace = DEFAULT_AI_PROVIDER_STORAGE_NAMESPACE,
    providers,
    allowSystemProvider,
    label,
    requestMode = 'hosted',
    showAdvancedSettings = true,
}) => {
    const handleConfigChange = useCallback((config: UserAIProviderConfig | null) => {
        onConfigChange(config);
        window.dispatchEvent(new CustomEvent<AiProviderConfigChangedDetail>(AI_PROVIDER_CONFIG_CHANGED, {
            detail: { storageNamespace, config },
        }));
    }, [onConfigChange, storageNamespace]);
    return (
        <AiProviderSelectorView
            onConfigChange={handleConfigChange}
            storage={webLocalStoragePort}
            storageNamespace={storageNamespace}
            providers={providers}
            allowSystemProvider={allowSystemProvider}
            label={label}
            loadChannelAvailability={requestMode === 'direct' ? undefined : loadChannelAvailability}
            renderAvailabilityBadge={(entry) => (
                <ChannelAvailabilityBadge availability={entry} compact />
            )}
            renderDocsLink={renderDocsLink}
            subscribeSync={requestMode === 'direct' ? undefined : subscribeSync}
            showAdvancedSettings={showAdvancedSettings}
            apiKeyStorageHint={requestMode === 'direct'
                ? 'API Key 仅存储于本地浏览器；请求时通过 HTTPS 直接发送到所选供应商，不经本站服务器。'
                : 'API Key 仅存储于本地浏览器；请求时会随 HTTPS 发送到边缘函数用于转发调用，不会写入数据库或日志。'}
        />
    );
};

export default AiProviderSelector;
