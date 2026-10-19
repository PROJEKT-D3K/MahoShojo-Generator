// @vitest-environment jsdom

import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// 实际消费 engine、store、结果页、修复 hook、报告转换与 unsigned domain；只替换外部边界。
const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(), ownedHeaders: vi.fn(), openStream: vi.fn(), quickCheck: vi.fn(), cooldown: vi.fn(),
  download: vi.fn(), update: vi.fn(), retryUpdate: vi.fn(), push: vi.fn(), backup: vi.fn(), roomSession: false,
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
vi.mock('@/components/arena/multiplayer/useArenaRoom', () => ({
  useArenaRoomContext: () => mocks.roomSession ? {
    state: { session: { roomId: 'synthetic-room' } },
    controller: { getSnapshot: () => ({ session: { roomId: 'synthetic-room' } }) },
  } : null,
}));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({ useGenerationApiIntentLatch: () => ({ tryAcquire: () => ({ dispatch: mocks.dispatch }) }) }));
vi.mock('@/lib/arena/resumable-generation-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/arena/resumable-generation-client')>(),
  openArenaGenerationStream: mocks.openStream,
}));

import { useBattleEngine } from '@/components/arena/hooks/useBattleEngine';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';
import { toBattleReportMarkdown } from '@/components/arena/utils/battleReportMarkdown';
import { useNarrativeHistoryStore } from '@/components/arena/stores/useNarrativeHistoryStore';
import type { AuthIdentity } from '@/lib/auth-identity';

import { BattleResult } from '@/components/arena/components/BattleResult';
import { GenerationModeSwitcher } from '@/components/arena/components/GenerationModeSwitcher';
import { BattleModeSwitcher } from '@/components/arena/components/BattleModeSwitcher';
vi.mock('@/components/arena/components/BattleIllustrationPanel', () => ({ BattleIllustrationPanel: () => <aside>插图工具</aside> }));
vi.mock('@/components/SaveToCloudButton', () => ({ default: () => null }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ isAuthenticated: false, loading: false, user: null, userBadges: [] }) }));
vi.mock('@/lib/client/snapdomCapture', () => ({ capturePngBlob: vi.fn() }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: mocks.download, createBlobUrl: vi.fn() }));
const sse = (event: string, payload: unknown) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
const safeCheck = (text: string) => ({ hasSensitiveWords: false, matchDetails: [], detectedWords: [], filteredText: text });
const body = '完成正文标记 A；这一份生成结果不能因选择下一场设置而丢失。'.repeat(8);
const scenario = (title: string) => ({ content: { title, description: `${title}内容` }, fileName: `${title}.json`, isNative: false });
let current: ReturnType<typeof useBattleEngine>, root: Root, container: HTMLDivElement;
const Harness = () => {
  const engine = useBattleEngine();
  useEffect(() => { current = engine; });
  return (
    <>
      <GenerationModeSwitcher />
      <BattleModeSwitcher />
      <BattleResult onSaveImage={() => {}} />
    </>
  );
};
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.roomSession = false;
  localStorage.clear();
  sessionStorage.clear();
  mocks.quickCheck.mockImplementation(async (text: string) => safeCheck(text));
  mocks.update.mockResolvedValue(undefined); mocks.retryUpdate.mockResolvedValue(undefined);
  mocks.ownedHeaders.mockImplementation(async (identity: AuthIdentity) => ({ identity, headers: {} }));
  vi.stubGlobal('fetch', vi.fn((url: string) => { if (url === '/api/verify-origin') return Promise.resolve(Response.json({ isValid: false })); throw new Error(`No external network permitted: ${url}`); })); vi.spyOn(window, 'confirm').mockReturnValue(true);
  const initial = useBattleStore.getInitialState();
  useBattleStore.setState({ ...initial, reportFormat: 'markdown', generationMode: 'stream', battleMode: 'scenario', scenario: scenario('生成时情景 A'),
    combatants: [{ type: 'general-character', filename: 'test.json', data: { name: '角色甲' }, isValid: false, isPreset: false }],
    settings: { ...initial.settings, writeArenaHistory: true, writeCurrentState: true, writeNarrativeHistory: false, userGuidance: '生成时指导 A' },
  }, true);
  useNarrativeHistoryStore.setState(useNarrativeHistoryStore.getInitialState());
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const settle = async () => {
  await act(async () => { await vi.dynamicImportSettled(); });
};
const structuredReport = () => ({
  headline: '完成标题 A',
  article: { body, analysis: '完成点评 A' },
  officialReport: { winner: '角色甲', conclusion: '完成结论 A' },
  reporterInfo: { name: '记者 A', publication: '报刊 A' },
  userGuidance: '生成时指导 A',
});

