'use client';
import { buildArenaMemberRosterModel } from '@mahoshojo/ui-web/arena-room';
import type { ArenaRosterSectionModel } from './roster-contract';
import { useProposalSectionInput } from '../useProposalSectionInput';
import { useState } from 'react';
import { randomUUID } from '@/lib/crypto';
import type { ArenaRoomReferenceDetailsRequest } from '@/lib/arena-room/reference-presentation';

const inertModel: ArenaRosterSectionModel = {
  rows: [],
  teams: [],
  capabilities: {
    reorderRows: false,
    removeRows: false,
    editGuidance: false,
    ranking: false,
    addPlaceholders: false,
    clearRoster: false,
    createTeams: false,
    renameTeams: false,
    removeTeams: false,
    reorderTeams: false,
    assignTeamMembers: false,
    reorderTeamMembers: false,
    collapseTeams: false,
  },
  disabled: true,
  combatantCountLabel: '0',
  combatantCapReached: true,
  actions: {
    moveRow: () => undefined,
    removeRow: () => undefined,
    setGuidance: () => undefined,
    addPlaceholder: () => undefined,
    clearRoster: () => undefined,
    createTeam: () => '',
    renameTeam: () => undefined,
    removeTeam: () => undefined,
    moveTeam: () => undefined,
    assignCombatant: () => undefined,
    moveTeamMember: () => undefined,
    toggleTeamCollapsed: () => undefined,
  },
};


export const useProposalRosterSectionModel = (input: { disabled: boolean; onActionError(message: string): void; onRequestDetails?(request: ArenaRoomReferenceDetailsRequest): void }): ArenaRosterSectionModel => {
  const section = useProposalSectionInput(input.disabled, input.onActionError);
  const [collapsedTeams, setCollapsedTeams] = useState<ReadonlySet<string>>(new Set());
  return section ? buildArenaMemberRosterModel({ ...section, collapsedTeams, createId: randomUUID, requestDetails: input.onRequestDetails,
    toggleTeamCollapsed: key => setCollapsedTeams(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; }) }) : inertModel;
};
