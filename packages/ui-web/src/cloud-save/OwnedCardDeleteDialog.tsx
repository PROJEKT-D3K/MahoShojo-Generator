import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { BaseModal } from '../modal/BaseModal';
import { createOwnedCardDeleteController, type OwnedCardDeleteController, type OwnedCardDeletePort } from './owned-card-delete';

const labels = { character: '角色', scenario: '情景', history: '叙事历史', questionnaire: '问卷' };
export function useOwnedCardDelete(port: OwnedCardDeletePort | undefined, open: boolean) {
  const controller = useMemo(() => port ? createOwnedCardDeleteController(port) : null, [port]);
  const state = useSyncExternalStore(controller?.subscribe ?? (() => () => {}), controller?.getSnapshot ?? (() => null), controller?.getSnapshot ?? (() => null));
  useEffect(() => { if (!open) controller?.invalidate(); }, [controller, open]);
  useEffect(() => () => controller?.invalidate(), [controller]);
  return { controller, state, busy: state !== null && state.phase !== 'idle', refresh: state?.refresh ?? 0 };
}
export function OwnedCardDeleteDialog({ controller, onManageRecycle }: { controller: OwnedCardDeleteController | null; onManageRecycle?: () => void }) {
  const state = useSyncExternalStore(controller?.subscribe ?? (() => () => {}), controller?.getSnapshot ?? (() => null), controller?.getSnapshot ?? (() => null));
  if (!controller || !state || state.phase === 'idle') return null;
  const pending = state.phase === 'reading' || state.phase === 'writing';
  const permanent = state.phase === 'confirm-purge-active' || state.phase === 'confirm-purge-recycle';
  const targets = state.phase === 'confirm-purge-recycle' ? state.targets : state.active ? [state.active] : [];
  const cancel = () => { controller.cancel(); };
  const manage = () => { if (controller.cancel()) onManageRecycle?.(); };
  return <BaseModal key={state.phase} isOpen title={permanent ? '确认永久删除' : '删除数据卡'} onClose={cancel} closeButtonAriaLabel="取消" closeButtonContent="取消" closeOnBackdrop={!pending} zIndexClassName="z-[70]" maxWidthClassName="max-w-xl">
    {pending && <p role="status">{state.phase === 'reading' ? '正在核对完整删除清单…' : '正在处理，请等待结果…'}</p>}
    {state.message && <p role={state.phase === 'success' ? 'status' : 'alert'} className="mb-3 whitespace-pre-wrap">{state.message}</p>}
    {(state.phase === 'confirm-soft' || permanent) && <>
      <p className="mb-3">{permanent ? '以下数据卡及其关联记录将永久删除，无法撤销或从回收站恢复。请核对名称、类型与 ID。' : '确认将以下数据卡移入回收站？回收站满额时会停止，不会自动清理旧卡。'}</p>
      {state.phase === 'confirm-purge-recycle' && state.active && <p className="mb-3">这是账号全部类型的实际清空清单。清空成功后才会尝试把原卡「{state.active.name || '未命名'}」（{labels[state.active.type]}，ID {state.active.id.slice(0, 12)}{state.active.id.length > 12 ? '…' : ''}）移入回收站；原卡变化或回收站再次满额时会停止。</p>}
      <ul className="mb-4 space-y-2">{targets.map(target => <li key={target.id} className="break-words rounded border p-2">「{target.name || '未命名'}」 · {labels[target.type]} · ID {targets.some(other => other.id !== target.id && other.id.slice(0, 12) === target.id.slice(0, 12)) ? target.id : `${target.id.slice(0, 12)}${target.id.length > 12 ? '…' : ''}`}</li>)}</ul>
      <button type="button" className="rounded border px-3 py-2" onClick={cancel}>取消</button>{' '}
      <button type="button" className="rounded bg-red-600 px-3 py-2 text-white" onClick={() => void controller.confirm()}>{permanent ? state.active && state.phase === 'confirm-purge-recycle' ? '永久清空并继续' : '确认永久删除' : '移入回收站'}</button>
    </>}
    {state.phase === 'full' && <div className="flex flex-col items-start gap-3">
      <button type="button" onClick={cancel}>取消</button>
      <button type="button" onClick={controller.choosePurgeActive}>永久删除「{state.active?.name || '未命名'}」…</button>
      <button type="button" onClick={() => void controller.chooseClear()}>清空回收站并继续…</button>
      {onManageRecycle && <button type="button" onClick={manage}>整理回收站</button>}
    </div>}
    {['success', 'rejected', 'unknown'].includes(state.phase) && <button type="button" className="mt-4 rounded border px-3 py-2" onClick={cancel}>关闭</button>}
  </BaseModal>;
}
