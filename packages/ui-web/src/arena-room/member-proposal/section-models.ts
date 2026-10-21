import { COMBATANT_TYPE_LABELS } from '@mahoshojo/domain/arena-file-parser';
import { MAX_COMBATANTS, MAX_ARENA_REFERENCE_ITEMS, type DataCardRef } from '@mahoshojo/contracts/arena-room';
import type { ArenaMemberProposalActions } from '@mahoshojo/multiplayer-core/member-proposal';
import { ARENA_ROOM_PRESET_CATALOG } from '@mahoshojo/multiplayer-core/preset-catalog';
import { PRESET_LIST } from '@mahoshojo/domain/presets';
import { SCENARIO_PRESET_LIST } from '@mahoshojo/domain/scenario-presets';
import type { ArenaRosterSectionModel } from '../../arena/features/roster/roster-contract';
import type { ArenaScenarioSectionModel } from '../../arena/features/scenario/scenario-contract';
import type { ArenaMaterialSectionModel } from '../../arena/features/material/material-contract';
import type { ArenaMemberReferenceRequest, ArenaMemberScenarioView } from './types';
import type { ArenaMemberViewProjection } from './projection';

export const arenaMemberCharacterPresets = PRESET_LIST.filter(preset => ARENA_ROOM_PRESET_CATALOG.some(entry => entry.kind === 'character' && entry.id === preset.filename));
export const arenaMemberScenarioPresets = SCENARIO_PRESET_LIST.filter(preset => ARENA_ROOM_PRESET_CATALOG.some(entry => entry.kind === 'scenario' && entry.id === preset.filename));
export const arenaMemberReferenceRequest = (item: ArenaMemberScenarioView, kind: DataCardRef['kind']): ArenaMemberReferenceRequest | null =>
  item.source === 'host-local' || !item.reference ? null : { source: item.source, kind, id: item.reference.id, versionToken: item.reference.versionToken };
