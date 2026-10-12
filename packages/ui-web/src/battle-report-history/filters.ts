import { useEffect, useState } from 'react';
import { DEFAULT_BATTLE_REPORT_FILTERS, type BattleReportFilters } from '@mahoshojo/contracts/battle-report-history';

/** Local filter editing only. Requests, identity, URL and caching belong to each host. */
export function useBattleReportFilters(initial = DEFAULT_BATTLE_REPORT_FILTERS) {
  const [filters, setFilters] = useState<BattleReportFilters>(initial);
  const [searchInput, setSearchInput] = useState(initial.q);
  useEffect(() => {
    const handle = setTimeout(() => {
      const q = searchInput.trim().slice(0, 120);
      setFilters((current) => current.q === q ? current : { ...current, q, page: 1 });
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput]);
  return { filters, setFilters, searchInput, setSearchInput };
}
