'use client';
import { buildArenaMemberWebPackageModel } from '@mahoshojo/ui-web/arena-room';
import type { ArenaWebPackageSectionModel } from './web-package-contract';
import { useProposalSectionInput } from '../useProposalSectionInput';
import { useWebPackagePresetDownload } from './useWebPackagePresetDownload';

export const useProposalWebPackageSectionModel = (input: { disabled: boolean; onActionError(message: string): void }): ArenaWebPackageSectionModel => {
  const section = useProposalSectionInput(input.disabled, input.onActionError);
  const { downloadingDigest, downloadError, downloadPreset } = useWebPackagePresetDownload();
  if (!section) throw new Error('Proposal Web package section requires a member editor session');
  return buildArenaMemberWebPackageModel({ ...section, downloadingDigest, downloadError, download: downloadPreset, onError: input.onActionError });
};
