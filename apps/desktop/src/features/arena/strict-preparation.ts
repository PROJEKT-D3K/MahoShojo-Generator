import type { PublicSeasonMeta } from '@mahoshojo/contracts/public-ranking';
import { buildStrictSetupConfiguration, deriveSeasonStrictRules, projectStrictSetupQuestionnaires } from '@mahoshojo/domain/arena-strict-setup';
import type { QuestionnairePresetEntry } from '@mahoshojo/domain/questionnaire-definition';
import presetIndex from '../../../../../content/questionnaires/presets/index.json';
import { loadBuiltinQuestionnaire } from '../questionnaire/flow';
import { arenaItemName, fetchArenaPreset, parseArenaScenario } from './input';
import type { ArenaDraft } from './session';

/** All IO completes before the owner applies one draft update. Failure never half-applies resources. */
export async function prepareDesktopStrictDraft(draft: ArenaDraft, season: PublicSeasonMeta, signal: AbortSignal): Promise<ArenaDraft> {
  const rules = deriveSeasonStrictRules(season);
  if (rules.mode === 'scenario' && season.specialRules?.scenarioPresetFilename?.trim() && !rules.scenarioPresetFilename) {
    throw new Error('客户端尚不能识别赛季指定情景，请更新客户端后重试。');
  }
  const config = buildStrictSetupConfiguration(rules, draft.combatants.map(card => card.filename));
  const guidance = new Map(config.characterGuidanceUpdates.map(item => [item.filename, item.characterGuidance]));
  const loadedPresets = await Promise.all(rules.questionnaireLorePresetIds.map(async presetId => {
    const entry = (presetIndex.presets as QuestionnairePresetEntry[]).find(preset => preset.id === presetId);
    if (!entry) throw new Error(`未找到赛季指定的预设问卷：${presetId}`);
    const questionnaire = await loadBuiltinQuestionnaire({ fallbackKind: entry.kind, builtinQuestionnaireId: entry.id, builtinPresetPath: entry.path }, signal);
    signal.throwIfAborted(); return { presetId, questionnaire };
  }));
  const lore = projectStrictSetupQuestionnaires({ rules, selectedQuestionnaires: draft.selectedQuestionnaires ?? [], loadedPresets, createSelectionSuffix: () => crypto.randomUUID() });
  let scenario = config.clearScenario ? { content: null, fileName: null, isPreset: false } : draft.scenario;
  if (rules.scenarioPresetFilename) {
    const content = parseArenaScenario(await fetchArenaPreset('scenario', rules.scenarioPresetFilename, signal));
    scenario = { content, fileName: rules.scenarioPresetFilename, isPreset: true };
  }
  signal.throwIfAborted();
  return { ...draft, battleMode: config.battleMode, selectedLanguage: config.selectedLanguage,
    settings: { ...draft.settings, ...config.settings }, adjudicationEvents: config.adjudicationEvents,
    combatants: draft.combatants.map(card => guidance.has(card.filename) ? { ...card, characterGuidance: guidance.get(card.filename)! } : card),
    auxScenarios: config.clearAuxScenarios ? [] : draft.auxScenarios, materials: config.clearMaterials ? [] : draft.materials,
    scenario, scenarioDisplayName: scenario.content ? arenaItemName(scenario.content) : null,
    // Legacy raw questionnaires are superseded only when the season requires changing Lore.
    ...(draft.selectedQuestionnaires !== undefined || rules.questionnaireLorePresetIds.length || !rules.questionnaireLoreAllowed
      ? { selectedQuestionnaires: lore.selections } : {}),
  };
}
