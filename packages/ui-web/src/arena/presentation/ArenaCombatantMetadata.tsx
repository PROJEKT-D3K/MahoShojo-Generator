import type { ArenaEloPrediction } from '@mahoshojo/domain/arena-elo';
import type { CombatantData } from '@mahoshojo/domain/arena-file-parser';

/** 宿主只传已验证的事实；不能从签名存在或预设身份推断原生。 */
export function ArenaCombatantTags({ combatant }: { combatant: Pick<CombatantData, 'isValid' | 'isPreset' | 'isNonStandard' | 'wasCorrected'> }) {
  return <>
    {combatant.isValid ? <span className="text-green-600 whitespace-nowrap">(原生)</span> : null}
    {combatant.isPreset ? <span className="text-purple-600 whitespace-nowrap">(预设)</span> : null}
    {combatant.isNonStandard ? <span className="text-orange-500 font-semibold whitespace-nowrap">(非规范格式)</span> : null}
    {combatant.wasCorrected ? <span className="text-yellow-600 whitespace-nowrap">(格式已修正)</span> : null}
  </>;
}
export function ArenaCombatantTechScore({ techScore }: { techScore: number | null | undefined }) {
  return <span className="whitespace-normal break-words sm:whitespace-nowrap">技术值：{typeof techScore === 'number' && Number.isFinite(techScore) ? techScore : '-'}</span>;
}

export function ArenaCombatantWinRate({ prediction }: { prediction: ArenaEloPrediction }) {
  const queueLabel = prediction.queue === 'strict' ? '严格' : '自由';
  const title = `预计胜率（Elo · ${queueLabel}）：${prediction.expectedPct}%（${prediction.selfRating} vs ${prediction.opponentRating}）；实体评分观察值，不代表本次计分资格或正文已验签`;
  return <span className="whitespace-nowrap" title={title}>
    预计胜率：<span className="font-mono font-semibold text-sky-700">{prediction.expectedPct}%</span>
    <span className="ml-1 text-gray-500">（{queueLabel}）</span>
  </span>;
}
