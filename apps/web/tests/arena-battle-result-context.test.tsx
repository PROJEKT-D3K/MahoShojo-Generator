// @vitest-environment jsdom

import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(), ownedHeaders: vi.fn(), openStream: vi.fn(), quickCheck: vi.fn(), cooldown: vi.fn(),
  capture: vi.fn(), download: vi.fn(), update: vi.fn(), retryUpdate: vi.fn(), push: vi.fn(), backup: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ setQueryData: vi.fn() }) }));
vi.mock('@/lib/client-route-adapter', () => ({ useClientRouteAdapter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/cooldown', () => ({ useProviderModeCooldown: () => ({ isCooldown: false, startCooldown: mocks.cooldown, remainingTime: 0, otherRemainingTime: 0 }) }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: mocks.quickCheck }));
vi.mock('@/lib/shield-word-filter', () => ({ applyShieldWords: (text: string) => ({ filteredText: text }) }));
vi.mock('@/lib/arrested-backup', () => ({ persistArrestedBackup: mocks.backup }));
vi.mock('@/lib/auth', async (original) => ({ ...await original<typeof import('@/lib/auth')>(), authStorage: { getOwnedAuthHeaders: mocks.ownedHeaders } }));
vi.mock('@/lib/arena/narrative-draft-owner', () => ({ captureNarrativeDraftOwner: () => ({ scope: 'anonymous', isCurrent: () => true }) }));
vi.mock('@/components/arena/hooks/useBattleActions', () => ({ useBattleActions: () => ({ handleResolveRandomPlaceholders: async () => {} }) }));
vi.mock('@/components/arena/hooks/useStreamCombatantUpdater', () => ({ useStreamCombatantUpdater: () => ({ updateFromMarkdown: mocks.update, retryGenerationUpdate: mocks.retryUpdate }) }));
vi.mock('@/components/arena/multiplayer/useArenaRoom', () => ({ useArenaRoomContext: () => null }));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({ useGenerationApiIntentLatch: () => ({ tryAcquire: () => ({ dispatch: mocks.dispatch }) }) }));
vi.mock('@/lib/arena/resumable-generation-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/arena/resumable-generation-client')>(),
  openArenaGenerationStream: mocks.openStream,
}));

import { useBattleEngine } from '@/components/arena/hooks/useBattleEngine';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';
import { useNarrativeHistoryStore } from '@/components/arena/stores/useNarrativeHistoryStore';
import type { NewsReport } from '@/components/BattleReportCard';
import { ArenaPersistedStateBoundary } from '@/components/arena/ArenaPersistedStateBoundary';
import type { AuthIdentity } from '@/lib/auth-identity';

