// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStrictSetupMissingReasons, deriveSeasonStrictRules as sharedRules } from '@mahoshojo/domain/arena-strict-setup';
import { deriveSeasonStrictRules, type SeasonsConfig } from '@/lib/seasons';
import { SCENARIO_PRESET_LIST } from '@mahoshojo/domain/scenario-presets';
import type { QuestionnaireSelection } from '@mahoshojo/domain/questionnaire-selection';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';
const host = vi.hoisted(() => ({ scenario: vi.fn() }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ isAuthenticated: false }) }));
vi.mock('@/components/arena/hooks/useBattleActions', () => ({ useBattleActions: () => ({ handleScenarioPaste: host.scenario }) }));
import { RankingQuickActions } from '@/components/arena/components/RankingQuickActions';

const seasons: SeasonsConfig = { schemaVersion: 1, seasons: [{ id: 'S1', name: '合成赛季', startsAt: '2026-01-01', status: 'current', description: '' }] };
let root: Root; let container: HTMLDivElement; let client: QueryClient;
const render = () => act(async () => root.render(<QueryClientProvider client={client}><RankingQuickActions /></QueryClientProvider>));
const apply = () => act(async () => [...container.querySelectorAll('button')].find((node) => node.textContent === '一键严格设置')!.click());
const basic = () => [...container.querySelectorAll('div')].find((element) => element.className === 'text-xs font-semibold text-gray-900' && element.textContent === '严格计分基础条件')!.parentElement!.parentElement!;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); useBattleStore.setState(useBattleStore.getInitialState(), true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['seasonsConfig'], seasons);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No new request for cached seasons and local missing setup'); }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });

