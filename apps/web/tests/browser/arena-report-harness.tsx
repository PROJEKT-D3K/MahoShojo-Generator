import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useColorModePreference } from '@mahoshojo/ui-web/color-mode';
import { ErrorMessageBox } from '@mahoshojo/ui-web/details-controls';

import { useBattleEngine } from '@/components/arena/hooks/useBattleEngine';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';
import { useNarrativeHistoryStore } from '@/components/arena/stores/useNarrativeHistoryStore';
import { BattleResult } from '@/components/arena/components/BattleResult';
import { GenerationModeSwitcher } from '@/components/arena/components/GenerationModeSwitcher';
import { BattleModeSwitcher } from '@/components/arena/components/BattleModeSwitcher';
import type { BattleStoreState } from '@/components/arena/types';
import { GUIDANCE_A, SCENARIO_A, getHarnessConfiguration, scenario } from '../../../../scripts/fixtures/web-arena-report.mjs';

const configuration = getHarnessConfiguration(window.location.search);
const initial = useBattleStore.getInitialState();
useBattleStore.setState({
  ...initial,
  generationMode: configuration.generation as BattleStoreState['generationMode'],
  reportFormat: configuration.format as BattleStoreState['reportFormat'],
  battleMode: 'scenario',
  scenario: SCENARIO_A,
  userProviderConfig: { providerId: 'system', apiKey: '', modelId: 'selection-model-A' },
  combatants: [{
    type: 'general-character', filename: 'synthetic-character-A.json',
    data: { name: '角色甲' }, isValid: false, isPreset: false,
  }],
  settings: {
    ...initial.settings,
    writeArenaHistory: true, writeCurrentState: true, writeNarrativeHistory: false,
    userGuidance: GUIDANCE_A,
  },
}, true);
useNarrativeHistoryStore.setState(useNarrativeHistoryStore.getInitialState(), true);

const setNextSettings = () => {
  const state = useBattleStore.getState();
  state.setGenerationMode(configuration.generation === 'stream' ? 'non-stream' : 'stream');
  state.setBattleMode('daily');
  state.setScenario(scenario('下一场情景 B'));
  state.setReportFormat(configuration.format === 'markdown' ? 'web' : 'markdown');
  state.setUserProviderConfig({ providerId: 'system', apiKey: '', modelId: 'selection-model-B' });
  state.updateSettings({ userGuidance: '下一场指导 B' });
};

function Harness() {
  const engine = useBattleEngine();
  const colorMode = useColorModePreference();
  const state = useBattleStore();
  const observation = {
    configuration,
    currentSettings: {
      generationMode: state.generationMode,
      battleMode: state.battleMode,
      reportFormat: state.reportFormat,
      scenario: state.scenario,
      selectedModel: state.userProviderConfig?.modelId ?? null,
      userGuidance: state.settings.userGuidance,
    },
    resultContext: state.resultContext,
    resultReportFormat: state.resultReportFormat,
    resultWebReady: state.resultWebReady,
    isGenerating: state.isGenerating,
    error: state.error,
    lastGenerationId: state.lastGenerationId,
    lastGenerationRepairContext: state.lastGenerationRepairContext,
    repairAppliedGenerationId: state.repairAppliedGenerationId,
    roster: state.combatants,
    updatedCombatants: state.updatedCombatants,
  };
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4" data-testid="arena-report-harness">
      <header>
        <h1 className="text-2xl font-bold">竞技场战报本地组件验收</h1>
        <p>仅使用合成战报与本地可编辑角色，网络由测试服务限定。</p>
      </header>
      <section className="space-y-4" aria-label="下一场设置">
        <div className="flex gap-3">{(['light', 'dark'] as const).map(mode => <button key={mode} type="button" onClick={() => colorMode.setPreference(mode)}>{mode === 'light' ? '浅色验收' : '深色验收'}</button>)}</div>
        <GenerationModeSwitcher />
        <BattleModeSwitcher />
        <div className="flex flex-wrap gap-3">
          <button type="button" className="generate-button" disabled={state.isGenerating}
            onClick={() => void engine.handleGenerate()}>生成合成报告 A</button>
          <button type="button" className="rounded border px-3 py-2" disabled={state.isGenerating}
            onClick={setNextSettings}>修改下一场设置</button>
        </div>
      </section>
      {state.error ? <section data-testid="generation-error"><ErrorMessageBox message={state.error} /></section> : null}
      <section data-testid="result-surface" aria-label="真实战报与角色修复">
        <BattleResult onSaveImage={() => undefined} />
      </section>
      <section className="grid gap-3 md:grid-cols-2" aria-label="错误文字对比" id="error-help">
        {['默认红色', '蓝色主题'].map((label, index) => (
          <div key={label} className={index ? 'blue-theme' : undefined} data-testid={index ? 'error-blue' : 'error-red'}>
            <ErrorMessageBox message={`${label}：普通正文保持清晰，原文换行仍保留。\n示例错误内容，不触发真实请求。`}>
              <div className="mt-2 text-xs opacity-95">
                <a href="#error-help" className="underline underline-offset-2 hover:opacity-100">95% 帮助链接：悬停与焦点仍继承错误文字颜色</a>
              </div>
            </ErrorMessageBox>
          </div>
        ))}
      </section>
      <section aria-label="只读验收数据">
        <h2 className="font-semibold">当前设置、结果上下文与角色数据</h2>
        <pre data-testid="harness-observation" className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
          {JSON.stringify(observation, null, 2)}
        </pre>
      </section>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Arena report harness requires #root');
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(root).render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
