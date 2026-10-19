import { useLayoutEffect, useRef, useState } from 'react';
import type { ArenaRoomGenerationResult } from '@mahoshojo/contracts/arena-room';
import { RoomGenerationResult, type RoomGenerationView } from '@mahoshojo/ui-web/arena-room';
import { ArenaWebResultView, CombatantUpdatesPresentation, StreamingBattleReportCard, type BattleReportHostPorts } from '@mahoshojo/ui-web/arena-report';
import { BattleStoryContentPreview } from '@mahoshojo/ui-web/arena-story-session';
import { DENY_EXTERNAL_MEDIA, MarkdownBlock } from '@mahoshojo/ui-web/markdown';
import { generationActionClassNames } from '@mahoshojo/ui-web/generation-actions';
import { ErrorMessageBox } from '@mahoshojo/ui-web/details-controls';
import { downloadTextFile } from '../../platform/download-text-file';
import { useExternalLinks } from '../external-links/external-links-provider';

export type DesktopRoomGenerationResultProps = {
  readonly generation: RoomGenerationView & { readonly result?: ArenaRoomGenerationResult | null };
  /** Room/epoch/generation identity resets an explicitly expanded long preview. */
  readonly generationKey: string;
  readonly onRetry?: () => void | Promise<void>;
  readonly retryDisabled?: boolean;
  /** Bind export errors to this visible room result, not the hidden ordinary editor. */
  readonly createReportPorts?: (onError: (error: unknown) => void) => BattleReportHostPorts;
};

/** Read-only room report: shared renderers with the existing Desktop media/link gates. */
export function DesktopRoomGenerationResult({ generation, generationKey, onRetry, retryDisabled, createReportPorts }: DesktopRoomGenerationResultProps) {
  const { openContent } = useExternalLinks();
  const [exportError, setExportError] = useState<{ generationKey: string; message: string } | null>(null);
  const activeGenerationKey = useRef<string | null>(generationKey);
  useLayoutEffect(() => {
    activeGenerationKey.current = generationKey;
    return () => { activeGenerationKey.current = null; };
  }, [generationKey]);
  const reportError = (error: unknown) => {
    if (activeGenerationKey.current !== generationKey) return;
    setExportError({ generationKey, message: error instanceof Error && error.message.trim() ? error.message : '导出失败，战报原文仍保留。' });
  };
  const download = (filename: string, content: string, mimeType: string) => {
    setExportError(null);
    try { downloadTextFile(filename, content, mimeType); } catch (error) { reportError(error); }
  };
  const hostPorts = createReportPorts?.(reportError) ?? { mediaPolicy: DENY_EXTERNAL_MEDIA, onNavigateExternal: openContent,
    downloadMarkdown: (content: string, filename: string) => download(filename, content, 'text/markdown;charset=utf-8') };
  const reportPorts: BattleReportHostPorts = {
    ...hostPorts,
    downloadMarkdown: hostPorts.downloadMarkdown ? (content, filename) => {
      setExportError(null);
      try { hostPorts.downloadMarkdown?.(content, filename); } catch (error) { reportError(error); }
    } : undefined,
    saveImage: hostPorts.saveImage ? async (element, context) => {
      setExportError(null);
      await hostPorts.saveImage?.(element, context);
    } : undefined,
    onImageSaveError: hostPorts.onImageSaveError ?? reportError,
  };
  const result = generation.result;
  const web = result?.format === 'stream-web';
  const ready = generation.finalAuthoritative && generation.phase === 'completed';
  const exportFull = () => download(web ? '房间战报源码.txt' : '房间战报完整正文.md', generation.markdown,
    web ? 'text/plain;charset=utf-8' : 'text/markdown;charset=utf-8');
  return <><RoomGenerationResult generation={generation} onRetry={onRetry} retryDisabled={retryDisabled} report={<>
    {!generation.finalAuthoritative && generation.markdown ? <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">当前显示实时预览，最终内容仍以服务器生成记录核验为准。</p> : null}
    <div className="mt-6">
      <BattleStoryContentPreview key={generationKey} characterCount={generation.markdown.length}
        exportAction={<button type="button" className={generationActionClassNames.secondary} onClick={exportFull}>导出当前完整正文</button>}>
        <StreamingBattleReportCard content={generation.markdown}
          isStreaming={generation.phase === 'running' || generation.phase === 'starting' || generation.phase === 'resyncing'}
          mode={result?.mode} scenarioName={result?.scenarioDisplayName} reporterInfo={result?.reporterInfo ?? null}
          userGuidance={result?.sharedGuidance ?? null}
          characterGuidances={result?.characterGuidances?.map(guidance => ({ characterName: guidance.displayName, guidance: guidance.guidance })) ?? null}
          adjudicationResults={result?.adjudicationResults ?? null} aiUsage={result?.ai?.usage ?? null} aiModel={result?.ai?.model ?? null}
          narrativeHistoryReadCount={result?.narrativeHistoryReadCount ?? null}
          ports={reportPorts}
          disableExport={web}
          reportContent={web ? <ArenaWebResultView source={generation.markdown} ready={ready}
            actions={[{ id: 'export-room-web-source', label: '导出安全源码文本', onClick: exportFull }]}
            execution={{ available: false, reason: '当前房间战报只展示安全源码；隔离运行尚未开放，不会在主界面执行网页或加载包资源。' }} /> : undefined} />
      </BattleStoryContentPreview>
    </div>
    {result?.combatantUpdates?.length ? <CombatantUpdatesPresentation title="战后角色变化"
      description={`服务器公开的安全摘要（共 ${result.combatantUpdates.length} 个）`}
      items={result.combatantUpdates.map(update => ({ key: update.combatantKey, displayName: update.displayName, impact: update.impact, currentStateSummary: update.currentStateSummary }))}
      defaultOpen={false} storageKey="arena.section.safeCombatantUpdates.open" emptyMessage="本场没有可公开的角色变化。"
      renderMarkdown={content => <MarkdownBlock content={content} variant="light" externalMediaPolicy={DENY_EXTERNAL_MEDIA} onNavigateExternal={openContent} />} /> : null}
  </>} />
    {exportError?.generationKey === generationKey ? <ErrorMessageBox message={exportError.message} /> : null}
  </>;
}
