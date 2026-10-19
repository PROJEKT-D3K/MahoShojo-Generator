// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { magicalQuestionnaire } from '@/lib/questionnaire-presets';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/details',
  useSearchParams: () => new URLSearchParams(),
}));

// 保留页面、卡库宿主与共享选择器，只隔离网络、云端保存和嵌套详情。
vi.mock('@/components/SaveToCloudButton', () => ({ default: () => null }));
vi.mock('@/components/DataCardDetailsModal', () => ({ default: () => null }));

let container: HTMLDivElement;
let root: Root;
const jsonResponse = (data: unknown) => new Response(JSON.stringify(data), {
  headers: { 'Content-Type': 'application/json' },
});
const questionnaireCards = [
  { id: 'invalid-questionnaire', name: '无内容问卷', data: {
    id: 'empty', kind: 'magical-girl', title: '无内容问卷', questions: [],
  } },
  { id: 'valid-questionnaire', name: '可用问卷', data: {
    ...magicalQuestionnaire, title: '可用问卷',
  } },
].map((card) => ({
  ...card, type: 'questionnaire', description: '', is_public: 1, username: '问卷作者',
  data: JSON.stringify(card.data),
}));
const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
  const url = typeof input === 'string' ? input : (input as Request).url;
  if (url.endsWith('/languages.json')) return jsonResponse([{ code: 'zh-CN', name: '简体中文' }]);
  if (url === '/questionnaires/presets/index.json') return jsonResponse({ presets: [{
    id: magicalQuestionnaire.id,
    kind: 'magical-girl',
    title: magicalQuestionnaire.title,
    path: '/questionnaires/presets/magical-girl-default.json',
    isDefault: true,
  }] });
  if (url === '/questionnaires/presets/magical-girl-default.json') return jsonResponse(magicalQuestionnaire);
  if (url === '/api/auth/verify') return jsonResponse({ success: false });
  if (url === '/api/ai/channel-availability') return jsonResponse({ entries: [] });
  if (url.startsWith('/api/public-data-cards?')) {
    const id = new URL(url, 'https://example.test').searchParams.get('id');
    if (id) return jsonResponse({ success: true, card: questionnaireCards.find((card) => card.id === id) });
    return jsonResponse({
      success: true,
      cards: questionnaireCards.map(({ data: _data, ...summary }) => summary),
      total: questionnaireCards.length,
    });
  }
  if (url === '/api/tags?includeInactive=1') return jsonResponse({ success: true, tags: [] });
  if (url === '/api/data-card-meta-batch') return jsonResponse({
    success: true, items: Object.fromEntries(questionnaireCards.map((card) => [card.id, { metrics: null, strict: null }])),
  });
  if (url === '/api/data-card-stats') return jsonResponse({ success: true });
  throw new Error(`unexpected fetch: ${url}`);
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Web DetailsPage 常驻品牌（真实共享控件）', () => {
  it.each([false, true])('开始答题后保留品牌，已有草稿：%s', async (withDraft) => {
    if (withDraft) {
      const firstQuestion = magicalQuestionnaire.questions[0]!;
      window.localStorage.setItem('magicalGirlAnswersDraft', JSON.stringify({
        version: 3,
        answerEntries: [{
          key: `${magicalQuestionnaire.id}::${firstQuestion.id}`,
          question: firstQuestion.question,
          questionId: firstQuestion.id,
          questionnaireId: magicalQuestionnaire.id,
          answer: '保留草稿回答',
        }],
      }));
    }
    const { DetailsPage } = await import('@/components/creation/DetailsPage');
    await act(async () => root.render(<DetailsPage />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)); });
    const logo = container.querySelector('img[alt="Questionnaire Logo"]');
    expect(logo).toBeTruthy();
    expect(logo?.closest('.card')?.firstElementChild?.contains(logo)).toBe(true);
    expect(container.querySelector('h1')?.textContent).toBe('魔法少女问卷生成');
    const start = [...container.querySelectorAll('button')].find((button) => button.textContent === '开始回答问卷');
    expect(start).toBeTruthy();
    await act(async () => start!.click());
    expect(container.querySelector('img[alt="Questionnaire Logo"]')).toBe(logo);
    expect(container.querySelectorAll('img[alt="Questionnaire Logo"]')).toHaveLength(1);
    expect(container.querySelector('textarea.ui-web-questionnaire-answer-input')?.getAttribute('aria-label')).toBe(magicalQuestionnaire.questions[0]!.question);
    const actions = container.querySelector('[aria-label="问卷翻页操作"]');
    expect(actions?.className).toBe('ui-web-questionnaire-navigation');
    expect(actions?.querySelectorAll('.ui-web-questionnaire-step-button')).toHaveLength(2);
    expect(actions?.querySelectorAll('button')[1].textContent).toBe(withDraft ? '下一题' : '跳过并继续');
    expect(container.querySelector<HTMLTextAreaElement>('textarea.ui-web-questionnaire-answer-input')?.value).toBe(withDraft ? '保留草稿回答' : '');
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/generate-'))).toBe(false);
  });
});

describe('Web DetailsPage 真实问卷卡库接线', () => {
  it('拒绝坏问卷后保留弹窗、错误和回答；后续合法选择才关闭并计使用', async () => {
    const firstQuestion = magicalQuestionnaire.questions[0]!;
    window.localStorage.setItem('magicalGirlAnswersDraft', JSON.stringify({
      version: 3,
      answerEntries: [{
        key: `${magicalQuestionnaire.id}::${firstQuestion.id}`,
        question: firstQuestion.question,
        questionId: firstQuestion.id,
        questionnaireId: magicalQuestionnaire.id,
        answer: '选择失败不能丢失的回答',
      }],
    }));
    const { DetailsPage } = await import('@/components/creation/DetailsPage');
    await act(async () => root.render(<DetailsPage />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)); });
    const clickButton = async (label: string) => {
      const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(label));
      expect(button, label).toBeTruthy();
      await act(async () => button!.click());
    };
    await clickButton('开始回答问卷');
    await clickButton('问卷设置');
    // 预热真实延迟模块，避免本用例的业务断言依赖首次转译耗时。
    await import('@/components/BattleDataModalContent');
    await clickButton('从云端问卷库选择');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.querySelector('[aria-label="选择无内容问卷"]')).toBeTruthy();

    const answer = () => container.querySelector<HTMLTextAreaElement>('textarea.ui-web-questionnaire-answer-input');
    const statCalls = () => fetchMock.mock.calls.filter(([input]) => input === '/api/data-card-stats');
    const originalDraft = window.localStorage.getItem('magicalGirlAnswersDraft');
    expect(answer()?.value).toBe('选择失败不能丢失的回答');
    await act(async () => (document.querySelector('[aria-label="选择无内容问卷"]') as HTMLElement).click());

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain('问卷数据卡解析失败');
    expect(answer()?.getAttribute('aria-label')).toBe(firstQuestion.question);
    expect(answer()?.value).toBe('选择失败不能丢失的回答');
    expect(window.localStorage.getItem('magicalGirlAnswersDraft')).toBe(originalDraft);
    expect(statCalls()).toHaveLength(0);

    await act(async () => (document.querySelector('[aria-label="选择可用问卷"]') as HTMLElement).click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain('问卷数据卡解析失败');
    await clickButton('问卷设置');
    expect(container.textContent).toContain('可用问卷');
    expect(statCalls()).toHaveLength(1);
    expect(JSON.parse(String(statCalls()[0]![1]?.body))).toEqual({ cardId: 'valid-questionnaire', type: 'usage' });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/generate-'))).toBe(false);
  });
});
