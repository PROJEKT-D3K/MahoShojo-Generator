'use client';

import { useEffect, useRef } from 'react';
import { generationActionClassNames } from '../generation-actions';

export interface RoomGenerationCancelActionProps {
  confirmation: boolean; disabled: boolean; busy?: boolean;
  onRequest: () => void; onConfirm: () => void; onDismiss: () => void;
}
/** Hosts retain and recheck the frozen target and account identity. This view never chooses a target. */
export function RoomGenerationCancelAction({ confirmation, disabled, busy = false, onRequest, onConfirm, onDismiss }: RoomGenerationCancelActionProps) {
  const trigger = useRef<HTMLButtonElement>(null), confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmation) confirm.current?.focus(); }, [confirmation]);
  const dismiss = () => { onDismiss(); queueMicrotask(() => trigger.current?.focus()); };
  return <div>
    <button ref={trigger} type="button" className={generationActionClassNames.secondary} disabled={disabled || busy} onClick={onRequest}>停止当前生成</button>
    {confirmation ? <div role="alertdialog" aria-label="确认停止当前生成" className="mt-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-950 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(); } }}>
      <p>确定停止确认时选中的战报生成吗？只发送一次停止请求；结果未知时会读取核对，不会再次发送。</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button ref={confirm} type="button" className={generationActionClassNames.primary} disabled={disabled || busy} onClick={onConfirm}>确认停止生成</button>
        <button type="button" className={generationActionClassNames.secondary} onClick={dismiss}>取消</button>
      </div>
    </div> : null}
  </div>;
}
