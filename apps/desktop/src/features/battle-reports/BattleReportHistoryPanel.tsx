import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BattleReportDetailsView, BattleReportsListView, useBattleReportFilters } from '@mahoshojo/ui-web/battle-report-history';
import type { BattleReportDetail, BattleReportList } from '@mahoshojo/contracts/battle-report-history';
import { readCloudBattleReports } from '../../platform/battle-report-bridge';
import { DesktopCloudError } from '../../platform/cloud-bridge';
import { useDesktopCloudSession } from '../account/use-desktop-cloud-session';
import type { DesktopCloudSessionStore } from '../account/cloud-session-store';

type ReadState<T> = { key: string; data?: T; loading: boolean; error: string | null };
const pending = <T,>(key: string): ReadState<T> => ({ key, loading: true, error: null });

function OwnedBattleReportHistory({ store, userId, epoch }: { store: DesktopCloudSessionStore; userId: number; epoch: number }) {
  const { filters, setFilters, searchInput, setSearchInput } = useBattleReportFilters();
  const [refresh, setRefresh] = useState(0);
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const listKey = JSON.stringify([filters, refresh]);
  const detailKey = JSON.stringify([generationId, detailRefresh]);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const [list, setList] = useState<ReadState<BattleReportList>>(() => pending(listKey));
  const [detail, setDetail] = useState<ReadState<BattleReportDetail>>(() => pending(detailKey));
  useEffect(() => {
    const sequence = ++listSequence.current;
    let active = true;
    const isCurrent = () => active && sequence === listSequence.current && store.getSnapshot().account?.userId === userId && store.getCredentialEpoch() === epoch;
    setList(pending(listKey));
    if (isCurrent()) void readCloudBattleReports(invoke, { kind: 'list', expectedUserId: userId, filters }).then((data) => {
      if (isCurrent()) setList({ key: listKey, data, loading: false, error: null });
    }).catch((cause: unknown) => {
      if (!isCurrent()) return;
      setList({ key: listKey, loading: false, error: cause instanceof Error ? cause.message : '战报读取失败，请重试' });
      if (cause instanceof DesktopCloudError && cause.code === 'not-authenticated') void store.refresh();
    });
    return () => { active = false; };
  }, [store, userId, epoch, filters, listKey]);
  useEffect(() => {
    const sequence = ++detailSequence.current;
    let active = true;
    const isCurrent = () => active && sequence === detailSequence.current && store.getSnapshot().account?.userId === userId && store.getCredentialEpoch() === epoch;
    setDetail(pending(detailKey));
    if (generationId && isCurrent()) void readCloudBattleReports(invoke, { kind: 'detail', expectedUserId: userId, generationId }).then((data) => {
      if (isCurrent()) setDetail({ key: detailKey, data, loading: false, error: null });
    }).catch((cause: unknown) => {
      if (!isCurrent()) return;
      setDetail({ key: detailKey, loading: false, error: cause instanceof Error ? cause.message : '战报详情读取失败，请重试' });
      if (cause instanceof DesktopCloudError && cause.code === 'not-authenticated') void store.refresh();
    });
    return () => { active = false; };
  }, [store, userId, epoch, generationId, detailKey]);
  const currentList = list.key === listKey ? list : pending<BattleReportList>(listKey);
  const currentDetail = detail.key === detailKey ? detail : pending<BattleReportDetail>(detailKey);
  return <>
    <p className="mt-2 text-xs text-gray-600">服务器战报可能被清理，预览按现存内容展示。此页不保存本地副本。</p>
    <BattleReportsListView filters={filters} onFiltersChange={setFilters} searchInput={searchInput} onSearchInputChange={setSearchInput}
      data={currentList.data} loading={currentList.loading} refreshing={currentList.loading} error={currentList.error}
      onRefresh={() => setRefresh((value) => value + 1)} onOpenDetails={(id) => { setGenerationId(id); setDetailRefresh((value) => value + 1); }} />
    <BattleReportDetailsView isOpen={generationId !== null} generationId={generationId} data={currentDetail.data}
      loading={currentDetail.loading} error={currentDetail.error} onClose={() => setGenerationId(null)} onRetry={() => setDetailRefresh((value) => value + 1)} />
  </>;
}

export function BattleReportHistoryPanel() {
  const { state, store } = useDesktopCloudSession();
  const userId = state.account?.userId ?? null;
  const epoch = store.getCredentialEpoch();
  return <section aria-label="服务器战报记录">
    <h2 className="text-sm font-semibold text-gray-700">战报记录</h2>
    {userId === null ? <p className="mt-2 text-sm text-gray-600">登录后可查看服务器战报记录。</p>
      : <OwnedBattleReportHistory key={`${userId}:${epoch}`} store={store} userId={userId} epoch={epoch} />}
  </section>;
}
