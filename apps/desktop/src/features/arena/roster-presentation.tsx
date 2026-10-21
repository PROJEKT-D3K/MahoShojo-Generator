import type { PublicEntityRating } from '@mahoshojo/contracts/public-ranking';
import type { GenerationRankingParticipant } from '@mahoshojo/contracts/arena-generation-ranking';
import type { ArenaEloPrediction, ArenaQueueRatings } from '@mahoshojo/domain/arena-elo';
import { getCombatantTypeLabel, getCombatantCardLibrarySelectionId } from '@mahoshojo/domain/arena-file-parser';
import { computeTechIndex } from '@mahoshojo/domain/metrics/tech-index';
import { ArenaCombatantTags, ArenaCombatantTechScore, ArenaCombatantWinRate, ArenaRankingQueueFeedback, type ArenaRosterRowExtras } from '@mahoshojo/ui-web/arena';
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
export function buildDesktopRosterExtras(card: Combatant, onShowDetails: () => void, metadata?: DesktopRosterDisplayMetadata, observation?: { hasSource: boolean; rating: (ArenaQueueRatings & { tiers?: { strict: PublicEntityRating['tier']; free: PublicEntityRating['tier'] } }) | null; prediction: ArenaEloPrediction | null }, generationParticipant?: GenerationRankingParticipant | null): ArenaRosterRowExtras {
  let localTech: ReturnType<typeof computeTechIndex> | null = null;
  try { localTech = computeTechIndex(card.data); } catch { /* 辅助指标失败不能阻断正文与详情。 */ }
  const techScore = metadata?.techScore ?? localTech?.techScore ?? null;
  const techLevel = metadata?.techLevel ?? localTech?.techLevel ?? null;
  const tiers = observation?.hasSource ? observation.rating?.tiers : null;
  const currentTier = tiers?.strict ? { tier: tiers.strict, label: '严格' } : tiers?.free ? { tier: tiers.free, label: '自由' } : null;
  return {
    tags: <ArenaCombatantTags combatant={card} />,
    onShowDetails,
    rankingBadge: <span className="flex flex-wrap items-center gap-1 min-w-0">
      {currentTier ? <span className="inline-flex items-center gap-1" title="当前实体段位观察值，不代表此正文版本或本次计分资格">
        <TierBadge tier={currentTier.tier} /><span className="text-[10px] text-gray-500">({currentTier.label})</span>
      </span> : metadata?.strictTier ? <span className="inline-flex items-center gap-1" title="选卡时的严格段位快照，非当前段位，不代表正文已验签或本次计分资格">
        <TierBadge tier={metadata.strictTier} /><span className="text-[10px] text-gray-500">(严格·选卡时快照)</span>
      </span> : null}
      {techLevel ? <span title={metadata ? '选卡时的线上技术指标快照，不代表正文已验签' : undefined}><TechBadge mode="level" techScore={techScore} techLevel={techLevel} /></span> : null}
    </span>,
    ranking: <><div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0" title={observation?.hasSource ? '当前实体评分观察值，不代表此正文版本或本次计分资格' : undefined}>
      <ArenaCombatantTechScore techScore={techScore} />
      {observation?.hasSource ? <>
        <ArenaRankingQueueFeedback queue="strict" result={null} fallbackRating={observation.rating?.strict} />
        <ArenaRankingQueueFeedback queue="free" result={null} fallbackRating={observation.rating?.free} />
      </> : null}
      {observation?.prediction ? <ArenaCombatantWinRate prediction={observation.prediction} /> : null}
    </div>
      {generationParticipant ? <div className="space-y-1" aria-label="本局排位结算（生成时）" title="本局生成时该实体的结算历史，不代表更新后的正文获计分或具有严格排位资格">
        <p className="text-xs text-gray-500">本局排位结算（生成时）</p>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <ArenaRankingQueueFeedback queue="strict" result={generationParticipant.queues.strict} />
          <ArenaRankingQueueFeedback queue="free" result={generationParticipant.queues.free} />
        </div>
      </div> : null}
    </>,
  };
}

/** 冻结已选择的正文，不以重新读取的在线版本替换当前参战角色。 */
export function snapshotDesktopRosterDetails(card: Combatant): Pick<CardLibraryDetailsModalProps, 'card' | 'source'> {
  return {
    card: { id: `selected:${card.filename}`, name: arenaItemName(card.data), description: getCombatantTypeLabel(card.type), type: 'character', data: JSON.stringify(card.data), isPublic: false },
    source: card.desktopSource === 'preset' && card.isPreset ? { kind: 'preset' } : { kind: 'local', label: '已选角色正文快照', provenance: '不代表当前线上版本；本机未验证签名' },
  };
}