const generationId = 'generation-repair-context-A';
const markdown = `# 完成标题 A\n\n${body}\n\n## 胜利者\n\n- 角色甲`;
const patch = { impacts: [{ combatantIndex: 0, characterName: '角色甲', impact: '用户修复影响', currentStateSummary: '用户修复状态' }] };
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('button')];
const button = (label: string) => {
  const target = buttons().find(item => item.textContent?.includes(label));
  if (!target) throw new Error(`找不到按钮「${label}」`);
  return target;
};
const click = async (label: string) => {
  await act(async () => button(label).click());
  await settle();
};
const enterDraft = async (value = JSON.stringify(patch)) => { const area = container.querySelector('textarea')!;
  expect(area).toBeTruthy();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value); area.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(area.value).toBe(value); };
const complete = async (mode: 'stream' | 'non-stream' = 'stream', text = markdown) => {
  await act(async () => useBattleStore.getState().setGenerationMode(mode));
  if (mode === 'stream') mocks.openStream.mockResolvedValueOnce(new Response(sse('snapshot', { markdown: text, status: 'completed' }) + sse('done', { status: 'completed', ok: true }), { headers: { 'Content-Type': 'text/event-stream', 'x-mahoshojo-generation-id': generationId, 'x-mahoshojo-stream-meta': encodeURIComponent(JSON.stringify({ outputContract: 'stream-markdown', reportFormat: 'markdown', userGuidance: '生成时指导 A', mode: useBattleStore.getState().battleMode, scenarioDisplayName: '生成时情景 A' })) } }));
  else mocks.dispatch.mockResolvedValueOnce(Response.json({ report: structuredReport(), generationId, updatedCombatants: [] }));
  await act(async () => current.handleGenerate()); await settle();
  expect(useBattleStore.getState().error).toBeNull();
  expect(useBattleStore.getState().lastGenerationId).toBe(generationId);
  expect(useBattleStore.getState().lastGenerationRepairContext?.generationId).toBe(generationId);
  expect(container.textContent).toContain('完成标题 A');
  await click('自定义修复本次角色变化');
  expect(button('AI 重新生成修复草稿').disabled).toBe(false);
};

