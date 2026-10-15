import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isHotCard } from '@mahoshojo/domain/data-card-size';
import { ONLINE_DATA_CARD_TYPES, type OnlineDataCardType } from '@mahoshojo/contracts/data-cards';
import { RecycleBinModal, DataCardsModal, getOwnedCardDeleteNotice, type OwnedCardDeleteNotice, getOwnedCardRestoreNotice, type OwnedCardRestoreNotice, type OwnedCardMetadataPort, type DataCardsModalHost } from '@mahoshojo/ui-web/cloud-save';
import { createDesktopCardLibraryOnlinePort, useDesktopCardLibraryHost } from '../../platform/card-library-host';
import { readCloudReplaceTarget, updateCloudCardMetadata, readPrivateCloudCapacity } from '../../platform/private-cloud-save';
import { createDesktopOwnedCardRestorePort } from '../../platform/cloud-restore';
import { createDesktopOwnedCardDeletePort } from '../../platform/cloud-delete';
import { createDesktopRecycleBinPort } from '../../platform/cloud-recycle';
import type { InvokeFn } from '../../platform/cloud-bridge';
import { useDesktopCloudSession } from '../account/use-desktop-cloud-session';

export interface DesktopOwnedCard {
  id: string;
  type: OnlineDataCardType;
  name: string;
  description?: string | null;
  data: string;
  [key: string]: unknown;
}
export interface DesktopOwnedCardsModalProps {
  isOpen: boolean;
  onClose: () => void;
  expectedUserId: number;
  selectedType?: OnlineDataCardType;
  onReplaceCard?: (card: DesktopOwnedCard) => void | Promise<void>;
  onSelectCard?: (card: DesktopOwnedCard) => void | Promise<void>;
  refreshToken?: number;
  isBusy?: boolean;
  metadataEditing?: { isBlocked: () => boolean; onBusyChange: (busy: boolean) => void };
  scopeKey?: string;
  titleOverride?: string;
  invokeFn?: InvokeFn;
}

const ownedCard = (value: unknown): DesktopOwnedCard => {
  if (!value || typeof value !== 'object') throw new Error('数据卡读取失败');
  const card = value as Record<string, unknown>;
  if (typeof card.id !== 'string' || typeof card.name !== 'string' || typeof card.data !== 'string' || !ONLINE_DATA_CARD_TYPES.includes(card.type as OnlineDataCardType)) {
    throw new Error('数据卡格式无效，请刷新后重试');
  }
  return card as DesktopOwnedCard;
};

/** 角色管理与生成结果都回用 Web 的真实管理模态框；不复制任何 Desktop 对话框。 */
export function DesktopOwnedCardsModal(props: DesktopOwnedCardsModalProps) {
  const { state, store } = useDesktopCloudSession();
  const epoch = store.getCredentialEpoch();
  const owns = state.account?.userId === props.expectedUserId && state.verification === 'verified' && state.authFlow.kind === 'idle';
  return <DesktopOwnedCardsModalScope key={`${props.expectedUserId}:${epoch}:${props.scopeKey ?? ''}`} {...props} deleteNotice={getOwnedCardDeleteNotice(store, epoch, props.expectedUserId)} restoreNotice={getOwnedCardRestoreNotice(store, epoch, props.expectedUserId)} isOpen={props.isOpen && owns}
    isCurrent={() => store.getCredentialEpoch() === epoch && store.getSnapshot().account?.userId === props.expectedUserId && store.getSnapshot().verification === 'verified' && store.getSnapshot().authFlow.kind === 'idle'} />;
}

