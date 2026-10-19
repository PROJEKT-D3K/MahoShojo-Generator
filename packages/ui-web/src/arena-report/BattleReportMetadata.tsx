import { getVisibleOutputTokens, normalizeUsage } from '@mahoshojo/ai-core/token-usage';
import type { ArenaBattleReport } from '@mahoshojo/ai-core/arena-generation';

/** 两种报告共用的元数据展示：缺失用量不估算、不补零。 */
export function BattleReportMetadata({ aiModel, aiUsage, narrativeHistoryReadCount, showModelAndTokens = true }: {
  aiModel?: string | null;
  aiUsage?: ArenaBattleReport['aiUsage'] | null;
  narrativeHistoryReadCount?: number | null;
  showModelAndTokens?: boolean;
}) {
  const usage = normalizeUsage(aiUsage);
  const hasHistory = typeof narrativeHistoryReadCount === 'number';
  if (!showModelAndTokens && !hasHistory) return null;
  const token = (value: number | undefined) => value === undefined ? '未提供' : value.toLocaleString();
  return <p className="text-xs text-gray-400 mt-1">
    {showModelAndTokens ? <>
      模型：{aiModel?.trim() || '未提供'} · tokens：输入 {token(usage?.promptTokens)}｜推理 {token(usage?.reasoningTokens)}｜输出 {token(getVisibleOutputTokens(usage))}
    </> : null}
    {showModelAndTokens && hasHistory ? ' · ' : ''}
    {hasHistory ? <>叙事历史读取：{narrativeHistoryReadCount} 条</> : null}
  </p>;
}
