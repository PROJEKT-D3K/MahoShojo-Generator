// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { magicalQuestionnaire } from '@/lib/questionnaire-presets';
import { DETAILS_PREFERENCES_STORAGE_KEY } from '@/lib/settings/page-preferences';

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), alert: vi.fn(), download: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }), usePathname: () => '/', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/SaveToCloudButton', () => ({ default: ({ data, cardType }: { data: unknown; cardType?: string }) => <button data-card-json={JSON.stringify(data)} data-card-type={cardType}>保存到云端</button> }));
vi.mock('@/components/BattleDataModal', () => ({ default: () => null }));
vi.mock('@/components/DataCardDetailsModal', () => ({ default: () => null }));
vi.mock('@/components/GeneralCharacterCard', () => ({ default: ({ general, isStreaming, onStopGeneration }: { general: { content: string }; isStreaming?: boolean; onStopGeneration?: () => void }) => <div aria-label="生成正文">{general.content}{isStreaming && <button onClick={onStopGeneration}>停止生成</button>}</div> }));
vi.mock('@/components/MagicalGirlCard', () => ({ default: ({ magicalGirl }: { magicalGirl: { codename: string } }) => <div aria-label="魔法少女结果">{magicalGirl.codename}</div> }));
vi.mock('@/components/ai/AiReasoningPanel', () => ({ default: ({ reasoning }: { reasoning?: { text?: string } | null }) => reasoning?.text ? <div aria-label="思考内容">{reasoning.text}</div> : null }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: mocks.download }));
vi.mock('@/components/shared/CharacterPortraitAssetPanel', () => ({ CharacterPortraitAssetPanel: ({ prompt }: { prompt: string }) => <div aria-label="立绘提示">{prompt}</div> }));
vi.mock('@/components/AiProviderSelector', () => ({ default: () => null }));
vi.mock('@/components/ai/ProviderCooldownNotice', () => ({ ProviderCooldownNotice: () => null }));
vi.mock('@/components/Footer', () => ({ default: () => null }));
vi.mock('@/lib/auth', () => ({ authStorage: { getActivityHeaders: async () => ({}) } }));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({ useGenerationApiIntentLatch: () => ({ tryAcquire: () => ({ dispatch: mocks.dispatch }) }) }));
vi.mock('@/lib/cooldown', () => ({ useProviderModeCooldown: () => ({ isCooldown: false, remainingTime: 0, startCooldown: vi.fn() }) }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: async (text: string) => ({ hasSensitiveWords: false, matchDetails: [], filteredText: text }) }));
vi.mock('@/lib/shield-word-filter', () => ({ applyShieldWords: (text: string) => ({ filteredText: text }) }));

import { DetailsPage } from '@/components/creation/DetailsPage';
import { CreatorPage } from '@/components/creation/CreatorPage';

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const markdown = '# 复制原件\n\n完整正文';
const streamResponse = (tail = sse('done', { ok: true })) => new Response([
  sse('reasoning', { source: 'sdk', chunk: '原请求思考' }),
  sse('markdown', { chunk: markdown }),
  tail,
].join(''), { headers: { 'Content-Type': 'text/event-stream' } });

const questionnaire = { ...magicalQuestionnaire, nativeAllowed: false, questions: [{ ...magicalQuestionnaire.questions[0]!, required: false }] };
let host: HTMLDivElement, root: Root;
let originalClipboard: PropertyDescriptor | undefined, originalExec: PropertyDescriptor | undefined;
const button = (label: string) => {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label);
  expect(found, `按钮 ${label}`).toBeTruthy(); return found!;
};
const resultCopy = () => { const matches = [...host.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent?.trim() === '复制到剪贴板'); expect(matches.length).toBeGreaterThan(1); return matches.at(-1)!; };
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function editAnswer(text: string) {
  const input = host.querySelector<HTMLTextAreaElement>('textarea.ui-web-questionnaire-answer-input')!;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function prepare(page: 'Details' | 'Creator') {
  await act(async () => root.render(page === 'Details' ? <DetailsPage /> : <CreatorPage />));
  await click(button('开始回答问卷'));
  await editAnswer('复制原件');
}
async function generate(page: 'Details' | 'Creator') {
  await prepare(page);
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
  mocks.dispatch.mockReset().mockImplementation(async () => streamResponse());
  mocks.download.mockReset();
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

it.each(['success', 'failure'] as const)('Details keeps the same result copy active after choosing the next mode, including a pending %s', async (outcome) => {
  let resolve!: () => void, reject!: (reason: Error) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(() => pending) } });
  const fallback = vi.fn(() => true);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: fallback });
  await generate('Details'); await click(resultCopy());
  await click(button('非流式'));
  expect(resultCopy()).toBeTruthy();
  expect(button('非流式').getAttribute('aria-pressed')).toBe('true');
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  mocks.alert.mockClear();
  await act(async () => { if (outcome === 'success') resolve(); else reject(new Error('late rejection')); });
  if (outcome === 'failure') expect(fallback).toHaveBeenCalledExactlyOnceWith('copy');
  else expect(fallback).not.toHaveBeenCalled();
  expect(mocks.alert).toHaveBeenLastCalledWith('✅ 通用角色卡 JSON 已复制到剪贴板');
});

