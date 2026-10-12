import { describe, expect, it } from 'vitest';
import { buildStrictSetupMissingReasons, deriveSeasonStrictRules, normalizeStrictStoryGuidance, type StrictSetupInput } from '../src/arena-strict-setup';
import { SCENARIO_PRESET_LIST } from '../src/scenario-presets';

const ready = (): StrictSetupInput => ({
  isAuthenticated: true, battleMode: 'classic', requiredMode: 'classic', requiredStoryGuidance: '',
  requiredScenarioPresetFilename: null, scenarioFileName: null, scenarioIsPreset: false,
  rankableCombatants: [{}], userGuidance: '', selectedLanguage: 'zh-CN',
  readArenaHistory: false, readCurrentState: false, readNarrativeHistory: false, adjudicationEventCount: 0,
  userProviderConfigModelId: null, scenarioEnabled: false, auxScenarioCount: 0, materialCount: 0,
  questionnaireLoreEnabled: false, questionnaireLoreAllowed: false, requiredQuestionnaireLorePresetIds: [], questionnaireLoreIds: [],
});

describe('shared Strict basic setup, not server eligibility', () => {
  it('preserves Web one-character setup readiness without requiring two-character preflight', () => {
    expect(buildStrictSetupMissingReasons(ready())).toEqual([]);
    expect(buildStrictSetupMissingReasons({ ...ready(), rankableCombatants: [] })).toEqual(['需先选择 1 位可计分的参战角色（数据卡/预设）']);
  });
  it('preserves the original complete reason order and does not mutate caller data', () => {
    const input: StrictSetupInput = { ...ready(), isAuthenticated: false, battleMode: 'daily', selectedLanguage: 'en-US',
      userGuidance: '指令', readArenaHistory: true, readCurrentState: true, readNarrativeHistory: true,
      adjudicationEventCount: 1, rankableCombatants: [{ characterGuidance: '行动' }], questionnaireLoreEnabled: true,
      scenarioEnabled: true, auxScenarioCount: 1, materialCount: 1, userProviderConfigModelId: ' GEMMA-3-4B-IT ' };
    const before = structuredClone(input);
    expect(buildStrictSetupMissingReasons(input)).toEqual([
      '需要先登录', '模式需为「经典」', '生成语言需为「简体中文」', '需清空「故事引导」',
      '需关闭「读取历战」', '需关闭「读取当前状态」', '需关闭「读取叙事历史」', '需清空「随机判定器事件」',
      '需清空「角色行动引导」', '需关闭「问卷/设定卡 Lore 注入」', '需关闭「情景模式」',
      '需移除「辅助情景」', '需移除「素材」', '需改用支持严格排位计分的 AI 模型',
    ]);
    expect(input).toEqual(before);
  });
  it('keeps required Lore set equality and scenario source checks separate', () => {
    const input = { ...ready(), battleMode: 'scenario', requiredMode: 'scenario' as const, scenarioEnabled: true,
      requiredScenarioPresetFilename: 'scenario.json', scenarioFileName: 'scenario.json', scenarioIsPreset: true,
      requiredQuestionnaireLorePresetIds: ['a', 'b'], questionnaireLoreIds: ['b', 'a', 'a'] };
    expect(buildStrictSetupMissingReasons(input)).toEqual([]);
    expect(buildStrictSetupMissingReasons({ ...input, questionnaireLoreIds: ['a', 'c'], scenarioIsPreset: false })).toEqual([
      '需启用赛季指定的「问卷/设定卡 Lore 注入」', '需选择赛季指定的「预设情景」',
    ]);
    expect(buildStrictSetupMissingReasons({ ...input, isAuthenticated: null, scenarioIsPreset: null })).toEqual([
      '账号登录状态尚未确认', '主情景的预设来源尚未确认',
    ]);
  });
  it('retains season normalization and UTF-16 story-guidance limits', () => {
    expect(deriveSeasonStrictRules(null)).toEqual({ mode: 'classic', storyGuidance: '', scenarioPresetFilename: null, questionnaireLoreAllowed: false, questionnaireLorePresetIds: [] });
    const filename = SCENARIO_PRESET_LIST[0]!.filename;
    const rules = deriveSeasonStrictRules({ specialRules: { mode: 'scenario', scenarioPresetFilename: filename.replace(/\.json$/, ''),
      storyGuidance: `  ${'😀'.repeat(120)}  `, questionnaireLorePresetIds: [' a ', '', ...Array.from({ length: 12 }, (_, index) => `q${index}`)], questionnaireLoreAllowed: false } });
    expect(rules.scenarioPresetFilename).toBe(filename);
    expect(rules.storyGuidance).toBe('😀'.repeat(100));
    expect(rules.questionnaireLorePresetIds).toHaveLength(10);
    expect(rules.questionnaireLoreAllowed).toBe(true);
    expect(normalizeStrictStoryGuidance(` ${'😀'.repeat(120)} `)).toBe(rules.storyGuidance);
    expect(deriveSeasonStrictRules({ specialRules: { mode: 'scenario', scenarioPresetFilename: 'unknown-future.json' } }).scenarioPresetFilename).toBeNull();
  });
});
