import { useMemo, useRef } from 'react';
import { useUnsavedPageGuard } from '@mahoshojo/ui-web/client';
import { useAuth } from '@/lib/useAuth';
import { captureAuthIdentity } from '@/lib/auth-identity';
import { createWebOwnedCardDeletePort } from '@/lib/owned-card-delete';
import { createWebOwnedCardMetadataPort } from '@/lib/owned-card-metadata';
// 真实管理模态框已共源；Web 只装配网络、文件、详情与链接端口。
import { DataCardsModal as SharedDataCardsModal, type DataCardsModalProps, type DataCardsModalHost } from '@mahoshojo/ui-web/cloud-save';
import DataCardDetailsModal from '../DeferredDataCardDetailsModal';
import { config } from '@/lib/config';
import { downloadBlob } from '@/lib/client/blobUrl';
import { isHotCard } from '@/lib/constants';
import { authStorage } from '@/lib/auth';
import { getDataCardSummaryPage, loadFullDataCard } from '@/lib/data-card-list-client';
import { webCardTilePlatform } from '@/lib/card-tile-platform';

const host: DataCardsModalHost = {
  defaultCapacity: config.DEFAULT_DATA_CARD_CAPACITY,
  recycleLimit: config.RECYCLE_BIN_LIMIT,
  isHotCard,
  tilePlatform: webCardTilePlatform,
  DetailsModal: DataCardDetailsModal,
  fetchSummaryPage: (source, query, signal) => getDataCardSummaryPage(source, query, signal),
  loadFullCard: (card, source, signal) => loadFullDataCard(card, source, signal),
  downloadJson: (fileName, jsonText) => downloadBlob(new Blob([jsonText], { type: 'application/json' }), fileName),
  async fetchCardMetaBatch(cardIds, signal) {
    const authHeader = await authStorage.getAuthHeader();
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    if (authHeader) headers.Authorization = authHeader;
    const response = await fetch('/api/data-card-meta-batch', {
      method: 'POST', headers, body: JSON.stringify({ dataCardIds: cardIds }), signal,
    });
    if (!response.ok) return null;
    const json = await response.json();
    if (!json || json.success !== true || typeof json.items !== 'object' || !json.items) return null;
    return Object.fromEntries(Object.entries<any>(json.items).map(([id, item]) => [id, {
      techScore: typeof item?.metrics?.techScore === 'number' ? item.metrics.techScore : null,
      techLevel: typeof item?.metrics?.techLevel === 'string' ? item.metrics.techLevel : null,
      strictTier: typeof item?.strict?.tier === 'string' ? item.strict.tier : null,
      isNative: typeof item?.metrics?.isNative === 'boolean' ? item.metrics.isNative : null,
    }]));
  },
};

type WebDataCardsModalProps = Omit<DataCardsModalProps, 'host' | 'metadataEditor' | 'deletePort'> & {
  metadataGuard?: { onBusyChange: (busy: boolean) => void | (() => void); isBlocked?: () => boolean };
  onMetadataSaved?: () => void;
};
export default function DataCardsModal(props: WebDataCardsModalProps) {
  const { user, identityEpoch } = useAuth();
  const ownerId = props.summaryOwnerId ?? user?.id;
  const identity = captureAuthIdentity();
  return <WebDataCardsModalScope key={`${ownerId ?? ''}:${identityEpoch ?? identity.epoch}:${props.scopeKey ?? ''}`} {...props} ownerId={ownerId} identity={identity} />;
}
function WebDataCardsModalScope(props: WebDataCardsModalProps & { ownerId?: number; identity: ReturnType<typeof captureAuthIdentity> }) {
  const busy = useRef(false);
  return props.metadataGuard ? <WebDataCardsModalView {...props} pending={busy} /> : <InternallyGuardedWebDataCardsModal {...props} pending={busy} />;
}
function InternallyGuardedWebDataCardsModal(props: WebDataCardsModalProps & { ownerId?: number; identity: ReturnType<typeof captureAuthIdentity>; pending: { current: boolean } }) {
  useUnsavedPageGuard(() => props.pending.current, '正在修改云端数据卡，请等待响应后再离开', () => false);
  return <WebDataCardsModalView {...props} />;
}
function WebDataCardsModalView({ metadataGuard, onMetadataSaved, ownerId, identity, pending, ...props }: WebDataCardsModalProps & { ownerId?: number; identity: ReturnType<typeof captureAuthIdentity>; pending: { current: boolean } }) {
  const latest = useRef({ metadataGuard, onMetadataSaved, externalBusy: props.busy });
  latest.current = { metadataGuard, onMetadataSaved, externalBusy: props.busy };
  const metadataEditor = useMemo(() => ownerId === undefined ? undefined : createWebOwnedCardMetadataPort(ownerId, identity, {
    isBlocked: () => Boolean(pending.current || latest.current.externalBusy || latest.current.metadataGuard?.isBlocked?.()),
    onBusyChange: (value) => {
      pending.current = value;
      const release = latest.current.metadataGuard?.onBusyChange(value);
      return typeof release === 'function' ? () => { pending.current = false; release(); } : undefined;
    },
    onSaved: () => latest.current.onMetadataSaved?.(),
  }), [ownerId, identity, pending]);
  const deletePort = useMemo(() => ownerId === undefined ? undefined : createWebOwnedCardDeletePort(ownerId, identity, {
    isBlocked: () => Boolean(pending.current || latest.current.externalBusy || latest.current.metadataGuard?.isBlocked?.()),
    onBusyChange: (value) => { pending.current = value; latest.current.metadataGuard?.onBusyChange(value); },
    onChanged: () => latest.current.onMetadataSaved?.(),
  }), [ownerId, identity, pending]);
  return <SharedDataCardsModal {...props} host={host} metadataEditor={metadataEditor} deletePort={deletePort} />;
}
