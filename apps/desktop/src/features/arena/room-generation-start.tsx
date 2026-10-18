import { useMemo, useState } from 'react';
import type { ArenaRoomSessionResponse } from '@mahoshojo/contracts/arena-room';
import { RoomGenerationStartConfirmButton, RoomGenerationPendingProposalsWarning } from '@mahoshojo/ui-web/arena-room';
import { generationActionClassNames } from '@mahoshojo/ui-web/generation-actions';
import { prepareDesktopRoomStartSource } from './room-source';
import { desktopRoomStartSourceBudget } from './room-source-budget';
import type { DesktopArenaRoomSession, DesktopRoomState } from './room-session';
import type { ArenaDraft } from './session';

type Confirmation = { identity: symbol; session: ArenaRoomSessionResponse; draft: ArenaDraft; intentId?: string };
/** Abandoning local retry material never claims that the server did not start. */
export function DesktopRoomStartTracking({ owner, state, disabled }: {
  owner: DesktopArenaRoomSession; state: DesktopRoomState; disabled: boolean;
}) {
  const [confirmation, setConfirmation] = useState<{ identity: symbol; intentId: string } | null>(null);
  const pending = state.unknown?.operation === 'generationStart' ? state.unknown : null;
  const blocked = disabled || state.busy || state.generationReading || state.phase === 'unavailable';
  const current = confirmation && confirmation.identity === owner.confirmationOwner() && pending?.intentId === confirmation.intentId ? confirmation : null;
  return <>
    {pending?.intentId ? <section aria-label="停止本机生成跟踪">
      <button type="button" className={generationActionClassNames.secondary} disabled={blocked} onClick={() => {
        const identity = owner.confirmationOwner(); if (identity && pending.intentId && !blocked) setConfirmation({ identity, intentId: pending.intentId });
      }}>停止本机跟踪并返回大厅</button>
      {current ? <div role="alertdialog" aria-label="确认停止本机生成跟踪">
        <p>这不会取消服务器任务。原材料和重试许可会被销毁，不能再以原 ID 重试；本窗口仍保留原房间防重复记录，暂不能开始新生成，但可查看、退出或换房。关闭应用会丢失本机记录，不代表生成未发生。</p>
        <button type="button" disabled={blocked} onClick={() => { const frozen = current; setConfirmation(null); void owner.endGenerationStartTracking(frozen.intentId, frozen.identity); }}>确认停止本机跟踪</button>
        <button type="button" onClick={() => setConfirmation(null)}>继续保留跟踪</button>
      </div> : null}
    </section> : null}
    {state.generationStartBlocked ? <section aria-label="未确认生成防重复记录">
      <p>本窗口保留一条未确认生成记录，暂不允许新的生成。大厅、只读、退出和换房仍可使用。</p>
      {state.generationStartFence ? <>
        <p>原房间：{state.generationStartFence.roomId}。原请求：{state.generationStartFence.generationRequestId}。只能核对，不能重新发送原请求；明确关闭原房间也不等于停止服务器模型。</p>
        <button type="button" disabled={disabled || state.busy || !!state.unknown || !!state.session && state.session.roomId !== state.generationStartFence.roomId} onClick={() => { void owner.checkGenerationStartFence(); }}>只读核对保留记录的原房间</button>
        {state.session && state.session.roomId !== state.generationStartFence.roomId ? <p>请先明确断开当前房间、返回大厅，再核对原房间；当前成员草稿不会被只读按钮悄悄替换。</p> : null}
      </> : <p>请由原账号核对其未确认记录。这里不会显示其它账号的房间或请求信息。</p>}
    </section> : null}
  </>;
}
/** A confirmation never follows changed source/authority, and never stores a large request. */
export function DesktopRoomGenerationStart({ owner, state, draft, isDraftCurrent, disabled }: {
  owner: DesktopArenaRoomSession; state: DesktopRoomState; draft: ArenaDraft;
  isDraftCurrent: (draft: ArenaDraft) => boolean; disabled: boolean;
}) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const session = state.session, identity = owner.confirmationOwner();
  const pending = state.unknown?.operation === 'generationStart' ? state.unknown : null;
  const current = confirmation && confirmation.identity === identity && confirmation.session === session
    && confirmation.draft === draft && isDraftCurrent(draft)
    && (confirmation.intentId === undefined ? !pending : pending?.intentId === confirmation.intentId) ? confirmation : null;
  const blocked = disabled || owner.startGenerationBlockedReason() !== null;
  const retryBlocked = disabled || state.busy || state.phase !== 'online' || !state.snapshotReceived || !pending?.generationStart?.retryable;
  const confirm = () => {
    setConfirmation(null);
    if (!current || disabled) return;
    if (current.intentId) { void owner.retryStartGeneration(current.intentId, current.identity); return; }
    void owner.startGeneration(current.session, current.identity, () => prepareDesktopRoomStartSource(current.draft), () => isDraftCurrent(current.draft));
  };
  return <section aria-label="房主开始多人生成">
    <DesktopRoomVisibleSources draft={draft} busy={state.busy} />
    <p>本房间使用服务器系统默认，普通模型及参数保持不变。当前可见配置与完整本地来源一致后才可开始；流式/非流式偏好不影响房间的实时共享战报。</p>
    {pending ? <>
      <p>{session?.snapshot.activeGeneration?.state === 'starting' ? '已占位，尚未确认启动。当前只可核对或在原任务明确缺失后重试；此阶段暂不支持停止。' : '原生成请求结果未知。'}只读核对不会开始新任务；以原请求重试可能补执行原任务，不会读取新草稿。离开页面只断开本机连接，不取消服务器任务。</p>
      {!pending.generationStart?.retryable ? <p>原材料或授权暂不可用于重试。请只读核对；换账号、页面或房间后不会拼回旧请求，也不能据此另开新任务。</p> : null}
      <button type="button" className={generationActionClassNames.secondary} disabled={state.busy || disabled} onClick={() => { void owner.reconcile(); }}>只读核对生成状态</button>
      <button type="button" className={generationActionClassNames.secondary} disabled={retryBlocked} onClick={() => {
        if (identity && session && pending.intentId && !retryBlocked) setConfirmation({ identity, session, draft, intentId: pending.intentId });
      }}>以原请求重试</button>
    </> : <>
      <button type="button" className={generationActionClassNames.primary} disabled={blocked} onClick={() => {
        if (identity && session && !blocked) setConfirmation({ identity, session, draft });
      }}>开始多人生成</button>
      {owner.startGenerationBlockedReason() ? <p>{owner.startGenerationBlockedReason()}</p> : null}
      <button type="button" className={generationActionClassNames.secondary} disabled={disabled || state.busy} onClick={() => { void owner.reconnect(); }}>只读核对当前房间状态</button>
    </>}
    {current ? <div role="alertdialog" aria-label={current.intentId ? '确认原请求重试' : '确认多人生成配置'}>
      {current.intentId ? <p>这会再次提交原请求，可能补执行尚未开始的生成；不是只读查询。账号、页面、房间或原材料失效时不会发送。</p>
        : <><p>确认使用下方当前可见设置和完整本地正文开始？不会应用未处理的提案。配置未发布或来源不完整时会阻止发送。</p>
          <RoomGenerationPendingProposalsWarning count={session?.snapshot.proposals.filter(item => item.status === 'submitted').length ?? 0} /></>}
      <RoomGenerationStartConfirmButton retry={!!current.intentId} disabled={current.intentId ? retryBlocked : blocked} onConfirm={confirm} />
      <button type="button" onClick={() => setConfirmation(null)}>返回检查</button>
    </div> : null}
  </section>;
}

