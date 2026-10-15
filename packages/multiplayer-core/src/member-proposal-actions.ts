import type { ArenaRoomSharedConfig, DataCardRef, SharedHistorySettings } from '@mahoshojo/contracts/arena-room';
import { ARENA_ROOM_PRESET_CATALOG } from './preset-catalog';

export type ArenaMemberProposalUpdate = (_update: (_draft: ArenaRoomSharedConfig) => ArenaRoomSharedConfig) => void;
export type ArenaMemberProposalSourceKind = 'character' | 'scenario' | 'auxScenario' | 'material';

const move = <T>(items: readonly T[], from: number, to: number): T[] => {
  const next = [...items];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
};

/** Only projected references enter this boundary. Public visibility is verified by the source adapter and server. */
export function createArenaMemberProposalActions(update: ArenaMemberProposalUpdate) {
  const removeCombatant = (key: string) => update(draft => ({ ...draft,
    combatants: draft.combatants.filter(item => item.key !== key),
    teams: draft.teams.map(team => ({ ...team, combatantKeys: team.combatantKeys.filter(item => item !== key) })),
  }));
  return Object.freeze({
    setBattleMode: (value: ArenaRoomSharedConfig['battleMode']) => update(draft => ({ ...draft, battleMode: value })),
    setReportFormat: (value: ArenaRoomSharedConfig['reportFormat']) => update(draft => ({ ...draft, reportFormat: value, webPackageRef: value === 'web' ? draft.webPackageRef : undefined })),
    setWebPackageRef: (value: ArenaRoomSharedConfig['webPackageRef'] | null) => update(draft => ({ ...draft, webPackageRef: value ?? undefined })),
    setStoryLength: (value: ArenaRoomSharedConfig['storyLength']) => update(draft => ({ ...draft, storyLength: value })),
    setCustomStoryLength: (value: string) => update(draft => ({ ...draft, customStoryLength: value.trim() || null })),
    setSelectedLanguage: (value: string) => update(draft => ({ ...draft, selectedLanguage: value })),
    setUserGuidance: (value: string) => update(draft => ({ ...draft, userGuidance: value })),
    updateHistorySettings: (value: Partial<SharedHistorySettings>) => update(draft => ({ ...draft, historySettings: { ...draft.historySettings, ...value } })),
    selectOnlineReference(kind: ArenaMemberProposalSourceKind, ref: DataCardRef, selected = true): void {
      const expectedKind = kind === 'auxScenario' ? 'scenario' : kind;
      if (ref.kind !== expectedKind) throw new Error('在线数据卡类型不匹配');
      // Project explicitly: never retain source payloads or client-only fields.
      const entry = { key: `data-card:${ref.id}`, ref: { id: ref.id, kind: ref.kind, versionToken: ref.versionToken } };
      if (kind === 'character' && !selected) return removeCombatant(entry.key);
      update(draft => {
        if (kind === 'character') return { ...draft, combatants: [...draft.combatants.filter(item => item.key !== entry.key), { ...entry, ref: { ...entry.ref, kind: 'character' as const } }] };
        if (kind === 'scenario') return { ...draft, scenario: selected ? { ...entry, ref: { ...entry.ref, kind: 'scenario' as const } } : null };
        const field = kind === 'auxScenario' ? 'auxScenarios' : 'materials';
        return { ...draft, [field]: selected ? [...draft[field].filter(item => item.key !== entry.key), entry] : draft[field].filter(item => item.key !== entry.key) };
      });
    },
    togglePreset(kind: 'character' | 'scenario', id: string): void {
      const preset = ARENA_ROOM_PRESET_CATALOG.find(item => item.kind === kind && item.id === id);
      if (!preset) throw new Error('预设元数据不可用，请刷新后重试');
      const entry = { key: `preset:${preset.id}`, ref: { id: preset.id, kind, versionToken: preset.versionToken } };
      update(draft => {
        if (kind === 'character') {
          const removing = draft.combatants.some(item => item.key === entry.key);
          return { ...draft, combatants: removing ? draft.combatants.filter(item => item.key !== entry.key) : [...draft.combatants, { ...entry, ref: { ...entry.ref, kind: 'character' as const } }],
            teams: removing ? draft.teams.map(team => ({ ...team, combatantKeys: team.combatantKeys.filter(key => key !== entry.key) })) : draft.teams };
        }
        if (draft.scenario?.key === entry.key) return { ...draft, scenario: null };
        if (draft.auxScenarios.some(item => item.key === entry.key)) return { ...draft, auxScenarios: draft.auxScenarios.filter(item => item.key !== entry.key) };
        return draft.scenario === null ? { ...draft, scenario: { ...entry, ref: { ...entry.ref, kind: 'scenario' as const } } } : { ...draft, auxScenarios: [...draft.auxScenarios, { ...entry, ref: { ...entry.ref, kind: 'scenario' as const } }] };
      });
    },
    moveCombatant: (from: number, to: number) => update(draft => ({ ...draft, combatants: move(draft.combatants, from, to) })),
    removeCombatant,
    setCharacterGuidance: (key: string, value: string) => update(draft => ({ ...draft, combatants: draft.combatants.map(item => item.key === key ? { ...item, characterGuidance: value.trim() ? value : undefined } : item) })),
    createTeam: (key: string, name?: string) => update(draft => ({ ...draft, teams: [...draft.teams, { key, displayName: name ?? `分队 ${draft.teams.length + 1}`, combatantKeys: [] }] })),
    renameTeam: (key: string, name: string) => { if (name.trim()) update(draft => ({ ...draft, teams: draft.teams.map(team => team.key === key ? { ...team, displayName: name.trim() } : team) })); },
    removeTeam: (key: string) => update(draft => ({ ...draft, teams: draft.teams.filter(team => team.key !== key) })),
    moveTeam: (key: string, direction: number) => update(draft => { const index = draft.teams.findIndex(team => team.key === key); return { ...draft, teams: move(draft.teams, index, index + direction) }; }),
    assignCombatant: (key: string, teamKey: string | null) => update(draft => ({ ...draft, teams: draft.teams.map(team => ({ ...team, combatantKeys: team.key === teamKey ? [...team.combatantKeys.filter(item => item !== key), key] : team.combatantKeys.filter(item => item !== key) })) })),
    moveTeamMember: (key: string, from: number, to: number) => update(draft => ({ ...draft, teams: draft.teams.map(team => team.key === key ? { ...team, combatantKeys: move(team.combatantKeys, from, to) } : team) })),
    clearScenario: () => update(draft => ({ ...draft, scenario: null })),
    moveAuxScenario: (from: number, to: number) => update(draft => ({ ...draft, auxScenarios: move(draft.auxScenarios, from, to) })),
    removeAuxScenario: (key: string) => update(draft => ({ ...draft, auxScenarios: draft.auxScenarios.filter(item => item.key !== key) })),
    clearAuxScenarios: () => update(draft => ({ ...draft, auxScenarios: [] })),
    moveMaterial: (from: number, to: number) => update(draft => ({ ...draft, materials: move(draft.materials, from, to) })),
    removeMaterial: (key: string) => update(draft => ({ ...draft, materials: draft.materials.filter(item => item.key !== key) })),
    clearMaterials: () => update(draft => ({ ...draft, materials: [] })),
  });
}
export type ArenaMemberProposalActions = ReturnType<typeof createArenaMemberProposalActions>;