import { BattleResult } from '@/components/arena/components/BattleResult';
import { GenerationModeSwitcher } from '@/components/arena/components/GenerationModeSwitcher';
import { BattleModeSwitcher } from '@/components/arena/components/BattleModeSwitcher';
vi.mock('@/components/arena/hooks/useCombatantRepair', () => ({ useCombatantRepair: () => ({ isInRoom: false, hasRepairContext: false }) }));
vi.mock('@/components/arena/components/BattleIllustrationPanel', () => ({ BattleIllustrationPanel: () => <aside>插图工具</aside> }));
vi.mock('@/components/SaveToCloudButton', () => ({ default: () => null }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ isAuthenticated: false, loading: false, user: null, userBadges: [] }) }));
vi.mock('@/lib/client/snapdomCapture', () => ({ capturePngBlob: mocks.capture }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: mocks.download, createBlobUrl: vi.fn() }));
const sse = (event: string, payload: unknown) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
const safeCheck = (text: string) => ({ hasSensitiveWords: false, matchDetails: [], detectedWords: [], filteredText: text });
const usage = { promptTokens: 123, completionTokens: 45, reasoningTokens: 6, textTokens: 39, totalTokens: 168 };
const body = '完成正文标记 A；这一份生成结果不能因选择下一场设置而丢失。';
const scenario = (title: string) => ({ content: { title, description: `${title}内容` }, fileName: `${title}.json`, isNative: false });
let current: ReturnType<typeof useBattleEngine>, root: Root, container: HTMLDivElement;
const Harness = () => { const engine = useBattleEngine(); useEffect(() => { current = engine; }); return <><GenerationModeSwitcher /><BattleModeSwitcher /><BattleResult onSaveImage={() => {}} /></>; };
const capture = () => ({ text: container.textContent, imageAlts: [...container.querySelectorAll('img')].map(x => x.alt) });
const selectButton = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent?.includes(label))!;
beforeEach(async () => {
  vi.resetAllMocks(); localStorage.clear(); sessionStorage.clear();
  mocks.quickCheck.mockImplementation(async (text: string) => safeCheck(text));
  mocks.update.mockResolvedValue(undefined); mocks.retryUpdate.mockResolvedValue(undefined);
  mocks.ownedHeaders.mockImplementation(async (identity: AuthIdentity) => ({ identity, headers: {} }));
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('No external network is permitted in this local probe'))));
  const initial = useBattleStore.getInitialState();
  useBattleStore.setState({ ...initial, reportFormat: 'markdown', generationMode: 'stream', battleMode: 'scenario', scenario: scenario('生成时情景 A'),
    combatants: [{ type: 'general-character', filename: 'test.json', data: { name: '角色甲' }, isValid: false, isPreset: false }],
    settings: { ...initial.settings, writeArenaHistory: false, writeCurrentState: false, writeNarrativeHistory: false },
  }, true);
  useNarrativeHistoryStore.setState(useNarrativeHistoryStore.getInitialState());
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
});
const settle = async () => { await act(async () => { await vi.dynamicImportSettled(); }); };
const structuredReport = (format: 'markdown' | 'web'): NewsReport => ({ headline: '完成标题 A', article: { body, analysis: '完成点评 A' }, officialReport: { winner: '角色甲', conclusion: '完成结论 A' }, reporterInfo: { name: '记者 A', publication: '报刊 A' }, aiModel: 'authoritative-model-A', aiUsage: usage,
 ...(format === 'web' ? { reportFormat: 'web', webHtml: `<html><head><title>完成标题 A</title></head><body>${body}</body></html>` } : {}) });