it.each(['stream', 'non-stream'] as const)('%s 切换下一场生成方式仍保留已完成战报的真实修复控件', async mode => {
  await complete(mode);
  expect(container.querySelector('textarea')).not.toBeNull();
  const original = { newsReport: useBattleStore.getState().newsReport, streamingMarkdown: useBattleStore.getState().streamingMarkdown };
  await act(async () => buttons().find(x => x.textContent === (mode === 'stream' ? '非流式' : '流式'))!.click()); await settle();
  expect(container.textContent).toContain('完成标题 A');
  expect(container.textContent).toContain('自定义修复本次角色变化');
  expect(container.querySelector('textarea')).not.toBeNull();
  expect(useBattleStore.getState()).toMatchObject(original);
  expect(mode === 'stream' ? original.newsReport : original.streamingMarkdown).toBeNull();
});
it('AI 草稿使用已完成战报模式与指导，且不会自动应用', async () => {
  await complete(); const before = useBattleStore.getState().combatants;
  await click('日常模式');
  await act(async () => useBattleStore.getState().updateSettings({ userGuidance: '下一场指导 B' }));
  mocks.dispatch.mockResolvedValueOnce(Response.json({ success: true, ...patch }));
  await click('AI 重新生成修复草稿');
  const [url, init] = mocks.dispatch.mock.calls.at(-1)!; const payload = JSON.parse(init.body);
  expect(url).toBe('/api/arena/repair-combatant-meta');
  expect(payload.battleReportMarkdown).toBe(markdown);
  expect(payload.mode).toBe('scenario');
  expect(payload.userGuidance).toBe('生成时指导 A');
  expect(payload.scenario?.title).toBe('生成时情景 A');
  expect(useBattleStore.getState().resultContext).toMatchObject({ battleMode: 'scenario', scenarioDisplayName: '生成时情景 A' });
  expect(container.querySelector('textarea')!.value).toContain('用户修复影响');
  expect(useBattleStore.getState().combatants).toBe(before);
  expect(useBattleStore.getState().repairAppliedGenerationId).toBeNull();
});
it('非流式 AI 草稿复用真实报告转换且不会采用下一场情景', async () => {
  await complete('non-stream');
  await act(async () => useBattleStore.getState().setScenario(scenario('下一场情景 B')));
  mocks.dispatch.mockResolvedValueOnce(Response.json({ success: true, ...patch }));
  await click('AI 重新生成修复草稿');
  const [url, init] = mocks.dispatch.mock.calls.at(-1)!; const payload = JSON.parse(init.body);
  expect(payload.battleReportMarkdown).toBe(toBattleReportMarkdown(useBattleStore.getState().newsReport!));
  expect(payload.mode).toBe('scenario');
  expect(payload.scenario?.title).toBe('生成时情景 A');
  expect(useBattleStore.getState().resultContext?.scenarioDisplayName).toBe('生成时情景 A');
});
it('缺失 effect 使用原战报情景，经两次确认后应用并移除 canonical 信任', async () => {
  await complete();
  await act(async () => {
    const s = useBattleStore.getState(); s.setScenario(scenario('下一场情景 B')); s.updateSettings({ userGuidance: '下一场指导 B' });
    s.setCombatants([{ type: 'general-character', filename: 'preset.json', isValid: true, isPreset: true, sourceDataCardId: 'card-synthetic-A', sourceDataCardUpdatedAt: 'old', arenaRoomKey: 'synthetic-room-key', adjudicationSourceKey: 'synthetic-source-key', data: { name: '角色甲', signature: 'synthetic-signature', metadata: { signature: 'synthetic-legacy-signature' } } }]);
  });
  await enterDraft();
  await click('应用修复');
  const result = useBattleStore.getState().combatants[0] as any; const entry = result.data.arena_history.entries[0];
  expect(entry).toMatchObject({ type: 'scenario', title: '完成标题 A', winner: '角色甲', impact: '用户修复影响', metadata: { generation_id: generationId, scenario_title: '生成时情景 A', user_guidance: '生成时指导 A', non_native_data_involved: true } });
  expect(result.data.current_state).toMatchObject({ generation_id: generationId, summary: '用户修复状态' });
  expect(window.confirm).toHaveBeenCalledTimes(2);
  expect(vi.mocked(window.confirm).mock.calls[0][0]).toContain('非原生可编辑版本');
  expect(vi.mocked(window.confirm).mock.calls[1][0]).toContain('自定义 effect');
  expect(result.isValid).toBe(false);
  expect(result.isPreset).toBe(false);
  expect(result.data.signature).toBeUndefined();
  expect(result.data.metadata.signature).toBeUndefined();
  for (const key of ['sourceDataCardId', 'sourceDataCardUpdatedAt', 'arenaRoomKey', 'adjudicationSourceKey']) expect(result[key]).toBeUndefined();
  expect(button('重试角色更新').disabled).toBe(true);
});
it('匹配 generation 的既有历史仅替换 impact，保留原 metadata', async () => {
  await complete(); const originalEntry = { id: 1, type: 'scenario', title: '完成标题 A', winner: '角色甲', participants: ['角色甲'], impact: '旧影响', metadata: { generation_id: generationId, scenario_title: '生成时情景 A', user_guidance: '生成时指导 A' } };
  await act(async () => useBattleStore.getState().setCombatants([{ type: 'general-character', filename: 'native.json', isValid: true, isPreset: false, data: { name: '角色甲', signature: 'synthetic-signature', arena_history: { entries: [originalEntry] }, current_state: { generation_id: generationId, summary: '旧状态' } } }]));
  await click('日常模式');
  await enterDraft();
  await click('应用修复'); const result = (useBattleStore.getState().combatants[0] as any).data;
  expect(result.arena_history.entries).toEqual([{ ...originalEntry, impact: '用户修复影响' }]);
  expect(result.current_state.summary).toBe('用户修复状态');
  expect(window.confirm).toHaveBeenCalledOnce();
  expect(result.signature).toBeUndefined();
});
it.each(['trust', 'missing'] as const)('拒绝 %s 确认不修改 roster 或修复标记', async decline => {
  await complete(); if (decline === 'trust') await act(async () => useBattleStore.getState().setCombatants([{ type: 'general-character', filename: 'native.json', isValid: true, isPreset: false, data: { name: '角色甲', signature: 'synthetic-signature' } }]));
  const before = useBattleStore.getState().combatants; vi.mocked(window.confirm).mockReturnValue(false);
  await enterDraft();
  await click('应用修复');
  expect(useBattleStore.getState().combatants).toBe(before);
  expect(useBattleStore.getState().repairAppliedGenerationId).toBeNull();
  expect(window.confirm).toHaveBeenCalledOnce();
});
it('日常参与者报告不会因下一场改为经典模式而误阻止手工修复', async () => {
  await act(async () => useBattleStore.getState().setBattleMode('daily')); const dailyMarkdown = `# 完成标题 A\n\n参与者：角色甲\n\n${body}`;
  await complete('stream', dailyMarkdown);
  await enterDraft();
  await click('经典模式');
  await click('应用修复');
  expect(container.textContent).not.toContain('无法从战报中解析标题/胜利者');
  expect(window.confirm).toHaveBeenCalledOnce();
  expect(useBattleStore.getState().repairAppliedGenerationId).toBe(generationId);
});

