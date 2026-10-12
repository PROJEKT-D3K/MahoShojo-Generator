import { describe, expect, it } from 'vitest';
import { buildStrictSetupConfiguration, buildStrictSetupMissingReasons, deriveSeasonStrictRules, normalizeStrictStoryGuidance, projectStrictSetupQuestionnaires, type StrictSetupInput } from '../src/arena-strict-setup';
import type { QuestionnaireDefinition } from '../src/questionnaire-definition';
import type { QuestionnaireSelection } from '../src/questionnaire-selection';
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

const questionnaire = (id: string, loreMarkdown = '设定'): QuestionnaireDefinition => ({
  id, kind: 'magical-girl', title: `问卷 ${id}`, questions: [], loreMarkdown,
});
const projectLore = (
  selectedQuestionnaires: QuestionnaireSelection[],
  requiredIds: string[],
  loaded = requiredIds.map((presetId) => ({ presetId, questionnaire: questionnaire(presetId) })),
  allowed = true,
) => projectStrictSetupQuestionnaires({
  rules: { questionnaireLoreAllowed: allowed, questionnaireLorePresetIds: requiredIds },
  selectedQuestionnaires, loadedPresets: loaded, createSelectionSuffix: () => 'unique',
});

describe('one-time Strict setup projections shared by Web and Desktop', () => {
  it('projects only Strict configuration and keeps scenario selection under the host', () => {
    const rules = { ...deriveSeasonStrictRules(null), mode: 'daily' as const, storyGuidance: '赛季引导' };
    const filenames = ['a.json', 'b.json'];
    const before = structuredClone({ rules, filenames });
    expect(buildStrictSetupConfiguration(rules, filenames)).toEqual({
      battleMode: 'daily', selectedLanguage: 'zh-CN',
      settings: { userGuidance: '赛季引导', readArenaHistory: false, readCurrentState: false, readNarrativeHistory: false },
      adjudicationEvents: [], characterGuidanceUpdates: [
        { filename: 'a.json', characterGuidance: '' }, { filename: 'b.json', characterGuidance: '' },
      ], clearScenario: true, clearAuxScenarios: true, clearMaterials: true,
    });
    expect(buildStrictSetupConfiguration({ ...rules, mode: 'scenario' }, []).clearScenario).toBe(false);
    expect({ rules, filenames }).toEqual(before);
  });

  it('retains allowed Lore and does not alter inert selections when none is injecting', () => {
    const selections: QuestionnaireSelection[] = [{ source: 'upload', questionnaire: questionnaire('optional') }];
    const allowed = projectLore(selections, []);
    expect(allowed).toEqual({ selections, changed: false, addedQuestionnaireLoreCount: 0, disabledQuestionnaireLoreCount: 0 });
    expect(allowed.selections[0]).toBe(selections[0]);
    const inert: QuestionnaireSelection[] = [{ source: 'database', questionnaire: questionnaire('empty', '') }];
    expect(projectLore(inert, [], [], false)).toMatchObject({ selections: inert, changed: false });
  });

  it('disables forbidden injection while preserving questionnaire payloads and selection metadata', () => {
    const selections: QuestionnaireSelection[] = [
      { source: 'upload', questionnaire: questionnaire('injecting'), selectionId: 'local' },
      { source: 'database', questionnaire: questionnaire('disabled'), useLore: false, dataCardId: 'card' },
      { source: 'preset', questionnaire: questionnaire('no-lore', '') },
    ];
    const before = structuredClone(selections);
    const projected = projectLore(selections, [], [], false);
    expect(projected).toMatchObject({ changed: true, addedQuestionnaireLoreCount: 0, disabledQuestionnaireLoreCount: 1 });
    expect(projected.selections.map((selection) => selection.useLore)).toEqual([false, false, false]);
    expect(projected.selections[0]!.selectionId).toBe('local');
    expect(projected.selections[1]).toBe(selections[1]);
    expect(projected.selections[0]!.questionnaire).toBe(selections[0]!.questionnaire);
    expect(selections).toEqual(before);
  });

  it('refreshes actual presets, disables duplicates and same-ID uploads, and appends only missing presets', () => {
    const selections: QuestionnaireSelection[] = [
      { source: 'upload', questionnaire: questionnaire('a', '同名上传'), selectionId: 'a' },
      { source: 'preset', questionnaire: questionnaire('a', '旧预设'), selectionId: 'official-a', useLore: false },
      { source: 'preset', questionnaire: questionnaire('a', '重复预设'), selectionId: 'duplicate-a' },
      { source: 'database', questionnaire: questionnaire('b', '同名数据库卡'), selectionId: 'b' },
      { source: 'preset', questionnaire: questionnaire('extra'), selectionId: 'extra' },
    ];
    const before = structuredClone(selections);
    const projected = projectLore(selections, ['a', 'b', 'b']);
    expect(projected).toMatchObject({ changed: true, addedQuestionnaireLoreCount: 1, disabledQuestionnaireLoreCount: 4 });
    expect(projected.selections.map((selection) => [selection.source, selection.questionnaire.id, selection.selectionId, selection.useLore])).toEqual([
      ['upload', 'a', 'a', false], ['preset', 'a', 'official-a', true], ['preset', 'a', 'duplicate-a', false],
      ['database', 'b', 'b', false], ['preset', 'extra', 'extra', false], ['preset', 'b', 'b::season', true],
    ]);
    expect(projected.selections[1]!.questionnaire.loreMarkdown).toBe('设定');
    expect(projectLore(projected.selections, ['a', 'b'])).toMatchObject({
      selections: projected.selections, addedQuestionnaireLoreCount: 0, disabledQuestionnaireLoreCount: 0,
    });
    expect(selections).toEqual(before);
  });

  it('allocates new preset selection IDs without replacing colliding local selections', () => {
    const selections: QuestionnaireSelection[] = [
      { source: 'upload', questionnaire: questionnaire('a'), selectionId: 'a' },
      { source: 'database', questionnaire: questionnaire('other'), selectionId: 'a::season' },
    ];
    expect(projectLore(selections, ['a']).selections[2]).toMatchObject({ source: 'preset', selectionId: 'a::unique', useLore: true });
  });

  it('requires loaded preset resources even if an existing selection claims the required ID or source', () => {
    const selections: QuestionnaireSelection[] = [{ source: 'preset', questionnaire: questionnaire('required') }];
    const before = structuredClone(selections);
    expect(() => projectLore(selections, ['required'], [])).toThrow('未找到赛季指定的预设问卷：required');
    expect(() => projectLore(selections, ['required'], [{ presetId: 'other', questionnaire: questionnaire('required') }])).toThrow('未找到赛季指定的预设问卷：required');
    expect(() => projectLore(selections, ['required'], [{ presetId: 'required', questionnaire: questionnaire('different') }])).toThrow('预设问卷标识不匹配：required');
    expect(() => projectLore(selections, ['required'], [{ presetId: 'required', questionnaire: questionnaire('required', '  ') }])).toThrow('不包含 loreMarkdown');
    expect(selections).toEqual(before);
  });
});
