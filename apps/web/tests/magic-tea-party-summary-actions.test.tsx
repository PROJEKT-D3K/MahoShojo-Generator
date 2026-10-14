// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectMagicTeaPartySummaryInput } from '@mahoshojo/ai-core/magic-tea-party';
import { MagicTeaPartyChatComposer, MagicTeaPartyChatTimeline, MagicTeaPartySummaryBody } from '@mahoshojo/ui-web/magic-tea-party';
import type { MagicTeaPartyMessage, MagicTeaPartySession } from '@/lib/magic-tea-party/types';
import { DEFAULT_MAGIC_TEA_PARTY_PREFERENCES } from '@/lib/magic-tea-party/preferences';
import { useMagicTeaPartyChat, type UseMagicTeaPartyChatResult } from '@/lib/magic-tea-party/useMagicTeaPartyChat';

const mocks = vi.hoisted(() => ({ compare: vi.fn(), read: vi.fn(), fetch: vi.fn(), headers: vi.fn(), persist: vi.fn(), shield: vi.fn(), globalError: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authStorage: { getActivityHeaders: mocks.headers } }));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({ useGenerationApiIntentLatch: () => ({ tryAcquire: vi.fn() }) }));
vi.mock('@/lib/magic-tea-party/storage', async () => ({ ...(await vi.importActual('@/lib/magic-tea-party/storage')),
  putMagicTeaPartyMessage: vi.fn(), deleteMagicTeaPartyMessages: vi.fn(),
  compareAndPatchMagicTeaPartySummary: mocks.compare, getMagicTeaPartySession: mocks.read }));
vi.mock('@/lib/shield-word-filter', () => ({ applyShieldWords: mocks.shield }));

const session: MagicTeaPartySession = {
  id: 'tea', title: '茶会', createdAt: 1, updatedAt: 1, roles: [], draft: '未发草稿', summary: '原摘要',
  lastChoices: [{ id: 'old', text: '旧行动' }],
  summaryMeta: { updatedAt: 1, coverage: { version: 1, sourceMessageCount: 1, selectedMessageIds: ['old'], clippedMessageIds: [], omittedMessageCount: 0 } },
  settings: { providerId: 'openai', modelId: 'selected-model', language: 'zh-CN', userDisplayName: '旅人',
    contextWindowTokens: 8192, maxContextMessages: 2, enableSummary: false },
};
const message = (id: string, content = '剧情', role: MagicTeaPartyMessage['role'] = 'assistant'): MagicTeaPartyMessage =>
  ({ id, sessionId: 'tea', content, role, createdAt: 1, status: 'done' });
const history = [message('first', '进入茶馆', 'user'), message('omitted'), message('long', `${'字'.repeat(40_000)}尾声`), message('last', '继续', 'user')];
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const reply = (request: RequestInit, text = '新摘要') => {
  const body = JSON.parse(String(request.body));
  const { summaryInput } = projectMagicTeaPartySummaryInput({
    messages: body.messages, contextWindowTokens: body.contextWindowTokens, userDisplayName: body.userDisplayName,
    language: body.language, sourceMessageCount: body.messages.length,
  });
  return new Response(JSON.stringify({ summary: text, summaryInput }));
};

