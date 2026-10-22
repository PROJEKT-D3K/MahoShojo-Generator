'use client';
import { CombatantRepairPanel } from '@mahoshojo/ui-web/arena-report-views';

import { useGeneratedResultAutoScroll } from '@mahoshojo/ui-web/details-controls';

import SaveToCloudButton from '@/components/SaveToCloudButton';
import type { NewsReport, BattleReportIllustrationAsset } from '@/components/BattleReportCard';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useBattleStore } from '../stores/useBattleStore';
import { useBattleEngine } from '../hooks/useBattleEngine';
import { useCombatantRepair } from '../hooks/useCombatantRepair';
import { getCombatantDisplayName } from '../utils/characterValidator';
import { inferTemplate } from '@/lib/data-card-converter';
import { BattleStoreState, CombatantData } from '../types';
import { MarkdownBlock } from './DeferredArenaRenderers';
import { CollapsibleSection } from '@/components/shared/CollapsibleSection';
import { JsonSizeIndicator } from '@/components/shared/JsonSizeIndicator';
import { BattleIllustrationPanel } from './DeferredArenaRenderers';
import { BattleResultPresentation } from './BattleResultPresentation';
import { CombatantUpdatesPresentation } from './CombatantUpdatesPresentation';
import { resolveBattleReportCardManualWidthPx } from '../utils/battleReportCardWidth';
import { resolveBattleResultContext } from '../utils/battleResultContext';
import { downloadBlob } from '@/lib/client/blobUrl';

interface BattleResultProps {
  onSaveImage: (imageUrl: string) => void;
}

