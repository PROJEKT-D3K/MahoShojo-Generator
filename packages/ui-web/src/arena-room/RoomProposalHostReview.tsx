'use client';

import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import type {
  ArenaProposal,
  ArenaProposalChange,
  ArenaRoomProposalResolveRequest,
  ArenaRoomSharedConfig,
} from '@mahoshojo/contracts/arena-room';
import {
  previewArenaProposalApplication,
  validateProposalChanges,
  type ArenaProposalChangeAnalysis,
} from '@mahoshojo/multiplayer-core';
import { buttonClassName } from '../card-library/Button';
import {
  ArenaProposalChangeDescription,
  ArenaProposalSelectionDetails,
  arenaProposalChangeProposedSummary,
  arenaProposalValueSummary,
  type ArenaProposalChangeLabels,
} from './proposal-presentation';
import { ArenaProposalConflictReview } from './ArenaProposalConflictReview';

export type RoomProposalHostReviewProps = {
  readonly proposal: ArenaProposal;
  readonly roomId: string;
  readonly revision: number;
  readonly roomEpoch: string;
  readonly currentConfig: ArenaRoomSharedConfig;
  readonly authorDisplayName: string;
  readonly disabled: boolean;
  readonly labels?: ArenaProposalChangeLabels;
  /** Opaque host scope; rotating it invalidates consent but does not grant authority. */
  readonly reviewIdentity?: unknown;
  readonly onResolve: (proposalId: string, request: ArenaRoomProposalResolveRequest) => Promise<void>;
};

export const arenaProposalSelectionError = (
  changes: readonly ArenaProposalChange[],
  selected: ReadonlySet<string>,
): string | null => {
  if (selected.size === 0) return '至少选择一项变更';
  return validateProposalChanges(changes, [...selected]).valid
    ? null
    : '所选变更缺少依赖或拆分了联动变更组';
};

export const arenaProposalConflictSummary = (analysis: ArenaProposalChangeAnalysis): string => {
  if (analysis.outcome !== 'conflict' || !analysis.conflict) return '';
  return analysis.conflict.code === 'reference-changed'
    ? '引用的数据卡已更新版本，需要重新选择数据卡'
    : '该目标的当前值已与提案基准不一致';
};

