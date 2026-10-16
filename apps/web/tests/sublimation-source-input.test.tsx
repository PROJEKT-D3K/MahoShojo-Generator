// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ dispatch: vi.fn(), stream: vi.fn() }));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({
  useGenerationApiIntentLatch: () => ({ tryAcquire: () => ({ dispatch: mock.dispatch }) }),
}));
vi.mock('@/lib/client-route-adapter', () => ({ useClientRouteAdapter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ isAuthenticated: false }) }));
vi.mock('@/lib/auth', () => ({ authStorage: { getActivityHeaders: async () => ({}) } }));
vi.mock('@/lib/content-safety/client', () => ({ getSensitiveWordRedirectTarget: async () => null }));
vi.mock('@/lib/cooldown', () => ({ useProviderModeCooldown: () => ({ isCooldown: false, startCooldown: vi.fn() }) }));
vi.mock('@/lib/stream/read-safe-text-and-reasoning-stream', () => ({
  readSafeTextAndReasoningStreamFromResponse: (...args: unknown[]) => mock.stream(...args),
}));
vi.mock('@/components/MagicalGirlCard', () => ({ default: () => null }));
vi.mock('@/components/CanshouCard', () => ({ default: () => null }));
vi.mock('@/components/GeneralCharacterCard', () => ({ default: () => null }));
vi.mock('@/components/SaveToCloudButton', () => ({ default: () => null }));
vi.mock('@/components/Footer', () => ({ default: () => null }));
vi.mock('@/components/BattleDataModal', () => ({ default: () => null }));
vi.mock('@/components/DataCardDetailsModal', () => ({ default: () => null }));
vi.mock('@/components/arena/components/NarrativeHistoryModal', () => ({ NarrativeHistoryModal: () => null }));
vi.mock('@/components/arena/components/NarrativeHistoryPickerModal', () => ({ NarrativeHistoryPickerModal: () => null }));
vi.mock('@/components/AiProviderSelector', () => ({ default: () => null }));
vi.mock('@/components/ai/AiReasoningPanel', () => ({ default: () => null }));
vi.mock('@/components/ai/ProviderCooldownNotice', () => ({ ProviderCooldownNotice: () => null }));
vi.mock('@/components/shared/ThemeImage', () => ({ ThemeImage: () => null }));
vi.mock('@/components/shared/TokenIndicator', () => ({ TokenIndicator: () => null }));

import { SublimationPage } from '@/components/competition/SublimationPage';

const source = {
  templateId: '通用角色', name: '原角色', content: '原卡正文',
  _custom: { note: '保留源卡自定义字段', values: [1, '二'] },
  futureExtension: { enabled: true },
};
let root: Root;
let container: HTMLDivElement;
let finishStream: (result: { text: string; outputSafetyStatus: string; wasAborted: boolean }) => void;

