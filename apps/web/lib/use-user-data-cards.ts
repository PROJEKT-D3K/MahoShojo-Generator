import { useCallback, useEffect, useRef, useState } from 'react';

import { dataCardApi } from '@/lib/auth';

export function useUserDataCards(userId: number | null) {
  const [cards, setCards] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    setCards([]);
    setLoading(false);
    setError(null);
    return () => { requestId.current += 1; };
  }, [userId]);

  const reload = useCallback(async (
    search?: string,
    sortBy?: 'likes' | 'usage' | 'favorites' | 'created_at',
  ) => {
    if (userId === null) return;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await dataCardApi.getCardsDetailed(search, sortBy);
      if (currentRequest !== requestId.current) return;
      if (result.success) setCards(result.cards);
      else setError(result.error || '获取数据卡失败，请重试');
    } catch (cause) {
      if (currentRequest === requestId.current) {
        setError(cause instanceof Error ? cause.message : '获取数据卡失败，请重试');
      }
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [userId]);

  return { cards, setCards, loading, error, reload };
}
