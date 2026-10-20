// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { magicalQuestionnaire } from '@/lib/questionnaire-presets';
import { DETAILS_PREFERENCES_STORAGE_KEY } from '@/lib/settings/page-preferences';

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), acquire: vi.fn(), quickCheck: vi.fn(), routerPush: vi.fn(), startCooldown: vi.fn(), alert: vi.fn(), download: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.routerPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }), usePathname: () => '/', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/SaveToCloudButton', () => ({ default: ({ data, cardType }: { data: unknown; cardType?: string }) => <button data-card-json={JSON.stringify(data)} data-card-type={cardType}>保存到云端</button> }));
vi.mock('@/components/BattleDataModal', () => ({ default: () => null }));
vi.mock('@/components/DataCardDetailsModal', () => ({ default: () => null }));
vi.mock('@/components/GeneralCharacterCard', () => ({ default: ({ general, isStreaming, onStopGeneration }: { general: { content: string; name?: string }; isStreaming?: boolean; onStopGeneration?: () => void }) => <div aria-label="生成正文" data-card-name={general.name} data-streaming={String(Boolean(isStreaming))}>{general.content}{isStreaming && <button onClick={onStopGeneration}>停止生成</button>}</div> }));
vi.mock('@/components/MagicalGirlCard', () => ({ default: ({ magicalGirl }: { magicalGirl: { codename: string } }) => <div aria-label="魔法少女结果">{magicalGirl.codename}</div> }));
vi.mock('@/components/ai/AiReasoningPanel', () => ({ default: ({ reasoning }: { reasoning?: { text?: string } | null }) => reasoning?.text ? <div aria-label="思考内容">{reasoning.text}</div> : null }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: mocks.download }));
vi.mock('@/components/shared/CharacterPortraitAssetPanel', () => ({ CharacterPortraitAssetPanel: ({ prompt }: { prompt: string }) => <div aria-label="立绘提示">{prompt}</div> }));
vi.mock('@/components/AiProviderSelector', () => ({ default: () => null }));
vi.mock('@/components/ai/ProviderCooldownNotice', () => ({ ProviderCooldownNotice: () => null }));
vi.mock('@/components/Footer', () => ({ default: () => null }));
vi.mock('@/lib/auth', () => ({ authStorage: { getActivityHeaders: async () => ({}) } }));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({ useGenerationApiIntentLatch: () => ({ tryAcquire: mocks.acquire }) }));
vi.mock('@/lib/cooldown', () => ({ useProviderModeCooldown: () => ({ isCooldown: false, remainingTime: 0, startCooldown: mocks.startCooldown }) }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: mocks.quickCheck }));
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
const otherQuestionnaire = { ...questionnaire, id: 'other-questionnaire', title: '新问卷', questions: [{ ...questionnaire.questions[0]!, id: 'other-name', question: '新问卷的名字？' }] };
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
  mocks.acquire.mockReset().mockReturnValue({ dispatch: mocks.dispatch });
  mocks.quickCheck.mockReset().mockImplementation(async (text: string) => ({ hasSensitiveWords: false, matchDetails: [], filteredText: text }));
  mocks.routerPush.mockReset();
  mocks.startCooldown.mockReset();
  mocks.download.mockReset();
  mocks.alert.mockReset(); vi.stubGlobal('alert', mocks.alert);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === '/languages.json') return Response.json([{ code: 'zh-CN', name: '简体中文' }]);
    if (url === '/questionnaires/presets/index.json') return Response.json({ presets: [{ id: questionnaire.id, kind: 'magical-girl', title: questionnaire.title, path: '/copy-questionnaire.json', isDefault: true }, { id: otherQuestionnaire.id, kind: 'magical-girl', title: otherQuestionnaire.title, path: '/other-questionnaire.json' }] });
    if (url === '/copy-questionnaire.json') return Response.json(questionnaire);
    if (url === '/other-questionnaire.json') return Response.json(otherQuestionnaire);
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

