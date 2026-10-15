'use client';
import { buildArenaMemberScenarioModel } from '@mahoshojo/ui-web/arena-room';
import type { ArenaScenarioSectionModel } from './scenario-contract';
import { useProposalSectionInput } from '../useProposalSectionInput';

const inertModel: ArenaScenarioSectionModel = {
  disabled: true,
  isAuthenticated: false,
  isMatchingBlocked: false,
  isMatchingScenario: false,
  mainName: null,
  mainIsNative: false,
  auxScenarios: [],
  auxBudgetLine: null,
  auxBudgetExhausted: false,
  presets: [],
  presetsLoading: false,
  presetsError: null,
  selectedPresetFilenames: [],
  loadingPresetFilename: null,
  capabilities: {
    browseMain: false,
    randomMatchMain: false,
    clearMain: false,
    uploadMain: false,
    pasteMain: false,
    presetRefs: false,
    auxSection: false,
    addAux: false,
    browseAux: false,
    randomMatchAux: false,
    uploadAux: false,
    pasteAux: false,
    reorderAux: false,
    removeAux: false,
    clearAux: false,
  },
  actions: {
    openMainModal: () => undefined,
    randomMatchMain: () => undefined,
    clearMain: () => undefined,
    uploadMain: async () => undefined,
    pasteMain: async () => undefined,
    openAuxModal: () => undefined,
    randomMatchAux: () => undefined,
    uploadAux: async () => undefined,
    pasteAux: async () => undefined,
    togglePreset: () => undefined,
    moveAux: () => undefined,
    removeAux: () => undefined,
    clearAux: () => undefined,
  },
};


export const useProposalScenarioSectionModel = (input: { disabled: boolean; onActionError(message: string): void; onOpenMainModal(): void; onOpenAuxModal(): void }): ArenaScenarioSectionModel => {
  const section = useProposalSectionInput(input.disabled, input.onActionError);
  return section ? buildArenaMemberScenarioModel({ ...section, openMain: input.onOpenMainModal, openAux: input.onOpenAuxModal }) : inertModel;
};
