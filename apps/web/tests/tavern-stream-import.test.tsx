// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERAL_CHARACTER_TEMPLATE_ID, GENERAL_SCENARIO_TEMPLATE_ID } from '@mahoshojo/domain/data-cards';
import { projectTavernStreamMarkdown } from '@mahoshojo/domain/tavern-card';
import { TavernImportPanel } from '@/components/tavern/TavernImportPanel';
import { OFFICIAL_KEY_MAX_AI_COOLDOWN_MS, USER_PROVIDED_KEY_COOLDOWN_MS } from '@/lib/ai/cooldowns';
import { STREAM_ABORT_REASON_OUTPUT_SAFETY, STREAM_ABORT_REASON_TIMEOUT, STREAM_ABORT_REASON_USER } from '@/lib/stream/abort';
import type { readSafeTextAndReasoningStreamFromResponse, ReadSafeTextAndReasoningStreamResult } from '@/lib/stream/read-safe-text-and-reasoning-stream';
import type { AIReasoningEnvelope } from '@/types/ai-reasoning';
import type { UserAIProviderConfig } from '@/components/AiProviderSelector';

type Template = Parameters<typeof projectTavernStreamMarkdown>[0]['template'];
type StreamOptions = Parameters<typeof readSafeTextAndReasoningStreamFromResponse>[1];
type Card = Record<string, unknown>;
type PendingStream = {
  options: StreamOptions;
  text: string;
  reasoning: AIReasoningEnvelope | null;
  resolve: (result: ReadSafeTextAndReasoningStreamResult) => void;
  reject: (error: Error) => void;
};

const mocks = vi.hoisted(() => ({
  download: vi.fn<(blob: Blob, name: string) => void>(),
  readStream: vi.fn(),
  useCooldown: vi.fn(),
  startCooldown: vi.fn(),
  isCooldown: false,
  remainingTime: 120,
}));

