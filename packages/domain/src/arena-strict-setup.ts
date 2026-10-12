import type { PublicSeasonMeta } from '@mahoshojo/contracts/public-ranking';
import { normalizeScenarioPresetFilename } from './scenario-presets';
import { formatBattleModeLabel } from './public-ranking';
import { isStrictRankedModelBlacklisted } from './arena-ranked-model-policy';

export type SeasonBattleMode = 'classic' | 'kizuna' | 'daily' | 'scenario';

export type SeasonStrictRules = {
  mode: SeasonBattleMode;
  storyGuidance: string;
  scenarioPresetFilename: string | null;
  questionnaireLoreAllowed: boolean;
  questionnaireLorePresetIds: string[];
};

export const normalizeStrictStoryGuidance = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.slice(0, 200);
};
const normalizeSeasonBattleMode = (value: unknown): SeasonBattleMode | null => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  if (raw === 'classic' || raw === 'kizuna' || raw === 'daily' || raw === 'scenario') return raw;
  return null;
};

const normalizeSeasonScenarioPresetFilename = (mode: SeasonBattleMode, value: unknown): string | null => {
  if (mode !== 'scenario') return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return normalizeScenarioPresetFilename(trimmed);
  } catch {
    return null;
  }
};

const normalizeSeasonQuestionnaireLoreAllowed = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  }
  return false;
};

const normalizeSeasonQuestionnaireLorePresetIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const cleaned = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => Boolean(item));
  return cleaned.slice(0, 10);
};

export const deriveSeasonStrictRules = (season: Pick<PublicSeasonMeta, 'specialRules'> | null | undefined): SeasonStrictRules => {
  const special = season?.specialRules && typeof season.specialRules === 'object' ? season.specialRules : null;
  const mode = normalizeSeasonBattleMode(special?.mode) ?? 'classic';
  const storyGuidance = normalizeStrictStoryGuidance(special?.storyGuidance);
  const scenarioPresetFilename = normalizeSeasonScenarioPresetFilename(mode, special?.scenarioPresetFilename);
  const questionnaireLorePresetIds = normalizeSeasonQuestionnaireLorePresetIds(special?.questionnaireLorePresetIds);
  const questionnaireLoreAllowed =
    questionnaireLorePresetIds.length > 0 || normalizeSeasonQuestionnaireLoreAllowed(special?.questionnaireLoreAllowed);
  return { mode, storyGuidance, scenarioPresetFilename, questionnaireLoreAllowed, questionnaireLorePresetIds };
};

export type StrictSetupInput = {
  isAuthenticated: boolean | null;
  battleMode: string;
  requiredMode: SeasonBattleMode;
  requiredStoryGuidance: string;
  requiredScenarioPresetFilename: string | null;
  scenarioFileName: string | null;
  scenarioIsPreset: boolean | null;
  rankableCombatants: readonly { characterGuidance?: string }[];
  userGuidance: string;
  selectedLanguage: string;
  readArenaHistory: boolean;
  readCurrentState: boolean;
  readNarrativeHistory: boolean;
  adjudicationEventCount: number;
  userProviderConfigModelId: string | null;
  scenarioEnabled: boolean;
  auxScenarioCount: number;
  materialCount: number;
  questionnaireLoreEnabled: boolean;
  questionnaireLoreAllowed: boolean;
  requiredQuestionnaireLorePresetIds: string[];
  questionnaireLoreIds: string[];
};

/** Local configuration hints only; the server remains the eligibility authority. */
export const buildStrictSetupMissingReasons = (input: StrictSetupInput): string[] => {
  const reasons: string[] = [];
  if (input.isAuthenticated === null) reasons.push('账号登录状态尚未确认');
  else if (!input.isAuthenticated) reasons.push('需要先登录');
  if (input.battleMode !== input.requiredMode) reasons.push(`模式需为「${formatBattleModeLabel(input.requiredMode)}」`);
  if (input.rankableCombatants.length <= 0) reasons.push('需先选择 1 位可计分的参战角色（数据卡/预设）');
  if (input.selectedLanguage !== 'zh-CN') reasons.push('生成语言需为「简体中文」');

  const actualStoryGuidance = normalizeStrictStoryGuidance(input.userGuidance);
  if (input.requiredStoryGuidance) {
    if (actualStoryGuidance !== input.requiredStoryGuidance) {
      reasons.push('需使用赛季指定的「故事引导」');
    }
  } else if (actualStoryGuidance) {
    reasons.push('需清空「故事引导」');
  }

  if (input.readArenaHistory) reasons.push('需关闭「读取历战」');
  if (input.readCurrentState) reasons.push('需关闭「读取当前状态」');
  if (input.readNarrativeHistory) reasons.push('需关闭「读取叙事历史」');
  if (input.adjudicationEventCount > 0) reasons.push('需清空「随机判定器事件」');
  if (input.rankableCombatants.some((c) => (c.characterGuidance ?? '').trim())) reasons.push('需清空「角色行动引导」');
  if (input.requiredQuestionnaireLorePresetIds.length > 0) {
    const requiredSet = new Set(input.requiredQuestionnaireLorePresetIds);
    const actualSet = new Set(input.questionnaireLoreIds);
    let ok = requiredSet.size === actualSet.size;
    if (ok) {
      for (const id of requiredSet) {
        if (!actualSet.has(id)) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) reasons.push('需启用赛季指定的「问卷/设定卡 Lore 注入」');
  } else if (input.questionnaireLoreEnabled && !input.questionnaireLoreAllowed) {
    reasons.push('需关闭「问卷/设定卡 Lore 注入」');
  }

  if (input.requiredMode === 'scenario') {
    if (!input.scenarioEnabled) reasons.push('需启用「情景模式」并选择主情景');
    if (input.requiredScenarioPresetFilename) {
      const fileName = typeof input.scenarioFileName === 'string' ? input.scenarioFileName.trim() : '';
      if (fileName === input.requiredScenarioPresetFilename && input.scenarioIsPreset === null) {
        reasons.push('主情景的预设来源尚未确认');
      } else if (!input.scenarioIsPreset || fileName !== input.requiredScenarioPresetFilename) {
        reasons.push('需选择赛季指定的「预设情景」');
      }
    }
  } else if (input.scenarioEnabled) {
    reasons.push('需关闭「情景模式」');
  }

  if (input.auxScenarioCount > 0) reasons.push('需移除「辅助情景」');
  if (input.materialCount > 0) reasons.push('需移除「素材」');
  if (input.userProviderConfigModelId && isStrictRankedModelBlacklisted(input.userProviderConfigModelId)) {
    reasons.push('需改用支持严格排位计分的 AI 模型');
  }
  return reasons;
};