const button = (text: string) => {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(text));
  expect(found, `应找到按钮：${text}`).toBeTruthy();
  return found!;
};
const click = async (text: string) => {
  await act(async () => button(text).click());
};
const pasteInput = () => {
  const label = [...container.querySelectorAll('label')].find((node) => node.textContent === '设定 JSON');
  expect(label, '设定 JSON 应有可关联的标签').toBeTruthy();
  expect(label!.control).toBeInstanceOf(HTMLTextAreaElement);
  const textarea = label!.control as HTMLTextAreaElement;
  expect(textarea.id).toBe('source-json');
  return textarea;
};
const paste = async (value: string) => {
  const textarea = pasteInput();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const uploadInput = () => {
  const input = container.querySelector<HTMLInputElement>('#character-upload')!;
  expect(input.labels?.[0]?.textContent).toBe('上传设定文件');
  return input;
};
const upload = async (file: { type: string; name: string; text: () => Promise<string> }) => {
  const input = uploadInput();
  // jsdom 不允许脚本给文件输入赋非空 value；模拟浏览器选中文件后再验证 owner 清空它。
  Object.defineProperty(input, 'value', { configurable: true, writable: true, value: `C:\\fakepath\\${file.name}` });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  return input;
};
const mount = async (stream = false) => {
  localStorage.setItem('mahoshojo.sublimation.preferences.v1', JSON.stringify({
    generationMode: stream ? 'stream' : 'non-stream', targetTemplate: 'general',
  }));
  await act(async () => root.render(<SublimationPage />));
};

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Desktop test browser');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url === '/languages.json' ? [] : url === '/api/verify-origin' ? { isNative: false } : { presets: [] },
  ), { headers: { 'content-type': 'application/json' } })));
  mock.dispatch.mockImplementation(async () => new Response(JSON.stringify({
    targetTemplate: 'general', sublimatedData: { ...source, content: '升华正文' },
  }), { headers: { 'content-type': 'application/json' } }));
  mock.stream.mockImplementation(() => new Promise((resolve) => { finishStream = resolve; }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('升华素材输入（真实 Web 页面）', () => {
  it('可访问地展开和折叠，保留草稿，显式加载后清空文本且不会自动生成', async () => {
    await mount();
    const toggle = button('展开文本粘贴区域');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#source-json')).toBeNull();
    await click('展开文本粘贴区域');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const controlledId = toggle.getAttribute('aria-controls');
    expect(controlledId).toBeTruthy();
    expect(document.getElementById(controlledId!)?.contains(pasteInput())).toBe(true);

    const text = JSON.stringify(source);
    await paste(text);
    expect(button('开始升华').disabled).toBe(true);
    await click('折叠文本粘贴区域');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await click('展开文本粘贴区域');
    expect(pasteInput().value).toBe(text);
    expect(mock.dispatch).not.toHaveBeenCalled();

    await click('从文本加载设定');
    expect(pasteInput().value).toBe('');
    expect(container.textContent).toContain('已加载角色: 粘贴的内容');
    expect(button('开始升华').disabled).toBe(false);
    expect(mock.dispatch).not.toHaveBeenCalled();
    await click('开始升华');
    expect(mock.dispatch).toHaveBeenCalledTimes(1);
    expect(mock.dispatch.mock.calls[0][0]).toBe('/api/generate-sublimation');
    expect(JSON.parse(mock.dispatch.mock.calls[0][1].body)).toMatchObject(source);
  });

  it('空白保留已加载素材，无效 JSON 清除素材并保留文本，修正后可重新加载', async () => {
    await mount();
    await click('展开文本粘贴区域');
    await paste(JSON.stringify(source));
    await click('从文本加载设定');

    await paste(' \n ');
    await click('从文本加载设定');
    expect(container.textContent).toContain('⚠️ 文本框内容为空。');
    expect(container.textContent).toContain('已加载角色: 粘贴的内容');
    expect(button('开始升华').disabled).toBe(false);
    expect(pasteInput().value).toBe(' \n ');

    await paste('{ invalid json');
    await click('从文本加载设定');
    expect(container.textContent).toContain('❌ 数据加载失败:');
    expect(container.textContent).not.toContain('已加载角色:');
    expect(button('开始升华').disabled).toBe(true);
    expect(pasteInput().value).toBe('{ invalid json');

    await paste(JSON.stringify({ ...source, name: '修正后的角色' }));
    await click('从文本加载设定');
    expect(container.textContent).not.toContain('❌ 数据加载失败:');
    expect(container.textContent).not.toContain('⚠️ 文本框内容为空。');
    expect(container.textContent).toContain('已加载角色: 粘贴的内容');
    expect(pasteInput().value).toBe('');
    expect(button('开始升华').disabled).toBe(false);
    expect(mock.dispatch).not.toHaveBeenCalled();
  });

  it('按 MIME 拒绝文件且不读取，通过和失败的 JSON 读取都会 reset 并允许再次导入', async () => {
    await mount();
    const readRejected = vi.fn(async () => JSON.stringify(source));
    const input = await upload({ name: 'source.json', type: 'text/plain', text: readRejected });
    expect(readRejected).not.toHaveBeenCalled();
    expect(container.textContent).toContain('❌ 文件必须是 .json 格式。');
    expect(input.value).toBe('C:\\fakepath\\source.json');
    expect(button('开始升华').disabled).toBe(true);

    const readAccepted = vi.fn(async () => JSON.stringify(source));
    await upload({ name: 'source.json', type: 'application/json', text: readAccepted });
    expect(readAccepted).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('');
    expect(container.textContent).toContain('已加载角色: source.json');
    expect(container.textContent).not.toContain('❌ 文件必须是 .json 格式。');
    expect(mock.dispatch).not.toHaveBeenCalled();

    await upload({ name: 'broken.json', type: 'application/json', text: async () => '{ broken' });
    expect(input.value).toBe('');
    expect(container.textContent).toContain('❌ 数据加载失败:');
    expect(container.textContent).not.toContain('已加载角色:');
    expect(button('开始升华').disabled).toBe(true);

    await upload({ name: 'source.json', type: 'application/json', text: readAccepted });
    expect(readAccepted).toHaveBeenCalledTimes(2);
    expect(input.value).toBe('');
    expect(container.textContent).toContain('已加载角色: source.json');
    expect(container.textContent).not.toContain('❌ 数据加载失败:');
    await click('开始升华');
    expect(JSON.parse(mock.dispatch.mock.calls[0][1].body)).toMatchObject(source);
  });

  it('生成期间素材区只禁用加载，文件选择、粘贴编辑与展开折叠仍可用', async () => {
    await mount(true);
    await upload({ name: 'source.json', type: 'application/json', text: async () => JSON.stringify(source) });
    await click('展开文本粘贴区域');
    mock.dispatch.mockResolvedValue(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
    await click('开始升华');
    expect(mock.stream).toHaveBeenCalledTimes(1);
    expect(button('从文本加载设定').disabled).toBe(true);
    expect(uploadInput().disabled).toBe(false);
    expect(pasteInput().disabled).toBe(false);
    expect(pasteInput().readOnly).toBe(false);
    expect(button('折叠文本粘贴区域').disabled).toBe(false);

    await paste('待稍后加载');
    await click('从文本加载设定');
    expect(pasteInput().value).toBe('待稍后加载');
    expect(container.textContent).not.toContain('❌ 数据加载失败:');
    await click('折叠文本粘贴区域');
    await click('展开文本粘贴区域');
    expect(pasteInput().value).toBe('待稍后加载');
    expect(button('从文本加载设定').disabled).toBe(true);
    expect(mock.dispatch).toHaveBeenCalledTimes(1);

    await click('停止');
    await act(async () => finishStream({ text: '', outputSafetyStatus: 'safe', wasAborted: true }));
    expect(button('从文本加载设定').disabled).toBe(false);
    expect(pasteInput().value).toBe('待稍后加载');
  });

  it('移动设备由页面自动展开粘贴区，保留可访问标签', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mobile test browser');
    await mount();
    expect(button('折叠文本粘贴区域').getAttribute('aria-expanded')).toBe('true');
    expect(pasteInput().value).toBe('');
    expect(mock.dispatch).not.toHaveBeenCalled();
  });
});
