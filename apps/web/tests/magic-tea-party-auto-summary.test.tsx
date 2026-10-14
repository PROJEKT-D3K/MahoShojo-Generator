// @vitest-environment jsdom
import { act, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectMagicTeaPartySummaryInput } from '@mahoshojo/ai-core/magic-tea-party';
import { useMagicTeaPartyChat, type UseMagicTeaPartyChatResult } from '@/lib/magic-tea-party/useMagicTeaPartyChat';
import { useMagicTeaPartySessions, type UseMagicTeaPartySessionsResult } from '@/lib/magic-tea-party/useMagicTeaPartySessions';
import { DEFAULT_MAGIC_TEA_PARTY_PREFERENCES } from '@/lib/magic-tea-party/preferences';
import { getMagicTeaPartySession, listMagicTeaPartyMessages, putMagicTeaPartyMessage, putMagicTeaPartySession,
  putMagicTeaPartySessionKeepingSummary } from '@/lib/magic-tea-party/storage';
import type { MagicTeaPartyMessage, MagicTeaPartySession } from '@/lib/magic-tea-party/types';
import type { UserAIProviderConfig } from '@/components/AiProviderSelector';
const mocks = vi.hoisted(() => ({ shield: vi.fn(), fetch: vi.fn(), dispatch: vi.fn(), sideChannels: vi.fn(), headers: vi.fn(), globalError: vi.fn() }));
vi.mock('@/lib/app-router-adapter', () => ({ useAppRouterAdapter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/auth', () => ({ authStorage: { getActivityHeaders: mocks.headers } }));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({ useGenerationApiIntentLatch: () => ({ tryAcquire: () => ({ dispatch: mocks.dispatch }) }) }));
vi.mock('@/lib/content-safety/client', () => ({ getSensitiveWordRedirectTarget: async () => null }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: async () => ({ hasSensitiveWords: false }) }));
vi.mock('@/lib/shield-word-filter', () => ({ applyShieldWords: mocks.shield }));
const provider = { providerId: 'openai', modelId: 'test', apiKey: 'synthetic-test-key' };
const stream = (text = '本回合完成', reason: string | null = 'stop') => new Response(
  `event: markdown\ndata: ${JSON.stringify({ chunk: text })}\n\n${reason === null ? '' : `event: tea_completion\ndata: ${JSON.stringify({ finishReason: reason })}\n\n`}event: done\ndata: {"ok":true}\n\n`,
  { headers: { 'content-type': 'text/event-stream' } });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let root: Root, container: HTMLDivElement, chat: UseMagicTeaPartyChatResult;
let session: MagicTeaPartySession, history: MagicTeaPartyMessage[], shown: MagicTeaPartyMessage[];
function Harness({ selected, config = provider }: { selected: MagicTeaPartySession; config?: UserAIProviderConfig }) {
  const [current, setCurrent] = useState(selected), [messages, setMessages] = useState(history);
  const selectedRef = useRef(selected.id); selectedRef.current = selected.id;
  useEffect(() => { setCurrent(selected); setMessages(history.map(message => ({ ...message, sessionId: selected.id }))); }, [selected]);
  const value = useMagicTeaPartyChat({ activeSession: current.id === selected.id ? current : null,
    activeSessionId: selected.id, messages, setMessages,
    persistSession: async (next, options) => {
      const saved = options?.preserveSummary ? await putMagicTeaPartySessionKeepingSummary(next) : (await putMagicTeaPartySession(next), next);
      if (selectedRef.current === saved.id) setCurrent(saved);
    }, onSummaryCommitted: saved => { if (selectedRef.current === saved.id) setCurrent(saved); },
    preferences: DEFAULT_MAGIC_TEA_PARTY_PREFERENCES, userProviderConfig: config, onSideChannels: mocks.sideChannels,
    onGlobalError: mocks.globalError, router: { push: vi.fn() },
  });
  useEffect(() => { chat = value; shown = messages; }, [value, messages]);
  return null;
}
const render = (selected = session, config: UserAIProviderConfig = provider) => act(async () => root.render(<Harness selected={selected} config={config} />));
const summaryReply = (request: RequestInit) => {
  const body = JSON.parse(String(request.body));
  const projection = projectMagicTeaPartySummaryInput({ messages: body.messages, contextWindowTokens: body.contextWindowTokens,
    language: body.language, userDisplayName: body.userDisplayName, sourceMessageCount: body.messages.length });
  return new Response(JSON.stringify({ summary: '新自动摘要', summaryInput: projection.summaryInput }));
};
const waitSummary = () => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); expect(chat.isSummarizing).toBe(false); });
beforeEach(async () => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  session = { id: crypto.randomUUID(), title: 'Tea', createdAt: 1, updatedAt: 1, roles: [], draft: '未发草稿', summary: '旧摘要',
    summaryMeta: { updatedAt: 1, tokenCount: 42, extension: '保留' }, settings: { ...provider, apiKey: undefined,
      outputFormat: 'markdown', enableChoices: false, enableSummary: false, autoSummaryEnabled: true,
      maxContextMessages: 2, outputPlan: { choices: 'off', summary: 'off', updates: 'off' } } as MagicTeaPartySession['settings'] };
  history = Array.from({ length: 8 }, (_, index) => ({ id: `${session.id}-${index}`, sessionId: session.id,
    role: index % 2 ? 'assistant' : 'user', content: `保留原文${index}`, createdAt: index + 1, status: 'done' }));
  await putMagicTeaPartySession(session); await Promise.all(history.map(putMagicTeaPartyMessage));
  mocks.shield.mockImplementation((text: string) => ({ filteredText: text }));
  mocks.headers.mockResolvedValue({}); mocks.dispatch.mockImplementation(async () => stream());
  mocks.fetch.mockImplementation(async (_url, request) => summaryReply(request));
  mocks.sideChannels.mockResolvedValue(false);
  vi.stubGlobal('fetch', mocks.fetch); vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); await render();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('Web automatic summary request ownership', () => {
  it('makes one extra request after a committed original reply and preserves every raw message', async () => {
    await act(async () => { await chat.sendMessage('选择行动'); }); await waitSummary();
    expect(mocks.dispatch).toHaveBeenCalledOnce(); expect(mocks.fetch).toHaveBeenCalledOnce();
    const request = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(request.customProvider.maxOutputTokens).toBe(1200);
    const saved = (await getMagicTeaPartySession(session.id))!;
    expect(saved).toMatchObject({ summary: '新自动摘要', draft: '未发草稿', summaryMeta: { extension: '保留', fromMessageId: history[0].id,
      toMessageId: shown.at(-1)!.id, coverage: { sourceMessageCount: 10, omittedMessageCount: 8 } },
      autoSummaryState: { lastAttemptedThroughMessageId: shown.at(-1)!.id } });
    expect(saved.summaryMeta).not.toHaveProperty('tokenCount');
    expect(saved.summaryMeta?.coverage?.selectedMessageIds).not.toContain(request.messages[0].id);
    expect((await listMagicTeaPartyMessages(session.id)).slice(0, 8)).toEqual(history);
    expect(await listMagicTeaPartyMessages(session.id)).toHaveLength(10);
  });
  it.each([false, undefined])('legacy enableSummary true with auto=%s performs no automatic request on load, toggle or reply', async autoSummaryEnabled => {
    session = { ...session, settings: { ...session.settings, autoSummaryEnabled, enableSummary: true } };
    await putMagicTeaPartySession(session); await render();
    expect(mocks.fetch).not.toHaveBeenCalled();
    await act(async () => { await chat.sendMessage('继续'); }); await waitSummary();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each(['length', 'unknown', null])('non-normal original completion %s never qualifies', async reason => {
    mocks.dispatch.mockImplementation(async () => stream('完成但不可确认', reason));
    await act(async () => { await chat.sendMessage('继续'); });
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(shown.at(-1)?.content).toBe('完成但不可确认');
  });
  it('empty original output never qualifies', async () => {
    mocks.dispatch.mockImplementation(async () => stream(''));
    await act(async () => { await chat.sendMessage('继续'); }); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('normal continue qualifies, regenerate does not', async () => {
    await act(async () => { await chat.continueGeneration(); }); await waitSummary();
    expect(mocks.fetch).toHaveBeenCalledOnce(); mocks.fetch.mockClear();
    await act(async () => { await chat.regenerateMessage(shown.at(-1)!); });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([200, 500])('an output-plan summary fallback attempt blocks another automatic request even with status %s', async status => {
    session = { ...session, settings: { ...session.settings, enableSummary: true,
      outputPlan: { choices: 'off', summary: 'on', updates: 'off' } } };
    await putMagicTeaPartySession(session); await render();
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify(status === 200 ? { summary: '旧计划摘要' } : { error: '失败' }), { status }));
    await act(async () => { await chat.sendMessage('继续'); }); await waitSummary();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect((await getMagicTeaPartySession(session.id))?.autoSummaryState).toBeUndefined();
  });
  it('an accepted merged summary skips automatic generation', async () => {
    session = { ...session, settings: { ...session.settings, outputFormat: 'jsonl', enableSummary: true } };
    await putMagicTeaPartySession(session); await render(); mocks.sideChannels.mockResolvedValue(true);
    mocks.dispatch.mockImplementation(async () => stream('{"type":"narration","text":"茶香"}\n{"type":"summary","text":"合并摘要"}'));
    await act(async () => { await chat.sendMessage('继续'); }); expect(mocks.sideChannels).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('persists a failed attempt before dispatch and does not retry it or the next too-close turn', async () => {
    mocks.fetch.mockImplementation(async () => {
      expect((await getMagicTeaPartySession(session.id))?.autoSummaryState?.lastAttemptedThroughMessageId).toBe((await listMagicTeaPartyMessages(session.id)).at(-1)?.id);
      return new Response(JSON.stringify({ error: '失败' }), { status: 500 });
    });
    await act(async () => { await chat.sendMessage('继续'); }); await waitSummary();
    expect(chat.summaryError).toBeTruthy(); expect(mocks.fetch).toHaveBeenCalledOnce();
    await act(async () => { await chat.sendMessage('再继续'); }); await waitSummary();
    expect(mocks.fetch).toHaveBeenCalledOnce(); expect((await getMagicTeaPartySession(session.id))?.summary).toBe('旧摘要');
  });
  it.each(['empty', 'shielded-empty', 'mismatch', 'null-input', 'legacy'] as const)('handles automatic %s responses without replacing unverified evidence or retrying', async outcome => {
    const previousCoverage = { version: 1 as const, sourceMessageCount: 8, selectedMessageIds: [history[0].id], clippedMessageIds: [], omittedMessageCount: 7 };
    session = { ...session, summaryMeta: { ...session.summaryMeta!, coverage: previousCoverage } };
    await putMagicTeaPartySession(session); await render();
    mocks.shield.mockImplementation((text: string) => ({ filteredText: text === '过滤成空' ? '  ' : text }));
    mocks.fetch.mockImplementationOnce(async (_url, request) => {
      const payload = await summaryReply(request).json();
      if (outcome === 'empty') payload.summary = '  \n ';
      if (outcome === 'shielded-empty') payload.summary = '过滤成空';
      if (outcome === 'mismatch') payload.summaryInput = { messageIds: ['wrong'], contentLengths: [7] };
      if (outcome === 'null-input') payload.summaryInput = null;
      if (outcome === 'legacy') delete payload.summaryInput;
      return new Response(JSON.stringify(payload));
    });
    await act(async () => { await chat.sendMessage('继续'); }); await waitSummary();
    const saved = (await getMagicTeaPartySession(session.id))!;
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(saved.autoSummaryState?.lastAttemptedThroughMessageId).toBe(shown.at(-1)?.id);
    if (outcome === 'legacy') {
      expect(saved.summary).toBe('新自动摘要'); expect(saved.summaryMeta).not.toHaveProperty('coverage');
      expect(saved.summaryMeta).not.toHaveProperty('tokenCount'); expect(saved.summaryMeta).toMatchObject({ extension: '保留' });
      expect(chat.summaryError).toBeNull();
    } else {
      expect(saved.summary).toBe('旧摘要'); expect(saved.summaryMeta).toEqual(session.summaryMeta);
      expect(chat.summaryError).toBeTruthy();
    }
    expect(await listMagicTeaPartyMessages(session.id)).toHaveLength(10);
  });

  it.each(['stop', 'switch-back', 'credential', 'manual', 'cross-tab'] as const)('ignores automatic late errors after %s without changing the current summary error', async event => {
    const entered = deferred<void>(), release = deferred<void>();
    mocks.fetch.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise;
      return new Response(JSON.stringify({ error: '不可显示的旧请求错误' }), { status: 500 });
    });
    await act(async () => { await chat.sendMessage('继续'); await entered.promise; });
    if (event === 'switch-back') {
      const other = { ...session, id: `${session.id}-other` }; await putMagicTeaPartySession(other); await render(other); await render(session);
    } else if (event === 'credential') await render(session, { ...provider, apiKey: 'replacement-synthetic-key' });
    else if (event === 'cross-tab') {
      const current = (await getMagicTeaPartySession(session.id))!;
      await putMagicTeaPartySession({ ...current, summary: '跨tab手改', summaryMeta: { ...current.summaryMeta, updatedAt: 99 } });
    } else await act(async () => { if (event === 'stop') chat.stopGenerating(); else chat.cancelSummary(); });
    await act(async () => { release.resolve(); }); await waitSummary();
    // Drain IndexedDB work as well as the already settled transport before checking stale error ownership.
    await act(async () => { await getMagicTeaPartySession(session.id); });
    expect(chat.summaryError).toBeNull(); expect(mocks.fetch).toHaveBeenCalledOnce();
    expect((await getMagicTeaPartySession(session.id))?.summary).toBe(event === 'cross-tab' ? '跨tab手改' : '旧摘要');
  });

  it.each(['stop', 'switch-back', 'credential', 'manual', 'delete', 'compact', 'cross-tab'] as const)('late auto success after %s cannot replace summary or draft', async event => {
    const entered = deferred<void>(), release = deferred<void>(); let signal: AbortSignal | null | undefined;
    mocks.fetch.mockImplementationOnce(async (_url, request) => { signal = request.signal; entered.resolve(); await release.promise; return summaryReply(request); });
    await act(async () => { await chat.sendMessage('继续'); await entered.promise; });
    if (event === 'switch-back') {
      const other = { ...session, id: `${session.id}-other` }; await putMagicTeaPartySession(other); await render(other); await render(session);
    } else if (event === 'credential') await render(session, { ...provider, apiKey: 'replacement-synthetic-key' });
    else if (event === 'cross-tab') { const current = (await getMagicTeaPartySession(session.id))!; await putMagicTeaPartySession({ ...current, summary: '跨tab手改', draft: '跨tab草稿' }); }
    else await act(async () => {
      if (event === 'stop') chat.stopGenerating();
      else if (event === 'delete') await chat.deleteMessage(history[0]);
      else if (event === 'compact') await chat.compactMessageContent({ ...history[0], content: '字'.repeat(200_000) });
      else chat.cancelSummary();
    });
    await act(async () => { release.resolve(); }); await waitSummary();
    const saved = (await getMagicTeaPartySession(session.id))!;
    expect(saved.summary).toBe(event === 'cross-tab' ? '跨tab手改' : '旧摘要');
    expect(saved.draft).toBe(event === 'cross-tab' ? '跨tab草稿' : '未发草稿');
    if (event !== 'cross-tab') expect(signal?.aborted).toBe(true);
    expect(chat.summaryError).toBeNull(); expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it('cross-tab edits and opt-out during the original stream survive terminal bookkeeping and suppress auto', async () => {
    mocks.dispatch.mockImplementationOnce(async () => {
      const current = (await getMagicTeaPartySession(session.id))!;
      await putMagicTeaPartySession({ ...current, summary: '原请求中手改', settings: { ...current.settings, autoSummaryEnabled: false } });
      return stream();
    });
    await act(async () => { await chat.sendMessage('继续'); }); await waitSummary();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await getMagicTeaPartySession(session.id)).toMatchObject({ summary: '原请求中手改', settings: { autoSummaryEnabled: false } });
  });
  it('new and forked sessions stay off and never inherit an attempt or dispatch on restoration', async () => {
    await putMagicTeaPartySession({ ...session, autoSummaryState: { lastAttemptedThroughMessageId: history[0].id } });
    let sessions!: UseMagicTeaPartySessionsResult;
    function SessionsHarness() {
      const value = useMagicTeaPartySessions({ userProviderConfig: provider });
      useEffect(() => { sessions = value; }, [value]); return null;
    }
    await act(async () => root.render(<SessionsHarness />));
    await vi.waitFor(async () => { await act(async () => {}); expect(sessions.sessions.length).toBeGreaterThan(0); });
    await act(async () => sessions.setActiveSessionId(session.id));
    await vi.waitFor(async () => { await act(async () => {}); expect(sessions.messages).toHaveLength(8); expect(sessions.activeSession?.id).toBe(session.id); });
    let branchId!: string | null;
    await act(async () => { branchId = await sessions.forkSessionFromMessage(history[2].id, '分支行动'); });
    expect(await getMagicTeaPartySession(branchId!)).toMatchObject({ settings: { autoSummaryEnabled: false }, autoSummaryState: undefined });
    await act(async () => sessions.createSession());
    await vi.waitFor(async () => { await act(async () => {}); expect(sessions.activeSession?.settings.autoSummaryEnabled).toBe(false); });
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('explicit generation override wins over automatic summaryMaxTokens', async () => {
    await render(session, { ...provider, maxOutputTokens: 9999, generationOverrides: { maxOutputTokens: 333 } });
    await act(async () => { await chat.sendMessage('继续'); }); await waitSummary();
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).customProvider).toMatchObject({ maxOutputTokens: 333, generationOverrides: { maxOutputTokens: 333 } });
  });
});