describe('real Web Strict controls consume shared configuration checks', () => {
  it('uses the same season implementation and preserves its existing basic missing checklist', async () => {
    expect(deriveSeasonStrictRules).toBe(sharedRules);
    const prior = useBattleStore.getState();
    await render();
    const expected = buildStrictSetupMissingReasons({ isAuthenticated: false, battleMode: prior.battleMode,
      requiredMode: 'classic', requiredStoryGuidance: '', requiredScenarioPresetFilename: null,
      scenarioFileName: null, scenarioIsPreset: false, rankableCombatants: [], userGuidance: prior.settings.userGuidance,
      selectedLanguage: prior.selectedLanguage, readArenaHistory: prior.settings.readArenaHistory,
      readCurrentState: prior.settings.readCurrentState, readNarrativeHistory: prior.settings.readNarrativeHistory,
      adjudicationEventCount: 0, userProviderConfigModelId: null, scenarioEnabled: false, auxScenarioCount: 0, materialCount: 0,
      questionnaireLoreEnabled: false, questionnaireLoreAllowed: false, requiredQuestionnaireLorePresetIds: [], questionnaireLoreIds: [] });
    expect([...basic().querySelectorAll('li')].map((element) => element.textContent)).toEqual(expected);
    expect(container.textContent).toContain('一键严格设置');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('严格设置按卡库身份清除同名角色引导，旧上传角色仍兼容', async () => {
    useBattleStore.setState({ combatants: [
      { type: 'general-character', filename: '同名.json', isValid: false, isPreset: false, cardLibrarySelectionId: 'local:one', characterGuidance: '本地行动', data: { name: '同名' } },
      { type: 'general-character', filename: '同名.json', isValid: false, isPreset: false, cardLibrarySelectionId: 'cache:two', characterGuidance: '缓存行动', data: { name: '同名' } },
      { type: 'general-character', filename: 'local:one', isValid: false, isPreset: false, characterGuidance: '上传行动', data: { name: '上传' } },
    ] });
    await render(); await apply();
    expect(useBattleStore.getState().combatants.map((item) => 'data' in item ? item.characterGuidance : undefined)).toEqual(['', '', '']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains the real one-click setup action, and keeps it disabled while generating', async () => {
    const prior = useBattleStore.getState();
    useBattleStore.setState({ battleMode: 'daily', selectedLanguage: 'en-US',
      settings: { ...prior.settings, userGuidance: '自定义', readArenaHistory: true, readCurrentState: true, readNarrativeHistory: true },
      combatants: [{ type: 'general-character', filename: 'preset.json', isValid: false, isPreset: true, characterGuidance: '行动', data: { name: '合成角色' } }] });
    await render();
    const button = [...container.querySelectorAll('button')].find((node) => node.textContent === '一键严格设置')!;
    await act(async () => button.click());
    const next = useBattleStore.getState();
    expect(next.battleMode).toBe('classic'); expect(next.selectedLanguage).toBe('zh-CN');
    expect(next.settings).toMatchObject({ userGuidance: '', readArenaHistory: false, readCurrentState: false, readNarrativeHistory: false });
    expect(next.combatants[0]).toMatchObject({ characterGuidance: '' });
    expect([...basic().querySelectorAll('li')].map((element) => element.textContent)).toEqual(['需要先登录']);
    await act(async () => useBattleStore.setState({ isGenerating: true })); expect(button.disabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled(); expect(host.scenario).not.toHaveBeenCalled();
  });
});

const loreSelection = (source: QuestionnaireSelection['source'], id: string, loreMarkdown = '旧设定'): QuestionnaireSelection => ({
  source, selectionId: id, questionnaire: { id, title: '问卷', kind: 'magical-girl', questions: [], loreMarkdown },
});
const setSeasonRules = (specialRules: NonNullable<SeasonsConfig['seasons'][number]['specialRules']>) => {
  client.setQueryData(['seasonsConfig'], { ...seasons, seasons: [{ ...seasons.seasons[0], specialRules }] });
};
const presetIndex = { presets: [{ id: 'required', kind: 'magical-girl', title: '赛季问卷', path: '/questionnaires/presets/required.json' }] };

describe('real Web one-click Strict resource and projection integration', () => {
  it('loads official Lore before enabling it, preserves model repair and leaves unrelated settings intact', async () => {
    setSeasonRules({ mode: 'daily', storyGuidance: '赛季故事', questionnaireLorePresetIds: ['required', 'required'] });
    const prior = useBattleStore.getState();
    useBattleStore.setState({
      selectedQuestionnaires: [loreSelection('upload', 'required')],
      userProviderConfig: { providerId: 'system', modelId: 'gemma-3-4b-it', apiKey: '' },
      scenario: { content: { title: '旧情景' }, fileName: 'old.json', isNative: false },
      auxScenarios: [{ id: 'aux', content: {}, fileName: 'aux.json', isNative: false }],
      materials: [{ id: 'material', name: '素材', content: {}, fileName: null, sourceKind: 'raw-json', sourceType: 'raw-json', isNative: false }],
      adjudicationEvents: [{ id: 'event', type: 'binary', description: '判定' }],
      arenaFreeRankingEnabled: true, storyLength: 'long', reportFormat: 'web',
      settings: { ...prior.settings, writeNarrativeHistory: true, isArenaHistoryUnlimited: true, readArenaHistoryLimit: 7 },
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/questionnaires/presets/index.json') return Response.json(presetIndex);
      if (url === '/questionnaires/presets/required.json') return Response.json({ loreMarkdown: '真实资源', nativeAllowed: false });
      throw new Error(`Unexpected request: ${url}`);
    }));
    await render(); await apply();
    const next = useBattleStore.getState();
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/questionnaires/presets/index.json', '/questionnaires/presets/required.json']);
    expect(next.selectedQuestionnaires).toHaveLength(2);
    expect(next.selectedQuestionnaires[0]).toMatchObject({ source: 'upload', useLore: false, questionnaire: { loreMarkdown: '旧设定' } });
    expect(next.selectedQuestionnaires[1]).toMatchObject({ source: 'preset', selectionId: 'required::season', useLore: true,
      questionnaire: { id: 'required', kind: 'magical-girl', title: '赛季问卷', loreMarkdown: '真实资源', nativeAllowed: false } });
    expect(next).toMatchObject({ battleMode: 'daily', selectedLanguage: 'zh-CN', scenario: { content: null }, auxScenarios: [], materials: [],
      adjudicationEvents: [], arenaFreeRankingEnabled: true, storyLength: 'long', reportFormat: 'web',
      userProviderConfig: { providerId: 'system', modelId: 'default', apiKey: '' },
      settings: { userGuidance: '赛季故事', readArenaHistory: false, readCurrentState: false, readNarrativeHistory: false,
        writeNarrativeHistory: true, isArenaHistoryUnlimited: true, readArenaHistoryLimit: 7 } });
    expect(next.error).toContain('已自动添加赛季问卷设定卡 1 张 / 已关闭其它设定注入 1 张');
    expect(next.error).toContain('已将 AI 模型恢复为「默认策略」');
    expect(localStorage.getItem('arena.customProvider.selected')).toBe('system');
    expect(host.scenario).not.toHaveBeenCalled();
  });

  it.each([true, false])('applies the optional Lore policy %s without fetching resources', async (allowed) => {
    setSeasonRules({ questionnaireLoreAllowed: allowed });
    const selections = [loreSelection('database', 'optional')];
    useBattleStore.setState({ selectedQuestionnaires: selections });
    await render(); await apply();
    if (allowed) {
      expect(useBattleStore.getState().selectedQuestionnaires).toBe(selections);
    } else {
      expect(useBattleStore.getState().selectedQuestionnaires[0]).toMatchObject({ source: 'database', useLore: false });
      expect(useBattleStore.getState().error).toContain('已关闭问卷/设定卡 Lore 注入 1 张');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps scenario fetch and host normalization after the common setup', async () => {
    const filename = SCENARIO_PRESET_LIST[0]!.filename;
    setSeasonRules({ mode: 'scenario', scenarioPresetFilename: filename });
    const text = JSON.stringify({ title: '赛季情景' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(text)));
    host.scenario.mockImplementationOnce(async () => {
      useBattleStore.setState({ adjudicationEvents: [{ id: 'imported', type: 'binary', description: '情景判定' }] });
    });
    await render(); await apply();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/scenario-presets/${encodeURIComponent(filename)}`);
    expect(host.scenario).toHaveBeenCalledExactlyOnceWith(text, { fileName: filename, isPreset: true });
    expect(useBattleStore.getState()).toMatchObject({ battleMode: 'scenario', adjudicationEvents: [] });
  });

  it.each([
    { name: 'index missing the required preset', index: { presets: [] }, data: {}, message: '未找到赛季指定的预设问卷：required', calls: 1 },
    { name: 'unparseable preset', index: presetIndex, data: null, message: '预设问卷解析失败：required', calls: 2 },
    { name: 'preset with a different ID', index: presetIndex, data: { id: 'different', loreMarkdown: '不匹配资源' }, message: '预设问卷标识不匹配：required', calls: 2 },
    { name: 'preset without Lore', index: presetIndex, data: { questions: ['问题'] }, message: '不包含 loreMarkdown', calls: 2 },
  ])('reports $name without replacing existing Lore or loading a scenario', async ({ index, data, message, calls }) => {
    setSeasonRules({ mode: 'scenario', scenarioPresetFilename: SCENARIO_PRESET_LIST[0]!.filename, questionnaireLorePresetIds: ['required'] });
    const selections = [loreSelection('preset', 'required')];
    useBattleStore.setState({ selectedQuestionnaires: selections, selectedLanguage: 'en-US' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/questionnaires/presets/index.json' ? index : data)));
    await render(); await apply();
    const next = useBattleStore.getState();
    expect(next.selectedQuestionnaires).toBe(selections);
    expect(next.error).toContain(`❌ 无法应用赛季问卷/设定卡规则：`);
    expect(next.error).toContain(message);
    expect(next.selectedLanguage).toBe('zh-CN');
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(host.scenario).not.toHaveBeenCalled();
  });
});
