'use client';

import { confirmDeferredPageReload, isDeferredChunkError } from '@/lib/client/loadDeferredModule';
import { Button } from './ui/Button';

export function DeferredChunkRecovery({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <div className="space-y-2 text-sm">
    <p>{isDeferredChunkError(error)
      ? '功能资源未能载入，可能是网络问题，或页面打开后网站已更新。重试仍失败时，可保存内容后刷新页面再试。'
      : '页面其他内容仍可继续使用。若重试后仍失败，可保存需要保留的内容后再刷新。'}</p>
    <p>刷新会中断生成或多人会话，并可能丢失未保存的输入；请先停止或等待任务完成，并保存、导出所需内容。</p>
    <div className="flex flex-wrap gap-2">
      {onRetry ? <Button size="sm" onClick={onRetry}>重试加载</Button> : null}
      <Button size="sm" variant="danger" onClick={() => confirmDeferredPageReload()}>刷新页面</Button>
    </div>
  </div>;
}