it('原 roster 创建缺失历史沿用战报模式，忽略下一场模式', async () => {
  await complete(); const originalRoster = useBattleStore.getState().combatants;
  await click('日常模式');
  await enterDraft();
  await click('应用修复');
  const repaired = (useBattleStore.getState().combatants[0] as any).data;
  expect(useBattleStore.getState().combatants).not.toBe(originalRoster);
  expect(repaired.arena_history.entries[0]).toMatchObject({ type: 'scenario', title: '完成标题 A', metadata: { generation_id: generationId, scenario_title: '生成时情景 A' } });
  expect(useBattleStore.getState().resultContext?.battleMode).toBe('scenario');
  expect(window.confirm).toHaveBeenCalledOnce();
});

it('其他 generation 当前状态会原子拒绝整批修复', async () => {
  await complete(); const originalEntry = { id: 1, type: 'scenario', title: '完成标题 A', winner: '角色甲', participants: ['角色甲'], impact: '旧影响', metadata: { generation_id: generationId } };
  await act(async () => useBattleStore.getState().setCombatants([{ type: 'general-character', filename: 'test.json', isValid: false, isPreset: false, data: { name: '角色甲', arena_history: { entries: [originalEntry] }, current_state: { generation_id: 'later-generation-B', summary: '后续状态 B' } } }]));
  const before = useBattleStore.getState().combatants;
  await enterDraft();
  await click('应用修复');
  expect(useBattleStore.getState().combatants).toBe(before);
  expect(useBattleStore.getState().repairAppliedGenerationId).toBeNull();
  expect(container.textContent).toContain('未找到本次 generation 的当前状态');
  expect(window.confirm).toHaveBeenCalledOnce();
});

it('no-op 保留原生签名且不要求无意义确认', async () => {
  await complete();
  await act(async () => useBattleStore.getState().setCombatants([{ type: 'general-character', filename: 'native.json', isValid: true, isPreset: true, data: { name: '角色甲', signature: 'synthetic-signature', arena_history: { entries: [{ id: 1, impact: '用户修复影响', metadata: { generation_id: generationId } }] }, current_state: { generation_id: generationId, summary: '用户修复状态' } } }]));
  const before = useBattleStore.getState().combatants;
  await enterDraft();
  await click('应用修复');
  expect(useBattleStore.getState().combatants).toBe(before);
  expect(window.confirm).not.toHaveBeenCalled();
  expect(useBattleStore.getState().repairAppliedGenerationId).toBeNull();
  expect(container.textContent).toContain('草稿内容与当前角色数据相同');
});

it('AI 返回前 generation 已变化时丢弃旧草稿', async () => {
  await complete(); let resolve!: (response: Response) => void;
  mocks.dispatch.mockImplementationOnce(() => new Promise<Response>(yes => { resolve = yes; }));
  await act(async () => button('AI 重新生成修复草稿').click());
  await act(async () => useBattleStore.getState().setLastGenerationId('generation-new-B'));
  await act(async () => resolve(Response.json({ success: true, ...patch }))); await settle();
  expect(container.querySelector('textarea')!.value).not.toContain('用户修复影响');
  expect(container.textContent).toContain('旧的 AI 修复草稿已丢弃');
  expect(useBattleStore.getState().repairAppliedGenerationId).toBeNull();
});

