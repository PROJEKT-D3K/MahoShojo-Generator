import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PublicSeasonMeta } from '@mahoshojo/contracts/public-ranking';
import type { DesktopStrictPreflightResponse } from '@mahoshojo/contracts/arena-strict-preflight';
import { formatStrictReason } from '@mahoshojo/domain/arena-strict-setup';
import type { ResolvedDesktopAiTarget } from '../ai-config/desktop-ai-config';
import { readStrictPreflight } from '../../platform/strict-preflight-bridge';
import { buildDesktopStrictPreflightInput } from './strict-preflight-input';
import { formatBattleModeLabel, formatSeasonTitle, getCurrentSeason } from '@mahoshojo/domain/public-ranking';
import { StrictSetupChecklist } from '@mahoshojo/ui-web/arena';
import { useDesktopRankingQuery } from '../ranking/use-ranking-query';
import { describeDesktopStrictSetup, type DesktopStrictSetupInput } from './strict-setup';

export interface DesktopStrictCheckSnapshot { key: object; season: PublicSeasonMeta; result: DesktopStrictPreflightResponse }
export interface DesktopStrictJourney {
  active: boolean; disabled: boolean; snapshotKey: object; target: ResolvedDesktopAiTarget; expectedUserId: number | null;
  isCurrent: (key: object) => boolean;
  prepare: (season: PublicSeasonMeta) => Promise<void>; exit: () => void; invalidate: () => void;
  checked: (snapshot: DesktopStrictCheckSnapshot | null) => void;
}
type Props = DesktopStrictSetupInput & { journey?: DesktopStrictJourney };
export function DesktopStrictConfigurationDiagnostics(props: Props) {
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(false);
  return (
    <details className="rounded-xl border border-gray-200 bg-white/70 p-3" aria-label="严格排位配置检查" onToggle={(event) => { const open = event.currentTarget.open; if (expandedRef.current === open) return; expandedRef.current = open; setExpanded(open); if (!open) props.journey?.invalidate(); }}>
      <summary className="cursor-pointer text-sm font-medium text-gray-800">严格排位配置检查{props.journey ? '与准备' : '（只读）'}</summary>
      {expanded ? <OpenDiagnostics {...props} /> : null}
    </details>
  );
}

/** Closing unmounts the reader, so its old response cannot enter a later opening. */
function OpenDiagnostics(props: Props) {
  const latest = useRef(props); latest.current = props;
  const flight = useRef<symbol | null>(null);
  const [check, setCheck] = useState<{ key: object; loading: boolean; result?: DesktopStrictPreflightResponse; error?: string } | null>(null);
  useLayoutEffect(() => { flight.current = null; setCheck(null); }, [props.journey?.snapshotKey]);
  useEffect(() => () => { flight.current = null; }, []);
  const query = useDesktopRankingQuery({ request: { kind: 'seasons' } });
  const season = getCurrentSeason(query.data);
  const setup = season ? describeDesktopStrictSetup(props, season) : null;
  const journey = props.journey;
  const currentCheck = check?.key === journey?.snapshotKey ? check : null;
  const runCheck = async () => {
    if (!journey || !season || !setup || !journey.active || journey.disabled || flight.current || setup.reasons.length || journey.expectedUserId === null || !journey.isCurrent(journey.snapshotKey)) return;
    const token = Symbol(), key = journey.snapshotKey; flight.current = token; journey.checked(null);
    const current = () => flight.current === token && latest.current.journey?.snapshotKey === key && latest.current.journey.isCurrent(key);
    setCheck({ key, loading: true });
    try {
      const body = buildDesktopStrictPreflightInput(props.draft, journey.target, props.adjudicationEventCount);
      const result = await readStrictPreflight(invoke, { expectedUserId: journey.expectedUserId, body });
      if (!current()) return;
      setCheck({ key, loading: false, result }); journey.checked({ key, season, result });
    } catch (cause) { if (current()) setCheck({ key, loading: false, error: cause instanceof Error ? cause.message : '服务器预检失败，请重试。' }); }
    finally { if (flight.current === token) flight.current = null; }
  };
  return (
    <div className="mt-3 space-y-3 text-xs text-gray-600">
      <p>{journey ? '准备仅用于当前页面的单次战报。服务器预检是当时的建议快照，不是计分保证；生成与结算仍由服务器按现有规则裁决。' : '仅检查当前单次草稿的基础配置，不适用于连续故事。服务器资格未知，未查询卡片资格、次数或冷却；是否计分以服务器结算为准。'}</p>
      {journey && !currentCheck?.result && !currentCheck?.loading ? <p>尚无当前服务器预检结果；服务器资格未知。</p> : null}
      {journey?.active ? <button type="button" disabled={journey.disabled} className="text-blue-700 underline" onClick={journey.exit}>退出严格排位准备</button> : null}
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
          {journey ? <div className="space-y-2">
            {!journey.active ? <button type="button" disabled={journey.disabled} className="text-blue-700 underline" onClick={() => void journey.prepare(season)}>一键严格设置并锁定服务器</button> : <>
              <p>本地或缓存副本需重新从线上卡库选择，或先到角色管理显式上传；不会自动上传。恢复草稿及生成后角色更新不沿用旧计分引用。</p>
              <button type="button" disabled={journey.disabled || setup.reasons.length > 0 || currentCheck?.loading} className="text-blue-700 underline" onClick={() => void runCheck()}>检查服务器计分条件</button>
            </>}
            {currentCheck?.loading ? <p role="status">正在检查服务器计分条件…</p> : null}
            {currentCheck?.error ? <p role="alert">{currentCheck.error}</p> : null}
            {currentCheck?.result ? <div role="status" aria-label="服务器预检结果">
              <p>{currentCheck.result.willCount ? '当前服务器预检未发现计分阻断；开始生成后仍可能因规则或状态变化不计分。' : '当前服务器预检发现计分阻断。'}</p>
              {currentCheck.result.reasons.length ? <ul>{currentCheck.result.reasons.map(reason => <li key={reason}>{formatStrictReason(reason)}</li>)}</ul> : null}
              <p>今日计分：{currentCheck.result.daily.used ?? '未知'} / {currentCheck.result.daily.limit}；同组合：{currentCheck.result.pair.used ?? '未知'} / {currentCheck.result.pair.limit}</p>
              {currentCheck.result.pair.nextEligibleAtIso ? <p>服务器返回的下次可计分时间：{currentCheck.result.pair.nextEligibleAtIso}</p> : null}
            </div> : null}
          </div> : null}
          <button type="button" disabled={journey?.disabled} className="text-blue-700 underline" onClick={() => { journey?.invalidate(); void query.refetch(); }}>刷新赛季规则</button>
        </>
      )}
    </div>
  );
}
