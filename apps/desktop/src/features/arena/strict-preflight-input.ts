import { StrictPreflightInputSchema, type StrictPreflightInput } from '@mahoshojo/contracts/arena-strict-preflight';
import { buildArenaQuestionnaireRequest } from '@mahoshojo/domain/arena-questionnaire-request';
import { normalizeStrictStoryGuidance } from '@mahoshojo/domain/arena-strict-setup';
import type { ResolvedDesktopAiTarget } from '../ai-config/desktop-ai-config';
import { projectDesktopArenaCombatant } from './strict-source';
import type { ArenaDraft } from './session';

export function buildDesktopStrictPreflightInput(draft: ArenaDraft, target: ResolvedDesktopAiTarget, adjudicationEventCount: number): StrictPreflightInput {
  const questionnaires = draft.selectedQuestionnaires ? buildArenaQuestionnaireRequest(draft.selectedQuestionnaires).questionnaires : draft.questionnaires;
  const lore = (questionnaires ?? []).filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value))
    .filter(value => value.useLore !== false && typeof value.loreMarkdown === 'string' && value.loreMarkdown.trim());
  const questionnaireLoreIds = [...new Set(lore.map(value => typeof value.id === 'string' ? value.id.trim() : '').filter(Boolean))].slice(0, 20);
  const combatants = draft.combatants.map(projectDesktopArenaCombatant).map(card => ({ isPreset: card.isPreset,
    filename: card.isPreset ? card.filename : null, sourceDataCardId: card.sourceDataCardId ?? null, characterGuidance: card.characterGuidance ?? null }));
  return StrictPreflightInputSchema.parse({ battleMode: draft.battleMode, language: draft.selectedLanguage, storyLength: draft.storyLength,
    scenarioEnabled: draft.battleMode === 'scenario' && !!draft.scenario.content,
    scenarioFileName: draft.battleMode === 'scenario' && draft.scenario.isPreset === true ? draft.scenario.fileName : null,
    auxScenarioCount: draft.auxScenarios.length, materialCount: draft.materials.length,
    questionnaireLoreEnabled: lore.length > 0, questionnaireLoreIds,
    settings: { userGuidance: normalizeStrictStoryGuidance(draft.settings.userGuidance), readArenaHistory: draft.settings.readArenaHistory,
      readCurrentState: draft.settings.readCurrentState, readNarrativeHistory: draft.settings.readNarrativeHistory },
    combatants, adjudicationEventCount,
    ...(target.modelId && target.modelId !== 'default' ? { customProvider: { providerId: target.providerTarget?.kind === 'preset' ? target.providerTarget.providerId : 'system', modelId: target.modelId } } : {}),
  });
}
