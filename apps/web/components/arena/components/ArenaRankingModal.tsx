'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PRESET_LIST } from '@mahoshojo/domain/presets';
import { getCombatantCardLibrarySelectionId } from '@mahoshojo/domain/arena-file-parser';
import type { PublicRankingItem } from '@mahoshojo/contracts/public-ranking';
import { ArenaRankingModalView, type ArenaRankingRosterEntity, type RankingDetailsTarget } from '@mahoshojo/ui-web/ranking';
import { isPublicVisibility, mapPublicDataCardRowToBattleSelectionPayload, mapPublicDataCardRowToSourceData, type CardLibraryHost } from '@mahoshojo/ui-web/card-library';
import { LeaderboardEntityDetailsModal } from '@/components/ranking/LeaderboardEntityDetailsModal';
import { useWebRankingQuery, webRankingCache } from '@/components/ranking/use-ranking-query';
import { useWebCardLibraryHost } from '@/lib/card-library-host';
import { useBattleActions } from '../hooks/useBattleActions';
import { getArenaRosterCombatantKey, useBattleStore } from '../stores/useBattleStore';
import { type CombatantData, formatCombatantCount, isCombatantLimitReached, MAX_COMBATANTS } from '../types';
import { validateCanshouData, validateMagicalGirlData } from '../utils/characterValidator';

const presets = new Map(PRESET_LIST.map(preset => [preset.filename, preset]));

/** UI row keys never grant an online reference; only the host-owned source metadata does. */
export function projectWebRankingRoster(combatants: readonly unknown[]) {
  const rankableRosterEntities: ArenaRankingRosterEntity[] = [];
  const selectedEntityKeys = new Set<string>();
  for (const value of combatants) {
    if (!value || typeof value !== 'object' || !('data' in value)) continue;
    const card = value as CombatantData;
    if (card.isPreset) {
      if (presets.has(card.filename)) {
        rankableRosterEntities.push({ entityType: 'preset', entityId: card.filename });
        selectedEntityKeys.add(`preset:${card.filename}`);
      }
      continue;
    }
    const id = card.sourceDataCardId?.trim();
    const selectionId = getCombatantCardLibrarySelectionId(card);
    if (!id || selectionId?.startsWith('local:')) continue;
    rankableRosterEntities.push({ entityType: 'data_card', entityId: id });
    if (selectionId === `cloud:${id}`) selectedEntityKeys.add(`data_card:${id}`);
  }
  return { rankableRosterEntities, selectedEntityKeys };
}

export function ArenaRankingModal(props: { isOpen: boolean; onClose: () => void }) {
  const host = useWebCardLibraryHost();
  // Changing account invalidates pending reads/admissions without probing an account to browse rankings.
  return <ArenaRankingScope key={host.auth.userId ?? 'anonymous'} {...props} host={host} />;
}

