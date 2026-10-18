'use client';

import { generationActionClassNames } from '../generation-actions';

/** Controlled confirmation only: callers freeze and recheck source, authority and proposals. */
export function RoomGenerationStartConfirmButton({ disabled, onConfirm, retry = false }: {
  disabled: boolean; onConfirm: () => void; retry?: boolean;
}) {
  return <button type="button" className={generationActionClassNames.primary} disabled={disabled} onClick={onConfirm}>
    {retry ? '确认以原请求重试' : '确认按当前配置开始'}
  </button>;
}

export function RoomGenerationPendingProposalsWarning({ count }: { count: number }) {
  return count > 0 ? <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 font-medium text-red-900">
    当前还有 {count} 个待处理提案；继续生成不会应用这些提案。
  </p> : null;
}
