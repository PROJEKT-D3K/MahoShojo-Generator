'use client';

import { useMemo, useState } from 'react';
import { RoomConfigDiffView, RoomConfigPublishStatus } from '@mahoshojo/ui-web/arena-room';

import type { ArenaRoomSharedConfig } from '@mahoshojo/contracts/arena-room';

import type { ArenaRoomController, ArenaRoomControllerState } from '@/lib/arena-room/controller';
import {
  resolveArenaRoomReferenceName,
  useArenaRoomReferenceNames,
} from '@/lib/arena-room/reference-presentation';

import { buttonClassName } from '@/components/shared/ui/Button';

import type { ArenaRoomHostReconciliation } from './useArenaRoomHostReconciliation';
import {
  buildArenaRoomConfigDiffEntries,
  collectArenaRoomConfigDiffReferenceRequests,
} from './presentation/config-diff';
import { arenaRoomDirtyReasonCopy } from './presentation/room-copy';

const ConfigDiffSection = ({
  roomConfig,
  localConfig,
  revision,
}: {
  readonly roomConfig: ArenaRoomSharedConfig;
  readonly localConfig: ArenaRoomSharedConfig | null;
  readonly revision: number;
}) => {
  const requests = useMemo(
    () => collectArenaRoomConfigDiffReferenceRequests([roomConfig, localConfig]),
    [roomConfig, localConfig],
  );
  const onlineNames = useArenaRoomReferenceNames(requests);
  const entries = useMemo(() => {
    if (!localConfig) return [];
    // 名称解析复用 collect 阶段的完整引用请求（kind + versionToken），
    // 不在渲染时从 key 二次推导，避免丢失版本或错配 kind。
    return buildArenaRoomConfigDiffEntries(roomConfig, localConfig, (request) => (
      resolveArenaRoomReferenceName(request, onlineNames) ?? undefined
    ));
  }, [roomConfig, localConfig, onlineNames]);

  return <RoomConfigDiffView roomConfig={roomConfig} localConfig={localConfig} revision={revision} entries={entries} emptyMessage="房间设置本身没有差异；区别来自尚未发布的本地内容（角色、情景、素材）。" />;
};

export function ArenaHostConfigPanel({
  controllerState,
  controller,
  reconciliation,
}: {
  readonly controller?: ArenaRoomController;
  readonly controllerState: ArenaRoomControllerState;
  readonly reconciliation: ArenaRoomHostReconciliation;
}) {
  const [diffOpen, setDiffOpen] = useState(false);
  const session = controllerState.session;
  const tracking = controllerState.configTracking;
  const trackingContent = tracking && controller ? (
    <RoomConfigPublishStatus
      phase={tracking.phase}
      observation={tracking.observation}
      trackingId={tracking.id}
      targetConfig={tracking.target?.request.sharedConfig}
      authoritySession={session}
      busy={tracking.checking}
      canEnd={!controllerState.configPublishPending}
      onCheck={() => { void controller.checkConfigPublish(); }}
      onEnd={() => controller.endConfigPublishTracking(tracking.id)}
      onRead={() => { void controller.readConfigAfterEnd(tracking.id); }}
    />
  ) : null;
  // Tracking describes an earlier request, not current permission to publish.
  if (!session || session.self.role !== 'host' || session.self.membershipState !== 'active') return trackingContent;
  const status = reconciliation.state;
  const busy = status.kind === 'synchronizing'
    || controllerState.configPublishPending
    || controllerState.configPublishResultUnknown
    || Boolean(controllerState.configTracking);

  return (
    <section aria-labelledby="arena-host-config-heading" className="rounded-xl border border-fuchsia-200 bg-white/70 p-3 dark:border-fuchsia-900 dark:bg-gray-900/60">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="arena-host-config-heading" className="text-sm font-semibold text-gray-950 dark:text-gray-100">房间配置</h3>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            本地编辑不会实时同步；开始生成时会检查本地与房间设置是否一致，有差异会先请你确认。
          </p>
        </div>
        <button
          type="button"
          className={buttonClassName({ variant: status.kind === 'error' ? 'secondary' : 'primary' })}
          disabled={busy}
          onClick={() => { void reconciliation.publishLocal(); }}
        >
          {status.kind === 'synchronizing' && status.action === 'publish'
            ? '正在更新…'
            : '更新房间配置'}
        </button>
      </div>

      {trackingContent}

      {!controllerState.configTracking && (status.kind === 'synced' ? (
        <div className="mt-3">
          <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">
            {status.message}
          </p>
          {status.refreshFailed ? (
            <button
              type="button"
              className={`${buttonClassName()} mt-2`}
              disabled={busy}
              onClick={() => { reconciliation.reconcilePublished(); }}
            >
              重试刷新数据卡
            </button>
          ) : null}
        </div>
      ) : status.kind === 'error' ? (
        <div
          role="alert"
          data-error-code={status.code}
          className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-950 dark:border-red-800 dark:bg-red-950/30 dark:text-red-100"
        >
          <p className="font-medium">{status.message}</p>
          <p className="mt-1 text-xs opacity-90">
            请先读取并同步服务器上的最新房间配置；此操作会放弃本地未发布修改。若错误涉及数据卡引用，请先修复或重新选择对应数据卡。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClassName({ variant: 'primary' })}
              disabled={busy}
              onClick={() => { void reconciliation.syncRoom(); }}
            >
              读取并同步最新房间配置
            </button>
          </div>
        </div>
      ) : status.kind === 'synchronizing' && status.action !== 'publish' ? (
        <p role="status" className="mt-3 text-sm text-gray-700 dark:text-gray-300">正在同步当前房间设置…</p>
      ) : null)}

      {!controllerState.configTracking && status.kind === 'conflicted' ? (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="font-medium">{controllerState.configDraftPreserved
            ? '请比较当前房间设置与保留的本地草稿，再选择下一步。'
            : '房间设置已更新，而本地还有未发布的修改。'}</p>
          <ul className="mt-2 list-disc pl-5 text-xs">
            {status.reasons.map((reason) => <li key={reason}>{arenaRoomDirtyReasonCopy[reason]}</li>)}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={buttonClassName()} disabled={busy} onClick={() => { void reconciliation.syncRoom(); }}>
              同步房间配置
            </button>
            <button type="button" className={buttonClassName()} onClick={() => setDiffOpen((open) => !open)}>
              {diffOpen ? '收起差异' : '查看差异'}
            </button>
            <button type="button" className={buttonClassName({ variant: 'primary' })} disabled={busy} onClick={() => { void reconciliation.publishLocal(); }}>
              保留本地修改并重新发布
            </button>
          </div>
        </div>
      ) : null}

      {diffOpen && status.kind === 'conflicted' ? (
        <ConfigDiffSection
          roomConfig={status.roomConfig}
          localConfig={status.localConfig}
          revision={status.revision}
        />
      ) : null}
    </section>
  );
}
