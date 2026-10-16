// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { magicalQuestionnaire } from '@/lib/questionnaire-presets';
import { DETAILS_PREFERENCES_STORAGE_KEY } from '@/lib/settings/page-preferences';

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), alert: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }), usePathname: () => '/', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/SaveToCloudButton', () => ({ default: () => null }));
vi.mock('@/components/BattleDataModal', () => ({ default: () => null }));
vi.mock('@/components/DataCardDetailsModal', () => ({ default: () => null }));
vi.mock('@/components/GeneralCharacterCard', () => ({ default: () => <div>生成正文</div> }));
vi.mock('@/components/shared/CharacterPortraitAssetPanel', () => ({ CharacterPortraitAssetPanel: () => null }));
vi.mock('@/components/AiProviderSelector', () => ({ default: () => null }));
vi.mock('@/components/ai/ProviderCooldownNotice', () => ({ ProviderCooldownNotice: () => null }));
vi.mock('@/components/Footer', () => ({ default: () => null }));
vi.mock('@/lib/auth', () => ({ authStorage: { getActivityHeaders: async () => ({}) } }));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({ useGenerationApiIntentLatch: () => ({ tryAcquire: () => ({ dispatch: mocks.dispatch }) }) }));
vi.mock('@/lib/cooldown', () => ({ useProviderModeCooldown: () => ({ isCooldown: false, remainingTime: 0, startCooldown: vi.fn() }) }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: async () => ({ hasSensitiveWords: false, matchDetails: [] }) }));
vi.mock('@/lib/stream/read-safe-text-and-reasoning-stream', () => ({ readSafeTextAndReasoningStreamFromResponse: async () => ({ text: '# 复制原件\n\n完整正文', outputSafetyStatus: 'ok', wasAborted: false }) }));

import { DetailsPage } from '@/components/creation/DetailsPage';
import { CreatorPage } from '@/components/creation/CreatorPage';

const questionnaire = { ...magicalQuestionnaire, nativeAllowed: false, questions: [{ ...magicalQuestionnaire.questions[0]!, required: false }] };
let host: HTMLDivElement, root: Root;
let originalClipboard: PropertyDescriptor | undefined, originalExec: PropertyDescriptor | undefined;
const button = (label: string) => {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label);
  expect(found, `按钮 ${label}`).toBeTruthy(); return found!;
};
const resultCopy = () => { const matches = [...host.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent?.trim() === '复制到剪贴板'); expect(matches.length).toBeGreaterThan(1); return matches.at(-1)!; };
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function generate(page: 'Details' | 'Creator') {
  await act(async () => root.render(page === 'Details' ? <DetailsPage /> : <CreatorPage />));
  await click(button('开始回答问卷'));
  const input = host.querySelector<HTMLTextAreaElement>('textarea.ui-web-questionnaire-answer-input')!;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '复制原件');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(button('提交'));
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  expect(resultCopy()).toBeTruthy();
}
beforeEach(() => {
  localStorage.clear();
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  originalExec = Object.getOwnPropertyDescriptor(document, 'execCommand');
  localStorage.setItem(DETAILS_PREFERENCES_STORAGE_KEY, JSON.stringify({ generationMode: 'stream' }));
  localStorage.setItem('mahoshojo.creator.build-rule-preference.v1', JSON.stringify({ version: 1, hasExplicitPreference: true, selectedRuleIds: [], primaryRuleId: null }));
  mocks.dispatch.mockReset().mockImplementation(async () => new Response('stream', { headers: { 'Content-Type': 'text/event-stream' } }));
  mocks.alert.mockReset(); vi.stubGlobal('alert', mocks.alert);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === '/languages.json') return Response.json([{ code: 'zh-CN', name: '简体中文' }]);
    if (url === '/questionnaires/presets/index.json') return Response.json({ presets: [{ id: questionnaire.id, kind: 'magical-girl', title: questionnaire.title, path: '/copy-questionnaire.json', isDefault: true }] });
    if (url === '/copy-questionnaire.json') return Response.json(questionnaire);
    throw new Error(`Unexpected fetch: ${url}`);
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard); else Reflect.deleteProperty(navigator, 'clipboard');
  if (originalExec) Object.defineProperty(document, 'execCommand', originalExec); else Reflect.deleteProperty(document, 'execCommand');
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe.each(['Details', 'Creator'] as const)('%s generated JSON copy assembly', (page) => {
  it.each(['missing', 'rejected'] as const)('uses the shared fallback for the real result when clipboard is %s', async (kind) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: kind === 'missing' ? undefined : { writeText: vi.fn().mockRejectedValue(new Error('unavailable')) } });
    let copied = '';
    const fallback = vi.fn(() => { copied = [...document.querySelectorAll('textarea')].find((item) => item.style.position === 'fixed')?.value ?? ''; return true; });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: fallback });
    await generate(page); await click(resultCopy());
    expect(fallback).toHaveBeenCalledExactlyOnceWith('copy');
    expect(JSON.parse(copied)).toMatchObject({ templateId: '通用角色', content: '# 复制原件\n\n完整正文' });
    expect(JSON.parse(copied).userAnswers).toBeTruthy();
    expect(mocks.alert).toHaveBeenLastCalledWith('✅ 通用角色卡 JSON 已复制到剪贴板');
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });
  it('does not show a late alert or invoke fallback after the page unmounts', async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<void>((_yes, no) => { reject = no; });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(() => pending) } });
    const fallback = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: fallback });
    await generate(page); await click(resultCopy());
    await act(async () => root.render(null)); mocks.alert.mockClear();
    await act(async () => reject(new Error('late rejection')));
    expect(fallback).not.toHaveBeenCalled(); expect(mocks.alert).not.toHaveBeenCalled();
  });
});

it.each(['success', 'failure'] as const)('Details retires a hidden result copy after mode switch, including a late %s after redisplay', async (outcome) => {
  let resolve!: () => void, reject!: (reason: Error) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(() => pending) } });
  const fallback = vi.fn(() => true);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: fallback });
  await generate('Details'); await click(resultCopy());
  await click(button('非流式'));
  expect([...host.querySelectorAll('button')].filter((item) => item.textContent?.trim() === '复制到剪贴板')).toHaveLength(1);
  await click(button('流式')); expect(resultCopy()).toBeTruthy();
  mocks.alert.mockClear();
  await act(async () => { if (outcome === 'success') resolve(); else reject(new Error('late rejection')); });
  expect(fallback).not.toHaveBeenCalled(); expect(mocks.alert).not.toHaveBeenCalled();
});
