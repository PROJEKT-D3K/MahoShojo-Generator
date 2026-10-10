'use client';

import { BaseModal } from '../modal';
import { BattleStoryActions } from './views';

export type BattleStoryDeleteSessionTargetView = { sessionId: string; title: string; chapterCount: number };
export type BattleStoryDeleteSessionControlsProps = {
  target: BattleStoryDeleteSessionTargetView | null;
  open?: boolean;
  disabledReason?: string | null;
  preparing?: boolean;
  busy?: boolean;
  mode?: 'confirm' | 'unknown';
  message?: string | null;
  onRequest(): void;
  onCancel(): void;
  onConfirm(): void;
  onExport(): void;
  onObserve?(): void;
};

/** A shared explicit confirmation; hosts own the frozen identity and every local effect. */
export function BattleStoryDeleteSessionControls(props: BattleStoryDeleteSessionControlsProps) {
  const safe = 'rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60';
  const danger = 'rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60';
  const close = () => { if (!props.busy) props.onCancel(); };
  return <>
    <button type="button" className={danger} disabled={!!props.disabledReason || props.preparing || props.busy || !!props.target}
      title={props.disabledReason ?? (props.target ? '请先只读核对上一个删除状态，再删除其它会话' : '明确确认后删除一个完整的本机会话')} onClick={props.onRequest}>
      {props.preparing ? '正在核对本机会话…' : '删除本机会话'}
    </button>
    {props.target && props.mode === 'unknown' && props.open === false ? <div role="status" className="w-full rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p>《{props.target.title}》的删除状态待确认。请先只读核对原会话，再继续操作这个会话；其它会话仍可正常使用。</p>
      {props.message ? <p>{props.message}</p> : null}
      <button type="button" className={safe} disabled={props.busy || !props.onObserve} onClick={props.onObserve}>只读核对当前状态</button>
    </div> : null}
    <BaseModal isOpen={props.target !== null && props.open !== false} title={props.mode === 'unknown' ? '删除状态待确认' : '删除本机会话'}
      onClose={close} closeOnBackdrop={!props.busy} maxWidthClassName="max-w-lg"
      footer={<BattleStoryActions>
        <button type="button" className={safe} disabled={props.busy} onClick={close}>返回</button>
        {props.mode === 'unknown' ? <button type="button" className={safe} disabled={props.busy || !props.onObserve} onClick={props.onObserve}>只读核对当前状态</button> : <>
          <button type="button" className={safe} disabled={props.busy} onClick={props.onExport}>先导出</button>
          <button type="button" className={danger} disabled={props.busy || !!props.disabledReason} onClick={props.onConfirm}>{props.busy ? '正在删除…' : '确认删除本机会话'}</button>
        </>}
      </BattleStoryActions>}>
      {props.target ? <div className="space-y-3 text-sm">
        <p className="font-semibold break-words">{props.target.title}</p>
        <p className="break-all text-xs text-gray-500">会话：{props.target.sessionId}｜共 {props.target.chapterCount} 章</p>
        <p>删除整个本机会话，包括它自己的全部章节、状态快照和章内保存回执。其它已复制的分支、源数据卡、服务器记录、已有备份和导出文件不受影响。</p>
        <p>此操作无法在故事页撤销。它不是安全擦除，也不保证存储文件立即缩小；恢复以前的整库备份可能重新带回故事。</p>
        {props.mode === 'unknown' ? <p>只核对原会话目前是否存在，不会再次删除或生成。确认目前不存在，不代表证明某一次删除恰好成功。</p> : null}
        {props.disabledReason ? <p role="status">{props.disabledReason}</p> : null}
        {props.message ? <p role="status">{props.message}</p> : null}
      </div> : null}
    </BaseModal>
  </>;
}
