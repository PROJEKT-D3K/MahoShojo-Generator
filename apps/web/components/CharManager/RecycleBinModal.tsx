import { useMemo } from 'react';
import { RecycleBinModal as SharedRecycleBinModal, type RecycleBinModalProps } from '@mahoshojo/ui-web/cloud-save';
import { captureAuthIdentity } from '@/lib/auth-identity';
import { useAuth } from '@/lib/useAuth';
import { createWebRecycleBinPort } from '@/lib/owned-recycle-bin';
import DataCardDetailsModal from '../DataCardDetailsModal';

type Props = Omit<RecycleBinModalProps, 'port' | 'DetailsModal'>;
const RecycledCardDetails: NonNullable<RecycleBinModalProps['DetailsModal']> = (props) =>
  <DataCardDetailsModal {...props} metaCardId={null} ratingHistoryEntity={null} />;
export default function RecycleBinModal(props: Props) {
  const { user, identityEpoch } = useAuth();
  const identity = captureAuthIdentity();
  const userId = user?.id;
  const port = useMemo(() => userId ? createWebRecycleBinPort(userId, identity) : null, [userId, identity]);
  if (!port) return null;
  return <SharedRecycleBinModal key={`${user?.id}:${identityEpoch ?? identity.epoch}`} {...props} port={port} DetailsModal={RecycledCardDetails} />;
}
