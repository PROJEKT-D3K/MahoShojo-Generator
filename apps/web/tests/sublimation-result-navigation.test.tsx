// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  dispatch: vi.fn(),
  stream: vi.fn(),
  safety: vi.fn(),
  download: vi.fn(),
  save: vi.fn(),
  acquire: vi.fn(),
}));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({
  useGenerationApiIntentLatch: () => ({ tryAcquire: mock.acquire }),
}));
vi.mock('@/lib/client-route-adapter', () => ({ useClientRouteAdapter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ isAuthenticated: false }) }));
vi.mock('@/lib/auth', () => ({ authStorage: { getActivityHeaders: async () => ({}) } }));
vi.mock('@/lib/content-safety/client', () => ({ getSensitiveWordRedirectTarget: (...args: unknown[]) => mock.safety(...args) }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: mock.download }));
vi.mock('@/lib/cooldown', () => ({ useProviderModeCooldown: () => ({ isCooldown: false, startCooldown: vi.fn() }) }));
vi.mock('@/lib/stream/read-safe-text-and-reasoning-stream', () => ({
  readSafeTextAndReasoningStreamFromResponse: (...args: unknown[]) => mock.stream(...args),
}));
vi.mock('@/components/MagicalGirlCard', () => ({ default: () => <article>魔法少女结果</article> }));
vi.mock('@/components/CanshouCard', () => ({ default: () => <article>残兽结果</article> }));
vi.mock('@/components/GeneralCharacterCard', () => ({ default: ({ general, isStreaming }: any) => <article data-name={general.name} data-streaming={isStreaming === true}>{general.content}</article> }));
vi.mock('@/components/SaveToCloudButton', () => ({ default: ({ data }: any) => <button onClick={() => mock.save(data)}>保存到云端</button> }));
vi.mock('@/components/Footer', () => ({ default: () => null }));
vi.mock('@/components/BattleDataModal', () => ({ default: () => null }));
vi.mock('@/components/DataCardDetailsModal', () => ({ default: () => null }));
vi.mock('@/components/arena/components/NarrativeHistoryModal', () => ({ NarrativeHistoryModal: () => null }));
vi.mock('@/components/arena/components/NarrativeHistoryPickerModal', () => ({ NarrativeHistoryPickerModal: () => null }));
vi.mock('@/components/AiProviderSelector', () => ({ default: ({ onConfigChange }: any) => <button onClick={() => onConfigChange({ providerId: 'openai', apiKey: '' })}>测试缺失 Key</button> }));
vi.mock('@/components/ai/AiReasoningPanel', () => ({ default: () => null }));
vi.mock('@/components/ai/ProviderCooldownNotice', () => ({ ProviderCooldownNotice: () => null }));
vi.mock('@/components/shared/ThemeImage', () => ({ ThemeImage: () => null }));
vi.mock('@/components/shared/TokenIndicator', () => ({ TokenIndicator: () => null }));

import { SublimationPage } from '@/components/competition/SublimationPage';
import * as sublimationResult from '@/lib/sublimation/stream-result';

let root: Root;
let container: HTMLDivElement;
let streamOptions: any;
let finishStream: (result: any) => void;
const scroll = vi.fn();
const source = { templateId: '通用角色', name: '原角色', content: '原卡正文' };
const click = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(label));
  expect(button).toBeTruthy();
  await act(async () => button!.click());
};
const mountAndImport = async (stream = false) => {
  localStorage.setItem('mahoshojo.sublimation.preferences.v1', JSON.stringify({
    generationMode: stream ? 'stream' : 'non-stream', targetTemplate: 'general',
  }));
  await act(async () => root.render(<SublimationPage />));
  const input = container.querySelector('#character-upload')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [{ type: 'application/json', name: 'source.json', text: async () => JSON.stringify(source) }] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  expect(scroll).not.toHaveBeenCalled();
};
beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-motion');
  scroll.mockClear();
  mock.safety.mockResolvedValue(null);
  mock.acquire.mockImplementation(() => ({ dispatch: mock.dispatch }));
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: innerHeight + 300 } as DOMRect);
  Element.prototype.scrollIntoView = scroll;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url === '/languages.json' ? [] : url === '/api/verify-origin' ? { isNative: false } : { presets: [] },
  ), { headers: { 'content-type': 'application/json' } })));
  mock.dispatch.mockImplementation(async () => new Response(JSON.stringify({ targetTemplate: 'general', sublimatedData: { ...source, content: '升华正文' } }), { headers: { 'content-type': 'application/json' } }));
  mock.stream.mockImplementation((_response, options) => {
    streamOptions = options;
    return new Promise((resolve) => { finishStream = resolve; });
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
});

