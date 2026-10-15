'use client';
import { buildArenaMemberMaterialModel } from '@mahoshojo/ui-web/arena-room';
import type { ArenaMaterialSectionModel } from './material-contract';
import { useProposalSectionInput } from '../useProposalSectionInput';

const inertModel: ArenaMaterialSectionModel = {
  disabled: true,
  items: [],
  statsLine: null,
  notice: null,
  hasReferenceCapacity: false,
  capabilities: {
    browseOnline: false,
    clearAll: false,
    upload: false,
    paste: false,
    reorder: false,
  },
  actions: {
    openModal: () => undefined,
    clearAll: () => undefined,
    upload: async () => undefined,
    paste: async () => undefined,
    move: () => undefined,
    remove: () => undefined,
  },
};


export const useProposalMaterialSectionModel = (input: { disabled: boolean; onActionError(message: string): void; onOpenModal(): void }): ArenaMaterialSectionModel => {
  const section = useProposalSectionInput(input.disabled, input.onActionError);
  return section ? buildArenaMemberMaterialModel({ ...section, open: input.onOpenModal }) : inertModel;
};
