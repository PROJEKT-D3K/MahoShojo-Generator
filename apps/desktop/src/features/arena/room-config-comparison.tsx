import { useEffect, useRef, useState } from 'react';
import type { ArenaRoomSessionResponse, ArenaRoomSharedConfig } from '@mahoshojo/contracts/arena-room';
import { buildArenaRoomConfigDiffEntries, RoomConfigDiffView } from '@mahoshojo/ui-web/arena-room';
import { generationActionClassNames } from '@mahoshojo/ui-web/generation-actions';
import { prepareDesktopRoomSource } from './room-source';
import type { ArenaDraft } from './session';
import type { DesktopArenaRoomSession } from './room-session';

type Comparison = { draft: ArenaDraft; session: ArenaRoomSessionResponse; identity: symbol; local: ArenaRoomSharedConfig | null; issues: readonly string[] };
/** Explicit projection and confirmation. No reference hydration or draft installation. */
export function DesktopRoomConfigComparison({ owner, session, draft, isDraftCurrent, disabled, languages = [] }: {
  owner: DesktopArenaRoomSession; session: ArenaRoomSessionResponse; draft: ArenaDraft;
  isDraftCurrent: (draft: ArenaDraft) => boolean; disabled: boolean;
  languages?: readonly { code: string; name: string }[];
}) {
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [confirmation, setConfirmation] = useState<Comparison | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef(0);
  useEffect(() => () => { operation.current += 1; }, []);
  const identity = owner.confirmationOwner();
  const current = comparison?.draft === draft && comparison.session === session && comparison.identity === identity ? comparison : null;
  const compare = async () => {
    if (busy || disabled || !identity) return;
    const token = ++operation.current;
    setBusy(true);
    try {
      const result = await prepareDesktopRoomSource(draft);
      if (token !== operation.current || owner.confirmationOwner() !== identity || owner.getSnapshot().session !== session || !isDraftCurrent(draft)) return;
      setComparison({ draft, session, identity, local: result.ok ? result.sharedConfig : null, issues: result.ok ? [] : result.issues });
    } finally {
      if (token === operation.current) setBusy(false);
    }
  };
  return <section aria-label="本地与房间配置比较">
    <button type="button" className={generationActionClassNames.secondary} disabled={disabled || busy || !identity} onClick={() => { void compare(); }}>{busy ? '正在比较可共享设置…' : '比较本地与房间设置'}</button>
    <p className="text-xs">比较本地可共享设置与当前房间；确认发布前不会写入。发布不上传本地正文、不覆盖草稿，也不加载引用正文。引用名称不可用时显示引用 ID。</p>
    {current?.issues.length ? <div role="alert"><p>当前本地草稿无法转换为可共享配置，未进行比较。</p><ul>{current.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div> : null}
    {current?.local ? <>
      <button type="button" disabled={disabled || busy} className={generationActionClassNames.primary} onClick={() => setConfirmation(current)}>发布已比较的设置</button>
      {confirmation === current ? <div role="group" aria-label="确认发布房间配置"><p>确认把上方已比较的可共享设置发布到房间？本地正文不会上传；发布结果未知时不会自动重试。</p>
        <button type="button" disabled={disabled || busy} onClick={() => { setConfirmation(null); if (current.local) void owner.publishConfig(current.session, current.local, current.identity,
          () => isDraftCurrent(current.draft) && owner.getSnapshot().session === current.session && owner.confirmationOwner() === current.identity); }}>确认发布房间配置</button>
        <button type="button" disabled={disabled || busy} onClick={() => setConfirmation(null)}>返回比较</button></div> : null}
      <RoomConfigDiffView roomConfig={session.snapshot.sharedConfig} localConfig={current.local} revision={session.snapshot.revision}
      entries={buildArenaRoomConfigDiffEntries(session.snapshot.sharedConfig, current.local, () => undefined, code => languages.find(language => language.code === code)?.name ?? code)}
      emptyMessage="当前可共享设置一致；本地正文不参与比较。" /></> : null}
  </section>;
}
