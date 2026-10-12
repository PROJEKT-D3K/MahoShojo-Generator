import { useState } from 'react';
import { formatBattleModeLabel, formatSeasonTitle, getCurrentSeason } from '@mahoshojo/domain/public-ranking';
import { StrictSetupChecklist } from '@mahoshojo/ui-web/arena';
import { useDesktopRankingQuery } from '../ranking/use-ranking-query';
import { describeDesktopStrictSetup, type DesktopStrictSetupInput } from './strict-setup';

export function DesktopStrictConfigurationDiagnostics(props: DesktopStrictSetupInput) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details className="rounded-xl border border-gray-200 bg-white/70 p-3" aria-label="严格排位配置检查" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-medium text-gray-800">严格排位配置检查（只读）</summary>
      {expanded ? <OpenDiagnostics {...props} /> : null}
    </details>
  );
}

/** Closing unmounts the reader, so its old response cannot enter a later opening. */
function OpenDiagnostics(props: DesktopStrictSetupInput) {
  const query = useDesktopRankingQuery({ request: { kind: 'seasons' } });
  const season = getCurrentSeason(query.data);
  const setup = season ? describeDesktopStrictSetup(props, season) : null;
  return (
    <div className="mt-3 space-y-3 text-xs text-gray-600">
      <p>仅检查当前单次草稿的基础配置，不适用于连续故事。服务器资格未知，未查询卡片资格、次数或冷却；是否计分以服务器结算为准。</p>
      {query.isLoading ? <p role="status">正在读取公开赛季规则…</p> : query.isError ? (
        <p role="alert">无法读取公开赛季规则，暂不能检查当前配置。<button type="button" className="ml-2 text-blue-700 underline" onClick={() => void query.refetch()}>重试读取赛季</button></p>
      ) : !season || !setup ? <p role="status">未找到当前赛季，暂不能检查当前配置。</p> : (
        <>
          <div className="space-y-1">
            <p>当前赛季：{formatSeasonTitle(season)}</p>
            <p>要求：{formatBattleModeLabel(setup.rules.mode)}模式 · 简体中文 · 2 人对战 · 服务器执行</p>
            <p className="whitespace-pre-wrap break-words">故事引导：{setup.rules.storyGuidance || '留空'}</p>
            {setup.rules.mode === 'scenario' && season.specialRules?.scenarioPresetFilename ? <p className="break-words">指定情景：{season.specialRules.scenarioPresetFilename}（本机文件名不代表已确认预设来源）</p> : null}
            <p className="break-words">Lore：{setup.rules.questionnaireLorePresetIds.length > 0 ? `需注入 ${setup.rules.questionnaireLorePresetIds.join('、')}` : setup.rules.questionnaireLoreAllowed ? '允许注入' : '关闭注入'}</p>
          </div>
          <StrictSetupChecklist reasons={setup.reasons} title="当前草稿的基础缺项或未确认项" readyLabel="基础配置已对齐" readyMessage="基础配置已对齐；服务器资格仍未知。" />
          <button type="button" className="text-blue-700 underline" onClick={() => void query.refetch()}>刷新赛季规则</button>
        </>
      )}
    </div>
  );
}