let storedSession: MagicTeaPartySession;
let root: Root;
let container: HTMLDivElement;
let chat: UseMagicTeaPartyChatResult;
let uiSummaryPending: Promise<boolean> | undefined;
function Harness({ current = session, seed = history, controls = false }: { current?: MagicTeaPartySession; seed?: MagicTeaPartyMessage[]; controls?: boolean }) {
  const [messages, setMessages] = useState(seed);
  const [draft, setDraft] = useState(current.draft ?? '');
  useEffect(() => setMessages(seed), [seed, current.id]);
  const value = useMagicTeaPartyChat({ activeSession: current, activeSessionId: current.id, messages, setMessages,
    persistSession: mocks.persist, preferences: { ...DEFAULT_MAGIC_TEA_PARTY_PREFERENCES, enableSummary: false },
    userProviderConfig: { providerId: 'openai', modelId: 'selected-model', apiKey: 'test-key' },
    onGlobalError: mocks.globalError, router: { push: vi.fn() },
  });
  useEffect(() => { chat = value; }, [value]);
  return controls ? <>
    <MagicTeaPartySummaryBody active summary={current.summary ?? ''} disabled={value.isGenerating}
      isSummarizing={value.isSummarizing} hasMessages={messages.length > 0} error={value.summaryError}
      description="生成会话摘要" collapsed={false} onCollapsedChange={() => {}}
      onGenerate={() => { uiSummaryPending = value.generateSummary(); }} onClear={() => void value.clearSummary()} onChange={() => {}} />
    <MagicTeaPartyChatTimeline activeSession={current} preferences={DEFAULT_MAGIC_TEA_PARTY_PREFERENCES}
      messages={messages} isGenerating={value.isGenerating} outputView="raw" onStopGenerating={value.stopGenerating}
      onSelectChoice={(text) => void value.sendMessage(text)} onRegenerate={(target) => void value.regenerateMessage(target)} />
    <MagicTeaPartyChatComposer activeSession={current} preferences={DEFAULT_MAGIC_TEA_PARTY_PREFERENCES}
      draft={draft} onDraftChange={setDraft} onSend={(text) => void value.sendMessage(text)}
      onContinue={() => void value.continueGeneration()} onGenerateChoices={() => void value.generateChoices()}
      isGenerating={value.isGenerating} hasMessages={messages.length > 0} />
  </> : null;
}
const render = (current = session, seed = history, controls = false) => {
  storedSession = current;
  return act(async () => root.render(<Harness current={current} seed={seed} controls={controls} />));
};
const button = (label: string) => [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.headers.mockResolvedValue({}); mocks.persist.mockResolvedValue(undefined);
  mocks.read.mockImplementation(async () => storedSession);
  mocks.compare.mockImplementation(async ({ patch, isCurrent, signal }) => {
    if (signal?.aborted || isCurrent?.() === false) return null;
    const next = { ...storedSession, ...patch };
    await mocks.persist(next);
    if (signal?.aborted || isCurrent?.() === false) return null;
    storedSession = next;
    return next;
  });
  mocks.shield.mockImplementation((text: string) => ({ filteredText: text }));
  mocks.fetch.mockImplementation(async (_url: string, request: RequestInit) => reply(request));
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  uiSummaryPending = undefined;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await render();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('Web manual summary projection and ownership', () => {
  it('dispatches once for same-tick clicks and preserves raw watermarks and first-pass coverage', async () => {
    const records = [...history.slice(0, 2), { ...message('operation', '旧摘要'), meta: { kind: 'summary' } },
      { ...message('failed-operation', ''), status: 'error' as const, meta: { kind: 'summary' } }, ...history.slice(2)];
    await render(session, records);
    await act(async () => { const generate = chat.generateSummary; await Promise.all([generate(), generate()]); });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url, request] = mocks.fetch.mock.calls[0];
    expect(url).toBe('/api/magic-tea-party/summarize');
    const body = JSON.parse(request.body);
    expect(body.messages.map((item: MagicTeaPartyMessage) => item.id)).toEqual(['long', 'last']);
    expect(Object.keys(body.messages[0]).sort()).toEqual(['content', 'id', 'role']);
    expect(body.messages[0].content).toContain('已省略中段');
    expect(body.messages[0].content.endsWith('尾声')).toBe(true);
    expect(body).not.toHaveProperty('settings');
    expect(body).not.toHaveProperty('coverage');
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.persist.mock.calls[0][0]).toMatchObject({ summary: '新摘要', draft: session.draft, lastChoices: session.lastChoices,
      settings: session.settings, summaryMeta: { fromMessageId: 'first', toMessageId: 'last', coverage: {
        version: 1, sourceMessageCount: 4, selectedMessageIds: ['long', 'last'], clippedMessageIds: ['long'], omittedMessageCount: 2,
      } } });
    expect(chat.isSummarizing).toBe(false);
  });

  it('accepts an old server without asserting machine coverage or inheriting the previous coverage', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ summary: '兼容摘要' })));
    await act(async () => chat.generateSummary());
    expect(mocks.persist.mock.calls[0][0]).toMatchObject({ summary: '兼容摘要', summaryMeta: { fromMessageId: 'first', toMessageId: 'last' } });
    expect(mocks.persist.mock.calls[0][0].summaryMeta).not.toHaveProperty('coverage');
  });

  it.each(['new', 'legacy'] as const)('preserves unknown summary metadata but drops stale tokenCount for %s responses', async (server) => {
    const summaryMeta = { ...session.summaryMeta!, tokenCount: 123, extension: { source: 'kept' } };
    await render({ ...session, summaryMeta });
    if (server === 'legacy') mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ summary: '兼容摘要' })));
    await act(async () => chat.generateSummary());
    expect(mocks.persist.mock.calls[0][0].summaryMeta).toMatchObject({ fromMessageId: 'first', toMessageId: 'last', extension: { source: 'kept' } });
    expect(mocks.persist.mock.calls[0][0].summaryMeta).not.toHaveProperty('tokenCount');
    if (server === 'legacy') expect(mocks.persist.mock.calls[0][0].summaryMeta).not.toHaveProperty('coverage');
    else expect(mocks.persist.mock.calls[0][0].summaryMeta.coverage.selectedMessageIds).toEqual(['long', 'last']);
  });

  it.each(['headers', 'response'] as const)('the real shared controls disable sending and expose a working Stop during manual summary %s', async (stage) => {
    await render(session, [message('story', '短篇剧情')], true);
    expect(button('发送')?.disabled).toBe(false);
    expect(button('停止生成')).toBeUndefined();
    const entered = deferred<void>(), release = deferred<void>();
    let signal: AbortSignal | null | undefined;
    if (stage === 'headers') mocks.headers.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return {}; });
    else mocks.fetch.mockImplementationOnce(async (_url: string, request: RequestInit) => {
      signal = request.signal; entered.resolve(); await release.promise; return reply(request);
    });
    await act(async () => { button('生成/更新摘要')!.click(); await entered.promise; });
    expect(chat.isGenerating).toBe(true); expect(chat.isSummarizing).toBe(true);
    for (const label of ['发送', '继续生成', '生成选项', '生成/更新摘要']) expect(button(label)?.disabled, label).toBe(true);
    expect(container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="输入你的行动"]')?.disabled).toBe(true);
    expect(button('停止生成')?.disabled).toBe(false);
    await act(async () => { button('发送')!.click(); button('继续生成')!.click(); button('生成选项')!.click(); });
    expect(mocks.fetch).toHaveBeenCalledTimes(stage === 'headers' ? 0 : 1);
    await act(async () => { button('停止生成')!.click(); release.resolve(); await uiSummaryPending; });
    if (stage === 'response') expect(signal?.aborted).toBe(true);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(stage === 'headers' ? 0 : 1);
    expect(chat.isGenerating).toBe(false); expect(chat.isSummarizing).toBe(false);
    expect(button('停止生成')).toBeUndefined();
    expect(button('发送')?.disabled).toBe(false);
    expect(container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="输入你的行动"]')?.value).toBe(session.draft);
  });

  it('does not dispatch when only summary-operation records remain', async () => {
    await render(session, [{ ...message('operation', '保留摘要原文'), meta: { kind: 'summary' } }]);
    await act(async () => chat.generateSummary());
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.persist).not.toHaveBeenCalled();
    expect(chat.summaryError).toBe('还没有可用于摘要的对话。');
  });

  it('rejects a callback captured in the previous session before starting any work', async () => {
    const oldGenerate = chat.generateSummary;
    await render({ ...session, id: 'other' });
    await act(async () => oldGenerate());
    expect(mocks.headers).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled(); expect(chat.isSummarizing).toBe(false);
    expect(chat.summaryError).toBeNull();
  });

  it.each(['other', 'round-trip'] as const)('old summary callbacks cannot touch the new owner after %s navigation', async (navigation) => {
    const oldClear = chat.clearSummary;
    const oldGenerate = chat.generateSummary;
    await render({ ...session, id: 'other' });
    if (navigation === 'round-trip') await render(session);
    const expectedId = navigation === 'round-trip' ? 'tea' : 'other';
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: '新会话错误' }), { status: 500 }));
    await act(async () => chat.generateSummary());
    const error = chat.summaryError;
    expect(error).toBeTruthy();
    await act(async () => { await oldClear(); await oldGenerate(); });
    expect(chat.summaryError).toBe(error); expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledOnce();

    const entered = deferred<void>(), release = deferred<void>();
    let signal: AbortSignal | null | undefined;
    mocks.fetch.mockImplementationOnce(async (_url: string, request: RequestInit) => {
      signal = request.signal; entered.resolve(); await release.promise; return reply(request, '新会话摘要');
    });
    let pending!: Promise<boolean>;
    await act(async () => { pending = chat.generateSummary(); await entered.promise; });
    await act(async () => { await oldClear(); await oldGenerate(); });
    expect(signal?.aborted).toBe(false); expect(chat.isGenerating).toBe(true); expect(chat.isSummarizing).toBe(true);
    expect(mocks.persist).not.toHaveBeenCalled();
    await act(async () => { release.resolve(); await pending; });
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.persist.mock.calls[0][0]).toMatchObject({ id: expectedId, summary: '新会话摘要' });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('reports a persistence failure without automatically issuing another model request', async () => {
    mocks.persist.mockRejectedValueOnce(new Error('storage-full'));
    await act(async () => chat.generateSummary());
    expect(mocks.fetch).toHaveBeenCalledOnce(); expect(mocks.persist).toHaveBeenCalledOnce();
    expect(chat.summaryError).toBe('storage-full'); expect(chat.isSummarizing).toBe(false);
  });

  it.each([null, { messageIds: ['wrong'], contentLengths: [1] }, { messageIds: ['long', 'last'], contentLengths: [1, 2] }])('rejects mismatched input checks without replacing the old summary: %j', async (summaryInput) => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ summary: '新摘要', summaryInput })));
    await act(async () => chat.generateSummary());
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(chat.summaryError).toContain('输入与本次选择不一致');
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it.each(['empty', 'shielded-empty', 'failed'] as const)('does not replace the summary for %s results or retry the model', async (outcome) => {
    if (outcome === 'empty') mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ summary: ' \n ' })));
    if (outcome === 'shielded-empty') mocks.shield.mockReturnValueOnce({ filteredText: ' \n ' });
    if (outcome === 'failed') mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: '失败' }), { status: 500 }));
    await act(async () => chat.generateSummary());
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(chat.summaryError).toBeTruthy(); expect(chat.isSummarizing).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it.each(['stop', 'switch'] as const)('dispatches nothing after %s during header preparation', async (outcome) => {
    const entered = deferred<void>(), release = deferred<Record<string, string>>();
    mocks.headers.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
    let pending!: Promise<boolean>;
    await act(async () => { pending = chat.generateSummary(); await entered.promise; });
    if (outcome === 'switch') await render({ ...session, id: 'other' });
    await act(async () => { if (outcome === 'stop') chat.stopGenerating(); release.resolve({}); await pending; });
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.persist).not.toHaveBeenCalled();
    expect(chat.summaryError).toBeNull(); expect(chat.isSummarizing).toBe(false);
  });

  it.each(['stop', 'clear'] as const)('ignores a successful late response after %s', async (outcome) => {
    const entered = deferred<void>(), release = deferred<void>();
    mocks.fetch.mockImplementationOnce(async (_url: string, request: RequestInit) => { entered.resolve(); await release.promise; return reply(request); });
    let pending!: Promise<boolean>;
    await act(async () => { pending = chat.generateSummary(); await entered.promise; });
    await act(async () => { if (outcome === 'stop') chat.stopGenerating(); else await chat.clearSummary(); release.resolve(); await pending; });
    expect(mocks.persist).toHaveBeenCalledTimes(outcome === 'clear' ? 1 : 0);
    if (outcome === 'clear') expect(mocks.persist.mock.calls[0][0].summary).toBeUndefined();
    expect(chat.summaryError).toBeNull(); expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it.each(['response', 'persist'] as const)('an old %s completion cannot clear a newer session summary owner', async (stage) => {
    const enteredOld = deferred<void>(), releaseOld = deferred<void>();
    const enteredNew = deferred<void>(), releaseNew = deferred<void>();
    if (stage === 'response') mocks.fetch.mockImplementationOnce(async (_url: string, request: RequestInit) => {
      enteredOld.resolve(); await releaseOld.promise; return reply(request, '旧请求');
    });
    else mocks.persist.mockImplementationOnce(async () => { enteredOld.resolve(); await releaseOld.promise; });
    let oldPending!: Promise<boolean>, newPending!: Promise<boolean>;
    await act(async () => { oldPending = chat.generateSummary(); await enteredOld.promise; });
    await render({ ...session, id: 'other' });
    mocks.fetch.mockImplementationOnce(async (_url: string, request: RequestInit) => { enteredNew.resolve(); await releaseNew.promise; return reply(request, '新请求'); });
    await act(async () => { newPending = chat.generateSummary(); await enteredNew.promise; });
    await act(async () => { releaseOld.resolve(); await oldPending; });
    expect(chat.isSummarizing).toBe(true); expect(chat.isGenerating).toBe(true); expect(chat.summaryError).toBeNull();
    if (stage === 'response') expect(mocks.persist).not.toHaveBeenCalled();
    await act(async () => { releaseNew.resolve(); await newPending; });
    expect(mocks.persist.mock.calls.at(-1)?.[0]).toMatchObject({ id: 'other', summary: '新请求' });
    expect(chat.isSummarizing).toBe(false); expect(chat.isGenerating).toBe(false); expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not reject unselected raw history over 800k when the actual selected request fits', async () => {
    await render(session, [message('huge', '字'.repeat(800_001)), ...history]);
    await act(async () => chat.generateSummary());
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.persist.mock.calls[0][0].summaryMeta.coverage).toMatchObject({ sourceMessageCount: 5, selectedMessageIds: ['long', 'last'], omittedMessageCount: 3 });
  });

  it('checks the actual context-clipped request length before dispatch', async () => {
    const largeSession = { ...session, settings: { ...session.settings, contextWindowTokens: 2_000_000, maxContextMessages: 200 } };
    await render(largeSession, Array.from({ length: 20 }, (_, index) => message(`m${index}`, '字'.repeat(50_000))));
    await act(async () => chat.generateSummary());
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.persist).not.toHaveBeenCalled();
    expect(chat.summaryError).toContain('超过单次请求');
  });

  it('keeps the 200-message, exactly 800k request boundary usable', async () => {
    const largeSession = { ...session, settings: { ...session.settings, contextWindowTokens: 2_000_000, maxContextMessages: 200 } };
    await render(largeSession, Array.from({ length: 200 }, (_, index) => message(`m${index}`, '字'.repeat(4000))));
    await act(async () => chat.generateSummary());
    expect(mocks.fetch).toHaveBeenCalledOnce(); expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.persist.mock.calls[0][0].summaryMeta.coverage).toMatchObject({ sourceMessageCount: 200, omittedMessageCount: 0, clippedMessageIds: [] });
  });
});