describe('成长升华结果导航（真实页面）', () => {
  it('恢复偏好和导入原卡不滚；非流式结果每次请求只滚一次', async () => {
    await mountAndImport();
    await click('开始升华');
    expect(mock.dispatch).toHaveBeenCalledWith('/api/generate-sublimation', expect.any(Object));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(container.querySelector('article')?.textContent).toBe('升华正文');
    await click('开始升华');
    expect(scroll).toHaveBeenCalledTimes(2);
  });
  it('流式空占位和推理不滚，首段正文滚一次，后续和最终卡不重复滚', async () => {
    await mountAndImport(true);
    mock.dispatch.mockResolvedValue(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
    await click('开始升华');
    await act(async () => { streamOptions.onText('  '); streamOptions.onReasoning({ status: 'streaming', content: '推理' }); });
    expect(scroll).not.toHaveBeenCalled();
    await act(async () => streamOptions.onText('首段正文'));
    expect(scroll).toHaveBeenCalledTimes(1);
    await act(async () => streamOptions.onText('首段正文和后续'));
    await act(async () => finishStream({ text: '首段正文和后续', outputSafetyStatus: 'safe', wasAborted: false }));
    expect(scroll).toHaveBeenCalledTimes(1);
  });
  it('停止后迟到正文不定位', async () => {
    await mountAndImport(true);
    mock.dispatch.mockResolvedValue(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
    await click('开始升华');
    await click('停止');
    expect(streamOptions.abortController.signal.aborted).toBe(true);
    await act(async () => streamOptions.onText('迟到正文'));
    await act(async () => finishStream({ text: '迟到正文', outputSafetyStatus: 'safe', wasAborted: true }));
    expect(scroll).not.toHaveBeenCalled();
  });
  it('失败请求不定位', async () => {
    await mountAndImport();
    mock.dispatch.mockResolvedValue(new Response(JSON.stringify({ error: '生成失败' }), { status: 500 }));
    await click('开始升华');
    expect(scroll).not.toHaveBeenCalled();
  });
  it('结果已经可见时不打断用户', async () => {
    await mountAndImport();
    vi.mocked(Element.prototype.getBoundingClientRect).mockReturnValue({ top: innerHeight - 20 } as DOMRect);
    await click('开始升华');
    expect(scroll).not.toHaveBeenCalled();
  });
  it('减少动效时用瞬时定位', async () => {
    await mountAndImport();
    document.documentElement.setAttribute('data-motion', 'reduce');
    await click('开始升华');
    expect(scroll).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  });
  it('设备关闭自动定位时不滚', async () => {
    await mountAndImport();
    localStorage.setItem('mahoshojo.result-auto-scroll', 'off');
    await click('开始升华');
    expect(scroll).not.toHaveBeenCalled();
  });

  it.each(['upload', 'paste', 'restored'] as const)('%s 来源不能借自报 nativeAllowed 获得原生许可或流式重签名', async (method) => {
    const questionnaire = {
      id: 'local-lore', kind: 'magical-girl', title: '本地星海设定',
      loreMarkdown: '星海中的守护者', nativeAllowed: true, questions: [],
    };
    const buildResult = vi.spyOn(sublimationResult, 'buildStreamedSublimationResultCard');
    vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(
      url === '/languages.json' ? [] : url === '/api/verify-origin' ? { isValid: true } : { presets: [] },
    ), { headers: { 'content-type': 'application/json' } }));
    localStorage.setItem('mahoshojo.sublimation.preferences.v1', JSON.stringify({
      generationMode: 'stream', targetTemplate: 'general', showQuestionnaireSettings: true,
      questionnaireSelections: method === 'restored' ? [{ source: 'upload', questionnaire }] : [],
    }));
    await act(async () => root.render(<SublimationPage />));
    const sourceInput = container.querySelector('#character-upload')!;
    Object.defineProperty(sourceInput, 'files', { value: [{ type: 'application/json', name: 'source.json', text: async () => JSON.stringify(source) }] });
    await act(async () => sourceInput.dispatchEvent(new Event('change', { bubbles: true })));

    if (method === 'upload') {
      const upload = [...container.querySelectorAll<HTMLInputElement>('input[type="file"]')].find((input) => input.closest('label')?.textContent?.includes('上传问卷 JSON'))!;
      Object.defineProperty(upload, 'files', { value: [{ type: 'application/json', name: 'lore.json', text: async () => JSON.stringify(questionnaire) }] });
      await act(async () => upload.dispatchEvent(new Event('change', { bubbles: true })));
    } else if (method === 'paste') {
      await click('粘贴导入 JSON');
      const textarea = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="在此粘贴问卷 JSON（可包含 loreMarkdown）"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, JSON.stringify(questionnaire));
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await click('解析并载入');
    }

    expect(container.textContent).toContain('来源：本地上传 · 非原生');
    expect(container.textContent).toContain('已注入非原生许可的问卷设定');
    const saved = JSON.parse(localStorage.getItem('mahoshojo.sublimation.preferences.v1')!);
    expect(saved.questionnaireSelections[0].questionnaire.nativeAllowed).toBe(method === 'restored');
    mock.dispatch.mockResolvedValue(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
    await click('开始升华');
    const sentBody = JSON.parse(mock.dispatch.mock.calls.at(-1)![1].body);
    expect(sentBody.questionnaireSelections).toEqual([{ source: 'upload', kind: 'magical-girl' }]);
    await act(async () => finishStream({ text: '## 星海新生\n升华正文', outputSafetyStatus: 'safe', wasAborted: false }));
    expect(buildResult).toHaveBeenLastCalledWith(expect.objectContaining({
      isNative: true, hasQuestionnaireLore: true, hasNonNativeQuestionnaireLore: true,
    }));
    expect(buildResult.mock.results.at(-1)?.value.arena_history.entries[0].metadata.non_native_data_involved).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/resign-data')).toBe(false);
    expect(container.textContent).toContain('衍生数据');
  });
});