it('旧流式结果缺失模式时不能使用下一场模式调用 AI，仍可修补已有同代历史', async () => {
  await complete();
  const existingEntry = { id: 1, type: 'scenario', title: '完成标题 A', impact: '旧影响', metadata: { generation_id: generationId } };
  await act(async () => {
    useBattleStore.setState({ resultContext: null, streamUserGuidance: null });
    useBattleStore.getState().setCombatants([{ type: 'general-character', filename: 'test.json', isValid: false, isPreset: false, data: {
      name: '角色甲', arena_history: { entries: [existingEntry] }, current_state: { generation_id: generationId, summary: '旧状态' },
    } }]);
    useBattleStore.getState().updateSettings({ userGuidance: '下一场指导 B' });
  });
  await click('AI 重新生成修复草稿');
  expect(mocks.dispatch).not.toHaveBeenCalled();
  await enterDraft();
  await click('应用修复');
  expect((useBattleStore.getState().combatants[0] as any).data.arena_history.entries).toEqual([
    { ...existingEntry, impact: '用户修复影响' },
  ]);
});

it('旧流式结果缺失模式时不能用下一场模式创建缺失历史', async () => {
  await complete();
  const before = useBattleStore.getState().combatants;
  await act(async () => useBattleStore.setState({ resultContext: null, streamUserGuidance: null }));
  await enterDraft();
  await click('应用修复');
  expect(useBattleStore.getState().combatants).toBe(before);
  expect(useBattleStore.getState().repairAppliedGenerationId).toBeNull();
});

it('模式缺失仍允许经确认创建不依赖 history type 的当前状态', async () => {
  await complete();
  await act(async () => useBattleStore.setState({ resultContext: null }));
  await enterDraft(JSON.stringify({ impacts: [{ combatantIndex: 0, characterName: '角色甲', currentStateSummary: '仅修复状态' }] }));
  await click('应用修复');
  const data = (useBattleStore.getState().combatants[0] as any).data;
  expect(data.current_state).toMatchObject({ generation_id: generationId, summary: '仅修复状态' });
  expect(data.arena_history).toBeUndefined();
  expect(window.confirm).toHaveBeenCalledOnce();
});

it('旧报告缺指导与修复情景快照时不从下一场草稿补入', async () => {
  await complete('non-stream');
  await act(async () => {
    const state = useBattleStore.getState();
    const { userGuidance: _guidance, ...legacyReport } = state.newsReport!;
    useBattleStore.setState({ newsReport: legacyReport, lastGenerationRepairContext: { generationId, customProvider: null } });
    state.setScenario(scenario('下一场情景 B'));
    state.updateSettings({ userGuidance: '下一场指导 B' });
  });
  mocks.dispatch.mockResolvedValueOnce(Response.json({ success: true, ...patch }));
  await click('AI 重新生成修复草稿');
  const [, init] = mocks.dispatch.mock.calls.at(-1)!;
  const payload = JSON.parse(init.body);
  expect(payload.userGuidance ?? '').toBe('');
  expect(payload.scenario).toBeUndefined();
  await click('应用修复');
  const entry = (useBattleStore.getState().combatants[0] as any).data.arena_history.entries[0];
  expect(entry.metadata.user_guidance).toBeNull();
  expect(entry.metadata.scenario_title).toBe('生成时情景 A');
});

it('多人会话中真实结果页不暴露修复或权威重试入口', async () => {
  await complete();
  mocks.roomSession = true;
  await act(async () => useBattleStore.getState().updateSettings({ userGuidance: '触发重绘' }));
  expect(container.textContent).not.toContain('自定义修复本次角色变化');
  expect(container.textContent).not.toContain('AI 重新生成修复草稿');
  expect(buttons().some(item => item.textContent === '重试角色更新')).toBe(false);
});

it('异步验签期间报告已被清空时不应用旧修复，即使 generationId 没变化', async () => {
  await complete();
  const before = useBattleStore.getState().combatants;
  let resolve!: (value: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(yes => { resolve = yes; }));
  await enterDraft();
  await act(async () => button('应用修复').click());
  expect(useBattleStore.getState().isCombatantMutationPending).toBe(true);
  await act(async () => useBattleStore.setState({ streamingMarkdown: null, resultContext: null }));
  await act(async () => resolve(Response.json({ isValid: false })));
  await settle();
  expect(useBattleStore.getState().lastGenerationId).toBe(generationId);
  expect(useBattleStore.getState().combatants).toBe(before);
  expect(useBattleStore.getState().repairAppliedGenerationId).toBeNull();
  expect(useBattleStore.getState().isCombatantMutationPending).toBe(false);
});

