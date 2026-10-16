import { useEffect, useState } from 'react';
import { PRESET_LIST } from '@mahoshojo/domain/presets';
import { PUBLIC_DATA_CARD_NOT_FOUND_CODE } from '@mahoshojo/contracts/desktop-cloud';
import { mapPublicDataCardRowToDetailsCard, saveLocalDataCard, type CardLibraryDetailsCard, type CardLibraryHost } from '@mahoshojo/ui-web/card-library';
import type { CardDetailsSource } from '@mahoshojo/ui-web/card-details';
import { RankingDetailsLoadingModal, type RankingDetailsTarget } from '@mahoshojo/ui-web/ranking';
import { fetchArenaPreset } from '../arena/input';
import { DesktopCardDetailsModal } from './card-details-modal';

export const canOpenDesktopRankingDetails = (target: Pick<RankingDetailsTarget, 'entityType' | 'entityId'>) => target.entityType === 'data_card' || PRESET_LIST.some((preset) => preset.filename === target.entityId);

export async function loadDesktopRankingDetails(target: RankingDetailsTarget, online: Pick<CardLibraryHost['online'], 'fetchPublicCardById'>, signal: AbortSignal): Promise<{ card: CardLibraryDetailsCard; source: CardDetailsSource }> {
  if (target.entityType === 'preset') {
    const preset = PRESET_LIST.find((entry) => entry.filename === target.entityId);
    if (!preset) throw new Error('此客户端未收录该预设正文');
    const data = await fetchArenaPreset('character', preset.filename, signal);
    signal.throwIfAborted();
    return { card: { id: `preset:${preset.filename}`, name: preset.name, description: preset.description ?? '系统预设角色', type: 'character', data, isPublic: false, author: '官方' }, source: { kind: 'preset' } };
  }
  const result = await online.fetchPublicCardById(target.entityId, signal);
  signal.throwIfAborted();
  const body = result.data as { success?: unknown; card?: Record<string, unknown>; code?: unknown } | undefined;
  if (result.status === 404 && body?.success === false && body.code === PUBLIC_DATA_CARD_NOT_FOUND_CODE) throw new Error('这张卡已撤回、不再公开或不存在，不能读取当前公开正文');
  if (!result.ok || body?.success !== true) throw new Error(`公开正文加载失败（HTTP ${result.status}），可重试`);
  if (!body.card || body.card.id !== target.entityId) throw new Error('返回的数据卡身份不匹配，未显示正文');
  if (typeof body.card.data !== 'string' || !body.card.data.trim()) throw new Error('只取得摘要，缺少数据卡正文');
  return { card: mapPublicDataCardRowToDetailsCard(body.card, { id: target.entityId, name: target.displayName, author: target.authorName ?? '未知' }), source: { kind: 'public' } };
}

export function DesktopRankingDetailsModal({ entity, onClose, host }: { entity: RankingDetailsTarget | null; onClose: () => void; host: Pick<CardLibraryHost, 'online' | 'local'> }) {
  return entity ? <RankingDetailsScope key={`${entity.entityType}:${entity.entityId}`} entity={entity} onClose={onClose} host={host} /> : null;
}
function RankingDetailsScope({ entity, onClose, host }: { entity: RankingDetailsTarget; onClose: () => void; host: Pick<CardLibraryHost, 'online' | 'local'> }) {
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof loadDesktopRankingDetails>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [saveState, setSaveState] = useState({ busy: false, message: null as string | null });
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null); setError(null);
    void loadDesktopRankingDetails(entity, host.online, controller.signal).then((result) => {
      if (!controller.signal.aborted) setLoaded(result);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '详情读取失败');
    });
    return () => controller.abort();
  }, [entity, host.online, retry]);
  if (!loaded) return <RankingDetailsLoadingModal entityType={entity.entityType} pendingNotice={entity.pendingNotice} error={error} onRetry={() => setRetry((value) => value + 1)} onClose={onClose} />;
  return <DesktopCardDetailsModal isOpen onClose={onClose} {...loaded} ratingHistoryEntity={{ entityType: entity.entityType, entityId: entity.entityId }} pendingNotice={entity.pendingNotice} localLibrarySaveState={saveState}
    onSaveCopyToLocalLibrary={async () => {
      setSaveState({ busy: true, message: null });
      try {
        const outcome = await saveLocalDataCard(host.local.repository, { cardType: loaded.card.type, title: loaded.card.name, payload: JSON.parse(loaded.card.data), execution: 'downloaded', cloudRef: loaded.source.kind === 'public' ? { cardId: loaded.card.id } : undefined });
        setSaveState({ busy: false, message: outcome.inRecycleBin ? '内容相同的数据卡在回收站中，未重复保存；请到本地库恢复' : outcome.updated ? '本地库已有相同内容，已更新原卡' : '已保存到本地库' });
      } catch (cause) {
        setSaveState({ busy: false, message: null });
        throw cause;
      }
    }} />;
}