export const collectArenaMemberReferenceRequests = (state: ArenaMemberViewProjection): ArenaMemberReferenceRequest[] => [
  ...state.combatants.map(item => arenaMemberReferenceRequest(item, 'character')),
  ...(state.scenario ? [arenaMemberReferenceRequest(state.scenario, 'scenario')] : []),
  ...state.auxScenarios.map(item => arenaMemberReferenceRequest(item, 'scenario')),
  ...state.materials.map(item => arenaMemberReferenceRequest(item, 'material')),
].filter((request): request is ArenaMemberReferenceRequest => request !== null);
export type ArenaMemberSectionInput = Readonly<{
  state: ArenaMemberViewProjection; actions: ArenaMemberProposalActions; disabled: boolean;
  resolveName(request: ArenaMemberReferenceRequest): string | undefined;
}>;
const nameOf = (item: ArenaMemberScenarioView, kind: DataCardRef['kind'], resolve: ArenaMemberSectionInput['resolveName']) => {
  const request = arenaMemberReferenceRequest(item, kind);
  if (!request) return item.name;
  const fallback = request.source === 'preset' || request.id.length <= 20 ? request.id : `${request.id.slice(0, 20)}…`;
  return `${request.source === 'preset' ? '预设' : '在线'}:${resolve(request) || fallback}`;
};
const noop = () => {};
const noUpload = async () => {};
export function buildArenaMemberRosterModel({ state, actions, disabled, resolveName, collapsedTeams, toggleTeamCollapsed, createId, requestDetails }: ArenaMemberSectionInput & {
  collapsedTeams: ReadonlySet<string>; toggleTeamCollapsed(key: string): void; createId(): string;
  requestDetails?(request: ArenaMemberReferenceRequest): void;
}): ArenaRosterSectionModel {
  return {
    rows: state.combatants.map((item, index) => ({ key: item.key, displayName: nameOf(item, 'character', resolveName),
      referenceTitle: item.reference ? `${item.source === 'preset' ? '预设' : '在线'}:${item.name}` : undefined,
      typeLabel: item.type ? COMBATANT_TYPE_LABELS[item.type] : (item.source === 'preset' ? '内置预设' : item.access === 'stub' ? '房主本地角色' : '在线角色'),
      guidance: item.characterGuidance, index, teamKey: item.teamKey, isPlaceholder: false })),
    teams: state.teams.map(team => ({ key: team.key, name: team.name, memberKeys: team.combatantKeys, collapsed: collapsedTeams.has(team.key) })),
    capabilities: { reorderRows: true, removeRows: true, editGuidance: true, ranking: false, addPlaceholders: false, clearRoster: false,
      createTeams: true, renameTeams: true, removeTeams: true, reorderTeams: true, assignTeamMembers: true, reorderTeamMembers: true, collapseTeams: true },
    disabled, combatantCountLabel: `${state.combatants.length}/${MAX_COMBATANTS}`, combatantCapReached: state.combatants.length >= MAX_COMBATANTS,
    rowExtras: requestDetails ? row => { const item = state.combatants.find(entry => entry.key === row.key); const request = item ? arenaMemberReferenceRequest(item, 'character') : null;
      return request ? { onShowDetails: () => requestDetails(request) } : undefined; } : undefined,
    actions: { moveRow: actions.moveCombatant, removeRow: actions.removeCombatant, setGuidance: actions.setCharacterGuidance,
      addPlaceholder: noop, clearRoster: noop, createTeam: () => { const key = `team:${createId()}`; actions.createTeam(key); return key; },
      renameTeam: actions.renameTeam, removeTeam: actions.removeTeam, moveTeam: actions.moveTeam, assignCombatant: actions.assignCombatant,
      moveTeamMember: actions.moveTeamMember, toggleTeamCollapsed },
  };
}
export function buildArenaMemberScenarioModel({ state, actions, disabled, resolveName, openMain, openAux }: ArenaMemberSectionInput & { openMain(): void; openAux(): void }): ArenaScenarioSectionModel {
  const count = state.auxScenarios.length + state.materials.length;
  return { disabled, isAuthenticated: true, isMatchingBlocked: false, isMatchingScenario: false,
    mainName: state.scenario ? nameOf(state.scenario, 'scenario', resolveName) : null, mainIsNative: false,
    auxScenarios: state.auxScenarios.map(item => ({ key: item.key, title: nameOf(item, 'scenario', resolveName), isNative: false })),
    auxBudgetLine: `参考项合计 ${count}/${MAX_ARENA_REFERENCE_ITEMS}`, auxBudgetExhausted: count >= MAX_ARENA_REFERENCE_ITEMS,
    presets: arenaMemberScenarioPresets, presetsLoading: false, presetsError: null, loadingPresetFilename: null,
    selectedPresetFilenames: [...(state.scenario?.source === 'preset' ? [state.scenario.reference!.id] : []), ...state.auxScenarios.filter(item => item.source === 'preset').map(item => item.reference!.id)],
    capabilities: { browseMain: true, randomMatchMain: false, clearMain: true, uploadMain: false, pasteMain: false, presetRefs: true,
      auxSection: true, addAux: state.scenario !== null && count < MAX_ARENA_REFERENCE_ITEMS, browseAux: true, randomMatchAux: false,
      uploadAux: false, pasteAux: false, reorderAux: true, removeAux: true, clearAux: true },
    actions: { openMainModal: openMain, randomMatchMain: noop, clearMain: actions.clearScenario, uploadMain: noUpload, pasteMain: noUpload,
      openAuxModal: openAux, randomMatchAux: noop, uploadAux: noUpload, pasteAux: noUpload,
      togglePreset: id => actions.togglePreset('scenario', id), moveAux: actions.moveAuxScenario, removeAux: actions.removeAuxScenario, clearAux: actions.clearAuxScenarios },
  };
}
export function buildArenaMemberMaterialModel({ state, actions, disabled, resolveName, open }: ArenaMemberSectionInput & { open(): void }): ArenaMaterialSectionModel {
  const count = state.auxScenarios.length + state.materials.length;
  return { disabled, items: state.materials.map(item => ({ key: item.key, name: nameOf(item, 'material', resolveName),
    sourceLabel: item.source === 'preset' ? '内置预设' : item.source === 'host-local' ? '房主本地素材' : '公开在线数据卡', fileName: null })),
    statsLine: `已选素材 ${state.materials.length}；参考项合计 ${count}/${MAX_ARENA_REFERENCE_ITEMS}`,
    notice: '内置素材预设暂不可用：目前没有经过服务器确认的素材目录，避免未验证的正文进入提案。',
    hasReferenceCapacity: count < MAX_ARENA_REFERENCE_ITEMS,
    capabilities: { browseOnline: true, clearAll: true, upload: false, paste: false, reorder: true },
    actions: { openModal: open, clearAll: actions.clearMaterials, upload: noUpload, paste: noUpload, move: actions.moveMaterial, remove: actions.removeMaterial },
  };
}