it('restores settings changes through actual Sublimation owner effects and preserves both owner extensions', async () => {
  const { createPagePreferencesAdapter } = await import('@mahoshojo/ui-web/settings');
  const { WEB_SUBLIMATION_PREFERENCES, WEB_SUBLIMATION_STATE_PREFERENCES } = await import('@/lib/settings/page-preferences');
  localStorage.setItem('mahoshojo.sublimation.preferences.v1', JSON.stringify({ userGuidance: '保留指导语', fieldsToPreserve: [], questionnaireSelections: [], extension: 'general-owner' }));
  localStorage.setItem('sublimation-history-state-preferences-v1', JSON.stringify({ extension: 'strategy-owner' }));
  const advanced = createPagePreferencesAdapter(WEB_SUBLIMATION_PREFERENCES, localStorage);
  const state = createPagePreferencesAdapter(WEB_SUBLIMATION_STATE_PREFERENCES, localStorage);
  expect(advanced.writeField('isAdvancedVisible', true)).toBe(true);
  expect(state.writeField('readArenaHistory', false)).toBe(true);
  expect(state.writeField('arenaHistoryRetentionStrategy', 'reset-all')).toBe(true);
  await act(async () => root.render(<SublimationPage />));
  expect(JSON.parse(localStorage.getItem('mahoshojo.sublimation.preferences.v1')!)).toMatchObject({ isAdvancedVisible: true, userGuidance: '保留指导语', extension: 'general-owner' });
  expect(JSON.parse(localStorage.getItem('sublimation-history-state-preferences-v1')!)).toMatchObject({ readArenaHistory: false, arenaHistoryRetentionStrategy: 'reset-all', extension: 'strategy-owner' });
  await act(async () => root.render(null));
  expect(advanced.reset()).toBe(true); expect(state.reset()).toBe(true);
  await act(async () => root.render(<SublimationPage />));
  expect(advanced.read()).toMatchObject({ status: 'ready', values: { isAdvancedVisible: false } });
  expect(state.read()).toMatchObject({ status: 'ready', values: { readArenaHistory: true, writeArenaHistory: true, readCurrentState: true, writeCurrentState: true, arenaHistoryRetentionStrategy: 'keep-sublimation-only' } });
  expect(JSON.parse(localStorage.getItem('mahoshojo.sublimation.preferences.v1')!)).toMatchObject({ userGuidance: '保留指导语', extension: 'general-owner' });
});


