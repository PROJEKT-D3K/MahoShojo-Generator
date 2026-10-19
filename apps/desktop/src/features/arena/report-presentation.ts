import { ArenaCompanionReportSchema, ArenaCompanionAdjudicationResultSchema } from '@mahoshojo/contracts/arena-companion';
import { normalizeUsage } from '@mahoshojo/ai-core/token-usage';
import type { StreamingBattleReportCardProps } from '@mahoshojo/ui-web/arena-report';
import type { ArenaSessionState } from './session';

/** 只展示原任务快照，不用当前模型选择或编辑后的草稿改写旧战报。 */
export function projectDesktopArenaReport(state: ArenaSessionState): StreamingBattleReportCardProps {
  const report = state.report;
  const saved = state.presentation;
  const header = state.hosted?.headerMeta;
  const telemetry = state.hosted?.telemetry;
  const successTelemetry = telemetry && !('errorClass' in telemetry) ? telemetry : null;
  const frozen = state.generation?.input;
  const reporter = report?.reporterInfo ?? header?.reporterInfo ?? saved?.reporterInfo;
  const reporterInfo = reporter && typeof reporter.name === 'string' && typeof reporter.publication === 'string'
    ? { name: reporter.name, publication: reporter.publication } : null;
  const characterGuidances = report?.characterGuidances ?? header?.characterGuidances?.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return typeof value.characterName === 'string' && typeof value.guidance === 'string'
      ? [{ characterName: value.characterName, guidance: value.guidance }] : [];
  });
  const model = report?.aiModel ?? successTelemetry?.aiModel
    ?? saved?.aiModel ?? (state.generation?.intent.mode !== 'hosted' ? state.generation?.intent.modelId : null);
  const mode = report?.mode ?? header?.mode ?? saved?.mode ?? frozen?.battleMode;
  return {
    content: state.activeGenerationMode === 'stream' || state.phase === 'completed' ? state.markdown : '',
    isStreaming: state.phase === 'generating',
    mode,
    scenarioName: mode === 'scenario' ? report?.scenario ?? header?.scenarioDisplayName ?? saved?.scenarioName ?? frozen?.scenarioDisplayName ?? undefined : undefined,
    reporterInfo,
    userGuidance: report?.userGuidance ?? header?.userGuidance ?? saved?.userGuidance ?? frozen?.settings.userGuidance,
    characterGuidances: characterGuidances ?? saved?.characterGuidances,
    adjudicationResults: report?.adjudicationResults ?? state.generation?.adjudicationResults ?? saved?.adjudicationResults,
    aiUsage: normalizeUsage(report?.aiUsage ?? successTelemetry?.usage ?? state.usage ?? saved?.aiUsage),
    aiModel: model ?? null,
    narrativeHistoryReadCount: report?.narrativeHistoryReadCount ?? successTelemetry?.narrativeHistoryReadCount ?? header?.narrativeHistoryReadCount ?? saved?.narrativeHistoryReadCount,
    aiReasoning: report?.aiReasoning ?? (state.reasoning ? {
      status: state.phase === 'generating' ? 'thinking' : 'done', source: 'provider', text: state.reasoning,
    } : null),
    softTimeoutWarning: state.hosted?.softTimeoutWarning,
    stopGenerationLabel: state.hosted?.connectionState === 'cancelling' ? '正在停止…' : '停止生成',
    stopGenerationDisabled: state.hosted?.connectionState === 'cancelling',
  };
}

export type ArenaReportPresentationSnapshot = { version: 1 } & Pick<StreamingBattleReportCardProps,
  'mode' | 'scenarioName' | 'reporterInfo' | 'aiModel' | 'aiUsage' | 'userGuidance' | 'characterGuidances' | 'adjudicationResults' | 'narrativeHistoryReadCount'>;

/** 可选本机展示快照；正文仍只保存一份，不恢复执行身份、完成证明或写入权限。 */
export function readArenaReportPresentationSnapshot(value: unknown): ArenaReportPresentationSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;
  const fields = ArenaCompanionReportSchema.shape;
  const mode = fields.mode.safeParse(raw.mode);
  const reporter = fields.reporterInfo.safeParse(raw.reporterInfo);
  const adjudications = ArenaCompanionAdjudicationResultSchema.array().safeParse(raw.adjudicationResults);
  const history = fields.narrativeHistoryReadCount.safeParse(raw.narrativeHistoryReadCount);
  return {
    version: 1,
    ...(mode.success ? { mode: mode.data } : {}),
    ...(typeof raw.scenarioName === 'string' ? { scenarioName: raw.scenarioName } : {}),
    ...(typeof raw.aiModel === 'string' ? { aiModel: raw.aiModel } : {}),
    aiUsage: normalizeUsage(raw.aiUsage),
    ...(reporter.success ? { reporterInfo: reporter.data } : {}),
    ...(typeof raw.userGuidance === 'string' ? { userGuidance: raw.userGuidance } : {}),
    ...(Array.isArray(raw.characterGuidances) ? { characterGuidances: raw.characterGuidances.flatMap(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      return typeof value.characterName === 'string' && typeof value.guidance === 'string'
        ? [{ characterName: value.characterName, guidance: value.guidance }] : [];
    }) } : {}),
    ...(adjudications.success ? { adjudicationResults: adjudications.data } : {}),
    ...(history.success ? { narrativeHistoryReadCount: history.data } : {}),
  };
}

export function snapshotDesktopArenaReport(state: ArenaSessionState): ArenaReportPresentationSnapshot | null {
  const snapshot = readArenaReportPresentationSnapshot({ ...projectDesktopArenaReport(state), version: 1 });
  return snapshot && Object.entries(snapshot).some(([key, value]) => key !== 'version' && value != null) ? snapshot : null;
}
