import { ArenaRoomSharedConfigSchema, type ArenaRoomSharedConfig } from '@mahoshojo/contracts/arena-room';
import { isBuiltinWebPackageRef } from '@mahoshojo/web-package';
import type { ArenaMemberCombatantView, ArenaMemberScenarioView, ArenaMemberMaterialView, ArenaMemberTeamView } from './types';

export type ArenaMemberViewProjection = Readonly<{
  combatants: readonly ArenaMemberCombatantView[];
  teams: readonly ArenaMemberTeamView[];
  scenario: ArenaMemberScenarioView | null;
  auxScenarios: readonly ArenaMemberScenarioView[];
  materials: readonly ArenaMemberMaterialView[];
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

const sourceOfKey = (key: string): 'data-card' | 'preset' => (
  key.startsWith('preset:') ? 'preset' : 'data-card'
);

const sharedReference = (
  entry: { readonly ref: { readonly id: string; readonly versionToken: string } },
) => Object.freeze({
  id: entry.ref.id,
  versionToken: entry.ref.versionToken,
});

const sharedScenarioView = (
  entry:
    | NonNullable<ArenaRoomSharedConfig['scenario']>
    | ArenaRoomSharedConfig['materials'][number],
): ArenaMemberScenarioView => {
  if ('ref' in entry) {
    return Object.freeze({
      key: entry.key,
      name: entry.ref.id,
      source: sourceOfKey(entry.key),
      access: 'reference' as const,
      reference: sharedReference(entry),
    });
  }
  return Object.freeze({
    key: entry.key,
    name: entry.displayName,
    source: 'host-local' as const,
    access: 'stub' as const,
    reference: null,
  });
};

export const cloneArenaMemberSharedConfig = (
  input: unknown,
): ArenaRoomSharedConfig => ArenaRoomSharedConfigSchema.parse(input);

export const mapSharedConfigToArenaMemberView = (
  input: unknown,
): ArenaMemberViewProjection => {
  const config = cloneArenaMemberSharedConfig(input);
  const assignmentByCombatant = new Map<string, string>();
  config.teams.forEach((team) => {
    team.combatantKeys.forEach((key) => assignmentByCombatant.set(key, team.key));
  });

  return Object.freeze({
    combatants: freezeArray(config.combatants.map((entry): ArenaMemberCombatantView => {
      if ('ref' in entry) {
        return Object.freeze({
          key: entry.key,
          name: entry.ref.id,
          type: null,
          source: sourceOfKey(entry.key),
          access: 'reference',
          reference: sharedReference(entry),
          characterGuidance: entry.characterGuidance ?? '',
          teamKey: assignmentByCombatant.get(entry.key) ?? null,
        });
      }
      return Object.freeze({
        key: entry.key,
        name: entry.displayName,
        type: entry.type,
        source: 'host-local',
        access: 'stub',
        reference: null,
        characterGuidance: entry.characterGuidance ?? '',
        teamKey: assignmentByCombatant.get(entry.key) ?? null,
      });
    })),
    teams: freezeArray(config.teams.map((team): ArenaMemberTeamView => Object.freeze({
      key: team.key,
      name: team.displayName,
      combatantKeys: freezeArray([...team.combatantKeys]),
    }))),
    scenario: config.scenario ? sharedScenarioView(config.scenario) : null,
    auxScenarios: freezeArray(config.auxScenarios.map(sharedScenarioView)),
    materials: freezeArray(config.materials.map(sharedScenarioView)),
    battleMode: config.battleMode,
    reportFormat: config.reportFormat,
    webPackageRef: config.webPackageRef && isBuiltinWebPackageRef(config.webPackageRef)
      ? config.webPackageRef
      : undefined,
    storyLength: config.storyLength,
    customStoryLength: config.customStoryLength ?? '',
    selectedLanguage: config.selectedLanguage,
    userGuidance: config.userGuidance,
    historySettings: Object.freeze({ ...config.historySettings }),
    busy: false,
  });
};
