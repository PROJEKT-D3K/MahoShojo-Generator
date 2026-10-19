// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canshouQuestionnaire, magicalQuestionnaire } from '@/lib/questionnaire-presets';
import { ClientRouteAdapterProvider } from '@/lib/client-route-adapter';

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
const defaultQuestionnaireCards = [
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
let questionnaireCards: Array<(typeof defaultQuestionnaireCards)[number] & { storageLocation?: string }> = [];
const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
  const url = typeof input === 'string' ? input : (input as Request).url;
  if (url.endsWith('/languages.json')) return jsonResponse([{ code: 'zh-CN', name: '简体中文' }]);
  if (url === '/questionnaires/presets/index.json') return jsonResponse({ presets: [{
    id: magicalQuestionnaire.id,
    kind: 'magical-girl',
    title: magicalQuestionnaire.title,
    path: '/questionnaires/presets/magical-girl-default.json',
    isDefault: true,
  }, {
    id: canshouQuestionnaire.id, kind: 'canshou', title: canshouQuestionnaire.title,
    path: '/questionnaires/presets/canshou-default.json', isDefault: true,
  }] });
  if (url === '/questionnaires/presets/magical-girl-default.json') return jsonResponse(magicalQuestionnaire);
  if (url === '/questionnaires/presets/canshou-default.json') return jsonResponse(canshouQuestionnaire);
  if (url === '/api/auth/verify') return jsonResponse({ success: false });
  if (url === '/api/ai/channel-availability') return jsonResponse({ entries: [] });
  if (url.startsWith('/api/public-data-cards?')) {
    const id = new URL(url, 'https://example.test').searchParams.get('id');
    if (id) return jsonResponse({ success: true, card: questionnaireCards.find((card) => card.id === id) });
    return jsonResponse({
      success: true,
      cards: questionnaireCards.map(({ data: _data, storageLocation: _storageLocation, ...summary }) => summary),
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
  questionnaireCards = [...defaultQuestionnaireCards];
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


describe('Web DetailsPage 卡库许可投影', () => {
  it.each([
    { wrapper: true, outer: false, inner: true, location: 'cloud', expected: false },
    { wrapper: true, outer: undefined, inner: true, location: 'cloud', expected: false },
    { wrapper: true, outer: true, inner: false, location: 'cloud', expected: true },
    { wrapper: true, outer: true, inner: undefined, location: 'cloud', expected: true },
    { wrapper: false, outer: true, inner: undefined, location: 'cloud', expected: true },
    { wrapper: false, outer: false, inner: undefined, location: 'cloud', expected: false },
    { wrapper: true, outer: true, inner: true, location: 'local', expected: false },
    { wrapper: true, outer: true, inner: true, location: 'cache', expected: false },
  ])('包装=$wrapper 外层=$outer 内层=$inner 来源=$location → 许可=$expected', async ({ wrapper, outer, inner, location, expected }) => {
    const questionnaire = {
      id: 'inner-questionnaire-id', kind: 'magical-girl', title: '问卷正文标题',
      nativeAllowed: inner, questions: [{ id: 'single', question: '许可矩阵问题', type: 'text' }],
    };
    const payload = wrapper ? { nativeAllowed: outer, questionnaire } : { ...questionnaire, nativeAllowed: outer };
    questionnaireCards = [{
      ...defaultQuestionnaireCards[1]!, id: 'outer-card-id', name: '外层卡名',
      data: JSON.stringify(payload), storageLocation: location,
    }];
    const { DetailsPage } = await import('@/components/creation/DetailsPage');
    await act(async () => root.render(<DetailsPage />));
    const click = async (label: string) => {
      const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(label));
      expect(button, label).toBeTruthy();
      await act(async () => button!.click());
    };
    await click('开始回答问卷');
    await click('问卷设置');
    await import('@/components/BattleDataModalContent');
    await click('从云端问卷库选择');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const select = document.querySelector<HTMLElement>('[aria-label="选择外层卡名"]');
    expect(select).toBeTruthy();
    await act(async () => select!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const stored = JSON.parse(localStorage.getItem('mahoshojo.details.preferences.v1')!);
    expect(stored.questionnaireSelections).toEqual([expect.objectContaining({
      source: location === 'cloud' ? 'database' : 'upload',
      dataCardName: '外层卡名', dataCardAuthor: '问卷作者',
      questionnaire: expect.objectContaining({ id: 'inner-questionnaire-id', title: '问卷正文标题', nativeAllowed: expected }),
    })]);
    expect(stored.questionnaireSelections[0].dataCardId).toBe(location === 'cloud' ? 'outer-card-id' : undefined);
    await click('问卷设置');
    expect(container.textContent?.includes('提示：当前问卷未获得原生许可')).toBe(!expected);
    expect(container.querySelector('textarea.ui-web-questionnaire-answer-input')?.getAttribute('aria-label')).toBe('许可矩阵问题');
    expect(questionnaireCards[0]!.data).toBe(JSON.stringify(payload));
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/generate-'))).toBe(false);
  });
});


// 复用上述真实卡库/mapper fixture，验证其余宿主同样消费共享许可投影与失败协议。
describe('Web 其余问卷卡库 consumer', () => {
  it.each(['canshou', 'creator', 'sublimation', 'arena'] as const)('%s 保留解析失败弹窗，并按外层许可/来源元数据接收兼容包装', async (page) => {
    const prefsKey = page === 'canshou' ? 'mahoshojo.canshou.preferences.v1'
      : page === 'sublimation' ? 'mahoshojo.sublimation.preferences.v1' : 'mahoshojo.details.preferences.v1';
    localStorage.setItem(prefsKey, JSON.stringify({ showQuestionnaireSettings: true }));
    const kind = page === 'canshou' ? 'canshou' : 'magical-girl';
    const inner = {
      id: 'consumer-inner-id', kind, title: '兼容包装问卷', nativeAllowed: true,
      loreMarkdown: '供宿主选择的参考设定', questions: [{ id: 'single', question: '兼容包装问题', type: 'text' }],
    };
    questionnaireCards = [defaultQuestionnaireCards[0]!, {
      ...defaultQuestionnaireCards[1]!, id: 'consumer-outer-id', name: '外层卡库名称',
      data: JSON.stringify({ nativeAllowed: false, questionnaire: inner }),
    }];
    const { useBattleStore } = await import('@/components/arena/stores/useBattleStore');
    useBattleStore.setState(useBattleStore.getInitialState(), true);
    const Component = page === 'canshou' ? (await import('@/components/creation/CanshouPage')).CanshouPage
      : page === 'creator' ? (await import('@/components/creation/CreatorPage')).CreatorPage
      : page === 'sublimation' ? (await import('@/components/competition/SublimationPage')).SublimationPage
      : (await import('@/components/arena/components/QuestionnaireLorePanel')).QuestionnaireLorePanel;
    await act(async () => root.render(
      <ClientRouteAdapterProvider adapter={{ isReady: true, query: {}, push: async () => {}, replace: async () => {} }}>
        <Component />
      </ClientRouteAdapterProvider>,
    ));
    const click = async (label: string) => {
      const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(label));
      expect(button, label).toBeTruthy();
      await act(async () => button!.click());
    };
    if (page === 'canshou') await click('开始调查');
    if (page === 'creator') await click('开始回答问卷');
    await import('@/components/BattleDataModalContent');
    await click(page === 'arena' ? '选择云端问卷' : '从云端问卷库选择');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const choose = async (name: string) => {
      const button = document.querySelector<HTMLElement>(`[aria-label="选择${name}"]`);
      expect(button, name).toBeTruthy();
      await act(async () => button!.click());
    };
    await choose('无内容问卷');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('问卷数据卡解析失败');
    expect(fetchMock.mock.calls.filter(([input]) => input === '/api/data-card-stats')).toHaveLength(0);
    await choose('外层卡库名称');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const selections = page === 'arena' ? useBattleStore.getState().selectedQuestionnaires
      : JSON.parse(localStorage.getItem(prefsKey)!).questionnaireSelections;
    expect(selections).toEqual([expect.objectContaining({
      source: 'database', dataCardId: 'consumer-outer-id', dataCardName: '外层卡库名称', dataCardAuthor: '问卷作者',
      questionnaire: expect.objectContaining({ id: 'consumer-inner-id', kind, nativeAllowed: false, loreMarkdown: inner.loreMarkdown }),
    })]);
    expect(fetchMock.mock.calls.filter(([input]) => input === '/api/data-card-stats')).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/generate-'))).toBe(false);
  });
});
