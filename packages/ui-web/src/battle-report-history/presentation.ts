import type { BattleReportSummary } from '@mahoshojo/contracts/battle-report-history';
export const battleReportSourceLabel = (record: Pick<BattleReportSummary, 'sourceKind' | 'arenaParticipantRole'>): string => {
  if (record.sourceKind === 'pvp') return 'PVP';
  if (record.sourceKind === 'arena-multiplayer') {
    if (record.arenaParticipantRole === 'host') return '多人 · 房主';
    if (record.arenaParticipantRole === 'member') return '多人 · 成员';
    return '多人参与';
  }
  return '单人';
};
export const formatBattleReportTime = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : iso;
};
export const formatBattleReportDuration = (ms: number): string => {
  if (!Number.isFinite(ms)) return '未知';
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
};
