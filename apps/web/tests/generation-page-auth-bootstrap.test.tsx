// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/cooldown', () => ({ useProviderModeCooldown: () => ({ isCooldown: false, startCooldown: vi.fn(), remainingTime: 0, otherRemainingTime: 0 }) }));
vi.mock('@/lib/content-safety/client', () => ({ getSensitiveWordRedirectTarget: async () => null }));
vi.mock('@/lib/app-router-adapter', () => ({ useAppRouterAdapter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ai/ProviderCooldownNotice', () => ({ ProviderCooldownNotice: () => null }));
vi.mock('@/components/Footer', () => ({ default: () => null }));
vi.mock('@/components/AiProviderSelector', () => ({ default: () => null }));
vi.mock('@/components/ai/AiReasoningPanel', () => ({ default: () => null }));
vi.mock('@/components/SaveToCloudButton', () => ({ default: () => null }));
vi.mock('@/components/shared/CharacterPortraitAssetPanel', () => ({ CharacterPortraitAssetPanel: () => null }));
vi.mock('@/components/GeneralCharacterCard', () => ({ default: () => null }));

import { FreePage } from '@/components/creation/FreePage';
import { authStorage } from '@/lib/auth';
import { honoApiConfig } from '@/config/hono-api';

const originalHonoConfig = { ...honoApiConfig };
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  localStorage.clear();
  authStorage.clearAuth();
  honoApiConfig.enabled = false;
  honoApiConfig.routingMode = 'static-next';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  authStorage.clearAuth();
  Object.assign(honoApiConfig, originalHonoConfig);
  vi.unstubAllGlobals();
});

it.each([
  ['non-stream', 'server-error'],
  ['stream', 'server-error'],
  ['stream', 'transport-error'],
] as const)('real FreePage %s/%s verifies once and leaves failed generation unreplayed', async (generationMode, failure) => {
  localStorage.setItem('mahoshojo.free-generator.draft.v1', JSON.stringify({
    schemaId: 'general', generationMode, prompt: '合成测试提示词', selectedLanguage: 'zh-CN',
    showFieldGuide: false, showLanguageSection: false,
  }));
  const verify = vi.fn(async () => Response.json({ success: false }, { status: 401 }));
  const business = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    if (failure === 'transport-error') throw new TypeError('synthetic lost response');
    return Response.json({ error: 'synthetic unavailable' }, { status: 503 });
  });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    if (path === '/languages.json') return Response.json([{ code: 'zh-CN', name: '中文' }]);
    if (path === '/api/auth/verify') return verify();
    if (path.startsWith('/api/generate-free')) return business(input, init);
    throw new Error(`Unexpected fixture request: ${path}`);
  }));

  await act(async () => root.render(<FreePage />));
  const submit = [...container.querySelectorAll('button')].find((button) => button.textContent === '开始生成')!;
  await act(async () => submit.click());

  expect(verify).toHaveBeenCalledOnce();
  expect(business).toHaveBeenCalledOnce();
  const [target, init] = business.mock.calls[0]!;
  expect(target).toBe(generationMode === 'stream' ? '/api/generate-free-stream?format=sse' : '/api/generate-free');
  expect(init?.method).toBe('POST');
  const headers = new Headers(init?.headers);
  expect(headers.get('Content-Type')).toBe('application/json');
  expect(headers.get('Accept')).toBe(generationMode === 'stream' ? 'text/event-stream' : null);
  expect(headers.get('x-mahoshojo-ai-meta')).toBe(generationMode === 'stream' ? null : '1');
  expect(headers.has('Authorization')).toBe(false);
  expect(headers.has('x-mahoshojo-activity-token')).toBe(false);
  expect(JSON.parse(String(init?.body))).toMatchObject({ schema: 'general', prompt: '合成测试提示词', language: 'zh-CN' });
  expect(submit.disabled).toBe(false);
});