it.each([['stream', 'markdown'], ['non-stream', 'markdown'], ['stream', 'web'], ['non-stream', 'web']] as const)('completed %s %s result keeps its snapshot across next-generation controls and export', async (generationMode, reportFormat) => {
  await act(async () => { useBattleStore.getState().setGenerationMode(generationMode); useBattleStore.getState().setReportFormat(reportFormat); });
  if (generationMode === 'stream') {
    mocks.openStream.mockResolvedValueOnce(new Response(
      sse('snapshot', { markdown: reportFormat === 'web' ? `<html><head><title>完成标题 A</title></head><body>${body}</body></html>` : '# 完成标题 A\n\n' + body, status: 'completed', telemetry: { aiModel: 'authoritative-model-A', usage } }) + sse('done', { status: 'completed', ok: true }),
      { headers: { 'Content-Type': 'text/event-stream', 'x-mahoshojo-generation-id': 'generation-snapshot-A', 'x-mahoshojo-stream-meta': encodeURIComponent(JSON.stringify({ outputContract: reportFormat === 'web' ? 'web-document' : 'stream-markdown', reportFormat, ai: { model: 'header-model-old' } })) } },
    ));
  } else mocks.dispatch.mockResolvedValueOnce(Response.json({ report: structuredReport(reportFormat), generationId: 'generation-snapshot-A', updatedCombatants: [] }));
  await act(async () => current.handleGenerate()); await settle();
  const before = capture();
  expect(before.text).toContain('生成时情景 A');
  expect(before.text).toContain(body); expect(before.text).toContain('authoritative-model-A');
  expect(useBattleStore.getState().isGenerating).toBe(false);
  const original = generationMode === 'stream' ? useBattleStore.getState().streamingMarkdown : useBattleStore.getState().newsReport;
  await act(async () => useBattleStore.getState().setScenario(scenario('下一场情景 B'))); await settle();
  const afterScenario = capture();
  await act(async () => selectButton('日常模式').click()); await settle();
  const afterBattleMode = capture();
  let exportedAfterMode: string | null = null;
  if (reportFormat === 'markdown') {
    await act(async () => selectButton(generationMode === 'stream' ? '下载记录' : '下载战斗记录').click());
    exportedAfterMode = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(mocks.download.mock.calls[0][0]); });
    expect(exportedAfterMode).toContain('模式：情景模式');
    expect(exportedAfterMode).not.toContain('日常模式');
  }
  await act(async () => useBattleStore.getState().setReportFormat(reportFormat === 'markdown' ? 'web' : 'markdown')); await settle();
  const afterFormat = capture();
  await act(async () => useBattleStore.getState().setUserProviderConfig({ providerId: 'system', apiKey: '', modelId: 'selection-model-B' })); await settle();
  const afterModel = capture();
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent === (generationMode === 'stream' ? '非流式' : '流式'))!.click()); await settle();
  const afterGenerationMode = capture();
  expect(useBattleStore.getState().generationMode).toBe(generationMode === 'stream' ? 'non-stream' : 'stream');
  expect(afterGenerationMode.text).toContain(body);
  expect(afterScenario.text).toContain('生成时情景 A');
  expect(afterScenario.text).not.toContain('下一场情景 B');
  expect(afterBattleMode.imageAlts).toContain('情景模式 📜');
  expect(afterBattleMode.imageAlts).not.toContain('日常模式 ☕');
  expect(afterFormat.text).toContain(body);
  expect(useBattleStore.getState().resultReportFormat).toBe(reportFormat);
  expect(afterModel.text).toContain('authoritative-model-A');
  expect(afterModel.text).toContain('输入 123');
  expect(afterModel.text).not.toContain('selection-model-B');
  mocks.capture.mockImplementationOnce(async (element: HTMLElement) => {
    expect(element.textContent).toContain('生成时情景 A');
    expect(element.textContent).not.toContain('下一场情景 B');
    expect(element.textContent).toContain('authoritative-model-A');
    expect(element.textContent).toContain('输入 123');
    expect([...element.querySelectorAll('img')].map(image => image.alt)).toContain('情景模式 📜');
    return new Blob(['synthetic-png'], { type: 'image/png' });
  });
  await act(async () => selectButton('保存为图片').click());
  expect(mocks.capture).toHaveBeenCalledOnce();
  expect(mocks.download.mock.calls.at(-1)?.[1]).toMatch(/\.png$/);
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent === (generationMode === 'stream' ? '流式' : '非流式'))!.click()); await settle();
  const afterRestoreMode = capture();
  expect(afterRestoreMode.text).toContain(body);
  expect(generationMode === 'stream' ? useBattleStore.getState().streamingMarkdown : useBattleStore.getState().newsReport).toBe(original);

});


