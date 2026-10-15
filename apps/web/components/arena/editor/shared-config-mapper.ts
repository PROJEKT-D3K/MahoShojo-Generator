import {
  type ArenaRoomSharedConfig,
} from '@mahoshojo/contracts/arena-room';

import type {
  ArenaEditorCombatantView,
  ArenaEditorMaterialView,
  ArenaEditorScenarioView,
  ArenaEditorTeamView,
} from './types';
import type { BattleStoreState, Combatant, ScenarioState } from '../types';
import type { ArenaMaterialState } from '@/lib/arena/materials';
import { isBuiltinWebPackageRef } from '@mahoshojo/web-package';

export type ArenaEditorViewProjection = Readonly<{
  combatants: readonly ArenaEditorCombatantView[];
  teams: readonly ArenaEditorTeamView[];
  scenario: ArenaEditorScenarioView | null;
  auxScenarios: readonly ArenaEditorScenarioView[];
  materials: readonly ArenaEditorMaterialView[];
  battleMode: ArenaRoomSharedConfig['battleMode'];
  reportFormat: ArenaRoomSharedConfig['reportFormat'];
  webPackageRef?: ArenaRoomSharedConfig['webPackageRef'];
  storyLength: ArenaRoomSharedConfig['storyLength'];
  customStoryLength: string;
  selectedLanguage: string;
  userGuidance: string;
  historySettings: ArenaRoomSharedConfig['historySettings'];
  busy: boolean;
}>;

const freezeArray = <T>(input: readonly T[]): readonly T[] => Object.freeze(input);

export { cloneArenaMemberSharedConfig as cloneArenaEditorSharedConfig, mapSharedConfigToArenaMemberView as mapSharedConfigToArenaEditorView } from '@mahoshojo/ui-web/arena-room';

const text = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const recordName = (value: unknown): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  return text(record.codename) || text(record.name) || text(record.title);
};

const localCombatantKey = (combatant: Combatant, index: number): string => {
  if ('data' in combatant) {
    if (text(combatant.sourceDataCardId)) return `data-card:${combatant.sourceDataCardId}`;
    if (combatant.isPreset) return `preset:${combatant.filename}`;
    return text(combatant.arenaRoomKey)
      || text(combatant.adjudicationSourceKey)
      || `local-combatant:${index}`;
  }
  return `random:${combatant.id}`;
};

const localScenarioView = (
  scenario: ScenarioState,
  fallbackKey: string,
): ArenaEditorScenarioView | null => {
  if (scenario.content === null) return null;
  const sourceDataCardId = text(scenario.sourceDataCardId);
  const isPreset = scenario.isPreset === true;
  const source = sourceDataCardId
    ? 'data-card' as const
    : isPreset ? 'preset' as const : 'host-local' as const;
  return Object.freeze({
    key: sourceDataCardId
      ? `data-card:${sourceDataCardId}`
      : isPreset && text(scenario.fileName)
        ? `preset:${text(scenario.fileName)}`
      : text(scenario.arenaRoomKey) || text(scenario.adjudicationSourceKey) || fallbackKey,
    name: text(scenario.sourceDataCardName)
      || recordName(scenario.content)
      || text(scenario.fileName)
      || '未命名情景',
    source,
    access: 'full' as const,
    reference: sourceDataCardId ? Object.freeze({
      id: sourceDataCardId,
      versionToken: text(scenario.sourceDataCardUpdatedAt),
    }) : null,
  });
};

const localMaterialView = (
  material: ArenaMaterialState,
  index: number,
): ArenaEditorMaterialView => {
  const sourceDataCardId = text(material.sourceDataCardId);
  const isPreset = material.isPreset === true;
  const source = sourceDataCardId
    ? 'data-card' as const
    : isPreset ? 'preset' as const : 'host-local' as const;
  return Object.freeze({
    key: sourceDataCardId
      ? `data-card:${sourceDataCardId}`
      : isPreset && text(material.fileName)
        ? `preset:${text(material.fileName)}`
      : text(material.arenaRoomKey) || `local-material:${material.id || index}`,
    name: text(material.name) || '未命名素材',
    source,
    access: 'full' as const,
    reference: sourceDataCardId ? Object.freeze({
      id: sourceDataCardId,
      versionToken: text(material.sourceDataCardUpdatedAt),
    }) : null,
  });
};

