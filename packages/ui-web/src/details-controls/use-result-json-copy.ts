import { useEffect, useMemo, useRef, useState } from 'react';

import { copyTextToClipboard } from '../client/clipboard';

type ResultJsonCopyStatus = 'idle' | 'success' | 'error';

/** 结果替换、模式切换和更新的点击同时隔离 fallback、反馈与延时清理。 */
export function useResultJsonCopy(data: unknown, {
  enabled = true,
  jsonPayload,
  onResult,
}: { enabled?: boolean; jsonPayload?: string; onResult?: (copied: boolean) => void } = {}) {
  const generation = useMemo(() => ({ data, enabled, jsonPayload }), [data, enabled, jsonPayload]);
  const currentGeneration = useRef(generation);
  currentGeneration.current = generation;
  const mounted = useRef(true);
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [feedback, setFeedback] = useState<{ generation: object; status: ResultJsonCopyStatus } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [generation]);

  const copyJson = async (): Promise<void> => {
    if (!enabled || !mounted.current || currentGeneration.current !== generation) return;
    const request = ++sequence.current;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const isCurrent = () => mounted.current && currentGeneration.current === generation && sequence.current === request;
    setFeedback(null);
    let copied = false;
    // 已派发的原生 writeText 无法撤销；失效意图只阻止后续 fallback 和界面反馈。
    try {
      // 文本保存模式复用界面上已经展示的 JSON；独立按钮只在点击时序列化。
      const text = jsonPayload ?? JSON.stringify(data, null, 2);
      if (typeof text === 'string') copied = await copyTextToClipboard(text, isCurrent);
    } catch { /* 序列化或复制失败不影响结果展示。 */ }
    if (!isCurrent()) return;
    setFeedback({ generation, status: copied ? 'success' : 'error' });
    timer.current = setTimeout(() => {
      if (isCurrent()) setFeedback(null);
      timer.current = null;
    }, copied ? 2_000 : 2_500);
    onResult?.(copied);
  };

  return { copyJson, copyStatus: feedback?.generation === generation ? feedback.status : 'idle' as ResultJsonCopyStatus };
}
