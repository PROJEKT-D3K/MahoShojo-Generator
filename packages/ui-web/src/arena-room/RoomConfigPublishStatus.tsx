'use client';
import type { ArenaRoomSessionResponse, ArenaRoomSharedConfig } from '@mahoshojo/contracts/arena-room';
import { RoomConfigDiffView } from './RoomConfigDiffView';
import { buildArenaRoomConfigDiffEntries } from './config-diff';
import { useState } from 'react';
import type { ArenaRoomConfigPublishObservation } from '@mahoshojo/multiplayer-core';

const observationCopy: Record<ArenaRoomConfigPublishObservation, string> = {
  unobserved: '原配置发布结果未知，请先核对当前房间状态。',
  'target-matches': '当前房间设置已符合原目标，原请求结果仍无法确认。',
  'target-differs': '当前房间设置与原目标不同，仍不能断定原请求未执行或不会迟到。',
  'target-unavailable': '原目标已不可恢复，只能核对当前房间；本地草稿不代表原发布目标。',
  'authority-unavailable': '当前房间状态不可读取，原请求结果仍未知。',
  'scope-changed': '房间或成员身份已变化，当前状态不能确认原请求结果。',
};

/** Ordinary hide/unmount does not acknowledge or end a pending request. */
export function RoomConfigPublishStatus({ phase, observation, trackingId, busy, canEnd, onCheck, onEnd, onRead, targetConfig, authoritySession }: {
  targetConfig?: ArenaRoomSharedConfig | null; authoritySession?: ArenaRoomSessionResponse | null;
  phase: 'unknown' | 'ended-needs-read'; observation: ArenaRoomConfigPublishObservation;
  trackingId: string; busy: boolean; canEnd: boolean;
  onCheck: () => void; onEnd: () => void; onRead: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  if (phase === 'ended-needs-read') return <section aria-label="配置发布跟踪">
    <p role="status">已结束本机跟踪；这不会撤销服务器请求。再次发布前，请重新读取房间并比较设置。</p>
    <button type="button" disabled={busy} onClick={onRead}>重新读取房间</button>
  </section>;
  return <section aria-label="配置发布跟踪">
    <p role="status">{observationCopy[observation]}</p>
    {observation === 'target-differs' && targetConfig && authoritySession ? <RoomConfigDiffView roomConfig={authoritySession.snapshot.sharedConfig} localConfig={targetConfig}
      revision={authoritySession.snapshot.revision} entries={buildArenaRoomConfigDiffEntries(authoritySession.snapshot.sharedConfig, targetConfig, () => undefined)}
      heading="原发布目标与当前房间的差异" localLabel="原发布目标（不是当前草稿）" emptyMessage="当前设置已符合原目标，原请求结果仍未知。" /> : null}
    <p>核对只读取权威状态，不重发发布请求，也不覆盖本地草稿。</p>
    <button type="button" disabled={busy} onClick={onCheck}>核对当前房间</button>
    <button type="button" disabled={busy || !canEnd} onClick={() => setConfirming(trackingId)}>结束本次跟踪</button>
    {confirming === trackingId ? <div role="group" aria-label="确认结束配置跟踪">
      <p>结束跟踪不会取消或回滚已派发的服务器写入。确定不再跟踪这次请求？</p>
      <button type="button" disabled={busy || !canEnd} onClick={() => { setConfirming(null); onEnd(); }}>确认结束跟踪</button>
      <button type="button" disabled={busy} onClick={() => setConfirming(null)}>继续跟踪</button>
    </div> : null}
  </section>;
}
