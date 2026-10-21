import { isArenaRealCombatant } from './roster-types';
import { ArenaRoomHostRuntimeGenerationSchema, StoryLengthSchema, type ArenaRoomSharedConfig } from '@mahoshojo/contracts/arena-room';
import {
  createArenaRoomSourceProjector,
  type ArenaRoomHostWorkspaceBundle,
  type ArenaRoomSourceCombatant,
  type ArenaRoomSourceMaterial,
  type ArenaRoomSourceState,
} from '@mahoshojo/multiplayer-core';
import { isBuiltinWebPackageRef } from '@mahoshojo/web-package';

import { buildArenaGenerationInputSnapshot } from '@mahoshojo/ai-core/arena-generation';
import { desktopRoomStartSourceBudget } from './room-source-budget';
export class DesktopRoomStartComplexityError extends Error {}
export class DesktopRoomStartCapacityError extends Error {}
import { buildDesktopArenaInput } from './session';
import type { ArenaDraft } from './session';
import { projectDesktopArenaCombatant } from './strict-source';

const projector = createArenaRoomSourceProjector({
  sha256Hex: async (text) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  },
  isBuiltinWebPackageRef,
});

const combatantSource = (card: ArenaDraft['combatants'][number]): ArenaRoomSourceCombatant => {
  const current = projectDesktopArenaCombatant(card);
  if (current.type !== 'magical-girl' && current.type !== 'canshou' && current.type !== 'general-character') {
    throw new Error('Unsupported combatant type');
  }
  return {
    type: current.type,
    filename: current.filename,
    data: current.data,
    teamId: current.teamId,
    characterGuidance: current.characterGuidance,
    isPreset: current.isPreset,
    sourceDataCardId: current.desktopSource === 'online' ? current.sourceDataCardId : undefined,
    sourceDataCardUpdatedAt: current.desktopSource === 'online' ? current.sourceDataCardUpdatedAt : undefined,
  };
};

const materialSource = (value: unknown): ArenaRoomSourceMaterial => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported material');
  const material = value as Record<string, unknown>;
  if (typeof material.id !== 'string' || typeof material.name !== 'string'
    || !(material.fileName === null || typeof material.fileName === 'string')
    || !Object.prototype.hasOwnProperty.call(material, 'content')) throw new Error('Unsupported material');
  // Desktop material imports may derive reference-looking fields from body metadata.
  // Without a current online selection marker, these remain host-local content.
  return { id: material.id, name: material.name, fileName: material.fileName, content: material.content };
};

/** Build the existing Room projection and complete local bundle. Creation and
 * configuration expose only the projection; explicit start owns the full bundle. */
async function prepareDesktopRoomBundle(draft: ArenaDraft, empty = false): Promise<
  { ok: true; sharedConfig: ArenaRoomSharedConfig; bundle: ArenaRoomHostWorkspaceBundle } | { ok: false; issues: readonly string[] }
> {
  if (empty) { const bundle = projector.createArenaRoomCanonicalEmptyDraftBundle(); return { ok: true, sharedConfig: bundle.sharedConfig, bundle }; }
  if (!draft.combatants.every(isArenaRealCombatant)) return { ok: false, issues: ['随机占位符不能发布到多人房间，请先在单人对战中生成完整角色。'] };
  try {
    const source: ArenaRoomSourceState = {
      battleMode: draft.battleMode,
      reportFormat: draft.reportFormat,
      webPackageRef: draft.webPackageRef ? {
        id: draft.webPackageRef.id, version: draft.webPackageRef.version, digest: draft.webPackageRef.digest,
      } : null,
      combatants: draft.combatants.map(combatantSource),
      teams: draft.teams.map(team => ({ id: team.id, name: team.name })),
      // Scenario selections currently retain only explicit preset provenance.
      scenario: {
        content: draft.scenario.content,
        fileName: draft.scenario.fileName,
        isPreset: draft.scenario.isPreset,
      },
      auxScenarios: draft.auxScenarios.map(scenario => ({
        content: scenario.content, fileName: scenario.fileName ?? null, isPreset: scenario.isPreset,
      })),
      materials: draft.materials.map(materialSource),
      storyLength: StoryLengthSchema.parse(draft.storyLength),
      customStoryLength: draft.customStoryLength ?? '',
      selectedLanguage: draft.selectedLanguage,
      settings: {
        userGuidance: draft.settings.userGuidance,
        readArenaHistory: draft.settings.readArenaHistory,
        readArenaHistoryLimit: draft.settings.readArenaHistoryLimit,
        isArenaHistoryUnlimited: draft.settings.isArenaHistoryUnlimited,
        writeArenaHistory: draft.settings.writeArenaHistory,
        readCurrentState: draft.settings.readCurrentState,
        writeCurrentState: draft.settings.writeCurrentState,
        readNarrativeHistory: draft.settings.readNarrativeHistory,
        readNarrativeHistoryLimit: draft.settings.readNarrativeHistoryLimit,
        isNarrativeHistoryUnlimited: draft.settings.isNarrativeHistoryUnlimited,
        writeNarrativeHistory: draft.settings.writeNarrativeHistory,
      },
    };
    const result = await projector.tryBuildArenaRoomHostWorkspaceBundleFromBattleState(source);
    return result.ok
      ? { ok: true, sharedConfig: result.bundle.sharedConfig, bundle: result.bundle }
      : { ok: false, issues: result.issues.map(issue => `${issue.target}：${issue.message}${issue.action}`) };
  } catch {
    return { ok: false, issues: ['当前设定不符合多人房间共享格式，请检查或重新选择来源后重试。'] };
  }
}

/** Same snapshot builder as ordinary Arena; only request-scoped runtime fields escape. */
export const prepareDesktopRoomGenerationRuntime = (draft: ArenaDraft) => {
  const input = buildArenaGenerationInputSnapshot(buildDesktopArenaInput(draft, 'arena'));
  return ArenaRoomHostRuntimeGenerationSchema.parse({
    arenaFreeRankingEnabled: false,
    ...(input.narrativeHistory === undefined ? {} : { narrativeHistory: input.narrativeHistory }),
    ...(input.adjudicationEvents === undefined ? {} : { adjudicationEvents: input.adjudicationEvents }),
    ...(input.questionnaireSelections === undefined ? {} : { questionnaireSelections: input.questionnaireSelections }),
    ...(input.questionnaires === undefined ? {} : { questionnaires: input.questionnaires }),
  });
};

/** Creation/configuration retain their projection-only boundary. */
export async function prepareDesktopRoomSource(draft: ArenaDraft, empty = false): Promise<
  { ok: true; sharedConfig: ArenaRoomSharedConfig } | { ok: false; issues: readonly string[] }
> {
  const source = await prepareDesktopRoomBundle(draft, empty);
  return source.ok ? { ok: true, sharedConfig: source.sharedConfig } : source;
}

/** One complete local snapshot is captured before the first hash await. */
export async function prepareDesktopRoomStartSource(draft: ArenaDraft) {
  const budget = desktopRoomStartSourceBudget(draft);
  if (budget === 'complexity') throw new DesktopRoomStartComplexityError('room-source-too-complex');
  if (budget === 'bytes') throw new DesktopRoomStartCapacityError('room-source-too-large');
  const frozen = structuredClone(draft);
  const generation = prepareDesktopRoomGenerationRuntime(frozen);
  const source = await prepareDesktopRoomBundle(frozen);
  if (!source.ok) throw new Error('room-source-unavailable');
  return { bundle: source.bundle, generation };
}
