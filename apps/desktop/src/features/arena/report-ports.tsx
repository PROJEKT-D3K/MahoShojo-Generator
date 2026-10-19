import { capturePngBlob, DENY_SNAPDOM_MEDIA } from '@mahoshojo/ui-web/client';
import { GeneratedByUserBadgeView, type BattleReportHostPorts } from '@mahoshojo/ui-web/arena-report';
import { DENY_EXTERNAL_MEDIA } from '@mahoshojo/ui-web/markdown-text';
import { downloadBlobFile, downloadTextFile } from '../../platform/download-text-file';

export function createDesktopBattleReportPorts({ username, onNavigateExternal, onError, onExportingChange }: {
  username?: string | null;
  onNavigateExternal: NonNullable<BattleReportHostPorts['onNavigateExternal']>;
  onError(error: unknown): void;
  onExportingChange(exporting: boolean): void;
}): BattleReportHostPorts {
  return {
    mediaPolicy: DENY_EXTERNAL_MEDIA,
    onNavigateExternal,
    generatedBy: <GeneratedByUserBadgeView username={username} className="mt-3" />,
    downloadMarkdown: (content, filename) => {
      try { downloadTextFile(filename, content, 'text/markdown;charset=utf-8'); } catch (error) { onError(error); }
    },
    onImageSaveError: () => onError(new Error('生成图片失败，请重试。战报原文仍保留。')),
    saveImage: async (element, { filename }) => {
      onExportingChange(true);
      try {
        const blob = await capturePngBlob(element, { scale: 1, dprMax: 2, fast: false,
          exclude: ['audio', 'video'], excludeMode: 'remove', mediaAdapter: DENY_SNAPDOM_MEDIA });
        downloadBlobFile(filename, blob);
      } finally { onExportingChange(false); }
    },
  };
}
