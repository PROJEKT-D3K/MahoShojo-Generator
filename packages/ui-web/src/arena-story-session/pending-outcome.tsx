'use client';

import type { ReactNode } from 'react';
import type { BattleStoryRoleResolution } from '@mahoshojo/domain/arena-story-completed-output';

export type BattleStoryPendingOutcomeProps = {
  heading?: string;
  detail: ReactNode;
  roleResolution?: BattleStoryRoleResolution;
  roleBusy?: boolean;
  canRetryRole?: boolean;
  canKeepOriginal?: boolean;
  onRetryRole?: () => void;
  onKeepOriginal?: () => void;
  exportAction: ReactNode;
  saveActions?: ReactNode;
  children?: ReactNode;
};

/** Controlled presentation only. Each host states its actual durability and owns every effect. */
export function BattleStoryPendingOutcome(props: BattleStoryPendingOutcomeProps) {
  const unresolved = props.roleResolution?.status === 'unresolved';
  const buttonClass = 'rounded-lg border border-amber-300 bg-white px-3 py-2 font-semibold disabled:opacity-60';
  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-story-pending-outcome>
      <div role="status" aria-live="polite">
        <div className="font-semibold">{props.heading ?? '正文已完成，尚未保存'}</div>
        <div className="mt-1">{props.detail}</div>
        {props.roleResolution?.status === 'unresolved' && props.roleResolution.message ? <div className="mt-1">{props.roleResolution.message}</div> : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {unresolved && props.onRetryRole ? <button type="button" className={buttonClass}
          disabled={props.roleBusy || !props.canRetryRole} onClick={props.onRetryRole}>
          {props.roleBusy ? '正在同步角色...' : '重试角色同步'}
        </button> : null}
        {unresolved && props.onKeepOriginal ? <button type="button" className={buttonClass}
          disabled={props.roleBusy || !props.canKeepOriginal} onClick={props.onKeepOriginal}>保留旧角色保存本章</button> : null}
        {props.saveActions}
        {props.exportAction}
      </div>
      {props.children}
    </section>
  );
}
