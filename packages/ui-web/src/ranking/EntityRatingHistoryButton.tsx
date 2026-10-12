'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { EntityRatingHistoryItem } from '@mahoshojo/contracts/public-ranking';
import type { PublicRankingReader } from './RankingPageView';
import { EntityRatingHistoryModal } from './EntityRatingHistoryModal';

export type EntityRatingHistoryButtonProps = {
  entityType: 'data_card' | 'preset';
  entityId: string;
  readRanking: PublicRankingReader;
  className?: string;
  onOpenChange?: (open: boolean) => void;
};

/** Target changes destroy the old view immediately; only an explicit click starts a read. */
export function EntityRatingHistoryButton(props: EntityRatingHistoryButtonProps) {
  return <HistoryScope key={`${props.entityType}:${props.entityId.trim()}`} {...props} />;
}

function HistoryScope({ entityType, entityId, readRanking, className, onOpenChange }: EntityRatingHistoryButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [state, setState] = useState<{ loading: boolean; error: string | null; items: EntityRatingHistoryItem[] }>({ loading: false, error: null, items: [] });
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const openRef = useRef(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const invalidate = () => { epoch.current++; controller.current?.abort(); controller.current = null; };
  useLayoutEffect(() => () => {
    epoch.current++; controller.current?.abort(); controller.current = null;
    if (openRef.current) onOpenChangeRef.current?.(false);
    openRef.current = false;
  }, []);
  const load = async () => {
    invalidate();
    const current = epoch.current;
    const abort = new AbortController();
    controller.current = abort;
    setState({ loading: true, error: null, items: [] });
    try {
      const data = await readRanking({ kind: 'ratingHistory', entityType, entityId: entityId.trim() }, abort.signal);
      if (current === epoch.current && !abort.signal.aborted) setState({ loading: false, error: null, items: data.items });
    } catch (cause) {
      if (current === epoch.current && !abort.signal.aborted) setState({ loading: false, error: cause instanceof Error ? cause.message : '请求失败，请重试', items: [] });
    }
  };
  const close = () => {
    invalidate(); openRef.current = false; setIsOpen(false);
    setState({ loading: false, error: null, items: [] });
    onOpenChangeRef.current?.(false);
  };
  return <>
    <button type="button" disabled={!entityId.trim()} onClick={() => {
      if (openRef.current) return;
      openRef.current = true; setIsOpen(true); onOpenChangeRef.current?.(true); void load();
    }} className={className ?? 'inline-flex items-center rounded-full border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50'}>最近严格排位</button>
    <EntityRatingHistoryModal isOpen={isOpen} onClose={close} {...state} onRetry={() => void load()} />
  </>;
}
