'use client';

import { CardLibraryModal, type CardLibraryModalProps } from '@mahoshojo/ui-web/card-library';
import { useWebCardLibraryHost } from '@/lib/card-library-host';

export type BattleDataModalContentProps = Omit<CardLibraryModalProps, 'host'>;

export default function BattleDataModalContent(props: BattleDataModalContentProps) {
  const host = useWebCardLibraryHost();
  return <CardLibraryModal host={host} {...props} />;
}
