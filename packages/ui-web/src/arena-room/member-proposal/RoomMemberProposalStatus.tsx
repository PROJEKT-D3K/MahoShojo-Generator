'use client';
import { useEffect, useMemo, useRef } from 'react';
import { buttonClassName } from '../../card-library/Button';
import type { ArenaMemberProposalRoom, ArenaMemberProposalWorkspaceActions } from './types';

export const arenaMemberProposalBlocked = (room: ArenaMemberProposalRoom) => room.operation !== null || room.resultUnknown || room.tracking != null || !!room.blockedReason;
export const arenaMemberProposalScopeKey = (room: ArenaMemberProposalRoom) => JSON.stringify([
  room.session?.roomId, room.session?.roomEpoch, room.session?.self.userId,
  room.session?.self.role, room.session?.self.membershipState,
]);

/** The host retains request tracking. This view cannot infer ACKs or advance a cursor. */
export function RoomMemberProposalStatus({ room, scopeIdentity, actions }: {
  room: ArenaMemberProposalRoom; scopeIdentity: unknown;
  actions: Pick<ArenaMemberProposalWorkspaceActions, 'withdraw' | 'read' | 'endTracking'>;
}) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const key = arenaMemberProposalScopeKey(room);
  const token = useMemo(() => ({ key, scopeIdentity }), [key, scopeIdentity]);
  const scope = useRef({ token, room });
  scope.current = { token, room };
  const stillCurrent = () => mounted.current && scope.current.token === token;
  const session = room.session;
  if (!session || session.self.role !== 'member' || session.self.membershipState !== 'active') return room.blockedReason ? <p role="status" className="mt-3 text-sm">{room.blockedReason}</p> : null;
  const disabled = arenaMemberProposalBlocked(room);
  const proposals = session.snapshot.proposals.filter(proposal => proposal.authorUserId === session.self.userId && proposal.status === 'submitted');
  return <>
    {room.blockedReason && !room.resultUnknown && room.tracking == null ? <p role="status" className="mt-3 text-sm">{room.blockedReason}</p> : null}
    {room.outcome ? <p role="status" className="mt-3 text-sm">{room.outcome}</p> : null}
    {room.resultUnknown || room.tracking != null ? <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
      <p>{room.tracking?.phase === 'ended-needs-read' ? '已结束本机跟踪，不取消服务器操作；请先重新读取房间状态。' : '上次提案请求结果未知，已冻结重复提交。'}</p>
      <button type="button" className={buttonClassName({ className: 'mt-2' })} onClick={() => { if (stillCurrent()) void actions.read(); }}>重新连接并对账</button>
      {room.tracking?.phase === 'unknown' ? <button type="button" className={buttonClassName({ className: 'mt-2 ml-2' })} onClick={() => {
        const tracking = room.tracking;
        if (tracking && stillCurrent() && scope.current.room.tracking?.id === tracking.id && scope.current.room.tracking?.phase === 'unknown') void actions.endTracking(tracking.id);
      }}>结束本机跟踪（不取消服务器操作）</button> : null}
    </div> : null}
    {proposals.length > 0 ? <div className="mt-4"><h4 className="text-sm font-semibold text-gray-950 dark:text-gray-100">我的待处理提案</h4>
      <ul className="mt-2 space-y-2">{proposals.map(proposal => <li key={proposal.proposalId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 p-2 dark:border-gray-700">
        <span className="text-xs text-gray-600 dark:text-gray-400" title={proposal.proposalId}>提交于 {proposal.createdAt}</span>
        <button type="button" className={buttonClassName({ variant: 'danger' })} disabled={disabled} onClick={() => {
          if (stillCurrent() && !arenaMemberProposalBlocked(scope.current.room)
            && scope.current.room.session?.snapshot.proposals.some(item => item.proposalId === proposal.proposalId && item.status === 'submitted' && item.authorUserId === session.self.userId)) void actions.withdraw(proposal.proposalId);
        }}>撤回提案</button>
      </li>)}</ul>
    </div> : null}
  </>;
}
