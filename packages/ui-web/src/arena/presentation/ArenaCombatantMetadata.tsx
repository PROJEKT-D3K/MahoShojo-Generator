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