const changeMode = async (label: '流式' | '非流式') => {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
};
const changeTarget = async (value: string) => {
  const select = container.querySelector<HTMLSelectElement>('#sublimation-target')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const readBlob = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob);
});
const finishCompletedStream = async (markdown = '流式正文') => {
  await mountAndImport(true);
  mock.dispatch.mockResolvedValue(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
  await click('开始升华');
  await act(async () => { streamOptions.onText(markdown); finishStream({ text: markdown, outputSafetyStatus: 'safe', wasAborted: false }); });
};

describe('升华当前结果与下次生成选项分离（真实页面）', () => {
  it.each([true, false])('非流式结果（响应目标模板 %s）切换方式与目标后保留原卡预览、原生性和原件出口', async (hasResponseTemplate) => {
    const card = { ...source, content: '已完成的结构化结果', signature: 'server-signature', extension: { keep: true } };
    mock.dispatch.mockResolvedValue(Response.json({ ...(hasResponseTemplate ? { targetTemplate: 'general' } : {}), sublimatedData: card, unchangedFields: ['name'] }));
    await mountAndImport(); await click('开始升华');
    await changeMode('流式'); await changeTarget('magical-girl');
    expect(container.querySelector('article')?.textContent).toBe(card.content);
    expect(container.textContent).toContain('升华成功！结果已显示');
    expect(container.textContent).toContain('原生数据');
    expect(container.textContent).toContain('升华报告');
    await click('下载新设定');
    expect(JSON.parse(await readBlob(mock.download.mock.calls.at(-1)![0]))).toEqual(card);
    await click('保存到云端'); expect(mock.save).toHaveBeenLastCalledWith(card);
    expect(mock.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['upload', 'paste'] as const)('%s 新来源只改下次输入，保留已完成结构化卡及原件出口', async (method) => {
    await mountAndImport(); await click('开始升华');
    const next = { ...source, name: '新的输入角色', content: '新的输入正文' };
    if (method === 'upload') {
      const input = container.querySelector('#character-upload')!;
      Object.defineProperty(input, 'files', { configurable: true, value: [{ type: 'application/json', name: 'next.json', text: async () => JSON.stringify(next) }] });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    } else {
      await click('展开文本粘贴区域');
      const textarea = container.querySelector<HTMLTextAreaElement>('#source-json')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, JSON.stringify(next));
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await click('从文本加载设定');
    }
    expect(container.querySelector('article')?.textContent).toBe('升华正文');
    await click('保存到云端');
    expect(mock.save).toHaveBeenLastCalledWith({ ...source, content: '升华正文' });
    await click('下载新设定');
    expect(mock.dispatch).toHaveBeenCalledTimes(1);
    await click('开始升华');
    expect(JSON.parse(mock.dispatch.mock.calls.at(-1)![1].body)).toMatchObject(next);
  });

  it('已完成流式卡切换方式和来源后保持冻结名称、历史及签名出口', async () => {
    const markdown = '---\n\n流式正文'; // 首行装饰符不产生名称，实际走原卡名称回退。
    vi.mocked(fetch).mockImplementation(async (url) => Response.json(url === '/api/verify-origin' ? { isValid: true } : url === '/api/resign-data' ? { ...source, content: markdown, signature: 'signed-result', arena_history: { retained: true } } : []));
    await finishCompletedStream(markdown);
    const saved = [...container.querySelectorAll('button')].find(node => node.textContent === '保存到云端')!;
    await act(async () => saved.click());
    const card = mock.save.mock.calls.at(-1)![0];
    expect(card.signature).toBe('signed-result');
    await changeMode('非流式');
    const input = container.querySelector('#character-upload')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [{ type: 'application/json', name: 'other.json', text: async () => JSON.stringify({ ...source, name: '另一位角色' }) }] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(container.querySelector('article')?.getAttribute('data-name')).toBe('原角色');
    expect(container.querySelector('article')?.textContent).toBe(markdown);
    expect(container.textContent).toContain('原生数据');
    await click('下载通用角色卡'); expect(JSON.parse(await readBlob(mock.download.mock.calls.at(-1)![0]))).toEqual(card);
    await click('保存到云端'); expect(mock.save).toHaveBeenLastCalledWith(card);
    expect(mock.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['aborted', 'blocked'] as const)('%s 流式内容切换后仍带未完成提示，按既有规则可保存但不报成功或重签名', async (kind) => {
    await mountAndImport(true);
    mock.dispatch.mockResolvedValue(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
    await click('开始升华');
    await act(async () => { streamOptions.onText('未完成正文'); finishStream({ text: '未完成正文', outputSafetyStatus: kind === 'blocked' ? 'blocked' : 'safe', wasAborted: kind === 'aborted', abortReason: 'user' }); });
    await changeMode('非流式');
    expect(container.querySelector('article')?.textContent).toBe('未完成正文');
    expect(container.textContent).toContain('当前内容可能不完整');
    expect(container.textContent).not.toContain('🎉 升华成功');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/resign-data')).toBe(false);
    await click('下载通用角色卡'); await click('保存到云端');
    expect(mock.save.mock.calls.at(-1)![0]).not.toHaveProperty('signature');
  });

  it('流式失败保留部分正文且切换后不出现完成卡保存或成功提示', async () => {
    await mountAndImport(true);
    mock.dispatch.mockResolvedValue(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
    mock.stream.mockImplementation(async (_response, options) => { options.onText('失败前的正文'); throw new Error('stream disconnected'); });
    await click('开始升华'); await changeMode('非流式');
    expect(container.querySelector('article')?.textContent).toBe('失败前的正文');
    expect(container.querySelector('article')?.getAttribute('data-streaming')).toBe('false');
    expect(container.textContent).toContain('升华失败');
    expect(container.textContent).not.toContain('🎉 升华成功');
    expect(container.textContent).not.toContain('下载通用角色卡');
    expect(container.textContent).not.toContain('保存到云端');
  });

  it.each(['safety', 'redirect', 'latch', 'key'] as const)('%s 拒绝下次请求时不替换原结果或改成生成中', async (reason) => {
    await finishCompletedStream(); await changeMode('非流式');
    if (reason === 'safety') mock.safety.mockRejectedValueOnce(new Error('预检不可用'));
    if (reason === 'redirect') mock.safety.mockResolvedValueOnce('/arrested');
    if (reason === 'latch') mock.acquire.mockReturnValueOnce(null);
    if (reason === 'key') await click('测试缺失 Key');
    await click('开始升华');
    expect(container.querySelector('article')?.textContent).toBe('流式正文');
    expect(container.querySelector('article')?.getAttribute('data-streaming')).toBe('false');
    await click('下载通用角色卡'); await click('保存到云端');
    expect(mock.dispatch).toHaveBeenCalledTimes(1);
  });

  it('下一次流式请求预检拒绝保留结构化结果，新派发失败不会恢复旧成功结果', async () => {
    await mountAndImport(); await click('开始升华'); await changeMode('流式');
    mock.safety.mockRejectedValueOnce(new Error('预检不可用'));
    await click('开始升华');
    expect(container.querySelector('article')?.textContent).toBe('升华正文');
    await click('下载新设定');
    mock.dispatch.mockResolvedValueOnce(Response.json({ error: '新请求失败' }, { status: 500 }));
    await click('开始升华');
    expect(mock.dispatch.mock.calls.at(-1)![0]).toBe('/api/generate-sublimation-stream?format=sse');
    expect(container.querySelector('article')).toBeNull();
    expect(container.textContent).not.toContain('下载新设定');
    expect(container.textContent).not.toContain('🎉 升华成功');
    expect(container.textContent).toContain('新请求失败');
  });

  it('下次预检等待时旧卡不冒充流式生成，新请求派发后再替换', async () => {
    await finishCompletedStream(); await changeMode('非流式');
    let releaseCheck!: (value: null) => void;
    mock.safety.mockImplementationOnce(() => new Promise(resolve => { releaseCheck = resolve; }));
    let releaseResponse!: (value: Response) => void;
    mock.dispatch.mockImplementationOnce(() => new Promise(resolve => { releaseResponse = resolve; }));
    await click('开始升华');
    expect(container.querySelector('article')?.textContent).toBe('流式正文');
    expect(container.querySelector('article')?.getAttribute('data-streaming')).toBe('false');
    expect(mock.dispatch).toHaveBeenCalledTimes(1);
    await act(async () => releaseCheck(null));
    expect(mock.dispatch).toHaveBeenCalledTimes(2);
    expect(mock.dispatch.mock.calls.at(-1)![0]).toBe('/api/generate-sublimation');
    expect(container.querySelector('article')).toBeNull();
    expect(container.textContent).not.toContain('下载通用角色卡');
    await act(async () => releaseResponse(Response.json({ targetTemplate: 'general', sublimatedData: { ...source, content: '下一次结果' } })));
    expect(container.querySelector('article')?.textContent).toBe('下一次结果');
    expect(container.textContent).toContain('下载新设定');
  });
});
