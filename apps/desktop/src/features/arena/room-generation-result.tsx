import type { ArenaRoomGenerationResult } from '@mahoshojo/contracts/arena-room';
import { RoomGenerationResult, type RoomGenerationView } from '@mahoshojo/ui-web/arena-room';
import { ArenaWebResultView, CombatantUpdatesPresentation, StreamingBattleReportCard } from '@mahoshojo/ui-web/arena-report';
import { BattleStoryContentPreview } from '@mahoshojo/ui-web/arena-story-session';
import { DENY_EXTERNAL_MEDIA, MarkdownBlock } from '@mahoshojo/ui-web/markdown';
import { generationActionClassNames } from '@mahoshojo/ui-web/generation-actions';
import { downloadTextFile } from '../../platform/download-text-file';
import { useExternalLinks } from '../external-links/external-links-provider';

export type DesktopRoomGenerationResultProps = {
  readonly generation: RoomGenerationView & { readonly result?: ArenaRoomGenerationResult | null };
  /** Room/epoch/generation identity resets an explicitly expanded long preview. */
  readonly generationKey: string;
  readonly onRetry?: () => void | Promise<void>;
  readonly retryDisabled?: boolean;
};

/** Read-only room report: shared renderers with the existing Desktop media/link gates. */
export function DesktopRoomGenerationResult({ generation, generationKey, onRetry, retryDisabled }: DesktopRoomGenerationResultProps) {
  const { openContent } = useExternalLinks();
  const result = generation.result;
  const web = result?.format === 'stream-web';
  const ready = generation.finalAuthoritative && generation.phase === 'completed';
  const exportFull = () => downloadTextFile(web ? '房间战报源码.txt' : '房间战报完整正文.md', generation.markdown,
    web ? 'text/plain;charset=utf-8' : 'text/markdown;charset=utf-8');
  return <RoomGenerationResult generation={generation} onRetry={onRetry} retryDisabled={retryDisabled} report={<>
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
          ports={{ mediaPolicy: DENY_EXTERNAL_MEDIA, onNavigateExternal: openContent,
            downloadMarkdown: (content, filename) => downloadTextFile(filename, content, 'text/markdown;charset=utf-8') }}
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
  </>} />;
}