/** Browse each full local source without enabling editor mutations or keeping a second whole draft. */
function DesktopRoomVisibleSources({ draft, busy }: { draft: ArenaDraft; busy: boolean }) {
  const [selection, setSelection] = useState('');
  const entries = useMemo(() => Object.entries(draft).filter(([key]) => !['generationMode'].includes(key)), [draft]);
  const budget = useMemo(() => desktopRoomStartSourceBudget(draft), [draft]);
  const text = useMemo(() => busy || budget || !selection ? '' : JSON.stringify(entries.find(([key]) => key === selection)?.[1], null, 2), [entries, selection, busy, budget]);
  return <section aria-label="房主完整本机来源只读检查">
    <label>查看完整来源或设置<select aria-label="选择完整本机来源" disabled={busy || !!budget} value={selection} onChange={event => setSelection(event.target.value)}>
      <option value="">选择要检查的部分</option>{entries.map(([key]) => <option key={key} value={key}>{key}</option>)}
    </select></label>
    {budget ? <p role="alert">{budget === 'complexity' ? '本机材料结构过于复杂' : '本机材料超过 12 MiB 来源检查上限'}，无法在本房间完整检查或开始。请减少材料后重试；普通草稿保持完整，不会截断。</p> : null}
    <p>这是眼前草稿的完整本机正文，可逐项只读检查。在线引用仍由服务器按公开来源校验；发送时不会从隐藏草稿另取正文。</p>
    {text ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all">{text}</pre> : null}
  </section>;
}
