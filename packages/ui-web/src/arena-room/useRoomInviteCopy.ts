'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { copyTextToClipboard } from '../client/clipboard';
import type { RoomInviteCopyStatus } from './RoomInviteShareButton';

export type RoomInviteCopyIntent = {
  readonly text: string;
  /** 宿主捕获的账号、Document 与房间代次仍有效；不能用相同显示 ID 续签。 */
  readonly isCurrent: () => boolean;
};
export type RoomInviteCopyOptions = {
  readonly scope: unknown;
  readonly prepare: () => RoomInviteCopyIntent | null;
};

/** 只在明确点击时写剪贴板；反馈和延时清理共用同一意图围栏。 */
export function useRoomInviteCopy({ scope, prepare }: RoomInviteCopyOptions) {
  const generation = useMemo(() => ({ scope }), [scope]);
  const currentGeneration = useRef(generation);
  currentGeneration.current = generation;
  const sequence = useRef(0);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [feedback, setFeedback] = useState<{ generation: object; status: RoomInviteCopyStatus; isCurrent: () => boolean } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current += 1; if (timer.current) clearTimeout(timer.current); };
  }, []);
  useEffect(() => () => {
    sequence.current += 1;
    if (timer.current) clearTimeout(timer.current);
  }, [generation]);

  const copy = async (): Promise<void> => {
    const intent = prepare();
    if (!intent?.isCurrent()) return;
    const request = ++sequence.current;
    if (timer.current) clearTimeout(timer.current);
    const isCurrent = () => mounted.current && currentGeneration.current === generation
      && sequence.current === request && intent.isCurrent();
    if (!isCurrent()) return;
    setFeedback({ generation, status: 'copying', isCurrent });
    let ok = false;
    try { ok = await copyTextToClipboard(intent.text, isCurrent); } catch { /* 失败仅投影给仍持有本次意图的宿主。 */ }
    if (!isCurrent()) return;
    setFeedback({ generation, status: ok ? 'copied' : 'error', isCurrent });
    timer.current = setTimeout(() => {
      if (isCurrent()) setFeedback(null);
    }, 2_000);
  };
  return { status: feedback?.generation === generation && feedback.isCurrent() ? feedback.status : 'idle' as RoomInviteCopyStatus, copy };
}
