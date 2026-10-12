// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStrictSetupMissingReasons, deriveSeasonStrictRules as sharedRules } from '@mahoshojo/domain/arena-strict-setup';
import { deriveSeasonStrictRules, type SeasonsConfig } from '@/lib/seasons';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';
const host = vi.hoisted(() => ({ scenario: vi.fn() }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ isAuthenticated: false }) }));
vi.mock('@/components/arena/hooks/useBattleActions', () => ({ useBattleActions: () => ({ handleScenarioPaste: host.scenario }) }));
import { RankingQuickActions } from '@/components/arena/components/RankingQuickActions';

const seasons: SeasonsConfig = { schemaVersion: 1, seasons: [{ id: 'S1', name: '合成赛季', startsAt: '2026-01-01', status: 'current', description: '' }] };
let root: Root; let container: HTMLDivElement; let client: QueryClient;
const render = () => act(async () => root.render(<QueryClientProvider client={client}><RankingQuickActions /></QueryClientProvider>));
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
