// @vitest-environment jsdom

import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


const mocks = vi.hoisted(() => ({
  openStream: vi.fn(), dispatch: vi.fn(), quickCheck: vi.fn(), shield: vi.fn(),
  updateFromMarkdown: vi.fn(), resolveRandom: vi.fn(), cooldown: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ setQueryData: vi.fn() }) }));
vi.mock('@/lib/client-route-adapter', () => ({ useClientRouteAdapter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/cooldown', () => ({ useProviderModeCooldown: () => ({ isCooldown: false, startCooldown: mocks.cooldown, remainingTime: 0, otherRemainingTime: 0 }) }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: mocks.quickCheck }));
vi.mock('@/lib/shield-word-filter', () => ({ applyShieldWords: mocks.shield }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth')>(),
  authStorage: {
    getAuthHeader: async () => null,
    getActivityHeaders: async () => ({}),
    getOwnedAuthHeaders: async (identity: import('@/lib/auth-identity').AuthIdentity) => Object.freeze({
      identity, headers: Object.freeze({}),
    }),
  },
}));
vi.mock('@/components/arena/hooks/useBattleActions', () => ({ useBattleActions: () => ({ handleResolveRandomPlaceholders: mocks.resolveRandom }) }));
vi.mock('@/components/arena/hooks/useStreamCombatantUpdater', () => ({ useStreamCombatantUpdater: () => ({ updateFromMarkdown: mocks.updateFromMarkdown, retryGenerationUpdate: vi.fn() }) }));
vi.mock('@/components/arena/multiplayer/useArenaRoom', () => ({ useArenaRoomContext: () => null }));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({ useGenerationApiIntentLatch: () => ({ tryAcquire: () => ({ dispatch: mocks.dispatch }) }) }));
vi.mock('@/lib/arena/resumable-generation-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/arena/resumable-generation-client')>(),
  openArenaGenerationStream: mocks.openStream,
}));

import { useBattleEngine } from '@/components/arena/hooks/useBattleEngine';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';
import { useNarrativeHistoryStore } from '@/components/arena/stores/useNarrativeHistoryStore';
import { arenaModes, arenaDeliveries, arenaParityPayload } from '../../../fixtures/arena-generation/input';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let current: ReturnType<typeof useBattleEngine>;
let root: Root;
let container: HTMLDivElement;
const Harness = () => {
  const engine = useBattleEngine();
  useEffect(() => { current = engine; });
  return null;
};
const sse = (event: string, payload: unknown) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
const report = {
  headline: 'SHIELD 雨夜', article: { body: '重逢正文', analysis: '点评独立' },
  officialReport: { winner: '雪绒', conclusion: '约定延续' }, reporterInfo: { name: '记者', publication: 'Arena' },
  aiReasoning: { status: 'done', source: 'provider', text: 'REASONING_ONLY', parts: [{ text: 'SHIELD 思考' }] },
  scenario: '服务端情景', aiModel: 'fixture-model',
  characterGuidances: [{ characterName: '雪绒', guidance: '守约' }],
  extension: { preserved: ['不丢失'] },
};
const markdown = '# SHIELD 雨夜\n\n重逢正文\n\n## 胜利者\n\n- 雪绒\n\n## 最终结果\n\n约定延续';
// 完整比较请求与结果，保留字段回归诊断；响应显示信息允许覆盖请求时的回退值。
const expectedRequest = (mode: typeof arenaModes[number], delivery: typeof arenaDeliveries[number]) => {
  const fixture = arenaParityPayload(mode, delivery);
  return {
    generationRequestId: 'fixture-request', reportFormat: 'markdown', mode,
    combatants: fixture.combatants.map((item, index) => ({
      ...item, isNative: false, isPreset: index === 0, filename: index === 0 ? '0.json' : null,
      sourceDataCardId: `card-${index}`, sourceDataCardUpdatedAt: '2026-01-01',
    })),
    arenaFreeRankingEnabled: true, userGuidance: fixture.userGuidance,
    ...(mode === 'scenario' ? {
      scenario: fixture.scenario, auxScenarios: fixture.auxScenarios,
      scenarioTitle: '雨夜车站', scenarioFileName: 'scenario.json', scenarioSourceDataCardId: 'scenario-card',
    } : {}),
    materials: fixture.materials.map((item) => ({ ...item, id: 'material', sourceKind: 'raw-json', isNative: false })),
    teams: fixture.teams, teamNames: fixture.teamNames, language: 'ja',
    readArenaHistory: true, arenaHistoryReadLimit: null, writeArenaHistory: false,
    readCurrentState: true, writeCurrentState: false,
    readNarrativeHistory: true, writeNarrativeHistory: true, narrativeHistoryReadLimit: 2,
    narrativeHistory: fixture.narrativeHistory,
    isDowngrade: false,
    adjudicationEvents: [{ id: 'event', type: 'binary', description: '是否晚点', probability: 50 }],
    storyLength: 'long', customStoryLength: '880',
    questionnaireSelections: [{ source: 'preset', kind: 'magical-girl', presetId: 'lore' }],
    questionnaires: fixture.questionnaires,
  };
};

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.quickCheck.mockResolvedValue({ hasSensitiveWords: false, matchDetails: [], detectedWords: [] });
  mocks.shield.mockImplementation((text: string) => ({ filteredText: text.split('SHIELD').join('被替换') }));
  mocks.resolveRandom.mockResolvedValue(undefined);
  mocks.updateFromMarkdown.mockResolvedValue(undefined);
  useBattleStore.setState(useBattleStore.getInitialState());
  useNarrativeHistoryStore.setState({ entries: [], lastUpdatedAt: null });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  useBattleStore.setState(useBattleStore.getInitialState());
  useNarrativeHistoryStore.setState({ entries: [], lastUpdatedAt: null });
});

