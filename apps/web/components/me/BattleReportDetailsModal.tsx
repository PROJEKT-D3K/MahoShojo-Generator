'use client';
import { useQuery } from '@tanstack/react-query';
import { BattleReportDetailsView } from '@mahoshojo/ui-web/battle-report-history';
import { readBattleReport, useBattleReportIdentity } from './battle-report-reader';

type Props = {
  isOpen: boolean;
  generationId: string | null;
  ownerScope: string | null;
  onClose: () => void;
  onRegenerate: (generationId: string) => void;
  isRegenerating?: boolean;
  regenerateError?: string | null;
};
export function BattleReportDetailsModal({ ownerScope, ...props }: Props) {
  const identity = useBattleReportIdentity();
  const enabled = Boolean(identity.user && identity.scope === ownerScope && props.isOpen && props.generationId);
  const detailQuery = useQuery({
    queryKey: ['me', 'battle-reports', identity.scope, 'detail', props.generationId],
    enabled,
    queryFn: ({ signal }) => readBattleReport('detail', `/api/me/battle-reports/${encodeURIComponent(props.generationId!)}?expectedUserId=${identity.user!.id}`, identity.user, signal, props.generationId!),
    retry: false,
    gcTime: 0,
  });
  return <BattleReportDetailsView {...props} isOpen={enabled} data={enabled ? detailQuery.data : undefined}
    loading={enabled && detailQuery.isLoading} error={enabled && detailQuery.error instanceof Error ? detailQuery.error.message : null}
    onRetry={() => { if (enabled) void detailQuery.refetch(); }} />;
}
