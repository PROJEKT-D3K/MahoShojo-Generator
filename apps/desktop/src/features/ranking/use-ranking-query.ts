import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PublicRankingRequest, PublicRankingData } from '@mahoshojo/contracts/public-ranking';
import type { PublicRankingReader, RankingQueryHook, RankingQueryResult } from '@mahoshojo/ui-web/ranking';
import { readPublicRanking } from '../../platform/public-ranking-bridge';

export const readDesktopRanking: PublicRankingReader = async (request, signal) => {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const data = await readPublicRanking(invoke, request);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return data;
};

/** Per mounted query memory only; no public-card persistence or background traversal. */
export const useDesktopRankingQuery: RankingQueryHook = <R extends PublicRankingRequest>({ request, enabled = true, staleTime = 0 }: {
  request: R; enabled?: boolean; staleTime?: number;
}): RankingQueryResult<PublicRankingData<R['kind']>> => {
  type Data = PublicRankingData<R['kind']>;
  const key = JSON.stringify(request);
  const requestRef = useRef(request);
  requestRef.current = request;
  const cacheRef = useRef(new Map<string, { data: Data; at: number }>());
  const [revision, setRevision] = useState(0);
  const forcedKeyRef = useRef<string | null>(null);
  const [state, setState] = useState<{ key: string; data?: Data; loading: boolean; error?: unknown }>({ key, loading: enabled });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const cached = cacheRef.current.get(key);
    if (cached && Date.now() - cached.at < staleTime && forcedKeyRef.current !== key) {
      setState({ key, data: cached.data, loading: false });
      return;
    }
    forcedKeyRef.current = null;
    setState({ key, loading: true });
    void readDesktopRanking(requestRef.current, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      cacheRef.current.delete(key);
      cacheRef.current.set(key, { data, at: Date.now() });
      // A long browsing session must not retain every distinct filter combination.
      while (cacheRef.current.size > 12) cacheRef.current.delete(cacheRef.current.keys().next().value!);
      setState({ key, data, loading: false });
    }, (error: unknown) => {
      if (!controller.signal.aborted) setState({ key, loading: false, error });
    });
    return () => controller.abort();
  }, [key, enabled, revision, staleTime]);
  const current = state.key === key ? state : { key, loading: enabled };
  return { data: current.data, isLoading: enabled && current.loading, isFetching: enabled && current.loading,
    isError: current.error !== undefined, error: current.error ?? null, refetch: () => { forcedKeyRef.current = key; setRevision((value) => value + 1); } };
};
