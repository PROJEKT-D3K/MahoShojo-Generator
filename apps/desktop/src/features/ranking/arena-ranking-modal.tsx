import { useEffect, useMemo, useState } from 'react';
import { PRESET_LIST } from '@mahoshojo/domain/presets';
import { getCombatantCardLibrarySelectionId } from '@mahoshojo/domain/arena-file-parser';
import type { PublicRankingItem } from '@mahoshojo/contracts/public-ranking';
import { ArenaRankingModalView, type ArenaRankingRosterEntity, type RankingDetailsTarget } from '@mahoshojo/ui-web/ranking';
import { mapPublicDataCardRowToBattleSelectionPayload, mapPublicDataCardRowToSourceData, type CardLibraryHost, type CardLibrarySelectionContext } from '@mahoshojo/ui-web/card-library';
import { DesktopRankingDetailsModal, canOpenDesktopRankingDetails } from '../card-details/ranking-details-modal';
import { readDesktopMemberPublicCard } from '../arena/room-member-source-data';
import { isDesktopStrictSource } from '../arena/strict-source';
import type { ArenaDraft } from '../arena/session';
import { useDesktopRankingQuery } from './use-ranking-query';

export function projectDesktopRankingRoster(combatants: ArenaDraft['combatants']) {
  const rankableRosterEntities: ArenaRankingRosterEntity[] = [];
  const selectedEntityKeys = new Set<string>();
  for (const card of combatants) {
    const selectionId = getCombatantCardLibrarySelectionId(card);
    if (card.isPreset) selectedEntityKeys.add(`preset:${card.filename}`);
    else if (selectionId?.startsWith('cloud:')) selectedEntityKeys.add(`data_card:${selectionId.slice('cloud:'.length)}`);
    // A restored/local/cache body or its cloudRef cannot acquire an online pivot.
    if (isDesktopStrictSource(card)) rankableRosterEntities.push(card.desktopSource === 'preset'
      ? { entityType: 'preset', entityId: card.filename }
      : { entityType: 'data_card', entityId: card.sourceDataCardId!.trim() });
  }
  return { rankableRosterEntities, selectedEntityKeys };
}

type Props = {
  isOpen: boolean;
  onClose: () => void;
  host: CardLibraryHost;
  combatants: ArenaDraft['combatants'];
  maxCombatants: number;
  selectionDisabledReason?: string | null;
  onToggleCharacter: (payload: unknown, nextSelected: boolean, context: CardLibrarySelectionContext) => Promise<void | false>;
  onTogglePreset: (filename: string, nextSelected: boolean, signal: AbortSignal) => Promise<void | false>;
  onSelectionError: (message: string | null) => void;
};

export function DesktopArenaRankingModal({ isOpen, onClose, host, combatants, maxCombatants, selectionDisabledReason, onToggleCharacter, onTogglePreset, onSelectionError }: Props) {
  const roster = useMemo(() => projectDesktopRankingRoster(combatants), [combatants]);
  const [detailsEntity, setDetailsEntity] = useState<RankingDetailsTarget | null>(null);
  useEffect(() => { if (!isOpen) setDetailsEntity(null); }, [isOpen]);
  const toggleEntity = async (item: PublicRankingItem, nextSelected: boolean, signal: AbortSignal): Promise<void | false> => {
    signal.throwIfAborted();
    if (item.entityType === 'preset') return onTogglePreset(item.entityId, nextSelected, signal);
    const context = { selectionId: `cloud:${item.entityId}`, rowSelectionId: `cloud:${item.entityId}`, storageLocation: 'cloud' as const, signal };
    if (!nextSelected) return onToggleCharacter(undefined, false, context);
    const { row, ref } = await readDesktopMemberPublicCard(host.online, item.entityId, 'character', signal);
    const payload = mapPublicDataCardRowToBattleSelectionPayload(row);
    const applied = await onToggleCharacter(payload, true, { ...context, cloudCardId: ref.id, cloudCardUpdatedAt: ref.versionToken, rawSourceData: mapPublicDataCardRowToSourceData(row),
      displayMetadata: { techScore: item.techScore, techLevel: item.techLevel, strictTier: null } });
    if (applied === false || signal.aborted) return false;
    if (!host.platform.marks.isUsed(ref.id)) {
      void host.online.reportCardStat(ref.id, 'usage').then(ok => { if (ok) host.platform.marks.markUsed(ref.id); }).catch(() => undefined);
    }
  };
  return <>
    <ArenaRankingModalView isOpen={isOpen} onClose={onClose} useRankingQuery={useDesktopRankingQuery} Link={host.platform.Link}
      {...roster} selectionDisabledReason={selectionDisabledReason} selectionCountLabel={`${combatants.length}/${maxCombatants}`} onToggleEntity={toggleEntity} onSelectionError={onSelectionError}
      onOpenEntityDetails={setDetailsEntity} canOpenEntityDetails={canOpenDesktopRankingDetails}
      getEntityUnavailableReason={item => item.entityType === 'preset' && !PRESET_LIST.some(preset => preset.filename === item.entityId) ? '此客户端未收录该预设正文' : null} />
    <DesktopRankingDetailsModal entity={isOpen ? detailsEntity : null} onClose={() => setDetailsEntity(null)} host={host} />
  </>;
}