function ArenaRankingScope({ isOpen, onClose, host }: { isOpen: boolean; onClose: () => void; host: CardLibraryHost }) {
  const combatants = useBattleStore(state => state.combatants);
  const setError = useBattleStore(state => state.setError);
  const isGenerating = useBattleStore(state => state.isGenerating);
  const { handleToggleCombatantDataCard } = useBattleActions();
  const roster = useMemo(() => projectWebRankingRoster(combatants), [combatants]);
  const [detailsEntity, setDetailsEntity] = useState<RankingDetailsTarget | null>(null);
  useEffect(() => { if (!isOpen) setDetailsEntity(null); }, [isOpen]);

  const toggleEntity = async (item: PublicRankingItem, nextSelected: boolean, signal: AbortSignal): Promise<void | false> => {
    if (signal.aborted || useBattleStore.getState().isGenerating) return false;
    if (item.entityType === 'data_card') {
      const context = { selectionId: `cloud:${item.entityId}`, rowSelectionId: `cloud:${item.entityId}`, storageLocation: 'cloud' as const, signal };
      // Removal uses the exact displayed online row, without rereading a withdrawn card.
      if (!nextSelected) return handleToggleCombatantDataCard(undefined, false, context);
      const result = await host.online.fetchPublicCardById(item.entityId, signal);
      signal.throwIfAborted();
      const body = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data as Record<string, unknown> : null;
      const row = body?.card && typeof body.card === 'object' && !Array.isArray(body.card) ? body.card as Record<string, unknown> : null;
      if (!result.ok || body?.success !== true || !row || row.id !== item.entityId) throw new Error('无法读取当前公开数据卡，请刷新后重试。');
      if (row.type !== 'character' || !isPublicVisibility(row.is_public) || row.review_status !== 'approved' || row.deleted_at != null || row.storageLocation !== undefined && row.storageLocation !== 'cloud') throw new Error('数据卡已撤回或尚未公开通过审核。');
      const payload = mapPublicDataCardRowToBattleSelectionPayload(row);
      const applied = await handleToggleCombatantDataCard(payload, true, { ...context, cloudCardId: item.entityId, cloudCardUpdatedAt: payload._updatedAt, rawSourceData: mapPublicDataCardRowToSourceData(row) });
      if (applied === false || signal.aborted) return false;
      if (!host.platform.marks.isUsed(item.entityId)) {
        void host.online.reportCardStat(item.entityId, 'usage').then(ok => { if (ok) host.platform.marks.markUsed(item.entityId); }).catch(() => undefined);
      }
      return;
    }

    const current = useBattleStore.getState();
    const selected = current.combatants.filter((card): card is CombatantData => 'data' in card && card.isPreset && card.filename === item.entityId);
    if (!nextSelected) {
      if (!selected.length) return false;
      // Typed roster refs preserve imported filenames which collide with preset/cloud aliases.
      selected.forEach(card => current.removeCombatant({ rosterKey: getArenaRosterCombatantKey(card) }));
      current.setError(null);
      return;
    }
    if (selected.length) return false;
    const preset = presets.get(item.entityId);
    if (!preset) throw new Error('此客户端未收录该预设正文。');
    const response = await fetch(`/presets/${encodeURIComponent(preset.filename)}`, { signal, credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw new Error('无法加载预设设定文件。');
    const data: unknown = await response.json();
    signal.throwIfAborted();
    const validation = preset.type === 'canshou' ? validateCanshouData(data) : validateMagicalGirlData(data);
    if (!validation.success) throw new Error(validation.errors?.[0] || '格式校验失败');
    let committed = false;
    useBattleStore.setState(state => {
      if (signal.aborted || state.isGenerating || state.combatants.some(card => 'data' in card && card.isPreset && card.filename === preset.filename)) return state;
      if (isCombatantLimitReached(state.combatants.length, MAX_COMBATANTS)) return { error: `❌ 最多只能选择 ${MAX_COMBATANTS} 位参战者。` };
      committed = true;
      return { combatants: [...state.combatants, { type: preset.type, data: validation.data ?? data, filename: preset.filename, isValid: true, isPreset: true } as CombatantData], error: null };
    });
    return committed ? undefined : false;
  };

  return <>
    <ArenaRankingModalView isOpen={isOpen} onClose={onClose} useRankingQuery={useWebRankingQuery} Link={Link} cache={webRankingCache}
      {...roster} selectionCountLabel={formatCombatantCount(combatants.filter(card => 'data' in card).length)} onToggleEntity={toggleEntity}
      selectionDisabledReason={isGenerating ? '战报生成中，请稍后调整参战者。' : null} onSelectionError={setError} onOpenEntityDetails={setDetailsEntity}
      getEntityUnavailableReason={item => item.entityType === 'preset' && !presets.has(item.entityId) ? '此客户端未收录该预设正文' : null} />
    <LeaderboardEntityDetailsModal isOpen={isOpen && Boolean(detailsEntity)} onClose={() => setDetailsEntity(null)} entity={detailsEntity} />
  </>;
}