/** Host-neutral review; authority, identity fencing and request tracking belong to the caller. */
export const RoomProposalHostReview = ({
  proposal,
  roomId,
  revision,
  roomEpoch,
  currentConfig,
  authorDisplayName,
  disabled,
  labels,
  reviewIdentity,
  onResolve,
}: RoomProposalHostReviewProps) => {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(proposal.changes.map((change) => change.changeId)),
  );
  // Consent belongs to this exact review, not to every future conflict on the ID.
  const reviewKey = useMemo(() => JSON.stringify([roomId, roomEpoch, revision, proposal]),
    [roomId, roomEpoch, revision, proposal]);
  const [overrideReview, setOverrideReview] = useState<{ key: string; identity: unknown; ids: readonly string[]; expired: boolean } | null>(null);
  const reviewMatches = overrideReview?.key === reviewKey && Object.is(overrideReview.identity, reviewIdentity);
  const overrideChangeIds = useMemo(() => overrideReview && reviewMatches
    ? overrideReview.ids.filter((id) => selected.has(id)) : [], [overrideReview, reviewMatches, selected]);
  const reviewExpired = Boolean(overrideReview && (overrideReview.expired || (overrideReview.ids.length > 0 && !reviewMatches)));
  // Clear consent on every scope transition, including a later return to an old snapshot.
  if (overrideReview && !reviewMatches) {
    setOverrideReview({ key: reviewKey, identity: reviewIdentity, ids: [], expired: reviewExpired });
  }
  const [actionError, setActionError] = useState<string | null>(null);
  const actionLock = useRef(false);
  const validationError = arenaProposalSelectionError(proposal.changes, selected);
  // 与服务器权威 apply 相同的依赖排序 + staged expectedBase 分析：
  // “新增角色 -> 修改该角色引导”不再误报冲突；目标已由其他修改满足的变更
  // 显示为安全跳过，而不是阻塞整份提案。
  const preview = useMemo(
    () => previewArenaProposalApplication({ roomId, config: currentConfig, revision }, proposal, [...selected], { overrideChangeIds }),
    [roomId, currentConfig, revision, proposal, selected, overrideChangeIds],
  );
  const analysisByChangeId = new Map(preview.plan.map((item) => [item.changeId, item] as const));
  const selectedConflictCount = preview.conflicts.length;
  const applicationError = validationError ?? (preview.issues.length > 0
    ? '所选变更无法应用，请检查目标、依赖和配置约束。' : null);
  const cannotAccept = Boolean(applicationError) || preview.status === 'rejected';
  const selectChange = (changeId: string, accepted: boolean): void => {
    const next = new Set(selected);
    if (accepted) next.add(changeId);
    else next.delete(changeId);
    setSelected(next);
    // A changed selection can alter staged dependency values: do not revive old consent.
    setOverrideReview(null);
    setActionError(null);
  };
  const adoptChange = (changeId: string): void => {
    if (disabled || !selected.has(changeId)) return;
    setOverrideReview({ key: reviewKey, identity: reviewIdentity, ids: [...new Set([...overrideChangeIds, changeId])], expired: false });
    setActionError(null);
  };

  const resolve = async (resolution: 'accept-selected' | 'reject'): Promise<void> => {
    if (actionLock.current || disabled) return;
    if (resolution === 'accept-selected' && cannotAccept) return;
    actionLock.current = true;
    setActionError(null);
    try {
      await onResolve(proposal.proposalId, {
        expectedRoomEpoch: roomEpoch,
        expectedRevision: revision,
        resolution,
        ...(resolution === 'accept-selected' ? { selectedChangeIds: [...selected],
          ...(overrideChangeIds.length > 0 ? { overrideChangeIds } : {}),
        } : {}),
      });
    } catch {
      setActionError('审阅未完成，请核对房间最新状态；结果未知时先重新连接并对账。');
    } finally {
      actionLock.current = false;
    }
  };

  return (
    <li className="rounded-xl border border-gray-200 bg-white/80 p-3 dark:border-gray-700 dark:bg-gray-900/70">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-gray-950 dark:text-gray-100">
            {authorDisplayName} 提出了 {proposal.changes.length} 项修改
          </p>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400" title={proposal.proposalId}>
            提交于 {proposal.createdAt}
          </p>
        </div>
      </div>
      <fieldset className="mt-3 space-y-2">
        <legend className="text-sm font-semibold text-gray-950 dark:text-gray-100">逐项审阅</legend>
        {proposal.changes.map((change) => {
          const analysis = analysisByChangeId.get(change.changeId);
          const conflict = analysis?.outcome === 'conflict' || analysis?.outcome === 'overridden' ? analysis.conflict : undefined;
          const satisfied = analysis?.outcome === 'satisfied';
          return (
          <div key={change.changeId} className="flex items-start gap-2 rounded-lg border border-gray-200 p-2 text-sm dark:border-gray-700">
            <input
              type="checkbox"
              className="mt-1"
              checked={selected.has(change.changeId)}
              disabled={disabled}
              aria-label={`接受变更：${arenaProposalChangeProposedSummary(change, labels)}`}
              onChange={(event: ChangeEvent<HTMLInputElement>) => selectChange(change.changeId, event.target.checked)}
            />
            <div className="min-w-0 flex-1">
              <ArenaProposalChangeDescription change={change} labels={labels} showDetails={false} />
              {satisfied ? (
                <span
                  className="mt-1 block font-medium text-emerald-700 dark:text-emerald-300"
                  data-change-outcome="satisfied"
                >
                  该项目标已由其他修改满足；接受时将自动跳过，不会重复应用。
                </span>
              ) : null}
              {conflict && analysis ? (
                <ArenaProposalConflictReview change={change} analysis={analysis} disabled={disabled}
                  onAdopt={() => adoptChange(change.changeId)}
                  onKeep={() => selectChange(change.changeId, false)} />
              ) : null}
            </div>
          </div>
          );
        })}
      </fieldset>
      <div aria-live="polite" className="mt-2 min-h-5 text-xs text-red-700 dark:text-red-300">
        {applicationError ?? actionError ?? ''}
      </div>
      {selectedConflictCount > 0 ? (
        <p role="status" className="mt-1 text-xs text-amber-700 dark:text-amber-300">
          所选变更中有 {selectedConflictCount} 项尚未裁决或无法应用；请采用提案值，或取消相关项后接受其余变更。
        </p>
      ) : null}
      {reviewExpired ? <p role="status" className="mt-2 text-sm text-amber-800 dark:text-amber-200">
        房间或提案在审阅期间发生变化，请重新确认覆盖项。
      </p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClassName({ variant: 'primary' })}
          disabled={disabled || cannotAccept}
          onClick={() => { void resolve('accept-selected'); }}
        >
          接受所选
        </button>
        <button
          type="button"
          className={buttonClassName({ variant: 'danger' })}
          disabled={disabled}
          onClick={() => { void resolve('reject'); }}
        >
          拒绝全部
        </button>
      </div>
      <details className="mt-2 border-t pt-2 dark:border-gray-800">
        <summary className="cursor-pointer select-none text-xs text-gray-600 dark:text-gray-400">技术详情</summary>
        <div className="mt-2 space-y-1.5 text-xs text-gray-600 dark:text-gray-400">
          <p>提案 ID：{proposal.proposalId} · 基于房间配置版本 {proposal.baseRevision}</p>
          {proposal.changes.map((change) => {
            const analysis = analysisByChangeId.get(change.changeId);
            const conflict = analysis?.outcome === 'conflict' || analysis?.outcome === 'overridden' ? analysis.conflict : undefined;
            return (
              <p key={`detail-${change.changeId}`}>
                <span className="font-mono">{change.changeId}</span>
                {' · '}<ArenaProposalSelectionDetails change={change} className="" />
                {conflict ? ` · 当前房间值：${arenaProposalValueSummary(conflict.current)}` : ''}
              </p>
            );
          })}
        </div>
      </details>
    </li>
  );
};