it('真实 C0 单次重连完成后，修复仍使用原报告上下文且不重新生成战报', async () => {
  const actual = await vi.importActual<typeof import('@/lib/arena/resumable-generation-client')>(
    '@/lib/arena/resumable-generation-client',
  );
  const headers = {
    'Content-Type': 'text/event-stream',
    'x-mahoshojo-generation-id': generationId,
    'x-mahoshojo-stream-meta': encodeURIComponent(JSON.stringify({
      outputContract: 'stream-markdown',
      reportFormat: 'markdown',
      mode: 'scenario',
      scenarioDisplayName: '生成时情景 A',
      userGuidance: '生成时指导 A',
    })),
  };
  const transport = vi.fn()
    .mockResolvedValueOnce(new Response(
      'id: 1-0\n' + sse('markdown', { chunk: '# 未完成首段\n\n连接暂时中断' }),
      { headers },
    ))
    .mockResolvedValueOnce(new Response(
      'id: 2-0\n' + sse('snapshot', { markdown, status: 'completed' })
        + 'id: 3-0\n' + sse('done', { status: 'completed', ok: true }),
      { headers },
    ));
  mocks.openStream.mockImplementationOnce(options => actual.openArenaGenerationStream({
    ...options,
    fetcher: transport,
    storage: null,
    baseReconnectDelayMs: 0,
    maxReconnectAttempts: 1,
  }));
  await act(async () => current.handleGenerate());
  await settle();
  expect(useBattleStore.getState().error).toBeNull();
  expect(useBattleStore.getState().streamingMarkdown).toBe(markdown);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[0][1].method).toBe('POST');
  expect(transport.mock.calls[1][0]).toContain(`/${generationId}/stream?after=1-0`);
  expect(transport.mock.calls[1][1].method).toBe('GET');

  await click('非流式');
  await click('日常模式');
  await act(async () => {
    useBattleStore.getState().setScenario(scenario('下一场情景 B'));
    useBattleStore.getState().updateSettings({ userGuidance: '下一场指导 B' });
  });
  await click('自定义修复本次角色变化');
  mocks.dispatch.mockResolvedValueOnce(Response.json({ success: true, ...patch }));
  await click('AI 重新生成修复草稿');
  expect(mocks.dispatch).toHaveBeenCalledOnce();
  const [url, init] = mocks.dispatch.mock.calls[0];
  expect(url).toBe('/api/arena/repair-combatant-meta');
  expect(JSON.parse(init.body)).toMatchObject({
    generationId,
    battleReportMarkdown: markdown,
    mode: 'scenario',
    scenario: { title: '生成时情景 A' },
    userGuidance: '生成时指导 A',
  });
  expect(mocks.openStream).toHaveBeenCalledOnce();
  expect(transport).toHaveBeenCalledTimes(2);
});

it('repair 情景快照深拷贝且不写入 localStorage', async () => {
  await act(async () => useBattleStore.persist.rehydrate());
  const context = {
    generationId,
    customProvider: null,
    scenario: { title: '仅内存情景', nested: { canary: 'synthetic-repair-scenario-canary' } },
  };
  await act(async () => {
    useBattleStore.getState().setLastGenerationRepairContext(context);
    useBattleStore.getState().updateSettings({ userGuidance: '持久化对照' });
  });
  context.scenario.title = '外部后来修改';
  context.scenario.nested.canary = '外部后来修改嵌套值';
  expect(useBattleStore.getState().lastGenerationRepairContext?.scenario).toEqual({
    title: '仅内存情景', nested: { canary: 'synthetic-repair-scenario-canary' },
  });
  expect(useBattleStore.getState().lastGenerationRepairContext?.scenario).not.toBe(context.scenario);
  const persisted = localStorage.getItem('arena-storage')!;
  expect(persisted).toContain('持久化对照');
  expect(persisted).not.toContain('lastGenerationRepairContext');
  expect(persisted).not.toContain('synthetic-repair-scenario-canary');
  expect(persisted).not.toContain('仅内存情景');
});