const finishStreamA = async () => {
  mocks.openStream.mockResolvedValueOnce(new Response(sse('snapshot', { markdown: '# 完成标题 A\n\n' + body, status: 'completed', telemetry: { aiModel: 'authoritative-model-A', usage } }) + sse('done', { status: 'completed', ok: true }), { headers: { 'Content-Type': 'text/event-stream' } }));
  await act(async () => current.handleGenerate()); await settle();
};
it.each(['stream', 'non-stream'] as const)('missing actual model and usage never inherit selected config (%s)', async generationMode => {
  await act(async () => { useBattleStore.getState().setGenerationMode(generationMode); useBattleStore.getState().setUserProviderConfig({ providerId: 'system', apiKey: '', modelId: 'selection-model-A' }); });
  if (generationMode === 'stream') mocks.openStream.mockResolvedValueOnce(new Response(sse('snapshot', { markdown: '# 完成标题 A\n\n' + body, status: 'completed' }) + sse('done', { status: 'completed', ok: true }), { headers: { 'Content-Type': 'text/event-stream' } }));
  else {
    const { aiModel: _model, aiUsage: _usage, ...report } = structuredReport('markdown');
    mocks.dispatch.mockResolvedValueOnce(Response.json({ report, updatedCombatants: [] }));
  }
  await act(async () => current.handleGenerate()); await settle();
  expect(useBattleStore.getState().error).toBeNull(); expect(container.textContent).toContain(body); expect(container.textContent).toContain('模型：未提供');
  expect(container.textContent).toContain('输入 未提供'); expect(container.textContent).not.toContain('selection-model-A');
  await act(async () => useBattleStore.getState().setUserProviderConfig({ providerId: 'system', apiKey: '', modelId: 'selection-model-B' }));
  expect(container.textContent).toContain('模型：未提供'); expect(container.textContent).not.toContain('selection-model-B');
});
it('preflight rejection preserves the displayed original result and snapshot', async () => {
  await finishStreamA();
  const original = useBattleStore.getState().streamingMarkdown;
  await act(async () => { useBattleStore.getState().setGenerationMode('non-stream'); useBattleStore.getState().setBattleMode('classic'); });
  await act(async () => current.handleGenerate()); await settle();
  expect(useBattleStore.getState().streamingMarkdown).toBe(original);
  expect(useBattleStore.getState().error).toContain('至少需要');
  expect(mocks.dispatch).not.toHaveBeenCalled(); expect(mocks.openStream).toHaveBeenCalledOnce();
  expect(container.textContent).toContain(body);
  expect(container.textContent).toContain('生成时情景 A');
  expect(useBattleStore.getState().resultContext).toMatchObject({ generationMode: 'stream', battleMode: 'scenario' });
});
it('an admitted new request clears old result and telemetry before transport completion', async () => {
  await finishStreamA();
  let resolve!: (value: Response) => void;
  const gate = new Promise<Response>(yes => { resolve = yes; });
  mocks.dispatch.mockReturnValueOnce(gate);
  await act(async () => { useBattleStore.getState().setGenerationMode('non-stream'); useBattleStore.getState().setBattleMode('daily'); });
  let pending!: Promise<void>;
  await act(async () => { pending = current.handleGenerate(); await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce()); });
  expect(useBattleStore.getState()).toMatchObject({ streamingMarkdown: null, newsReport: null, streamAiModel: null, streamAiUsage: null, isGenerating: true });
  expect(container.textContent).not.toContain(body);
  expect(useBattleStore.getState().resultContext).toEqual({ generationMode: 'non-stream', battleMode: 'daily', scenarioDisplayName: null });
  await act(async () => { resolve(Response.json({ report: { ...structuredReport('markdown'), headline: '完成标题 B', article: { body: '完成正文 B', analysis: '点评 B' }, aiModel: 'authoritative-model-B' }, updatedCombatants: [] })); await pending; }); await settle();
  expect(container.textContent).toContain('完成正文 B'); expect(container.textContent).toContain('authoritative-model-B'); expect(container.textContent).not.toContain('authoritative-model-A');
});

it('failed stream keeps its received body and snapshot after changing the generation selector', async () => {
  mocks.openStream.mockResolvedValueOnce(new Response(sse('snapshot', { markdown: '# 已保留残文\n\n' + body, status: 'failed' }) + sse('done', { status: 'failed', ok: false }), { headers: { 'Content-Type': 'text/event-stream' } }));
  await act(async () => current.handleGenerate()); await settle();
  expect(useBattleStore.getState().error).toContain('未成功完成'); expect(container.textContent).toContain(body);
  await act(async () => selectButton('非流式').click()); await settle();
  expect(useBattleStore.getState().streamingMarkdown).toContain(body); expect(container.textContent).toContain(body);
});

