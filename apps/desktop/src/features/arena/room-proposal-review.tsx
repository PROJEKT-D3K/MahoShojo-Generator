import type { ArenaRoomSessionResponse } from '@mahoshojo/contracts/arena-room';
import { DesktopRoomSessionProposalIdSchema, DesktopRoomSessionRoomIdSchema } from '@mahoshojo/contracts/desktop-room-session';
import { RoomProposalHostReview } from '@mahoshojo/ui-web/arena-room';
import type { DesktopArenaRoomSession, DesktopRoomState } from './room-session';

const observationLabels = {
  pending: '最新证据显示提案仍待处理，继续保留防重发状态。',
  absent: '最新完整快照中没有此提案；缺失不足以确认原操作结果。',
  conflict: '同一提案标识出现身份冲突，尚不能确认原目标。',
  'scope-changed': '观察作用域已变化，不能用于确认原目标。',
  'target-unavailable': '当前页面无法接管原冻结意图；可明确结束本机跟踪，再读取最新房间重新选择。',
  submitted: '已收到提案状态，等待本机确认后再结束跟踪。',
  terminal: '已观察到终态，等待匹配的本机确认后再结束跟踪。',
};

/** The shared review is advisory; the fixed owner and Native authority decide dispatch. */
export function DesktopRoomProposalReview({ owner, session, state, disabled, languages = [] }: {
  owner: DesktopArenaRoomSession; session: ArenaRoomSessionResponse; state: DesktopRoomState;
  disabled: boolean; languages?: readonly { code: string; name: string }[];
}) {
  if (session.self.role !== 'host' || session.self.membershipState !== 'active') return null;
  const identity = owner.confirmationOwner();
  const blocked = disabled || state.busy || !!state.unknown || !!state.configTracking
    || (!!state.proposalTracking && state.proposalTracking.phase !== 'settled')
    || state.phase !== 'online' || !state.snapshotReceived || !identity;
  const proposals = session.snapshot.proposals.filter(proposal => proposal.status === 'submitted');
  const roomAddressable = DesktopRoomSessionRoomIdSchema.safeParse(session.roomId).success;
  return <section aria-label="房主提案审阅" className="mt-3 space-y-2">
    <h3>审阅成员提案</h3>
    <p>按所见房间修订 {session.snapshot.revision} 逐项预览；预览不表示服务器允许采纳。处理仅更新房间权威配置，本机草稿保持不变。</p>
    {state.phase !== 'online' || !state.snapshotReceived ? <p role="status">等待当前连接的完整房间快照后才能审阅。</p> : null}
    {proposals.length ? <ul className="space-y-3">{proposals.map(proposal => {
      const addressable = roomAddressable && DesktopRoomSessionProposalIdSchema.safeParse(proposal.proposalId).success;
      return <li key={proposal.proposalId} className="list-none">
        {!addressable ? <p role="status">此提案标识不支持桌面安全寻址，仅可查看；不会重命名或删除原提案。</p> : null}
        <ul><RoomProposalHostReview proposal={proposal} roomId={session.roomId} roomEpoch={session.roomEpoch}
          revision={session.snapshot.revision} currentConfig={session.snapshot.sharedConfig}
          authorDisplayName={session.snapshot.members.find(member => member.userId === proposal.authorUserId)?.displayName ?? '未知成员'}
          labels={{ language: code => languages.find(language => language.code === code)?.name }}
          reviewIdentity={identity} disabled={blocked || !addressable}
          onResolve={(proposalId, request) => identity && addressable && proposalId === proposal.proposalId
            ? owner.resolveProposal(session, proposal, request, identity) : Promise.resolve()} /></ul>
      </li>;
    })}</ul> : <p>当前快照没有待审阅提案。</p>}
  </section>;
}

export function DesktopRoomProposalStatus({ owner, state, disabled }: {
  owner: DesktopArenaRoomSession; state: DesktopRoomState; disabled: boolean;
}) {
  const tracking = state.proposalTracking;
  if (!tracking) return null;
  const observation = tracking.observation;
  const end = () => {
    if (owner.getSnapshot().proposalTracking !== tracking || !tracking.id
      || !window.confirm('确认结束本机提案跟踪？这不会取消已发送的服务器操作；之后必须读取最新房间并重新明确选择。')) return;
    void owner.endProposalTracking(tracking.id);
  };
  return <section aria-label="提案处理状态" className="mt-3 rounded border p-3 space-y-2">
    <h3>提案处理状态</h3>
    {tracking.phase === 'resolving' ? <p role="status">正在处理原提案请求，请勿重复操作。</p>
      : tracking.phase === 'ended-needs-read' ? <><p>已结束本机跟踪，服务器请求不会因此取消。新审阅前须读取最新完整房间状态。</p>
        <button type="button" disabled={disabled || state.busy} onClick={() => { void owner.readProposalAfterEnd(); }}>读取最新房间后重新审阅</button></>
      : tracking.phase === 'settled' ? <p role="status">{observation
        ? observation.outcome === 'scope-unverified' ? '已观察到提案部分接受；具体接受范围尚无法确认。'
          : observation.outcome === 'different' ? '已观察到提案结束，结果与原意图不同。'
            : '已观察到与原意图一致的提案状态；这不证明由原请求造成。'
        : '原提案处理回执已确认，房间权威状态已更新。本机草稿保持不变。'}</p>
        : <><p>原提案操作结果未知，不会自动重发。pending、缺失或关联不足均不能证明未执行。</p>
          {observation ? <p>{observationLabels[observation.observation]}</p> : null}
          <button type="button" disabled={disabled || state.busy} onClick={() => { void owner.checkProposalTracking(); }}>读取房间核对提案</button>
          <button type="button" disabled={disabled || state.busy || !tracking.id || state.unknown?.intentId !== tracking.id || state.phase === 'unavailable'} onClick={end}>明确结束本机提案跟踪</button></>}
  </section>;
}
