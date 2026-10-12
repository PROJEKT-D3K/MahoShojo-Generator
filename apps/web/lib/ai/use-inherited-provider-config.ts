'use client';

import { useEffect, useState } from 'react';
import { AI_PROVIDER_CATALOG } from '@mahoshojo/ai-core/provider-catalog';
import {
  createAiProviderStorageKeys, DEFAULT_AI_PROVIDER_STORAGE_NAMESPACE,
  getApiKeyStorageKey, getCustomModelStorageKey, getModelStorageKey,
  resolveEffectiveModelId, resolveModelSelection,
} from '@mahoshojo/ui-web/ai-provider';
import type { UserAIProviderConfig } from './custom-provider';

export const AI_PROVIDER_CONFIG_CHANGED = 'mahoshojo:ai-provider-config-changed';
export type AiProviderConfigChangedDetail = {
  storageNamespace: string;
  config: UserAIProviderConfig | null;
};

// Read the source settings without mounting another selector/writer in its namespace.
export function useInheritedProviderConfig(storageNamespace = DEFAULT_AI_PROVIDER_STORAGE_NAMESPACE) {
  const [config, setConfig] = useState<UserAIProviderConfig | null>(null);
  useEffect(() => {
    const read = () => {
      try {
        const keys = createAiProviderStorageKeys(storageNamespace);
        const providerId = localStorage.getItem(keys.selectedProvider);
        const provider = AI_PROVIDER_CATALOG.find((item) => item.id === providerId);
        if (!provider) { setConfig(null); return; }
        const selection = resolveModelSelection(provider,
          localStorage.getItem(getModelStorageKey(keys, provider.id)) ?? '',
          localStorage.getItem(getCustomModelStorageKey(keys, provider.id)) ?? '');
        setConfig({
          providerId: provider.id,
          modelId: resolveEffectiveModelId(provider, selection.selectedModel, selection.customModelId),
          apiKey: localStorage.getItem(getApiKeyStorageKey(keys, provider.id)) ?? '',
        });
      } catch { setConfig(null); }
    };
    const onConfigChanged = (event: Event) => {
      const detail = (event as CustomEvent<AiProviderConfigChangedDetail>).detail;
      if (detail?.storageNamespace === storageNamespace) setConfig(detail.config);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === null || event.key.startsWith(`${storageNamespace}.`))) read();
    };
    read();
    window.addEventListener(AI_PROVIDER_CONFIG_CHANGED, onConfigChanged);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(AI_PROVIDER_CONFIG_CHANGED, onConfigChanged);
      window.removeEventListener('storage', onStorage);
    };
  }, [storageNamespace]);
  return config;
}
