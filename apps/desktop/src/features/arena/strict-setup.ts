import type { PublicSeasonMeta } from '@mahoshojo/contracts/public-ranking';
import { buildStrictSetupMissingReasons, deriveSeasonStrictRules } from '@mahoshojo/domain/arena-strict-setup';
import { buildArenaQuestionnaireRequest } from '@mahoshojo/domain/arena-questionnaire-request';
import { PRESET_LIST } from '@mahoshojo/domain/presets';
import type { ArenaDraft } from './session';

export interface DesktopStrictSetupInput {
  draft: ArenaDraft;
  isAuthenticated: boolean | null;
  executionLocation: 'client' | 'server';
  modelId: string | null;
  modelUnavailable: boolean;
  /** The same inherited/edited event count used by this page's real dispatch. */
  adjudicationEventCount: number;
}

/** Display projection only. Neither draft IDs nor provenance grant online eligibility. */
export function describeDesktopStrictSetup(input: DesktopStrictSetupInput, season: PublicSeasonMeta) {
  const { draft } = input;
  const rules = deriveSeasonStrictRules(season);
  const presets = draft.combatants.filter((card) => card.isPreset && PRESET_LIST.some((preset) => preset.filename === card.filename));
  const questionnaires: readonly unknown[] | undefined = draft.selectedQuestionnaires
    ? buildArenaQuestionnaireRequest(draft.selectedQuestionnaires).questionnaires
    : draft.questionnaires;
  const lore = (questionnaires ?? []).filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value))
    .filter((value) => value.useLore !== false && typeof value.loreMarkdown === 'string' && value.loreMarkdown.trim());
  const loreIds = [...new Set(lore.map((value) => typeof value.id === 'string' ? value.id.trim() : '').filter(Boolean))].slice(0, 20);
  const reasons = buildStrictSetupMissingReasons({
    isAuthenticated: input.isAuthenticated,
    battleMode: draft.battleMode,
    requiredMode: rules.mode,
    requiredStoryGuidance: rules.storyGuidance,
    requiredScenarioPresetFilename: rules.scenarioPresetFilename,
    scenarioFileName: draft.scenario.fileName,
    // The current Desktop draft stores a filename for both uploads and presets.
    // Do not infer preset origin from a matching filename or from content fields.
    scenarioIsPreset: null,
    rankableCombatants: presets,
    userGuidance: draft.settings.userGuidance,
    selectedLanguage: draft.selectedLanguage,
    readArenaHistory: draft.settings.readArenaHistory,
    readCurrentState: draft.settings.readCurrentState,
    readNarrativeHistory: draft.settings.readNarrativeHistory,
    adjudicationEventCount: input.adjudicationEventCount,
    userProviderConfigModelId: input.modelId,
    scenarioEnabled: draft.battleMode === 'scenario' && !!draft.scenario.content,
    auxScenarioCount: draft.auxScenarios.length,
    materialCount: draft.materials.length,
    questionnaireLoreEnabled: lore.length > 0,
    questionnaireLoreAllowed: rules.questionnaireLoreAllowed,
    requiredQuestionnaireLorePresetIds: rules.questionnaireLorePresetIds,
    questionnaireLoreIds: loreIds,
  });
  if (input.executionLocation !== 'server') reasons.push('严格排位需服务器执行；当前选择为客户端');
  if (!input.modelId || input.modelUnavailable) reasons.push('当前 AI 模型配置尚不可用');
  if (draft.combatants.length !== 2) reasons.push('严格计分需 2 人对战');
  if (presets.length !== draft.combatants.length) reasons.push('本地、缓存或导入副本的线上角色身份尚未确认');
  if (draft.combatants.some((card) => card.characterGuidance?.trim()) && !presets.some((card) => card.characterGuidance?.trim())) {
    reasons.push('需清空「角色行动引导」');
  }
  if (rules.mode === 'scenario' && season.specialRules?.scenarioPresetFilename?.trim() && !rules.scenarioPresetFilename) {
    reasons.push('此客户端尚不能识别赛季指定情景，无法确认该项规则');
  }
  return { rules, reasons };
}
