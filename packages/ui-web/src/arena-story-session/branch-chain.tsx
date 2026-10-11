'use client';

import type { ReactNode } from 'react';
import { buildBattleStoryBranchChain, readBattleStoryBranchLink, type BattleStoryBranchLink } from '@mahoshojo/domain/arena-story-branch';
import { BaseModal } from '../modal';
import { formatBattleStoryDisplayTitle } from './display-title';

/** Display-only projection. Do not retain the source session/seed/summary here. */
export type BattleStoryBranchSessionView = {
  id: string; title: string; updatedAt: number; branchLabel?: string; parent: BattleStoryBranchLink;
};

export function projectBattleStoryBranchSession(session: {
  id: string; title: string; updatedAt: number; branchLabel?: unknown; branchOf?: unknown;
}): BattleStoryBranchSessionView {
  const parent = readBattleStoryBranchLink(session.branchOf);
  return {
    id: session.id, title: formatBattleStoryDisplayTitle(session.title), updatedAt: session.updatedAt,
    ...(typeof session.branchLabel === 'string' ? { branchLabel: formatBattleStoryDisplayTitle(session.branchLabel) } : {}),
    parent: parent.kind === 'parent' && parent.chapterTitle !== undefined
      ? { ...parent, chapterTitle: formatBattleStoryDisplayTitle(parent.chapterTitle) } : parent,
  };
}

export function BattleStoryBranchChainButton(props: { onClick(): void; disabled?: boolean; className?: string }) {
  return <button type="button" disabled={props.disabled} onClick={props.onClick}
    className={props.className ?? 'font-semibold text-emerald-800 hover:underline disabled:opacity-60'}>查看分支链</button>;
}

export type BattleStoryBranchChainModalProps = {
  isOpen: boolean;
  sessions: readonly BattleStoryBranchSessionView[];
  activeSession: BattleStoryBranchSessionView | null;
  onSelectSession(sessionId: string): void;
  onClose(): void;
  loading?: boolean;
  error?: string | null;
  /** Hosts supply explicit reads/pagination; the modal never starts IO. */
  actions?: ReactNode;
  scopeNote?: string;
  showChildren?: boolean;
};

/** Same controlled modal in both hosts. A missing row is not proof of deletion. */
export function BattleStoryBranchChainModal(props: BattleStoryBranchChainModalProps) {
  const { chain, children, stop } = buildBattleStoryBranchChain(props);
  const row = (session: BattleStoryBranchSessionView) => {
    const active = session.id === props.activeSession?.id;
    return <button key={session.id} type="button" aria-current={active ? 'true' : undefined}
      className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${active
        ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-emerald-100 bg-white hover:bg-emerald-50/60'}`}
      onClick={() => { if (!active) props.onSelectSession(session.id); props.onClose(); }}>
      <div className="min-w-0"><div className="truncate text-sm font-semibold">{session.title}</div>
        <div className="text-[11px] text-gray-500">{session.parent.kind === 'root' ? '根会话' : session.branchLabel || '分支会话'} · {new Date(session.updatedAt).toLocaleString()}</div>
        {session.parent.kind === 'parent' ? <div className="text-xs text-gray-500">来源：第 {session.parent.chapterIndex} 章{session.parent.chapterTitle ? `《${session.parent.chapterTitle}》` : ''}</div> : null}
      </div>
      <span className="shrink-0 text-[11px] font-semibold text-emerald-700">{active ? '当前' : '跳转'}</span>
    </button>;
  };
  return <BaseModal isOpen={props.isOpen} onClose={props.onClose} title="分支链"
    description="查看连续战报会话的父链与子分支，并快速跳转。" maxWidthClassName="max-w-2xl">
    <div className="space-y-4">
      <p className="text-xs text-gray-500">{props.scopeNote ?? '只展示当前已加载目录中的已知关系；目录可能不完整。'}</p>
      {props.loading ? <p role="status" className="text-sm text-gray-500">正在读取分支来源…</p> : null}
      {props.error ? <p role="alert" className="text-sm text-red-700">{props.error}</p> : null}
      {!props.activeSession ? !props.loading && !props.error ? <p className="text-sm text-gray-500">尚未选择连续战报会话。</p> : null : <>
        <section aria-label="已知父链"><div className="text-sm font-semibold text-gray-800">主线链路</div><div className="mt-2 space-y-2">{chain.map(row)}</div></section>
        {stop?.kind === 'root' ? <p role="status" className="text-xs text-gray-500">已读取到根会话。</p> : null}
        {stop?.kind === 'missing' ? <div role="status" className="space-y-1 text-xs text-amber-800">
          <p>父会话尚未在当前已读取的关系中，不能据此认定已删除。</p><p className="break-all">父会话 ID：{formatBattleStoryDisplayTitle(stop.sessionId)}</p>
        </div> : null}
        {stop?.kind === 'cycle' ? <p role="status" className="text-xs text-amber-800">检测到循环分支来源，已停止沿父链读取。</p> : null}
        {stop?.kind === 'invalid' ? <p role="status" className="text-xs text-amber-800">分支来源记录不完整或损坏，已停止沿父链读取。</p> : null}
        {props.showChildren !== false ? <section aria-label="已知子分支"><div className="text-sm font-semibold text-gray-800">已加载的子分支</div>
          {children.length ? <div className="mt-2 space-y-2">{children.map(row)}</div> : <p className="mt-2 text-xs text-gray-500">当前已加载目录中没有子分支记录。</p>}
        </section> : null}
      </>}
      {props.actions}
    </div>
  </BaseModal>;
}