async function configure(mode: typeof arenaModes[number], delivery: typeof arenaDeliveries[number], readHistory = true) {
  const fixture = arenaParityPayload(mode, delivery);
  const initial = useBattleStore.getInitialState();
  await act(async () => {
    useBattleStore.setState({
      battleMode: mode, generationMode: delivery, reportFormat: 'markdown',
      combatants: fixture.combatants.map((item, index) => ({ ...item, type: 'general-character', isValid: false, isPreset: index === 0, filename: `${index}.json`, sourceDataCardId: `card-${index}`, sourceDataCardUpdatedAt: '2026-01-01' })),
      teams: [{ id: 1, name: ' 红伞 ', isCollapsed: false }, { id: 2, name: '白灯', isCollapsed: true }],
      scenario: { content: fixture.scenario ?? null, fileName: 'scenario.json', isNative: false, sourceDataCardId: 'scenario-card' },
      auxScenarios: (fixture.auxScenarios ?? []).map((content) => ({ id: 'aux', content, isNative: false, fileName: 'aux.json' })),
      materials: fixture.materials.map((item) => ({ ...item, id: 'material', sourceKind: 'raw-json', sourceType: 'raw-json', isNative: false })),
      selectedLanguage: 'ja', storyLength: 'long', customStoryLength: '0880', arenaFreeRankingEnabled: true,
      selectedQuestionnaires: [{ source: 'preset', useLore: true, questionnaire: { id: 'lore', title: '地方志', kind: 'magical-girl', loreMarkdown: '雨城的约定', questions: [] } }],
      adjudicationEvents: [{ id: 'event', type: 'binary', description: '是否晚点', probability: 50 }],
      settings: { ...initial.settings, userGuidance: fixture.userGuidance, readArenaHistory: true, isArenaHistoryUnlimited: true,
        readCurrentState: true, writeArenaHistory: false, writeCurrentState: false,
        readNarrativeHistory: readHistory, writeNarrativeHistory: true, readNarrativeHistoryLimit: 2 },
    });
    useNarrativeHistoryStore.setState({ entries: [{ id: 'prior', title: '前情', content: '旧约定仍有效', createdAt: '2026-01-01', updatedAt: '2026-01-02' }] });
  });
}
function respond(delivery: typeof arenaDeliveries[number], status = 'completed') {
  if (delivery === 'non-stream') {
    mocks.dispatch.mockResolvedValue(new Response(JSON.stringify({ report, updatedCombatants: [], generationId: 'fixture-generation',
      impacts: [{ characterName: ' 雪绒 ', impact: 'SHIELD 成长' }, { characterName: '雪绒', currentStateSummary: '持伞' }],
    }), { headers: { 'Content-Type': 'application/json' } }));
  } else {
    mocks.openStream.mockResolvedValue(new Response(
      sse('reasoning', { chunk: 'REASONING_ONLY', source: 'provider' }) + sse('markdown', { chunk: markdown })
      + sse('done', { status, ok: status === 'completed' }),
      { headers: { 'Content-Type': 'text/event-stream', 'x-mahoshojo-generation-id': 'fixture-generation' } },
    ));
  }
}
const wireRequest = (delivery: typeof arenaDeliveries[number]) => delivery === 'stream'
  ? mocks.openStream.mock.calls[0][0].body : JSON.parse(mocks.dispatch.mock.calls[0][1].body);