it('real C0 reconnect retains the completed snapshot through subsequent controls', async () => {
  const actual = await vi.importActual<typeof import('@/lib/arena/resumable-generation-client')>('@/lib/arena/resumable-generation-client');
  const headers = { 'Content-Type': 'text/event-stream', 'x-mahoshojo-generation-id': 'generation-recovery-probe', 'x-mahoshojo-stream-meta': encodeURIComponent(JSON.stringify({ outputContract: 'stream-markdown', reportFormat: 'markdown', mode: 'scenario', scenarioDisplayName: '生成时情景 A' })) };
  const transport = vi.fn()
    .mockResolvedValueOnce(new Response('id: 1-0\n' + sse('markdown', { chunk: '# 首段\n\n未完成的首段' }), { headers }))
    .mockResolvedValueOnce(new Response('id: 2-0\n' + sse('snapshot', { markdown: '# 完成标题 A\n\n' + body, status: 'completed', telemetry: { aiModel: 'authoritative-recovered-model', usage } }) + 'id: 3-0\n' + sse('done', { status: 'completed', ok: true }), { headers }));
  mocks.openStream.mockImplementationOnce(options => actual.openArenaGenerationStream({ ...options, fetcher: transport, storage: null, baseReconnectDelayMs: 0, maxReconnectAttempts: 1 }));
  await act(async () => current.handleGenerate()); await settle();
  expect(useBattleStore.getState().error).toBeNull(); expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[0][1].method).toBe('POST'); expect(transport.mock.calls[1][0]).toContain('/generation-recovery-probe/stream?after=1-0'); expect(transport.mock.calls[1][1].method).toBe('GET');
  expect(container.textContent).toContain(body); expect(container.textContent).toContain('authoritative-recovered-model'); expect(container.textContent).toContain('输入 123');
  await act(async () => selectButton('非流式').click()); await settle();
  expect(container.textContent).toContain(body); expect(useBattleStore.getState().streamingMarkdown).toContain(body);
});

it.each(['stream', 'non-stream'] as const)('legal authoritative metadata wins over the request fallback (%s)', async generationMode => {
  await act(async () => useBattleStore.getState().setGenerationMode(generationMode));
  const metadata = { mode: 'scenario', scenarioDisplayName: '权威情景', outputContract: 'stream-markdown', reportFormat: 'markdown' };
  const headers = { 'x-mahoshojo-stream-meta': encodeURIComponent(JSON.stringify(metadata)) };
  if (generationMode === 'stream') mocks.openStream.mockResolvedValueOnce(new Response(sse('snapshot', { markdown: '# 完成标题 A\n\n' + body, status: 'completed' }) + sse('done', { status: 'completed', ok: true }), { headers: { ...headers, 'Content-Type': 'text/event-stream' } }));
  else mocks.dispatch.mockResolvedValueOnce(Response.json({ report: { ...structuredReport('markdown'), mode: 'daily' }, updatedCombatants: [] }, { headers }));
  await act(async () => current.handleGenerate()); await settle();
  expect(container.textContent).toContain(body); expect(container.textContent).not.toContain('生成时情景 A');
  if (generationMode === 'stream') {
    expect(container.textContent).toContain('权威情景');
    expect(useBattleStore.getState().resultContext).toEqual({ generationMode, battleMode: 'scenario', scenarioDisplayName: '权威情景' });
  } else {
    expect(capture().imageAlts).toContain('日常模式 ☕'); expect(container.textContent).not.toContain('权威情景');
    expect(useBattleStore.getState().newsReport?.scenario).toBeUndefined();
    expect(useBattleStore.getState().resultContext).toEqual({ generationMode, battleMode: 'daily', scenarioDisplayName: null });
  }
});

