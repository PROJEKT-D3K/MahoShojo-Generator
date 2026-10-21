import { getCombatantTypeLabel, getCombatantCardLibrarySelectionId } from '@mahoshojo/domain/arena-file-parser';
import { computeTechIndex } from '@mahoshojo/domain/metrics/tech-index';
import { ArenaCombatantTags, ArenaCombatantTechScore, type ArenaRosterRowExtras } from '@mahoshojo/ui-web/arena';
import { TechBadge, TierBadge, type CardLibraryDetailsModalProps } from '@mahoshojo/ui-web/card-library';
import type { ArenaDraft } from './session';
import { arenaItemName } from './input';

type Combatant = ArenaDraft['combatants'][number];
export type DesktopRosterDisplayMetadata = { techScore: number | null; techLevel: string | null; strictTier: string | null };

export type DesktopRosterMetadataSnapshot = { body: string; metadata: DesktopRosterDisplayMetadata };
export function readDesktopRosterMetadata(card: Combatant, snapshots: ReadonlyMap<string, DesktopRosterMetadataSnapshot>) {
  const snapshot = snapshots.get(getCombatantCardLibrarySelectionId(card) ?? '');
  return snapshot?.body === JSON.stringify(card.data) ? snapshot.metadata : undefined;
}

/** 指标只用于展示；不改变正文、签名、来源资格或发送给模型的输入。 */
export function buildDesktopRosterExtras(card: Combatant, onShowDetails: () => void, metadata?: DesktopRosterDisplayMetadata): ArenaRosterRowExtras {
  let localTech: ReturnType<typeof computeTechIndex> | null = null;
  try { localTech = computeTechIndex(card.data); } catch { /* 辅助指标失败不能阻断正文与详情。 */ }
  const techScore = metadata?.techScore ?? localTech?.techScore ?? null;
  const techLevel = metadata?.techLevel ?? localTech?.techLevel ?? null;
  return {
    tags: <ArenaCombatantTags combatant={card} />,
    onShowDetails,
    rankingBadge: <span title={metadata ? '选卡时的线上指标快照，不代表正文已验签' : undefined} className="flex flex-wrap items-center gap-1 min-w-0">
      {metadata?.strictTier ? <><TierBadge tier={metadata.strictTier} /><span className="text-[10px] text-gray-500">(严格)</span></> : null}
      {techLevel ? <TechBadge mode="level" techScore={techScore} techLevel={techLevel} /> : null}
    </span>,
    ranking: <ArenaCombatantTechScore techScore={techScore} />,
  };
}

/** 冻结已选择的正文，不以重新读取的在线版本替换当前参战角色。 */
export function snapshotDesktopRosterDetails(card: Combatant): Pick<CardLibraryDetailsModalProps, 'card' | 'source'> {
  return {
    card: { id: `selected:${card.filename}`, name: arenaItemName(card.data), description: getCombatantTypeLabel(card.type), type: 'character', data: JSON.stringify(card.data), isPublic: false },
    source: card.desktopSource === 'preset' && card.isPreset ? { kind: 'preset' } : { kind: 'local', label: '已选角色正文快照', provenance: '不代表当前线上版本；本机未验证签名' },
  };
}