function DesktopOwnedCardsModalScope({ isOpen, onClose, expectedUserId, selectedType, onReplaceCard, onSelectCard, refreshToken = 0, isBusy = false, metadataEditing, titleOverride = '我的数据卡', invokeFn = invoke, isCurrent, restoreNotice, deleteNotice }: DesktopOwnedCardsModalProps & { isCurrent: () => boolean; restoreNotice: OwnedCardRestoreNotice; deleteNotice: OwnedCardDeleteNotice }) {
  const libraryHost = useDesktopCardLibraryHost();
  const online = useMemo(() => createDesktopCardLibraryOnlinePort(invokeFn, expectedUserId), [expectedUserId, invokeFn]);
  const host = useMemo<DataCardsModalHost>(() => ({
    fetchSummaryPage: online.fetchSummaryPage,
    loadFullCard: online.loadFullCard,
    fetchCardMetaBatch: (ids, signal) => online.fetchCardMetaBatch?.(ids, signal) ?? Promise.resolve(null),
    // 数字只作共享接口默认值；实际未读到容量时明确显示「未知」。
    defaultCapacity: 20,
    recycleLimit: 5,
    isHotCard,
    tilePlatform: { ...libraryHost.platform, reviewHref: '/encyclopedia/review', reportStat: online.reportCardStat },
    downloadJson: (fileName, jsonText) => {
      if (!libraryHost.platform.downloadJson) throw new Error('文件下载暂不可用，请保留编辑内容');
      return libraryHost.platform.downloadJson(fileName, jsonText);
    },
    DetailsModal: libraryHost.slots.CardDetailsModal,
  }), [libraryHost.platform, libraryHost.slots.CardDetailsModal, online]);
  const [deleteRefresh, setDeleteRefresh] = useState(0);
  const [page, setPage] = useState(1);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const currentHost = useRef(isCurrent); currentHost.current = isCurrent;
  const recyclePort = useMemo(() => createDesktopRecycleBinPort(invokeFn, expectedUserId, () => currentHost.current()), [invokeFn, expectedUserId]);
  useEffect(() => { if (!isOpen) setRecycleOpen(false); }, [isOpen]);
  const [capacity, setCapacity] = useState<{ capacity: number; usedSlots: number } | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setCapacity(null);
    void readPrivateCloudCapacity(invokeFn, expectedUserId).then((value) => { if (active) setCapacity(value); });
    return () => { active = false; };
  }, [expectedUserId, invokeFn, isOpen, refreshToken, deleteRefresh]);
  const metadataHost = useRef({ isCurrent, metadataEditing });
  metadataHost.current = { isCurrent, metadataEditing };
  const metadataEditor = useMemo<OwnedCardMetadataPort | undefined>(() => metadataEditing ? {
    isCurrent: () => metadataHost.current.isCurrent(),
    isBlocked: () => metadataHost.current.metadataEditing?.isBlocked() !== false,
    onBusyChange: (value) => metadataHost.current.metadataEditing?.onBusyChange(value),
    read: (id) => readCloudReplaceTarget(invokeFn, expectedUserId, id),
    write: (target, draft) => updateCloudCardMetadata(invokeFn, expectedUserId, target, draft),
  } : undefined, [expectedUserId, invokeFn, Boolean(metadataEditing)]);
  const deletePort = useMemo(() => createDesktopOwnedCardDeletePort(invokeFn, expectedUserId, () => metadataHost.current.isCurrent(), {
    notice: deleteNotice,
    isBlocked: () => metadataHost.current.metadataEditing?.isBlocked() ?? false,
    onBusyChange: (value) => metadataHost.current.metadataEditing?.onBusyChange(value),
    onChanged: () => setDeleteRefresh(value => value + 1),
  }), [expectedUserId, invokeFn, deleteNotice]);
  const restorePort = useMemo(() => createDesktopOwnedCardRestorePort(invokeFn, expectedUserId, () => metadataHost.current.isCurrent(), {
    notice: restoreNotice,
    isBlocked: () => metadataHost.current.metadataEditing?.isBlocked() ?? false,
    onBusyChange: (value) => metadataHost.current.metadataEditing?.onBusyChange(value),
    onChanged: () => setDeleteRefresh(value => value + 1),
  }), [expectedUserId, invokeFn, restoreNotice]);
  const allowedTypes = useMemo(() => selectedType ? [selectedType] : ['character', 'scenario'] as OnlineDataCardType[], [selectedType]);
  const defaultFilters = useMemo(() => selectedType ? { type: selectedType } : {}, [selectedType]);
  return <><DataCardsModal host={host} isOpen={isOpen && !recycleOpen} onClose={onClose} summaryOwnerId={expectedUserId} dataCards={[]}
    metadataEditor={metadataEditor} deletePort={deletePort} currentPage={page} onPageChange={setPage} cardsPerPage={12} refreshKey={refreshToken + deleteRefresh} busy={isBusy}
    allowedTypes={allowedTypes} defaultFilters={defaultFilters}
    title={titleOverride} userCapacity={capacity?.capacity} userUsedSlots={capacity?.usedSlots} capacityKnown={capacity !== null}
    onLoadCard={onSelectCard ? async (card) => { if (isCurrent()) await onSelectCard(ownedCard(card)); } : undefined}
    onReplaceCard={onReplaceCard ? async (card) => { if (isCurrent()) await onReplaceCard(ownedCard(card)); } : undefined}
    onOpenRecycleBin={() => setRecycleOpen(true)} recycleLabel="云端回收站" recycleCount={null}
    allowHistoryReplace={true} />
    <RecycleBinModal isOpen={isOpen && recycleOpen} onClose={() => setRecycleOpen(false)} port={recyclePort} deletePort={deletePort} restorePort={restorePort}
      type={selectedType} refreshKey={refreshToken + deleteRefresh} busy={isBusy} operationGuard={metadataEditing}
      DetailsModal={host.DetailsModal} />
  </>;
}
