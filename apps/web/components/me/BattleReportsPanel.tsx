'use client';
import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { BattleReportsListView, useBattleReportFilters } from '@mahoshojo/ui-web/battle-report-history';
import { DEFAULT_BATTLE_REPORT_FILTERS, battleReportQueryParams, type BattleReportFilters } from '@mahoshojo/contracts/battle-report-history';
import { readBattleReport, useBattleReportIdentity } from './battle-report-reader';

type Props = {
  isAuthenticated: boolean;
  onOpenDetails: (generationId: string) => void;
  onRegenerate: (generationId: string) => void;
  isRegenerating: boolean;
  regenerateError: string | null;
};
const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
};

const getSingleQueryValue = (value: string | string[] | undefined): string | null => {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
  return typeof value === 'string' ? value : null;
};

const areQueryRecordsEqual = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const key = aKeys[i];
    if (key !== bKeys[i]) return false;
    if (a[key] !== b[key]) return false;
  }
  return true;
};

const normalizeQueryFromRouter = (
  query: Record<string, string | string[] | undefined>
): Record<string, string> => {
  const normalized: Record<string, string> = {};

  const page = clampInt(getSingleQueryValue(query.page), 1, 1, 10_000);
  const pageSize = clampInt(getSingleQueryValue(query.pageSize), 10, 1, 30);
  const status = getSingleQueryValue(query.status);
  const mode = getSingleQueryValue(query.mode);
  const generationMode = getSingleQueryValue(query.generationMode);
  const pvpOnly = getSingleQueryValue(query.pvpOnly);
  const sort = getSingleQueryValue(query.sort);
  const q = getSingleQueryValue(query.q);

  if (page !== 1) normalized.page = String(page);
  if (pageSize !== 10) normalized.pageSize = String(pageSize);
  if (status === 'completed' || status === 'aborted' || status === 'failed') normalized.status = status;
  if (mode === 'classic' || mode === 'kizuna' || mode === 'daily' || mode === 'scenario') normalized.mode = mode;
  if (generationMode === 'stream' || generationMode === 'non-stream') normalized.generationMode = generationMode;
  if (typeof pvpOnly === 'string') {
    const v = pvpOnly.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') normalized.pvpOnly = '1';
  }
  if (sort === 'started_at_asc' || sort === 'started_at_desc') {
    if (sort !== 'started_at_desc') normalized.sort = sort;
  }
  if (typeof q === 'string' && q.trim()) normalized.q = q.trim();

  return normalized;
};

export function BattleReportsPanel(props: Props) {
  const identity = useBattleReportIdentity();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [initial] = useState<BattleReportFilters>(() => {
    const query = normalizeQueryFromRouter(Object.fromEntries(searchParams?.entries() ?? []));
    return {
      ...DEFAULT_BATTLE_REPORT_FILTERS,
      page: Number(query.page ?? 1), pageSize: Number(query.pageSize ?? 10),
      status: (query.status ?? '') as BattleReportFilters['status'],
      mode: (query.mode ?? '') as BattleReportFilters['mode'],
      generationMode: (query.generationMode ?? '') as BattleReportFilters['generationMode'],
      pvpOnly: query.pvpOnly === '1', sort: (query.sort ?? 'started_at_desc') as BattleReportFilters['sort'], q: (query.q ?? '').slice(0, 120),
    };
  });
  const { filters, setFilters, searchInput, setSearchInput } = useBattleReportFilters(initial);
  useEffect(() => {
    if (!searchParams) return;
    const params = battleReportQueryParams(filters);
    if (filters.page === 1) params.delete('page');
    if (filters.pageSize === 10) params.delete('pageSize');
    if (filters.sort === 'started_at_desc') params.delete('sort');
    if (areQueryRecordsEqual(normalizeQueryFromRouter(Object.fromEntries(searchParams.entries())), Object.fromEntries(params))) return;
    const query = params.toString();
    window.history.replaceState(window.history.state, '', query ? `${pathname}?${query}` : pathname);
  }, [filters, pathname, searchParams]);
  const enabled = props.isAuthenticated && identity.user !== null;
  const reportsQuery = useQuery({
    queryKey: ['me', 'battle-reports', identity.scope, filters],
    enabled,
    queryFn: ({ signal }) => {
      const params = battleReportQueryParams(filters);
      params.set('expectedUserId', String(identity.user?.id));
      return readBattleReport('list', `/api/me/battle-reports?${params}`, identity.user, signal);
    },
    retry: false,
    staleTime: 10_000,
    gcTime: 0,
  });
  if (!enabled) return <p className="mt-3 text-sm text-gray-600">登录后可查看服务器战报记录。</p>;
  return <BattleReportsListView {...props} filters={filters} onFiltersChange={setFilters}
    searchInput={searchInput} onSearchInputChange={setSearchInput} data={reportsQuery.data}
    loading={reportsQuery.isLoading} refreshing={reportsQuery.isFetching}
    error={reportsQuery.error instanceof Error ? reportsQuery.error.message : null}
    onRefresh={() => { void reportsQuery.refetch(); }} />;
}
