import { useMemo, useRef } from 'react';
import { RecycleBinModal as SharedRecycleBinModal, type RecycleBinModalProps } from '@mahoshojo/ui-web/cloud-save';
import { captureAuthIdentity } from '@/lib/auth-identity';
import { useAuth } from '@/lib/useAuth';
import { createWebOwnedCardDeletePort } from '@/lib/owned-card-delete';
import { createWebRecycleBinPort } from '@/lib/owned-recycle-bin';
import DataCardDetailsModal from '../DataCardDetailsModal';

type Props = Omit<RecycleBinModalProps, 'port' | 'DetailsModal' | 'deletePort' | 'onDelete'> & { onChanged?: () => void };
const RecycledCardDetails: NonNullable<RecycleBinModalProps['DetailsModal']> = (props) =>
  <DataCardDetailsModal {...props} metaCardId={null} ratingHistoryEntity={null} />;
export default function RecycleBinModal(props: Props) {
  const latest = useRef(props); latest.current = props;
  const { user, identityEpoch } = useAuth();
  const identity = captureAuthIdentity();
  const userId = user?.id;
  const port = useMemo(() => userId ? createWebRecycleBinPort(userId, identity) : null, [userId, identity]);
  const deletePort = useMemo(() => userId ? createWebOwnedCardDeletePort(userId, identity, {
    isBlocked: () => Boolean(latest.current.busy || latest.current.operationGuard?.isBlocked()),
    onBusyChange: (value) => latest.current.operationGuard?.onBusyChange(value),
    onChanged: () => latest.current.onChanged?.(),
  }) : undefined, [userId, identity]);
  if (!port) return null;
  return <SharedRecycleBinModal key={`${user?.id}:${identityEpoch ?? identity.epoch}`} {...props} port={port} deletePort={deletePort} DetailsModal={RecycledCardDetails} />;
}
