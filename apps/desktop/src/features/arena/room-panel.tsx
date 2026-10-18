import { captureArenaRoomGenerationCancelTarget, isArenaRoomGenerationCancelTargetCurrent, type ArenaRoomGenerationCancelTarget } from '@mahoshojo/multiplayer-core';
import { DesktopRoomGenerationResult } from './room-generation-result';
import { DesktopRoomProposalReview, DesktopRoomProposalStatus } from './room-proposal-review';
import { DesktopRoomConfigComparison } from './room-config-comparison';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { RoomGenerationCancelAction, RoomConfigPublishStatus, RoomProposalReadOnlyList, RoomLobbyContent, RoomMembersView, RoomExitActions, RoomInviteShareButton, useRoomInviteCopy, createRoomInviteScope, projectRoomMembers, type RoomExitConfirmation } from '@mahoshojo/ui-web/arena-room';
import { parseArenaRoomJoinCode } from '@mahoshojo/multiplayer-core/room-join-code';
import { MAX_ROOM_MEMBERS, type RoomDirectoryVisibility } from '@mahoshojo/contracts/arena-room';
import { buildArenaRoomInviteText } from '@mahoshojo/multiplayer-core/room-invite';
import { DESKTOP_PRODUCT_ORIGIN } from '../../platform/product-origin';
import { generationActionClassNames } from '@mahoshojo/ui-web/generation-actions';
import { prepareDesktopRoomSource } from './room-source';
import type { ArenaDraft } from './session';
import type { DesktopArenaRoomSession } from './room-session';
const secondary = generationActionClassNames.secondary;
export interface DesktopArenaRoomPanelProps {
  languages?: readonly { code: string; name: string }[];
  owner: DesktopArenaRoomSession; draft: ArenaDraft; isDraftCurrent: (draft: ArenaDraft) => boolean;
  disabled: boolean; authenticated: boolean; displayName: string; onAuthenticate: () => void;
}
/** Shared product sections; only this Desktop host binds the fixed Native owner. */
export function DesktopArenaRoomPanel({ owner, draft, isDraftCurrent, disabled, authenticated, displayName, onAuthenticate, languages }: DesktopArenaRoomPanelProps) {
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const [title, setTitle] = useState('多人房间'); const [visibility, setVisibility] = useState<RoomDirectoryVisibility>('public');
  const [joinCode, setJoinCode] = useState('');
  const [joinCodeError, setJoinCodeError] = useState<string | null>(null);
  const joinCodePreview = parseArenaRoomJoinCode(joinCode);
  const [confirmation, setConfirmation] = useState<{ action: RoomExitConfirmation; scope: string; identity: symbol | null } | null>(null);
  const [cancelConfirmation, setCancelConfirmation] = useState<{ target: ArenaRoomGenerationCancelTarget; identity: symbol } | null>(null);
  const session = state.session;
  const scope = session ? `${session.roomId}\n${session.roomEpoch}\n${session.self.userId}` : '';
  const currentScope = () => { const s = owner.getSnapshot().session; return s ? `${s.roomId}\n${s.roomEpoch}\n${s.self.userId}` : ''; };
  const create = (empty = false) => {
    const frozen = draft, identity = owner.confirmationOwner();
    if (empty && !window.confirm('确认以项目标准空草稿创建房间？只创建房间配置，本机当前草稿和结果仍保留。')) return;
    if (!identity || owner.confirmationOwner() !== identity) return;
    void owner.create({ title, visibility, displayName }, () => prepareDesktopRoomSource(frozen, empty), () => isDraftCurrent(frozen));
  };
  const disconnect = () => {
    if (owner.needsLeaveConfirmation() && !window.confirm('确认断开本机房间连接？未提交成员草稿将丢弃，原普通 Arena 草稿、结果和模型会恢复。成员资格不会因此退出，服务器任务也不会停止；未知操作仍可能已发生。应用关闭后未确认意图不能跨进程恢复，请优先核对。')) return;
    owner.detach(); setConfirmation(null); setJoinCodeError(null);
  };
  const view = projectRoomMembers({ roomId: session?.roomId ?? null, roomEpoch: session?.roomEpoch ?? null, members: session?.snapshot.members ?? [], presence: state.presence,
    presenceEligible: state.phase === 'online' && state.snapshotReceived && !!state.presence?.onlineUserIds.includes(session?.self.userId ?? '') });
  const inviteIdentity = owner.confirmationOwner();
  const inviteRoomScope = useMemo(() => createRoomInviteScope({
    readScope: () => {
      const current = owner.getSnapshot();
      const active = current.phase === 'closed' ? null : current.session;
      return active ? JSON.stringify([active.roomId, active.roomEpoch, active.self.userId]) : null;
    },
    subscribe: owner.subscribe,
  }), [owner]);
  const inviteRoomToken = useSyncExternalStore(inviteRoomScope.subscribe, inviteRoomScope.getSnapshot);
  const inviteScope = useMemo(() => ({ room: inviteRoomToken, identity: inviteIdentity }), [inviteRoomToken, inviteIdentity]);
  const inviteCopy = useRoomInviteCopy({
    scope: inviteScope,
    prepare: () => {
      const identity = owner.confirmationOwner();
      const current = owner.getSnapshot();
      const target = current.session;
      if (!identity || identity !== inviteIdentity || !target || currentScope() !== scope || inviteRoomScope.getSnapshot() !== inviteRoomToken) return null;
      const directoryRoom = current.rooms.find(room => room.roomId === target.roomId);
      const members = target.snapshot.members.filter(member => member.membershipState === 'active');
      return {
        text: buildArenaRoomInviteText(DESKTOP_PRODUCT_ORIGIN, target.roomId, {
          roomTitle: directoryRoom?.title ?? (target.self.role === 'host' ? title : undefined),
          hostDisplayName: members.find(member => member.role === 'host')?.displayName,
          memberCount: members.length,
          memberLimit: directoryRoom?.memberLimit ?? MAX_ROOM_MEMBERS,
        }),
        isCurrent: () => owner.confirmationOwner() === identity && currentScope() === scope && inviteRoomScope.getSnapshot() === inviteRoomToken,
      };
    },
  });
  const pending = state.unknown;
  const tracking = state.configTracking;
  const proposalTracking = state.proposalTracking;
  const proposalBlocked = !!proposalTracking && proposalTracking.phase !== 'settled';
  const reconcile = () => {
    if (owner.getSnapshot().unknown !== pending) return;
    if (state.phase !== 'unavailable' && pending?.operation === 'create' && pending.intentId && !window.confirm('确认核对原创建意图？这会以原请求 ID 和原正文发送 resume-only 幂等写请求，并非只读查询；找不到原回执也不会创建新房间。')) return;
    void owner.reconcile();
  };
  const status = { detached: '未连接', attaching: '正在验证窗口', ready: '大厅已就绪', connecting: '正在连接', online: view.onlineCount === null ? '等待权威在线状态' : '已在线', offline: '连接已断开', reconnecting: '正在重连', closed: '房间会话已结束', unavailable: '房间暂不可用' }[state.phase];
  return <section aria-label="桌面多人房间" className="mb-6 rounded-2xl border border-gray-200 bg-white/70 p-4 dark:border-gray-700 dark:bg-gray-900/60">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">多人房间</h2>
      {!state.opened ? <button type="button" className={secondary} disabled={disabled} onClick={() => { void owner.open(); }}>打开多人大厅</button>
        : <button type="button" className={secondary} onClick={disconnect}>断开本机房间连接</button>}</div>
    <p className="text-sm">当前桌面阶段支持创建、加入、成员在线状态、退出/关闭，以及房主比较后明确发布配置。支持完整成员提案编辑、提交、撤回与房主逐项审阅。支持读取当前房间战报与实时预览；房主可停止当前生成；开始协作生成仍需在 Web 端操作。</p>
    {state.constrained ? <p role="status">本次多人会话的有效执行位置：服务器。普通 AI 选择与本机草稿保持不变，退出后恢复普通操作。</p> : null}
    {state.opened ? <>
      <p role="status">{status}</p>
      {!authenticated ? <button type="button" className={secondary} onClick={onAuthenticate}>验证或登录账号</button> : null}
      {state.notice ? <p role="status">{state.notice}</p> : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.sourceIssues.length ? <div><p>在线来源缺少房间版本时，当前桌面选择路径尚不能补齐；可明确选择空稿房间，原设定保留。</p><ul>{state.sourceIssues.map((issue, index) => <li key={index}>{issue}</li>)}</ul><button type="button" className={secondary} disabled={state.busy || disabled} onClick={() => create(true)}>明确创建空草稿房间</button></div> : null}
      {pending && pending.operation !== 'generationCancel' && pending.operation !== 'config' && !pending.operation.startsWith('proposal') ? <section aria-label="核对未知房间操作"><p>原{pending.operation === 'create' ? '创建' : pending.operation === 'join' ? '加入' : pending.operation === 'leave' ? '退出' : pending.operation === 'close' ? '关闭' : pending.operation === 'proposalSubmit' ? '提案提交' : pending.operation === 'proposalWithdraw' ? '提案撤回' : '提案处理'}操作结果未知。不会自动再次发送。</p><button type="button" className={secondary} disabled={state.busy} onClick={reconcile}>{state.phase === 'unavailable' ? '重新验证窗口与本机原意图' : pending.operation === 'create' ? pending.intentId ? '确认恢复原创建意图' : '读取本机原意图' : '读取房间核对结果'}</button></section> : null}
      {pending?.operation === 'generationCancel' ? <section aria-label="核对停止生成结果">
        <p>{owner.cancelTrackingUnavailable() ? '原目标已不可核对，结果未知。新生成或房间换代不能证明原任务已停止。' : '正在核对原生成终态；停止请求不会再次发送。'}</p>
        <p>断开或刷新不会解除原停止请求的防重发状态，也不会停止服务器生成。</p>
        <button type="button" className={secondary} disabled={state.busy || state.generationReading} onClick={reconcile}>{state.phase === 'unavailable' ? '重新验证窗口与本机原意图' : '只读核对停止结果'}</button>
      </section> : null}
      {tracking && tracking.phase !== 'publishing' ? <RoomConfigPublishStatus phase={tracking.phase} observation={tracking.observation} trackingId={tracking.id}
        busy={state.busy || disabled} canEnd={pending?.intentId === tracking.id && state.phase !== 'unavailable'} targetConfig={tracking.target?.request.sharedConfig} authoritySession={session}
        onCheck={() => { void owner.checkConfigPublish(); }} onEnd={() => { void owner.endConfigTracking(tracking.id); }} onRead={() => { void owner.readConfigAfterEnd(); }} /> : null}
      {!state.memberModel || session?.self.role !== 'member' ? <DesktopRoomProposalStatus owner={owner} state={state} disabled={disabled} /> : null}
      {session ? <>
        <p>房间码：<span>{session.roomId}</span> · {session.self.role === 'host' ? '你是房主' : '你是成员'}</p>
        <RoomInviteShareButton status={inviteCopy.status} disabled={disabled || !inviteIdentity} onCopy={() => { void inviteCopy.copy(); }} />
        <p>{view.summary}</p>
        <RoomMembersView view={view} selfUserId={session.self.userId} membershipHint="断网或关闭页面只会离线，成员席位仍保留；要退出请明确离开，房主则关闭房间。" />
        <section aria-label="房间权威设定摘要"><h3>服务器房间设定</h3><p>修订 {session.snapshot.revision} · {session.snapshot.sharedConfig.combatants.length} 位角色 · {session.snapshot.sharedConfig.auxScenarios.length} 个辅助情景 · {session.snapshot.sharedConfig.materials.length} 份素材</p><p>生成状态：{session.snapshot.activeGeneration?.state ?? '无活动生成'}。</p></section>
        <DesktopRoomGenerationResult generation={state.generation} generationKey={`${scope}:${session.snapshot.activeGeneration?.generationId ?? 'none'}:${session.snapshot.activeGeneration?.attempt ?? 0}`}
          onRetry={() => owner.retryGenerationRecovery()} retryDisabled={disabled || state.busy || state.generationReading || state.phase !== 'online' || !state.snapshotReceived || !inviteIdentity} />
        {session.self.role === 'host' ? <RoomGenerationCancelAction
          disabled={disabled || owner.cancelGenerationBlockedReason() !== null}
          confirmation={!!cancelConfirmation && cancelConfirmation.identity === owner.confirmationOwner()
            && isArenaRoomGenerationCancelTargetCurrent(cancelConfirmation.target, session)}
          onRequest={() => {
            const identity = owner.confirmationOwner(), target = captureArenaRoomGenerationCancelTarget(owner.getSnapshot().session);
            if (!identity || !target || disabled || owner.cancelGenerationBlockedReason() !== null) return;
            setCancelConfirmation({ target, identity });
          }}
          onDismiss={() => setCancelConfirmation(null)}
          onConfirm={() => {
            const frozen = cancelConfirmation; setCancelConfirmation(null);
            if (frozen && !disabled) void owner.cancelGeneration(frozen.target, frozen.identity);
          }} /> : null}
        {session.self.role === 'host' ? <DesktopRoomProposalReview key={`proposals:${scope}`} owner={owner} session={session} state={state} disabled={disabled} languages={languages} />
          : <RoomProposalReadOnlyList session={session} isLive={state.phase === 'online' && state.snapshotReceived} labels={{ language: code => languages?.find(language => language.code === code)?.name }} />}
        {session.self.role === 'host' ? <DesktopRoomConfigComparison key={`comparison:${scope}`} owner={owner} session={session} draft={draft} isDraftCurrent={isDraftCurrent} languages={languages} disabled={state.busy || disabled || !!pending || !!tracking || proposalBlocked} /> : null}
        {session.self.role === 'member' && state.memberModel ? <p>离开房间将丢弃未提交成员草稿；原普通 Arena 草稿、结果与模型保持不变。</p> : null}
        {!pending ? <RoomExitActions key={scope} role={session.self.role} busy={state.busy} confirmation={confirmation?.scope === scope && confirmation.identity === owner.confirmationOwner() ? confirmation.action : null}
          onConfirmationChange={action => setConfirmation({ action, scope, identity: owner.confirmationOwner() })}
          onClose={() => { if (currentScope() === scope && confirmation?.scope === scope && confirmation.identity === owner.confirmationOwner()) { setConfirmation(null); void owner.close(); } }}
          onLeave={() => { if (currentScope() === scope && confirmation?.scope === scope && confirmation.identity === owner.confirmationOwner()) { setConfirmation(null); void owner.leave(); } }} /> : null}
        {!pending && !state.busy && ['offline', 'unavailable'].includes(state.phase) ? <button type="button" className={secondary} onClick={() => { if (currentScope() === scope) void owner.reconnect(); }}>读取房间并重连</button> : null}
      </> : !state.memberModel && !pending && !tracking && !proposalBlocked && state.phase === 'ready' ? <>
        <p className="text-sm">创建只共享当前可共享设定和来源引用；本地正文不会上传。加入不上传本机草稿。目录只保留当前页，人数不是在线人数。</p>
        {joinCodeError ? <p role="alert">{joinCodeError}</p> : null}
        <RoomLobbyContent roomTitle={title} visibility={visibility} joinCode={joinCode} rooms={state.rooms} loading={state.busy} loadingMore={state.busy} nextCursor={state.nextCursor} nextPageLabel="下一页" busy={state.busy || disabled}
          joinCodeHint={<>填写房间码或粘贴完整邀请文案，再点击加入房间。{joinCodePreview.ok ? <span className="mt-1 block" role="status">将加入：{joinCodePreview.roomId}</span> : null}</>} onRoomTitleChange={setTitle} onVisibilityChange={setVisibility}
          onJoinCodeChange={value => { setJoinCodeError(null); setJoinCode(value); }}
          onCreate={() => create()} onDiscover={() => { void owner.discover(); }} onDiscoverMore={() => { void owner.discover(true); }} onJoin={input => {
            if (disabled || owner.getSnapshot().busy) return;
            setJoinCodeError(null);
            const parsed = parseArenaRoomJoinCode(input);
            if (!parsed.ok) { setJoinCodeError(parsed.error); return; }
            void owner.join(parsed.roomId, displayName);
          }} />
      </> : !state.memberModel && !state.busy && !pending && !tracking && !proposalBlocked ? <button type="button" className={secondary} disabled={disabled || !authenticated} onClick={() => { void owner.open(); }}>重新打开房间会话</button> : null}
    </> : null}
  </section>;
}