export const mapBattleStoreToArenaEditorView = (
  state: BattleStoreState,
): ArenaEditorViewProjection => {
  const teamKeyById = new Map(state.teams.map((team) => [
    team.id,
    team.roomKey?.trim() || `team:${team.id}`,
  ]));
  const combatants = state.combatants.map((combatant, index): ArenaEditorCombatantView => {
    const key = localCombatantKey(combatant, index);
    if (!('data' in combatant)) {
      return Object.freeze({
        key,
        name: text(combatant.filename) || '随机角色',
        type: combatant.type === 'random-canshou' ? 'canshou' : 'magical-girl',
        source: 'random',
        access: 'placeholder',
        reference: null,
        characterGuidance: '',
        teamKey: combatant.teamId ? teamKeyById.get(combatant.teamId) ?? null : null,
      });
    }
    const sourceDataCardId = text(combatant.sourceDataCardId);
    return Object.freeze({
      key,
      name: text(combatant.sourceDataCardName)
        || recordName(combatant.data)
        || text(combatant.filename)
        || '未命名角色',
      type: combatant.type,
      source: sourceDataCardId
        ? 'data-card'
        : combatant.isPreset ? 'preset' : 'host-local',
      access: 'full',
      reference: sourceDataCardId ? Object.freeze({
        id: sourceDataCardId,
        versionToken: text(combatant.sourceDataCardUpdatedAt),
      }) : null,
      characterGuidance: combatant.characterGuidance ?? '',
      teamKey: combatant.teamId ? teamKeyById.get(combatant.teamId) ?? null : null,
    });
  });

  return Object.freeze({
    combatants: freezeArray(combatants),
    teams: freezeArray(state.teams.map((team): ArenaEditorTeamView => Object.freeze({
      key: team.roomKey?.trim() || `team:${team.id}`,
      name: team.name,
      combatantKeys: freezeArray(combatants
        .filter((combatant) => combatant.teamKey === (team.roomKey?.trim() || `team:${team.id}`))
        .map((combatant) => combatant.key)),
    }))),
    scenario: localScenarioView(state.scenario, 'local-scenario:main'),
    auxScenarios: freezeArray(state.auxScenarios.flatMap((scenario, index) => {
      const view = localScenarioView(scenario, `local-scenario:${scenario.id || index}`);
      return view ? [view] : [];
    })),
    materials: freezeArray(state.materials.map(localMaterialView)),
    battleMode: state.battleMode,
    reportFormat: state.reportFormat ?? 'markdown',
    webPackageRef: state.reportFormat === 'web' && state.webPackageRef && isBuiltinWebPackageRef(state.webPackageRef)
      ? state.webPackageRef
      : undefined,
    storyLength: state.storyLength,
    customStoryLength: state.customStoryLength,
    selectedLanguage: state.selectedLanguage,
    userGuidance: state.settings.userGuidance,
    historySettings: Object.freeze({
      readArenaHistory: state.settings.readArenaHistory,
      readArenaHistoryLimit: state.settings.readArenaHistoryLimit,
      isArenaHistoryUnlimited: state.settings.isArenaHistoryUnlimited,
      writeArenaHistory: state.settings.writeArenaHistory,
      readCurrentState: state.settings.readCurrentState,
      writeCurrentState: state.settings.writeCurrentState,
      readNarrativeHistory: state.settings.readNarrativeHistory,
      readNarrativeHistoryLimit: state.settings.readNarrativeHistoryLimit,
      isNarrativeHistoryUnlimited: state.settings.isNarrativeHistoryUnlimited,
      writeNarrativeHistory: state.settings.writeNarrativeHistory,
    }),
    busy: state.isGenerating,
  });
};
