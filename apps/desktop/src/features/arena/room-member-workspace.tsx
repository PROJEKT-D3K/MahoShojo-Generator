import { useCallback, useMemo, useRef, useEffect, useSyncExternalStore } from 'react';
import { RoomMemberProposalWorkspace, collectArenaMemberReferenceRequests, mapSharedConfigToArenaMemberView, type ArenaMemberProposalRoom } from '@mahoshojo/ui-web/arena-room';
import type { ArenaRoomSessionResponse } from '@mahoshojo/contracts/arena-room';
import type { ArenaMemberProposalModel } from '@mahoshojo/multiplayer-core/member-proposal';
import type { DesktopArenaRoomSession } from './room-session';
import { useDesktopArenaMemberSources } from './room-member-sources';

/** Desktop contributes fixed Native actions and source ports; the complete editor is shared with Web. */
export function DesktopRoomMemberWorkspace({ owner, model, session, languages }: {
  owner: DesktopArenaRoomSession; model: ArenaMemberProposalModel; session: ArenaRoomSessionResponse;
  languages: { code: string; name: string }[];
}) {
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const identity = owner.confirmationOwner();
  const scope = useMemo(() => ({}), [owner, identity, model, session.roomId, session.roomEpoch, session.self.userId]);
  const current = useRef<object | null>(scope);
  current.current = scope;
  useEffect(() => { current.current = scope; return () => { current.current = null; }; }, [scope]);
  const isCurrent = useCallback(() => {
    const latest = owner.getSnapshot();
    return current.current === scope && identity !== null && owner.confirmationOwner() === identity
      && latest.memberModel === model && !model.store.getState().disposed
      && latest.session?.roomId === session.roomId && latest.session.roomEpoch === session.roomEpoch
      && latest.session.self.userId === session.self.userId && latest.session.self.role === 'member'
      && latest.session.self.membershipState === 'active';
  }, [owner, identity, model, scope, session.roomId, session.roomEpoch, session.self.userId]);
  const modelState = useSyncExternalStore(model.store.subscribe, model.store.getState, model.store.getInitialState);
  const requests = useMemo(() => [
    ...collectArenaMemberReferenceRequests(mapSharedConfigToArenaMemberView(modelState.editor.workingConfig)),
    ...collectArenaMemberReferenceRequests(mapSharedConfigToArenaMemberView(modelState.editor.baselineConfig)),
  ], [modelState.editor.workingConfig, modelState.editor.baselineConfig]);
  const host = useDesktopArenaMemberSources({ scopeIdentity: identity, isCurrent, languages, roomId: session.roomId, requests });
  const tracking = state.proposalTracking;
  const room: ArenaMemberProposalRoom = {
    session: state.session,
    operation: tracking?.phase === 'resolving' ? tracking.operation === 'proposalSubmit' ? 'submit' : tracking.operation === 'proposalWithdraw' ? 'withdraw' : 'resolve' : null,
    resultUnknown: !!state.unknown && state.unknown.operation.startsWith('proposal'),
    tracking: tracking?.id && (tracking.phase === 'unknown' || tracking.phase === 'ended-needs-read') ? { id: tracking.id, phase: tracking.phase } : null,
    blockedReason: owner.memberProposalBlockedReason(),
    outcome: tracking?.phase === 'settled' ? state.notice : null,
  };
  return <RoomMemberProposalWorkspace model={model} scopeIdentity={scope} room={room} host={host}
    actions={{
      submit: intent => isCurrent() ? owner.submitProposal(session, intent, identity!) : Promise.resolve(),
      withdraw: id => isCurrent() ? owner.withdrawProposal(session, id, identity!) : Promise.resolve(),
      sync: () => { if (isCurrent()) owner.syncMemberProposal(session, identity!); },
      read: async () => {
        if (!isCurrent()) return;
        if (owner.getSnapshot().proposalTracking?.phase === 'ended-needs-read') await owner.readProposalAfterEnd();
        else if (owner.getSnapshot().proposalTracking?.phase === 'unknown') await owner.checkProposalTracking();
        else await owner.reconnect();
      },
      endTracking: id => {
        if (!isCurrent() || owner.getSnapshot().proposalTracking?.id !== id
          || !window.confirm('确认结束本机提案跟踪？这不会取消已发送的服务器操作；之后必须读取最新房间并重新明确选择。')) return;
        return owner.endProposalTracking(id);
      },
    }} />;
}
