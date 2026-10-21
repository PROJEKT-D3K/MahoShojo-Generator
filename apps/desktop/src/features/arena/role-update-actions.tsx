import { useCallback, useEffect, useRef, useState } from 'react';
import { DesktopCloudCardActions } from '../cloud-save/private-result-save';
import type { InvokeFn } from '../../platform/cloud-bridge';
import type { ArenaCharacterSaveSelection, DesktopArenaSession } from './session';

/** Arena 页面内的表单/请求寿命；旧表单清理不得释放尚在 Native 中的请求。 */
export function useArenaResultActionLocks(invoke: InvokeFn) {
  const intents = useRef(new Set<symbol>()), requests = useRef(new Set<symbol>()), forms = useRef(new Set<symbol>());
  const mounted = useRef(true);
  const [, render] = useState(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const changed = useCallback(() => { if (mounted.current) render(value => value + 1); }, []);
  const isBusy = useCallback(() => requests.current.size > 0 || forms.current.size > 0, []);
  const isSourceLocked = useCallback(() => intents.current.size > 0 || requests.current.size > 0 || forms.current.size > 0, []);
  const retainSourceIntent = useCallback(() => {
    const ticket = Symbol(); intents.current.add(ticket); changed();
    return () => { intents.current.delete(ticket); changed(); };
  }, [changed]);
  const setFormBusy = useCallback((ticket: symbol, value: boolean) => {
    if (value) forms.current.add(ticket); else forms.current.delete(ticket);
    changed();
  }, [changed]);
  const invokeTracked = useCallback<InvokeFn>(async (command, args) => {
    const ticket = Symbol(); requests.current.add(ticket); changed();
    try { return await invoke(command, args); }
    finally { requests.current.delete(ticket); changed(); }
  }, [invoke, changed]);
  return { busy: isBusy(), sourceLocked: isSourceLocked(), isBusy, isSourceLocked, retainSourceIntent, setFormBusy, invokeTracked };
}

type ResultLocks = ReturnType<typeof useArenaResultActionLocks>;
export function DesktopArenaRoleUpdateActions({ data, selection, repairSelection, session, locks, disabled, isBlocked, guard, onDownload }: {
  data: Record<string, unknown>;
  selection: ArenaCharacterSaveSelection | null;
  repairSelection?: ArenaCharacterSaveSelection | null;
  session: Pick<DesktopArenaSession, 'canSaveCharacter' | 'saveCharacter'> & Partial<Pick<DesktopArenaSession, 'canSaveRepairedCharacter' | 'saveRepairedCharacters'>>;
  locks: ResultLocks;
  disabled: boolean;
  isBlocked: () => boolean;
  guard: { ready: boolean; message: string | null };
  onDownload: () => void;
}) {
  const ticket = useRef(Symbol());
  const onBusyChange = useCallback((value: boolean) => locks.setFormBusy(ticket.current, value), [locks.setFormBusy]);
  const cloudBlocked = () => isBlocked() || locks.isBusy();
  return <div className="mt-2 space-y-2">
    <div className="flex flex-wrap justify-end gap-2">
      <button type="button" className="shrink-0 rounded-lg bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-600" onClick={onDownload}>下载更新设定</button>
      {repairSelection && session.canSaveRepairedCharacter?.(repairSelection) ? <button type="button" className="random-button" disabled={disabled || locks.sourceLocked}
        onClick={() => { if (!isBlocked() && !locks.isSourceLocked()) void session.saveRepairedCharacters?.(repairSelection); }}>另存此修复副本到本地库</button> : null}
      {selection && session.canSaveCharacter(selection) ? <button type="button" className="random-button" disabled={disabled || locks.sourceLocked}
        onClick={() => { if (!isBlocked() && !locks.isSourceLocked()) void session.saveCharacter(selection); }}>另存此角色到本地库</button> : null}
    </div>
    <DesktopCloudCardActions data={data} cardType="character" presentation="generation-result"
      disabled={disabled || locks.busy} isBlocked={cloudBlocked} invokeFn={locks.invokeTracked}
      retainSourceIntent={locks.retainSourceIntent} externalLeaveGuard={guard} onBusyChange={onBusyChange} />
  </div>;
}
