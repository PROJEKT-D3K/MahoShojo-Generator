import type { ArenaRoomSharedConfig } from '@mahoshojo/contracts/arena-room';
import {
  createArenaRoomSourceProjector,
  type ArenaRoomHostWorkspaceBundle,
  type ArenaRoomHostWorkspaceBundleBuildResult,
} from '@mahoshojo/multiplayer-core';

import type {
  AuxiliaryScenarioState,
  BattleMode,
  BattleSettings,
  BattleTeam,
  Combatant,
  ScenarioState,
  StoryLengthOption,
} from '@/components/arena/types';
import type { ArenaMaterialState } from '@/lib/arena/materials';
import { sha256Hex } from '@/lib/crypto';
import { isBuiltinWebPackageRef } from '@mahoshojo/web-package';

export type ArenaRoomBattleStateSource = {
  battleMode: BattleMode;
  reportFormat?: 'markdown' | 'web';
  webPackageRef?: import('@mahoshojo/contracts/web-package').WebPackageRef | null;
  combatants: Combatant[];
  teams: BattleTeam[];
  scenario: ScenarioState;
  auxScenarios: AuxiliaryScenarioState[];
  materials: ArenaMaterialState[];
  storyLength: StoryLengthOption;
  customStoryLength: string;
  selectedLanguage: string;
  settings: BattleSettings;
  userProviderConfig?: unknown;
};

export {
  ArenaRoomShareabilityError,
  type ArenaRoomShareabilityIssueCode,
  type ArenaRoomShareabilityIssue,
  type ArenaRoomHostWorkspaceBundleBuildResult,
  type ArenaRoomHostLocalContentDigest,
  type ArenaRoomHostWorkspaceBundle,
} from '@mahoshojo/multiplayer-core';

const projector = createArenaRoomSourceProjector({ sha256Hex, isBuiltinWebPackageRef });

export const buildArenaRoomHostWorkspaceBundleFromBattleState: (
  source: ArenaRoomBattleStateSource,
) => Promise<ArenaRoomHostWorkspaceBundle> = projector.buildArenaRoomHostWorkspaceBundleFromBattleState;

export const tryBuildArenaRoomHostWorkspaceBundleFromBattleState: (
  source: ArenaRoomBattleStateSource,
) => Promise<ArenaRoomHostWorkspaceBundleBuildResult> = projector.tryBuildArenaRoomHostWorkspaceBundleFromBattleState;

export const buildArenaRoomSharedConfigFromBattleState: (
  source: ArenaRoomBattleStateSource,
) => Promise<ArenaRoomSharedConfig> = projector.buildArenaRoomSharedConfigFromBattleState;

export const {
  computeArenaRoomContentDigest,
  createArenaRoomCanonicalEmptyDraftBundle,
} = projector;
