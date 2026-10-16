'use client';

import { lazy, Suspense, useEffect, useState } from 'react';
import type { CardLibraryModalProps } from '@mahoshojo/ui-web/card-library';

import { DeferredChunkBoundary, DeferredChunkLoading } from '@/components/shared/DeferredChunkBoundary';

export type BattleDataModalProps = Omit<CardLibraryModalProps, 'host'>;

const BattleDataModalContent = lazy(() => import('./BattleDataModalContent'));

export default function BattleDataModal(props: BattleDataModalProps) {
  const [hasOpened, setHasOpened] = useState(props.isOpen);

  useEffect(() => {
    if (props.isOpen) setHasOpened(true);
  }, [props.isOpen]);

  if (!hasOpened) return null;

  return (
    <DeferredChunkBoundary isOpen={props.isOpen} onClose={props.onClose}>
      <Suspense fallback={(
        <DeferredChunkLoading isOpen={props.isOpen} onClose={props.onClose} title="正在加载数据卡库…" />
      )}>
        <BattleDataModalContent {...props} />
      </Suspense>
    </DeferredChunkBoundary>
  );
}
