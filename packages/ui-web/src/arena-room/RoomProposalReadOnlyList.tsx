import { useMemo } from 'react';
import type { ArenaProposal, ArenaRoomSessionResponse } from '@mahoshojo/contracts/arena-room';
import { previewArenaProposalApplication } from '@mahoshojo/multiplayer-core';
import { ArenaProposalChangeDescription, arenaProposalValueSummary, type ArenaProposalChangeLabels } from './proposal-presentation';

function ProposalObservation({ proposal, session, labels }: {
  proposal: ArenaProposal; session: ArenaRoomSessionResponse; labels?: ArenaProposalChangeLabels;
}) {
  const { snapshot } = session;
  const preview = useMemo(() => {
    try {
      return previewArenaProposalApplication({ roomId: session.roomId, config: snapshot.sharedConfig, revision: snapshot.revision }, proposal);
    } catch {
      return null;
    }
  }, [session.roomId, snapshot.sharedConfig, snapshot.revision, proposal]);
  const author = snapshot.members.find(member => member.userId === proposal.authorUserId)?.displayName ?? '未知成员';
  const analysis = new Map(preview?.plan.map(item => [item.changeId, item]));
  return <li className="rounded-lg border p-3 space-y-2">
    <h4>{author} 提出了 {proposal.changes.length} 项修改</h4>
    <p>提案 ID：{proposal.proposalId} · 提交于 {proposal.createdAt}</p>
    <p>提案基准修订 {proposal.baseRevision} · 所见房间修订 {snapshot.revision}</p>
    {proposal.baseRevision !== snapshot.revision ? <p role="status">提案基准版本与所见快照不同；请核对下方逐项目标基准预览。</p> : null}
    {!preview || preview.issues.length ? <p role="status">配置或提案约束无法验证，不能完成预览。</p> : preview.conflicts.length ?
      <p role="status">有 {preview.conflicts.length} 项目标基准冲突；此处不提供裁决操作。</p> :
      <p>按所见快照及依赖顺序预览，未发现目标基准冲突；这不代表服务器已接受或允许采纳。</p>}
    <ul aria-label="提案只读变更">
      {proposal.changes.map(change => {
        const item = analysis.get(change.changeId);
        const conflict = item?.outcome === 'conflict' || item?.outcome === 'overridden' ? item.conflict : undefined;
        return <li key={change.changeId} className="mt-2 rounded border p-2">
          <ArenaProposalChangeDescription change={change} labels={labels} />
          {item?.outcome === 'satisfied' ? <p>按提案依赖顺序预览时，此项目标已满足；这不表示当前房间已应用或返回处理回执。</p> : null}
          {conflict ? <p>目标基准冲突 · 预览时的目标值：{arenaProposalValueSummary(conflict.current)}</p> : null}
        </li>;
      })}
    </ul>
  </li>;
}

/** Reads only the server-projected session; preview never changes the snapshot or a local draft. */
export function RoomProposalReadOnlyList({ session, isLive, labels }: {
  session: ArenaRoomSessionResponse | null; isLive: boolean; labels?: ArenaProposalChangeLabels;
}) {
  if (!session || session.self.membershipState !== 'active') return null;
  return <section aria-label="房间提案只读预览" className="mt-3 space-y-2">
    <h3>已收到的配置提案</h3>
    <p>{isLive ? '已收到的房间快照' : '最后已收到的房间快照（当前未同步）'}：修订 {session.snapshot.revision} · 控制序号 {session.snapshot.controlSeq}</p>
    <p>这里只读展示，并按提案依赖顺序模拟；预览不修改本机草稿、房间配置或提案状态。桌面暂不提供提交、撤回或审阅操作。</p>
    {session.snapshot.proposals.length ? <ul aria-label="已收到提案列表" className="space-y-3">
      {session.snapshot.proposals.map(proposal => <ProposalObservation key={proposal.proposalId} proposal={proposal} session={session} labels={labels} />)}
    </ul> : <p>此快照没有当前账号可见的待处理提案。</p>}
  </section>;
}