it('Details keeps completed stream presentation, reasoning and export data while editing the next request', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await generate('Details');
  const original = button('保存到云端').dataset.cardJson!;
  const portrait = host.querySelector('[aria-label="立绘提示"]')?.textContent;
  await click(button('非流式'));
  await editAnswer('下次回答');
  expect(host.querySelector('[aria-label="生成正文"]')?.textContent).toBe(markdown);
  expect(host.querySelector('[aria-label="思考内容"]')?.textContent).toBe('原请求思考');
  expect(host.querySelector('[aria-label="立绘提示"]')?.textContent).toBe(portrait);
  expect(button('保存到云端').dataset.cardJson).toBe(original);
  expect(button('保存到云端').dataset.cardType).toBe('character');
  await click(resultCopy());
  expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual(JSON.parse(original));
  await click(button('下载通用角色卡'));
  expect(mocks.download.mock.calls[0]![1]).toBe('通用魔法少女角色_复制原件.json');
  const exported = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(mocks.download.mock.calls[0]![0]); });
  expect(JSON.parse(exported)).toEqual(JSON.parse(original));
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
});

it.each(['success', 'failure'] as const)('Details retires a pending copy when a new result replaces it, including late %s', async (outcome) => {
  let resolve!: () => void, reject!: (reason: Error) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(() => pending) } });
  const fallback = vi.fn(() => true);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: fallback });
  await generate('Details'); await click(resultCopy());
  mocks.dispatch.mockResolvedValueOnce(new Response(sse('markdown', { chunk: '# 新结果\n\n另一正文' }) + sse('done', { ok: true }), { headers: { 'content-type': 'text/event-stream' } }));
  await click(button('提交'));
  expect(host.querySelector('[aria-label="生成正文"]')?.textContent).toBe('# 新结果\n\n另一正文');
  mocks.alert.mockClear();
  await act(async () => { if (outcome === 'success') resolve(); else reject(new Error('late rejection')); });
  expect(fallback).not.toHaveBeenCalled(); expect(mocks.alert).not.toHaveBeenCalled();
});

it.each(['success', 'failure'] as const)('Details clears the old stream only when the next non-stream request starts (%s)', async (outcome) => {
  await generate('Details');
  await click(button('非流式'));
  await editAnswer('下次回答');
  let finish!: (response: Response) => void;
  mocks.dispatch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
  await click(button('提交'));
  expect(host.querySelector('[aria-label="生成正文"]')).toBeNull();
  expect(host.querySelector('[aria-label="思考内容"]')).toBeNull();
  expect(mocks.dispatch.mock.calls[1]![0]).toBe('/api/generate-magical-girl-details');
  expect(JSON.parse(mocks.dispatch.mock.calls[1]![1].body).answers[0].answer).toBe('下次回答');
  await act(async () => finish(outcome === 'success'
    ? Response.json({ codename: '新的非流式角色' })
    : Response.json({ error: '下一次失败' }, { status: 500 })));
  if (outcome === 'success') expect(host.querySelector('[aria-label="魔法少女结果"]')?.textContent).toBe('新的非流式角色');
  else expect(host.textContent).toContain('下一次失败');
  expect(host.querySelector('[aria-label="生成正文"]')).toBeNull();
});

it('Details retains a failed stream preview and reasoning when choosing the next mode', async () => {
  mocks.dispatch.mockResolvedValueOnce(streamResponse(sse('error', { error: '上游请求失败' })));
  await prepare('Details'); await click(button('提交'));
  expect(host.textContent).toContain('上游请求失败');
  await click(button('非流式'));
  expect(host.querySelector('[aria-label="生成正文"]')?.textContent).toBe(markdown);
  expect(host.querySelector('[aria-label="思考内容"]')?.textContent).toBe('原请求思考');
  expect([...host.querySelectorAll('button')].some((item) => item.textContent === '下载通用角色卡')).toBe(false);
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
});

it('Details keeps a manually stopped stream result after changing the next mode', async () => {
  mocks.dispatch.mockImplementationOnce(async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse('reasoning', { source: 'sdk', chunk: '原请求思考' }) + sse('markdown', { chunk: markdown })));
      init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  await prepare('Details'); await click(button('提交'));
  await click(button('停止生成'));
  expect(host.textContent).toContain('已手动停止生成');
  await click(button('非流式'));
  expect(host.querySelector('[aria-label="生成正文"]')?.textContent).toBe(markdown);
  expect(resultCopy()).toBeTruthy();
  expect(JSON.parse(button('保存到云端').dataset.cardJson!).content).toBe(markdown);
});

it('Details remount restores the next draft without replaying the previous stream result', async () => {
  await generate('Details');
  await click(button('非流式')); await editAnswer('重新打开的草稿');
  await act(async () => root.render(null));
  await act(async () => root.render(<DetailsPage />));
  await click(button('开始回答问卷'));
  expect(host.querySelector<HTMLTextAreaElement>('textarea.ui-web-questionnaire-answer-input')?.value).toBe('重新打开的草稿');
  expect(host.querySelector('[aria-label="生成正文"]')).toBeNull();
  expect(host.querySelector('[aria-label="思考内容"]')).toBeNull();
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
});