it('invalid header fields retain the frozen fallback rather than the draft edited while awaiting transport', async () => {
  let release!: (value: Response) => void;
  mocks.openStream.mockReturnValueOnce(new Promise<Response>(resolve => { release = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = current.handleGenerate(); await vi.waitFor(() => expect(mocks.openStream).toHaveBeenCalledOnce()); });
  await act(async () => { useBattleStore.getState().setBattleMode('daily'); useBattleStore.getState().setScenario(scenario('下一场情景 B')); });
  await act(async () => { release(new Response(sse('snapshot', { markdown: '# 完成标题 A\n\n' + body, status: 'completed' }) + sse('done', { status: 'completed', ok: true }), { headers: { 'Content-Type': 'text/event-stream', 'x-mahoshojo-stream-meta': encodeURIComponent(JSON.stringify({ mode: 'invalid-mode', scenarioDisplayName: 42 })) } })); await pending; }); await settle();
  expect(container.textContent).toContain('生成时情景 A'); expect(container.textContent).not.toContain('下一场情景 B');
  expect(capture().imageAlts).toContain('情景模式 📜');
});

it.each(['stream', 'non-stream'] as const)('an old in-memory result without context uses its own shape and metadata (%s)', async generationMode => {
  await act(async () => useBattleStore.setState({ resultContext: null, generationMode: generationMode === 'stream' ? 'non-stream' : 'stream', battleMode: 'scenario', scenario: scenario('下一场情景 B'),
    streamingMarkdown: generationMode === 'stream' ? '# 完成标题 A\n\n' + body : null,
    newsReport: generationMode === 'non-stream' ? { ...structuredReport('markdown'), mode: 'daily' } : null,
  })); await settle();
  expect(container.textContent).toContain(body); expect(container.textContent).not.toContain('下一场情景 B');
  expect(capture().imageAlts).not.toContain('情景模式 📜');
  if (generationMode === 'non-stream') expect(capture().imageAlts).toContain('日常模式 ☕');
  else expect(capture().imageAlts).not.toContain('日常模式 ☕');
});

it('draft hydration ignores stored result context and preserves a current in-memory result', async () => {
  await act(async () => useBattleStore.persist.rehydrate());
  await finishStreamA();
  const currentContext = useBattleStore.getState().resultContext;
  const persisted = JSON.parse(localStorage.getItem('arena-storage')!);
  expect(persisted.state.resultContext).toBeUndefined(); expect(persisted.state.streamingMarkdown).toBeUndefined();
  localStorage.setItem('arena-storage', JSON.stringify({ ...persisted, state: { ...persisted.state, resultContext: { generationMode: 'non-stream', battleMode: 'daily', scenarioDisplayName: '旧字段' } } }));
  await act(async () => useBattleStore.persist.rehydrate());
  expect(useBattleStore.getState().resultContext).toBe(currentContext);
  expect(container.textContent).toContain('生成时情景 A');
  await act(async () => useBattleStore.setState({ resultContext: null, streamingMarkdown: null }));
  localStorage.setItem('arena-storage', JSON.stringify({ ...persisted, state: { ...persisted.state, resultContext: currentContext } }));
  await act(async () => useBattleStore.persist.rehydrate());
  expect(useBattleStore.getState().resultContext).toBeNull();
});

it.each(['markdown', 'web'] as const)('route remount keeps an in-memory non-stream %s result when the draft returns to stream', async reportFormat => {
  await act(async () => { await useBattleStore.persist.rehydrate(); useBattleStore.getState().setGenerationMode('non-stream'); useBattleStore.getState().setReportFormat(reportFormat); });
  mocks.dispatch.mockResolvedValueOnce(Response.json({ report: structuredReport(reportFormat), updatedCombatants: [] }));
  await act(async () => current.handleGenerate()); await settle();
  const originalContext = useBattleStore.getState().resultContext;
  const rehydrate = vi.spyOn(useBattleStore.persist, 'rehydrate');
  await act(async () => root.render(null));
  await act(async () => root.render(<ArenaPersistedStateBoundary generationModeAfterHydration="stream" hydrateNarrativeHistoryStore={false}><Harness /></ArenaPersistedStateBoundary>)); await settle();
  expect(rehydrate).not.toHaveBeenCalled(); expect(useBattleStore.getState().generationMode).toBe('stream');
  expect(useBattleStore.getState().resultContext).toBe(originalContext);
  expect(useBattleStore.getState().resultReportFormat).toBe(reportFormat);
  expect(useBattleStore.getState().resultWebReady).toBe(reportFormat === 'web');
  expect(container.textContent).toContain(body); expect(container.textContent).toContain('生成时情景 A');
});