describe('actual shared /battle and /arena engine behavior parity', () => {
  for (const mode of arenaModes) for (const delivery of arenaDeliveries) {
    it(`${mode}/${delivery} retains request, projected result and narrative history`, async () => {
      await configure(mode, delivery); respond(delivery);
      await act(async () => current.handleGenerate());
      expect(useBattleStore.getState().error).toBeFalsy();
      const request = wireRequest(delivery);
      request.generationRequestId = 'fixture-request';
      const state = useBattleStore.getState();
      const history = useNarrativeHistoryStore.getState().entries.map(({ createdAt: _created, updatedAt: _updated, ...entry }) => entry);
      expect(request).toEqual(expectedRequest(mode, delivery));
      const filteredMarkdown = markdown.replaceAll('SHIELD', '被替换');
      const structured = delivery === 'non-stream';
      expect(state.newsReport).toEqual(structured ? {
        ...report,
        headline: '被替换 雨夜',
        aiReasoning: { ...report.aiReasoning, parts: [{ text: '被替换 思考' }] },
        scenario: mode === 'scenario' ? '服务端情景' : undefined,
      } : null);
      expect(state.streamingMarkdown).toBe(structured ? null : filteredMarkdown);
      expect(state.latestAiImpacts).toEqual(structured
        ? [{ characterName: '雪绒', impact: '被替换 成长', currentStateSummary: '持伞' }] : null);
      expect(state.resultContext).toEqual({
        generationMode: delivery, battleMode: mode,
        scenarioDisplayName: mode === 'scenario' ? (structured ? '服务端情景' : '雨夜车站') : null,
      });
      expect(history).toEqual([
        { id: 'prior', title: '前情', content: '旧约定仍有效' },
        {
          id: 'arena-generation:fixture-generation',
          title: structured ? '被替换 雨夜' : 'SHIELD 雨夜',
          content: structured ? filteredMarkdown : markdown,
        },
      ]);
      expect(history[1].content).not.toMatch(/REASONING_ONLY|点评独立|MAHOSHOJO_ARENA_META/);
      respond(delivery);
      await act(async () => current.handleGenerate());
      expect(useNarrativeHistoryStore.getState().entries).toHaveLength(2);
    });
  }
  it('disabled history reading omits history while keeping independent write enabled', async () => {
    await configure('daily', 'non-stream', false); respond('non-stream');
    await act(async () => current.handleGenerate());
    const request = wireRequest('non-stream');
    expect(request.narrativeHistory).toBeUndefined();
    expect(request.narrativeHistoryReadLimit).toBeUndefined();
    expect(useNarrativeHistoryStore.getState().entries).toHaveLength(2);
  });
  it.each(['failed', 'cancelled', 'aborted'])('%s never appends a partial report', async (status) => {
    await configure('daily', 'stream'); respond('stream', status);
    await act(async () => current.handleGenerate());
    expect(useNarrativeHistoryStore.getState().entries).toHaveLength(1);
    expect(mocks.updateFromMarkdown).not.toHaveBeenCalled();
  });
  it.each([['classic', 2], ['kizuna', 2], ['daily', 1], ['scenario', 1]] as const)('%s keeps its canonical minimum of %s', async (mode, count) => {
    await configure(mode, 'non-stream');
    await act(async () => useBattleStore.setState({ combatants: useBattleStore.getState().combatants.slice(0, count) }));
    respond('non-stream'); await act(async () => current.handleGenerate());
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(wireRequest('non-stream').combatants).toHaveLength(count);
  });
  it('does not introduce a client-side roster cap below the existing 32 server limit', async () => {
    await configure('classic', 'non-stream');
    const first = useBattleStore.getState().combatants[0];
    await act(async () => useBattleStore.setState({ combatants: Array.from({ length: 32 }, () => ({ ...first })) }));
    respond('non-stream'); await act(async () => current.handleGenerate());
    expect(wireRequest('non-stream').combatants).toHaveLength(32);
  });
  it('keeps streamed reasoning and inline telemetry/meta out of the saved story', async () => {
    await configure('daily', 'stream');
    const withMeta = markdown + '\n\n<!-- MAHOSHOJO_ARENA_META {"report":{"headline":"hidden title"},"impacts":[]} -->';
    mocks.openStream.mockResolvedValue(new Response(
      sse('reasoning', { chunk: 'REASONING_ONLY', source: 'provider' }) + sse('markdown', { chunk: withMeta })
      + sse('telemetry', { aiModel: 'TELEMETRY_ONLY' }) + sse('done', { status: 'completed', ok: true }),
      { headers: { 'Content-Type': 'text/event-stream', 'x-mahoshojo-generation-id': 'fixture-generation' } },
    ));
    await act(async () => current.handleGenerate());
    const saved = useNarrativeHistoryStore.getState().entries.at(-1)!.content;
    expect(saved).toContain('重逢正文');
    expect(saved).not.toMatch(/REASONING_ONLY|TELEMETRY_ONLY|MAHOSHOJO_ARENA_META|hidden title/);
    expect(useBattleStore.getState().streamReasoning?.text).toBe('REASONING_ONLY');
  });

  it('applies the complete server-returned card without dropping roster metadata or extension fields', async () => {
    await configure('classic', 'non-stream');
    const original = useBattleStore.getState().combatants[0];
    const updated = { name: '雪绒', arena_history: { extension: '历史扩展' }, current_state: { summary: '持伞', extension: { keep: true } }, extension: { nested: ['updated'] } };
    mocks.dispatch.mockResolvedValue(new Response(JSON.stringify({ report, updatedCombatants: [updated], generationId: 'fixture-generation' }), { headers: { 'Content-Type': 'application/json' } }));
    await act(async () => current.handleGenerate());
    expect(useBattleStore.getState().combatants[0]).toEqual({ ...original, data: updated });
  });

});