export function BattleResult({ onSaveImage }: BattleResultProps) {
  const {
    handleRetryUpdates,
    stopGeneration,
    isRedoingUpdates,
    isRecoveringArenaGeneration,
    arenaGenerationConnectionState,
  } = useBattleEngine();
  const combatantRepair = useCombatantRepair();
  const useBattleSelector = <T,>(selector: (state: BattleStoreState) => T) => useBattleStore(selector);
  const resultSectionRef = useRef<HTMLDivElement | null>(null);
  const beginResultNavigation = useGeneratedResultAutoScroll(resultSectionRef);
  const resultNavigation = useBattleSelector((state) => state.resultNavigation);
  // 再次进入页面时已有结果仅展示；只有挂载后新发出的请求结果通知才定位。
  const observedNavigation = useRef(resultNavigation);
  useEffect(() => {
    if (observedNavigation.current === resultNavigation) return;
    observedNavigation.current = resultNavigation;
    if (resultNavigation) beginResultNavigation(resultNavigation.request, resultNavigation.signal)();
  }, [beginResultNavigation, resultNavigation]);
  const adjudicationResults = useBattleSelector((state) => state.adjudicationResults);
  const newsReport = useBattleSelector((state) => state.newsReport);
  const resultReportFormat = useBattleSelector((state) => state.resultReportFormat);
  const resultWebReady = useBattleSelector((state) => state.resultWebReady);
  const resultWebPackage = useBattleSelector((state) => state.resultWebPackage);
  const resultContext = useBattleSelector((state) => state.resultContext);
  const streamingMarkdown = useBattleSelector((state) => state.streamingMarkdown);
  const streamReporterInfo = useBattleSelector((state) => state.streamReporterInfo);
  const streamUserGuidance = useBattleSelector((state) => state.streamUserGuidance);
  const streamCharacterGuidances = useBattleSelector((state) => state.streamCharacterGuidances);
  const streamAiUsage = useBattleSelector((state) => state.streamAiUsage);
  const streamAiModel = useBattleSelector((state) => state.streamAiModel);
  const streamNarrativeHistoryReadCount = useBattleSelector((state) => state.streamNarrativeHistoryReadCount);
  const streamReasoning = useBattleSelector((state) => state.streamReasoning);
  const streamUpdateMetaDebug = useBattleSelector((state) => state.streamUpdateMetaDebug);
  const streamSoftTimeoutWarning = useBattleSelector((state) => state.streamSoftTimeoutWarning);
  const isGenerating = useBattleSelector((state) => state.isGenerating);
  const combatants = useBattleSelector((state) => state.combatants);
  const updatedCombatants = useBattleSelector((state) => state.updatedCombatants);
  const latestAiImpacts = useBattleSelector((state) => state.latestAiImpacts);
  const lastGenerationId = useBattleSelector((state) => state.lastGenerationId);
  const settings = useBattleSelector((state) => state.settings);
  const isCancellingArenaGeneration = arenaGenerationConnectionState === 'cancelling';
  const [illustrationAsset, setIllustrationAsset] = useState<BattleReportIllustrationAsset | null>(null);
  const battleReportCardWidthPx = resolveBattleReportCardManualWidthPx(settings);

  const displayContext = useMemo(() => resolveBattleResultContext({
    resultContext, newsReport, streamingMarkdown,
  }), [resultContext, newsReport, streamingMarkdown]);
  const generationMode = displayContext?.generationMode;
  const battleMode = displayContext?.battleMode ?? undefined;
  const scenarioDisplayName = displayContext?.scenarioDisplayName ?? undefined;

  const hasBattleReport = generationMode === 'stream' ? Boolean(streamingMarkdown)
    : generationMode === 'non-stream' && Boolean(newsReport);
  const shouldShowIllustrationPanel = hasBattleReport && !isGenerating;
  const illustrationPanelKey = `${generationMode}:${lastGenerationId ?? 'no-id'}:${
    generationMode === 'stream'
      ? (streamingMarkdown ?? '').slice(0, 80)
      : (newsReport?.headline ?? '')
  }`;
  const promptCombatants = useMemo(
    () => combatants.filter((item): item is CombatantData => 'data' in item),
    [combatants]
  );
  const updatedCombatantPresentationItems = useMemo(() => (
    updatedCombatants.flatMap((character, index) => {
      const entries = character.arena_history?.entries;
      const latestEntry = Array.isArray(entries) && entries.length > 0
        ? entries[entries.length - 1]
        : null;
      const impact = typeof latestEntry?.impact === 'string' ? latestEntry.impact.trim() : null;
      const stateSummary = typeof character.current_state?.summary === 'string'
        ? character.current_state.summary.trim()
        : null;
      if (!impact && !stateSummary) return [];

      const name = getCombatantDisplayName(character);
      const template = inferTemplate(character);
      const typeDisplay = template === 'magical-girl'
        ? '魔法少女'
        : template === 'canshou'
          ? '残兽'
          : '通用角色';
      return [{
        key: `updated-combatant-${index}`,
        displayName: name,
        typeLabel: typeDisplay,
        impact,
        currentStateSummary: stateSummary,
      }];
    })
  ), [updatedCombatants]);
  const updatedCombatantsByPresentationKey = useMemo(
    () => new Map(updatedCombatants.map((character, index) => [
      `updated-combatant-${index}`,
      character,
    ])),
    [updatedCombatants]
  );
  const canWriteUpdates = settings.writeArenaHistory || settings.writeCurrentState;
  const shouldShowCombatantUpdates =
    canWriteUpdates || Boolean(lastGenerationId) || updatedCombatants.length > 0;
  const streamMetaDebugSummary = useMemo(() => {
    if (!streamUpdateMetaDebug) return null;
    const sourceLabel = streamUpdateMetaDebug.source === 'sse' ? 'SSE' : '注释解析';
    const okLabel = streamUpdateMetaDebug.parseOk ? '解析成功' : '解析失败';
    const rawLabel = streamUpdateMetaDebug.raw ? (streamUpdateMetaDebug.rawTruncated ? 'raw 已截断' : 'raw 可用') : 'raw 缺失';
    return `${sourceLabel}｜${okLabel}｜${rawLabel}`;
  }, [streamUpdateMetaDebug]);
  const streamMetaParsedJson = useMemo(() => {
    if (!streamUpdateMetaDebug?.meta) return '';
    try {
      return JSON.stringify(streamUpdateMetaDebug.meta, null, 2);
    } catch {
      return '';
    }
  }, [streamUpdateMetaDebug?.meta]);
  const downloadUpdatedJson = (characterData: any) => {
    const name = characterData.codename || characterData.name;
    const jsonData = JSON.stringify(characterData, null, 2);
    const blob = new Blob([jsonData], { type: 'application/json' });
    downloadBlob(blob, `角色设定_${name}_更新.json`);
  };

  useEffect(() => {
    setIllustrationAsset(null);
  }, [lastGenerationId]);

  useEffect(() => {
    if (!hasBattleReport) {
      setIllustrationAsset(null);
    }
  }, [hasBattleReport]);

  return (
    <>
      <div ref={resultSectionRef}>
      <BattleResultPresentation
        report={generationMode === 'stream'
          ? isGenerating || streamingMarkdown !== null
            ? {
                format: resultReportFormat === 'web' ? 'stream-web' : 'stream-markdown',
                webReady: resultWebReady,
                webPackage: resultWebPackage,
                content: streamingMarkdown ?? '',
                headline: streamUpdateMetaDebug?.meta?.report?.headline ?? null,
                mode: battleMode,
                scenarioName: scenarioDisplayName,
                reporterInfo: streamReporterInfo,
                userGuidance: streamUserGuidance,
                characterGuidances: streamCharacterGuidances,
                aiUsage: streamAiUsage,
                aiModel: streamAiModel,
                narrativeHistoryReadCount: streamNarrativeHistoryReadCount,
                aiReasoning: streamReasoning,
                isStreaming: isGenerating,
                softTimeoutWarning: streamSoftTimeoutWarning,
                onStopGeneration: stopGeneration,
                stopGenerationLabel: isCancellingArenaGeneration
                  ? '正在停止…'
                  : isRecoveringArenaGeneration
                    ? '放弃恢复'
                    : '停止生成',
                stopGenerationDisabled: isCancellingArenaGeneration,
                illustrationAsset,
                cardWidthPx: battleReportCardWidthPx,
              }
            : null
          : generationMode === 'non-stream' && newsReport
            ? newsReport.reportFormat === 'web'
              ? {
                  format: 'web-document',
                  content: newsReport.webHtml ?? newsReport.article.body,
                  webPackage: newsReport.webPackage,
                  headline: newsReport.headline ?? null,
                  webReady: resultWebReady,
                  isStreaming: false,
                  mode: battleMode,
                  scenarioName: scenarioDisplayName,
                  reporterInfo: newsReport.reporterInfo,
                  userGuidance: newsReport.userGuidance,
                  characterGuidances: newsReport.characterGuidances,
                  aiUsage: newsReport.aiUsage,
                  aiModel: newsReport.aiModel,
                  aiReasoning: newsReport.aiReasoning,
                  narrativeHistoryReadCount: newsReport.narrativeHistoryReadCount,
                  illustrationAsset,
                  cardWidthPx: battleReportCardWidthPx,
                }
              : {
                format: 'structured-report',
                report: newsReport as NewsReport,
                mode: battleMode,
                illustrationAsset,
                cardWidthPx: battleReportCardWidthPx,
              }
            : null}
        onSaveImage={onSaveImage}
        adjudicationResults={adjudicationResults}
      />
      </div>

      {shouldShowIllustrationPanel && (
        <BattleIllustrationPanel
          key={illustrationPanelKey}
          ownerKey={lastGenerationId ?? (generationMode === 'stream' ? streamingMarkdown : newsReport)}
          headline={generationMode === 'stream' ? null : (newsReport?.headline ?? null)}
          reportBody={generationMode === 'stream' ? null : (newsReport?.article?.body ?? null)}
          reportMarkdown={generationMode === 'stream' ? (streamingMarkdown ?? null) : null}
          combatants={promptCombatants}
          aiImpacts={latestAiImpacts}
          onIllustrationAssetChange={setIllustrationAsset}
        />
      )}

      {hasBattleReport && shouldShowCombatantUpdates && (
        <CombatantUpdatesPresentation
          title="角色更新"
          description={`可下载/保存本次更新的角色设定（共 ${updatedCombatants.length} 个）`}
          defaultOpen
          itemDefaultOpen={false}
          storageKey="arena.section.updatedCombatants.open"
          emptyMessage="本次尚未产生可展示的角色更新。你可以点击“重试角色更新”，重试应用本次服务器已生成的历战记录/当前状态摘要。"
          headerRight={!combatantRepair.isInRoom ? (
            <button
              onClick={() => handleRetryUpdates()}
              disabled={
                isGenerating
                || isRedoingUpdates
                || combatantRepair.isCombatantMutationPending
                || !lastGenerationId
                || combatantRepair.isRepairAppliedForGeneration
              }
              className="px-3 py-1.5 text-xs font-semibold text-white bg-purple-500 rounded-lg hover:bg-purple-600 transition-colors disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
              title={combatantRepair.isRepairAppliedForGeneration
                ? '当前 roster 已应用自定义修复；需要生成新战报后才能再次权威重试'
                : lastGenerationId
                  ? '重试应用本次服务器已生成的角色更新'
                  : '本次战报缺少 generationId，无法安全重试'}
            >
              {isRedoingUpdates ? '重试中...' : '重试角色更新'}
            </button>
          ) : undefined}
          items={updatedCombatantPresentationItems}
          renderBeforeItems={(
            <>
              {combatantRepair.hasRepairContext && !combatantRepair.isInRoom && (
                <CombatantRepairPanel draft={combatantRepair.draftText} onDraftChange={combatantRepair.setDraftText}
                  onApply={() => { void combatantRepair.applyArenaRepairDraft(); }} applying={combatantRepair.isApplyingRepair}
                  disabled={isGenerating || combatantRepair.isGeneratingDraft || combatantRepair.isCombatantMutationPending}
                  applied={combatantRepair.isRepairAppliedForGeneration} error={combatantRepair.repairError} notice={combatantRepair.repairNotice}
                  storageKey="arena.section.combatantRepair.open" aiControls={(<div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => combatantRepair.generateAiRepairDraft()}
                        disabled={
                          isGenerating
                          || combatantRepair.isGeneratingDraft
                          || combatantRepair.isApplyingRepair
                          || combatantRepair.isCooldown
                          || !combatantRepair.canGenerateAiDraft
                        }
                        className="rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {combatantRepair.isGeneratingDraft
                          ? 'AI 草稿生成中...'
                          : 'AI 重新生成修复草稿'}
                      </button>
                      {combatantRepair.isCooldown && (
                        <span className="text-xs text-gray-500">
                          Provider 冷却中（{combatantRepair.remainingTime}s）
                        </span>
                      )}
                      {!combatantRepair.canGenerateAiDraft && (
                        <span className="text-xs text-gray-500">
                          AI 草稿需要开启历战记录或当前状态写入；手动编辑仍可使用。
                        </span>
                      )}
                    </div>)} />
              )}
              {generationMode === 'stream' && streamUpdateMetaDebug && (
                <CollapsibleSection
                  title="元数据诊断"
                  description={streamMetaDebugSummary ?? undefined}
                  defaultOpen={false}
                  storageKey="arena.section.streamUpdateMetaDebug.open"
                  variant="panel"
                >
                  <div className="text-sm text-gray-600 space-y-3">
                    {streamUpdateMetaDebug.error && (
                      <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                        <div className="font-medium text-amber-800">错误信息</div>
                        <div className="mt-1 whitespace-pre-wrap break-words">{streamUpdateMetaDebug.error}</div>
                      </div>
                    )}
                    {streamMetaParsedJson && (
                      <div>
                        <div className="font-medium text-gray-700">解析结果（parsed meta）</div>
                        <div className="mt-1">
                          <MarkdownBlock content={`\`\`\`json\n${streamMetaParsedJson}\n\`\`\``} variant="light" />
                        </div>
                      </div>
                    )}
                    {streamUpdateMetaDebug.raw && (
                      <div>
                        <div className="font-medium text-gray-700">
                          原始输出（raw meta）{streamUpdateMetaDebug.rawTruncated ? '（已截断）' : ''}
                        </div>
                        <div className="mt-1">
                          <MarkdownBlock content={`\`\`\`\n${streamUpdateMetaDebug.raw}\n\`\`\``} variant="light" />
                        </div>
                      </div>
                    )}
                  </div>
                </CollapsibleSection>
              )}
            </>
          )}
          renderActions={(item) => {
            const character = updatedCombatantsByPresentationKey.get(item.key);
            if (!character) return null;
            return (
              <>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    onClick={() => downloadUpdatedJson(character)}
                    className="shrink-0 rounded-lg bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-600"
                  >
                    下载更新设定
                  </button>
                  <SaveToCloudButton
                    data={character}
                    buttonText="保存到云端"
                    className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-colors"
                    style={{ backgroundColor: '#22c55e', backgroundImage: 'linear-gradient(to right, #22c55e, #16a34a)' }}
                  />
                </div>
                <JsonSizeIndicator
                  data={character}
                  className="mt-2"
                  warningText="⚠️ 接近云端 300KB 上限，保存/替换可能失败，请先精简数据。"
                />
              </>
            );
          }}
        />
      )}
    </>
  );
}