it('Details local random result does not gain answers from the next questionnaire draft', async () => {
  await act(async () => root.render(<DetailsPage />));
  await click(button('快速随机生成'));
  const original = JSON.parse(button('保存到云端').dataset.cardJson!);
  expect(original.userAnswers).toEqual([]);
  expect(mocks.dispatch).not.toHaveBeenCalled();
  await editAnswer('不属于随机结果的下次回答');
  expect(JSON.parse(button('保存到云端').dataset.cardJson!).userAnswers).toEqual([]);
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

it('Details keeps the submitted fallback name when Markdown starts with a separator', async () => {
  mocks.dispatch.mockResolvedValueOnce(new Response(sse('markdown', { chunk: '---\n\n## 角色介绍\n\n有实际正文' }) + sse('done', { ok: true }), { headers: { 'content-type': 'text/event-stream' } }));
  await generate('Details');
  const original = button('保存到云端').dataset.cardJson;
  const portrait = host.querySelector('[aria-label="立绘提示"]')?.textContent;
  expect(portrait).toContain('复制原件');
  await editAnswer('下次回答');
  expect(button('保存到云端').dataset.cardJson).toBe(original);
  expect(host.querySelector('[aria-label="立绘提示"]')?.textContent).toBe(portrait);
});

async function chooseOtherQuestionnaire() {
  const toggle = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.startsWith('问卷设置'))!;
  await click(toggle);
  const select = [...host.querySelectorAll('select')].find((item) => [...item.options].some((option) => option.value === otherQuestionnaire.id))!;
  expect(select).toBeTruthy();
  await act(async () => { select.value = otherQuestionnaire.id; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.querySelector('textarea.ui-web-questionnaire-answer-input')?.getAttribute('aria-label')).toBe('新问卷的名字？');
}

type SafetyResult = { hasSensitiveWords: boolean; matchDetails: never[]; filteredText: string };
const safetyResult = (text: string, blocked = false): SafetyResult => ({ hasSensitiveWords: blocked, matchDetails: [], filteredText: text });

it('Details random generation does not claim an existing restored questionnaire draft as its source', async () => {
  localStorage.setItem('magicalGirlAnswersDraft', JSON.stringify({ version: 3, answerEntries: [{
    key: `${questionnaire.id}::${questionnaire.questions[0]!.id}`, questionnaireId: questionnaire.id,
    questionId: questionnaire.questions[0]!.id, question: questionnaire.questions[0]!.question, answer: '无关的已有草稿',
  }] }));
  await act(async () => root.render(<DetailsPage />));
  await click(button('快速随机生成'));
  expect(host.querySelector<HTMLTextAreaElement>('textarea.ui-web-questionnaire-answer-input')?.value).toBe('无关的已有草稿');
  expect(JSON.parse(button('保存到云端').dataset.cardJson!).userAnswers).toEqual([]);
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

it.each([
  { label: 'missing', fields: {}, expected: [{ question: questionnaire.questions[0]!.question, answer: '复制原件' }] },
  { label: 'explicit empty', fields: { userAnswers: [] }, expected: [] },
  { label: 'legacy server strings', fields: { userAnswers: ['服务端原回答'] }, expected: [{ question: questionnaire.questions[0]!.question, answer: '服务端原回答' }] },
  { label: 'server-owned questions', fields: { userAnswers: [{ question: '结果原题目', answer: '结果原回答' }] }, expected: [{ question: '结果原题目', answer: '结果原回答' }] },
])('Details preserves $label answer provenance after next draft and questionnaire edits', async ({ fields, expected }) => {
  await prepare('Details'); await click(button('非流式'));
  mocks.dispatch.mockResolvedValueOnce(Response.json({ codename: '服务端角色', ...fields }));
  await click(button('提交'));
  const original = button('保存到云端').dataset.cardJson!;
  expect(JSON.parse(original).userAnswers).toMatchObject(expected);
  expect(JSON.parse(original).userAnswers).toHaveLength(expected.length);
  await editAnswer('下一轮草稿'); await chooseOtherQuestionnaire(); await editAnswer('新问卷草稿');
  expect(button('保存到云端').dataset.cardJson).toBe(original);
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
});

it('Details keeps request fallback identity for a failed partial stream with no parsed name', async () => {
  mocks.dispatch.mockResolvedValueOnce(new Response(sse('markdown', { chunk: '---\n\n已有部分正文' }) + sse('error', { error: '上游测试失败' }), { headers: { 'content-type': 'text/event-stream' } }));
  await prepare('Details'); await click(button('提交'));
  const preview = host.querySelector('[aria-label="生成正文"]')!;
  expect(preview.getAttribute('data-card-name')).toBe('复制原件');
  await editAnswer('下一轮姓名'); await click(button('非流式'));
  expect(host.querySelector('[aria-label="生成正文"]')?.getAttribute('data-card-name')).toBe('复制原件');
  expect(host.querySelector('[aria-label="立绘提示"]')?.textContent).toContain('复制原件');
  expect([...host.querySelectorAll('button')].some((item) => item.textContent === '下载通用角色卡')).toBe(false);
});

it.each(['safety', 'latch', 'check-error', 'empty-answer'] as const)('Details retains the previous result when the next request is refused by %s', async (reason) => {
  await generate('Details');
  const original = button('保存到云端').dataset.cardJson;
  mocks.startCooldown.mockClear(); mocks.acquire.mockClear();
  await editAnswer(reason === 'empty-answer' ? '' : '待检查回答');
  if (reason === 'safety') mocks.quickCheck.mockResolvedValueOnce(safetyResult('待检查回答', true));
  if (reason === 'latch') mocks.acquire.mockReturnValueOnce(null);
  if (reason === 'check-error') mocks.quickCheck.mockRejectedValueOnce(new Error('检查暂不可用'));
  await click(button(reason === 'empty-answer' ? '跳过并提交' : '提交'));
  expect(button('保存到云端').dataset.cardJson).toBe(original);
  expect(host.querySelector('[aria-label="生成正文"]')?.textContent).toBe(markdown);
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  expect(mocks.startCooldown).not.toHaveBeenCalled();
  if (reason !== 'latch') expect(mocks.acquire).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLTextAreaElement>('textarea.ui-web-questionnaire-answer-input')?.value).toBe(reason === 'empty-answer' ? '' : '待检查回答');
  expect(button(reason === 'empty-answer' ? '跳过并提交' : '提交').disabled).toBe(false);
});

it('Details binds one delayed safety check, dispatched body and result fallback to the same request answers', async () => {
  await generate('Details'); await click(button('非流式')); await editAnswer('本次请求回答');
  const original = button('保存到云端').dataset.cardJson;
  let finish!: (result: SafetyResult) => void;
  mocks.quickCheck.mockImplementationOnce(() => new Promise<SafetyResult>((resolve) => { finish = resolve; }));
  mocks.quickCheck.mockClear(); mocks.acquire.mockClear();
  const submit = button('提交');
  await act(async () => { submit.click(); submit.click(); });
  expect(mocks.quickCheck).toHaveBeenCalledExactlyOnceWith('本次请求回答');
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(button('保存到云端').dataset.cardJson).toBe(original);
  expect(host.querySelector('[aria-label="生成正文"]')?.getAttribute('data-streaming')).toBe('false');
  await editAnswer('下一轮未提交回答');
  mocks.dispatch.mockResolvedValueOnce(Response.json({ codename: '本次请求结果' }));
  await act(async () => finish(safetyResult('本次请求回答')));
  expect(mocks.acquire).toHaveBeenCalledTimes(1);
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  const body = JSON.parse(mocks.dispatch.mock.calls[1]![1].body);
  expect(body.answers[0].answer).toBe('本次请求回答');
  expect(JSON.parse(button('保存到云端').dataset.cardJson!).userAnswers[0].answer).toBe('本次请求回答');
  expect(host.querySelector<HTMLTextAreaElement>('textarea.ui-web-questionnaire-answer-input')?.value).toBe('下一轮未提交回答');
});

it.each([false, true])('Details cancels an obsolete questionnaire preflight before a newer one (late blocked: %s)', async (blocked) => {
  await generate('Details'); await editAnswer('旧问卷待检查');
  const original = button('保存到云端').dataset.cardJson;
  let finishOld!: (result: SafetyResult) => void, finishNew!: (result: SafetyResult) => void;
  mocks.quickCheck.mockImplementationOnce(() => new Promise<SafetyResult>((resolve) => { finishOld = resolve; }));
  mocks.acquire.mockClear();
  await click(button('提交'));
  await chooseOtherQuestionnaire();
  expect(button('保存到云端').dataset.cardJson).toBe(original);
  await editAnswer('新问卷本次回答');
  mocks.quickCheck.mockImplementationOnce(() => new Promise<SafetyResult>((resolve) => { finishNew = resolve; }));
  await click(button('提交'));
  await act(async () => finishOld(safetyResult('旧问卷待检查', blocked)));
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  expect(mocks.routerPush).not.toHaveBeenCalled();
  expect(button('提交中...').disabled).toBe(true);
  await act(async () => finishNew(safetyResult('新问卷本次回答')));
  expect(mocks.acquire).toHaveBeenCalledTimes(1);
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  const body = JSON.parse(mocks.dispatch.mock.calls[1]![1].body);
  expect(body.answers[0]).toMatchObject({ answer: '新问卷本次回答', questionnaireId: otherQuestionnaire.id });
  expect(JSON.parse(button('保存到云端').dataset.cardJson!).userAnswers[0]).toMatchObject({ answer: '新问卷本次回答', question: otherQuestionnaire.questions[0]!.question });
});

it.each([false, true])('Details does not dispatch or redirect after leaving during preflight (late blocked: %s)', async (blocked) => {
  await generate('Details'); await editAnswer('离开前的待检回答');
  let finish!: (result: SafetyResult) => void;
  mocks.quickCheck.mockImplementationOnce(() => new Promise<SafetyResult>((resolve) => { finish = resolve; }));
  mocks.acquire.mockClear(); mocks.startCooldown.mockClear();
  await click(button('提交')); await act(async () => root.render(null));
  await act(async () => finish(safetyResult('离开前的待检回答', blocked)));
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  expect(mocks.routerPush).not.toHaveBeenCalled();
  expect(mocks.startCooldown).not.toHaveBeenCalled();
});

it.each([false, true])('Details cancels the old preflight when a different preset starts loading (late blocked: %s)', async (blocked) => {
  await generate('Details'); await editAnswer('旧问卷待检查');
  const original = button('保存到云端').dataset.cardJson;
  let finishCheck!: (result: SafetyResult) => void, finishLoad!: (response: Response) => void;
  mocks.quickCheck.mockImplementationOnce(() => new Promise<SafetyResult>((resolve) => { finishCheck = resolve; }));
  mocks.acquire.mockClear();
  await click(button('提交'));
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => String(input) === '/other-questionnaire.json'
    ? new Promise<Response>((resolve) => { finishLoad = resolve; }) : originalFetch(input, init));
  await click([...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.startsWith('问卷设置'))!);
  const select = [...host.querySelectorAll('select')].find((item) => [...item.options].some((option) => option.value === otherQuestionnaire.id))!;
  await act(async () => { select.value = otherQuestionnaire.id; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => finishCheck(safetyResult('旧问卷待检查', blocked)));
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  expect(mocks.routerPush).not.toHaveBeenCalled();
  expect(button('保存到云端').dataset.cardJson).toBe(original);
  await act(async () => finishLoad(Response.json(otherQuestionnaire)));
  await editAnswer('新问卷本次回答'); await click(button('提交'));
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(mocks.dispatch.mock.calls[1]![1].body).answers[0]).toMatchObject({ answer: '新问卷本次回答', questionnaireId: otherQuestionnaire.id });
});