// Keep the real import panel, source normalization, placeholder replacement,
// projector, controls and reasoning panel. Replace only host I/O and card views.
vi.mock('@/components/AiProviderSelector', () => ({
  default: ({ onConfigChange }: { onConfigChange: (config: UserAIProviderConfig) => void }) => <button type="button" onClick={() => onConfigChange({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-only-key' })}>测试使用自有 Key</button>,
}));
vi.mock('@/components/TachieGenerator', () => ({ default: () => null }));
vi.mock('@/components/SaveToCloudButton', () => ({ default: () => null }));
vi.mock('@/components/GeneralCharacterCard', () => ({
  default: ({ general, isStreaming }: { general: Card; isStreaming: boolean }) => <pre data-projection="character" data-streaming={String(isStreaming)}>{JSON.stringify(general)}</pre>,
}));
vi.mock('@/components/GeneralScenarioCard', () => ({
  default: ({ scenario, isStreaming }: { scenario: Card; isStreaming: boolean }) => <pre data-projection="scenario" data-streaming={String(isStreaming)}>{JSON.stringify(scenario)}</pre>,
}));
vi.mock('@/components/MagicalGirlCard', () => ({ default: () => <div data-structured-card="magical-girl" /> }));
vi.mock('@/components/CanshouCard', () => ({ default: () => <div data-structured-card="canshou" /> }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/lib/auth', () => ({ authStorage: { getActivityHeaders: async () => ({ 'x-test-activity': 'active' }) } }));
vi.mock('@/lib/cooldown', () => ({ useCooldown: mocks.useCooldown }));
vi.mock('@/lib/app-router-adapter', () => ({ useAppRouterAdapter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: mocks.download, revokeBlobUrl: vi.fn() }));
vi.mock('@/lib/local-library/card-repository', () => ({ getLocalCardRepository: () => ({}) }));
vi.mock('@mahoshojo/local-library/imported-unsigned-card', () => ({ saveImportedUnsignedCard: vi.fn() }));
vi.mock('@/lib/stream/read-safe-text-and-reasoning-stream', () => ({ readSafeTextAndReasoningStreamFromResponse: mocks.readStream }));

let root: Root;
let container: HTMLDivElement;
let pending: PendingStream | null;
const source = { name: '原卡名字', description: '原始描述' };
const endpoint = '/api/tavern/convert-stream?format=sse';
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === label || element.getAttribute('aria-label') === label);
const projectionNode = () => container.querySelector<HTMLElement>('[data-projection]')!;
const projection = (): Card => JSON.parse(projectionNode().textContent!);
const templateSelector = () => [...container.querySelectorAll('select')].find((select) => [...select.options].some((option) => option.value === 'magical-girl'))!;
const keepRawCheckbox = () => [...container.querySelectorAll('label')].find((label) => label.textContent?.includes('同时保存'))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const streamRequests = () => vi.mocked(fetch).mock.calls.filter(([url]) => url === endpoint);

async function click(label: string) {
  const target = button(label);
  expect(target, `missing button: ${label}`).toBeDefined();
  await act(async () => target!.click());
}

async function upload(raw: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'source.json', size: bytes.length, arrayBuffer: async () => bytes.buffer }] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}

async function prepare({ template = 'general', raw = source, keepRaw = false, busy }: { template?: Template; raw?: Record<string, unknown>; keepRaw?: boolean; busy?: (value: boolean) => void } = {}) {
  await act(async () => root.render(<TavernImportPanel onBusyChange={busy} />));
  await upload(raw);
  await act(async () => {
    templateSelector().value = template;
    templateSelector().dispatchEvent(new Event('change', { bubbles: true }));
  });
  if (keepRaw) await act(async () => keepRawCheckbox().click());
  await act(async () => container.querySelectorAll<HTMLInputElement>('input[name="tavern-convert-mode"]')[1].click());
  await click('流式');
}

async function start(template: Template = 'general') {
  await click(template === 'scenario' || template === 'general-scenario' ? '生成情景卡' : '生成角色卡');
  expect(pending).not.toBeNull();
  return pending!;
}

async function emit(text: string, reasoning?: AIReasoningEnvelope) {
  await act(async () => {
    pending!.text = text;
    pending!.options.onText?.(text);
    if (reasoning) {
      pending!.reasoning = reasoning;
      pending!.options.onReasoning?.(reasoning);
    }
  });
}

function result(stream: PendingStream, overrides: Partial<ReadSafeTextAndReasoningStreamResult> = {}): ReadSafeTextAndReasoningStreamResult {
  return { text: stream.text, reasoning: stream.reasoning, telemetry: null, meta: null, isSse: true, outputSafetyStatus: 'done', wasAborted: false, abortReason: null, ...overrides };
}

async function finish(text: string) {
  await emit(text);
  await act(async () => pending!.resolve(result(pending!)));
}

async function download(): Promise<Card & { _tavern: { meta: Card; raw?: unknown } }> {
  await click('下载数据卡 JSON');
  return JSON.parse(await mocks.download.mock.calls.at(-1)![0].text());
}

function expectPreview(card: ReturnType<typeof projectTavernStreamMarkdown>['card'], streaming: boolean) {
  const scenario = card.templateId === GENERAL_SCENARIO_TEMPLATE_ID;
  expect(projectionNode().dataset.projection).toBe(scenario ? 'scenario' : 'character');
  expect(projectionNode().dataset.streaming).toBe(String(streaming));
  // The scenario view accepts title/content; the character view gets the card.
  expect(projection()).toEqual(scenario ? { title: 'title' in card ? card.title : undefined, content: card.content } : card);
  expect(container.querySelector('[data-structured-card]')).toBeNull();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  pending = null;
  mocks.isCooldown = false;
  mocks.remainingTime = 120;
  mocks.useCooldown.mockImplementation(() => ({ isCooldown: mocks.isCooldown, remainingTime: mocks.remainingTime, startCooldown: mocks.startCooldown }));
  mocks.startCooldown.mockImplementation(() => { mocks.isCooldown = true; });
  mocks.readStream.mockImplementation((_response: Response, options: StreamOptions) => new Promise<ReadSafeTextAndReasoningStreamResult>((resolve, reject) => {
    const stream: PendingStream = { options, resolve, reject, text: '', reasoning: null };
    pending = stream;
    options.abortController.signal.addEventListener('abort', () => resolve(result(stream, {
      outputSafetyStatus: options.abortController.signal.reason === STREAM_ABORT_REASON_OUTPUT_SAFETY ? 'blocked' : 'done',
      wasAborted: true,
      abortReason: options.abortController.signal.reason,
    })), { once: true });
  }));
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (url === '/languages.json') return { json: async () => [{ code: 'zh-CN', name: '中文' }, { code: 'en', name: 'English' }] } as Response;
    if (url === endpoint) return { ok: true, headers: new Headers({ 'content-type': 'text/event-stream' }) } as Response;
    throw new Error(`Unexpected request: ${String(url)}`);
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Web Tavern real shared streaming projection', () => {
  it.each<Template>(['general', 'magical-girl', 'canshou', 'general-scenario', 'scenario'])('%s streams a real preview and exports the shared general projection without altering Markdown', async (template) => {
    const scenario = template === 'scenario' || template === 'general-scenario';
    await prepare({ template });
    await start(template);
    const partial = '\r\n# 途中标题\r\n\r\n尚未完成  ';
    await emit(partial);
    const preview = projectTavernStreamMarkdown({ template, markdown: partial, sourceName: source.name }).card;
    expectPreview(preview, true);
    expect(projection()).toMatchObject(scenario ? { title: '途中标题', content: partial } : { name: '途中标题', content: partial });
    expect(button('下载数据卡 JSON')).toBeUndefined();
    expect(mocks.startCooldown).not.toHaveBeenCalled();

    const markdown = '\r\n# 标题回退\r\n名称：__最终角色__\r\n代号：星灯\r\n情景标题：__最终情景__\r\n\r\n- **内容保留**  \r\n';
    await finish(markdown);
    const projected = projectTavernStreamMarkdown({ template, markdown, sourceName: source.name });
    expect(projected.parsed).toMatchObject({ name: '最终角色', codename: '星灯', title: '最终情景' });
    const output = await download();
    const { _tavern, ...body } = output;
    expect(body).toEqual(projected.card);
    expect(body).toMatchObject(scenario
      ? { templateId: GENERAL_SCENARIO_TEMPLATE_ID, title: '最终情景', content: markdown }
      : { templateId: GENERAL_CHARACTER_TEMPLATE_ID, name: '最终角色', codename: '星灯', content: markdown });
    expect(_tavern.meta).toMatchObject(source);
    expect(_tavern).not.toHaveProperty('raw');
    expect(projectionNode().dataset.streaming).toBe('false');
    expect(projection()).toEqual(scenario ? { title: body.title, content: markdown } : output);
    expect(container.querySelector('[data-structured-card]')).toBeNull();
    expect(mocks.startCooldown).toHaveBeenCalledExactlyOnceWith(OFFICIAL_KEY_MAX_AI_COOLDOWN_MS);
    expect(streamRequests()).toHaveLength(1);
  });

  it.each<Template>(['general', 'scenario'])('%s uses the normalized source name when Markdown has no usable name or headline', async (template) => {
    await prepare({ template, raw: { name: '  “来源名字”  ', description: '原始描述' } });
    await start(template);
    const markdown = ' \r\n\t';
    await emit(markdown);
    const card = projectTavernStreamMarkdown({ template, markdown, sourceName: '“来源名字”' }).card;
    expectPreview(card, true);
    expect(projection()).toMatchObject(template === 'scenario' ? { title: '来源名字', content: markdown } : { name: '来源名字', content: markdown });
    await finish(markdown);
    const { _tavern, ...body } = await download();
    expect(body).toEqual(card);
    expect(_tavern.meta.name).toBe('“来源名字”');
  });

  it.each([false, true])('keepRaw=%s attaches original meta/raw only in the host while sending the normalized model attachment', async (keepRaw) => {
    const raw = { name: '原角色', description: '{{user}} 遇见 {{char}}', first_mes: '你好 {{user}}', system_prompt: 'RAW_ONLY_SYSTEM_PROMPT', extensions: { script: 'RAW_ONLY_EXTENSION' }, signature: 'RAW_ONLY_SIGNATURE' };
    localStorage.setItem('mahoshojo.tavern.import.placeholder.v1', JSON.stringify({ enabled: true, userReplacement: '访客', charReplacementMode: 'custom', customCharReplacement: '新角色' }));
    await prepare({ raw, keepRaw });
    const stream = await start();
    const init = streamRequests()[0][1]!;
    const request = JSON.parse(String(init.body));
    expect(request).toEqual({ template: 'general', sourceName: '原角色', language: 'zh-CN', attachments: [{ name: 'tavern-card.json', type: 'application/json', content: expect.any(String) }] });
    expect(JSON.parse(request.attachments[0].content)).toMatchObject({ name: '原角色', description: '访客 遇见 新角色', first_mes: '你好 访客' });
    expect(String(init.body)).not.toMatch(/RAW_ONLY_|_tavern|system_prompt|extensions|signature/);
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-test-activity': 'active' } });
    expect(init.signal).toBe(stream.options.abortController.signal);

    const markdown = '# 生成角色\n\n模型正文';
    await finish(markdown);
    const { _tavern, ...body } = await download();
    expect(body).toEqual(projectTavernStreamMarkdown({ template: 'general', markdown, sourceName: raw.name }).card);
    expect(_tavern.meta).toMatchObject({ name: raw.name, description: raw.description, firstMes: raw.first_mes });
    if (keepRaw) expect(_tavern.raw).toEqual(raw);
    else expect(_tavern).not.toHaveProperty('raw');
    expect(JSON.stringify(body)).not.toMatch(/RAW_ONLY_|_tavern|访客/);
  });

  it.each([
    { reason: STREAM_ABORT_REASON_USER, notice: '已手动停止生成' },
    { reason: STREAM_ABORT_REASON_OUTPUT_SAFETY, notice: '输出触发调查院规则' },
    { reason: STREAM_ABORT_REASON_TIMEOUT, notice: '流式生成已中断' },
  ])('keeps $reason partial output downloadable and releases busy controls', async ({ reason, notice }) => {
    const busy = vi.fn();
    await prepare({ busy });
    const stream = await start();
    expect(busy).toHaveBeenLastCalledWith(true);
    expect(button('生成中…')!.disabled).toBe(true);
    expect(templateSelector().disabled).toBe(true);
    expect(keepRawCheckbox().disabled).toBe(true);
    const markdown = reason === STREAM_ABORT_REASON_OUTPUT_SAFETY ? '# 安全片段\n\n已截断\n\n逮捕令' : '# 保留片段\n\n尚未完成';
    await emit(markdown);
    expectPreview(projectTavernStreamMarkdown({ template: 'general', markdown, sourceName: source.name }).card, true);
    expect(button('下载数据卡 JSON')).toBeUndefined();
    if (reason === STREAM_ABORT_REASON_USER) await click('停止生成');
    else await act(async () => stream.options.abortController.abort(reason));

    expect(stream.options.abortController.signal.reason).toBe(reason);
    expect(container.textContent).toContain(notice);
    expect(container.textContent).toContain('当前内容可能不完整，但可继续保存');
    expect(button('停止生成')).toBeUndefined();
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(templateSelector().disabled).toBe(false);
    expect(keepRawCheckbox().disabled).toBe(false);
    const output = await download();
    expect(output).toMatchObject({ templateId: GENERAL_CHARACTER_TEMPLATE_ID, name: reason === STREAM_ABORT_REASON_OUTPUT_SAFETY ? '安全片段' : '保留片段', content: markdown });
    expect(projection()).toEqual(output);
    expect(projectionNode().dataset.streaming).toBe('false');
    expect(mocks.startCooldown).toHaveBeenCalledExactlyOnceWith(OFFICIAL_KEY_MAX_AI_COOLDOWN_MS);
    expect(streamRequests()).toHaveLength(1);
  });

  it('keeps reasoning in its own real panel and never includes it in the preview or exported body', async () => {
    await prepare();
    await start();
    const markdown = '# 公开角色\n\n正文';
    const reasoning: AIReasoningEnvelope = { status: 'thinking', source: 'provider', text: 'REASONING_ONLY：内部分析' };
    await emit(markdown, reasoning);
    await click('AI 正在思考…');
    expect(container.querySelector('.ai-reasoning-panel')?.textContent).toContain(reasoning.text);
    expect(projectionNode().textContent).not.toContain('REASONING_ONLY');
    await emit(markdown, { ...reasoning, status: 'done' });
    await finish(markdown);
    const output = await download();
    expect(output.content).toBe(markdown);
    expect(JSON.stringify(output)).not.toContain('REASONING_ONLY');
    expect(container.querySelector('.ai-reasoning-panel')?.textContent).toContain('REASONING_ONLY');
  });

  it('suppresses repeated generation while streaming and reuses the completed result for repeated downloads during cooldown', async () => {
    await prepare();
    const generate = button('生成角色卡')!;
    await start();
    await act(async () => { generate.click(); generate.click(); });
    expect(streamRequests()).toHaveLength(1);
    expect(mocks.readStream).toHaveBeenCalledTimes(1);
    await finish('# 一次生成\n\n完整正文');
    expect(button('冷却中 (120s)')!.disabled).toBe(true);
    await act(async () => generate.click());
    const first = await download();
    const second = await download();
    expect(second).toEqual(first);
    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(streamRequests()).toHaveLength(1);
    expect(mocks.startCooldown).toHaveBeenCalledTimes(1);
  });

  it('does not start an official-key request during an existing cooldown', async () => {
    mocks.isCooldown = true;
    await prepare();
    expect(mocks.useCooldown).toHaveBeenLastCalledWith('tavernConvertCooldown:system', OFFICIAL_KEY_MAX_AI_COOLDOWN_MS);
    expect(button('冷却中 (120s)')!.disabled).toBe(true);
    await click('冷却中 (120s)');
    expect(streamRequests()).toHaveLength(0);
    expect(mocks.readStream).not.toHaveBeenCalled();
    expect(mocks.startCooldown).not.toHaveBeenCalled();
  });

  it('uses the custom-key cooldown and only starts it after the streamed result resolves', async () => {
    await prepare();
    await click('测试使用自有 Key');
    expect(mocks.useCooldown).toHaveBeenLastCalledWith('tavernConvertCooldown:custom', USER_PROVIDED_KEY_COOLDOWN_MS);
    await start();
    await emit('# 自有 Key\n\n正文');
    expect(mocks.startCooldown).not.toHaveBeenCalled();
    expect(JSON.parse(String(streamRequests()[0][1]!.body)).customProvider).toEqual({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-only-key' });
    await finish('# 自有 Key\n\n正文');
    expect(mocks.startCooldown).toHaveBeenCalledExactlyOnceWith(USER_PROVIDED_KEY_COOLDOWN_MS);
  });

  it('releases busy state after a reader failure without charging cooldown or exposing a completed export', async () => {
    const busy = vi.fn();
    await prepare({ busy });
    const stream = await start();
    await emit('# 尚未完成');
    await act(async () => stream.reject(new Error('stream connection failed')));
    expect(container.textContent).toContain('stream connection failed');
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(button('生成角色卡')!.disabled).toBe(false);
    expect(button('停止生成')).toBeUndefined();
    expect(button('下载数据卡 JSON')).toBeUndefined();
    expect(mocks.startCooldown).not.toHaveBeenCalled();
    await start();
    await finish('# 重试成功');
    expect((await download()).name).toBe('重试成功');
    expect(streamRequests()).toHaveLength(2);
    expect(mocks.startCooldown).toHaveBeenCalledTimes(1);
  });
});
