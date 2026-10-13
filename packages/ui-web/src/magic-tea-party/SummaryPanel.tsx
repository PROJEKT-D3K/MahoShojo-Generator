'use client';

import type { ReactNode } from 'react';

export type MagicTeaPartySummaryBodyProps = {
  active: boolean;
  summary: string;
  updatedAt?: number;
  disabled: boolean;
  editingDisabled?: boolean;
  isSummarizing: boolean;
  hasMessages: boolean;
  error: string | null;
  description: ReactNode;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onGenerate: () => void;
  onClear: () => void;
  onChange: (summary: string) => void;
  onSave?: () => void;
  dirty?: boolean;
  collapsedDetails?: ReactNode;
  renderError?: (message: string) => ReactNode;
  children?: ReactNode;
};

/** The host owns drafts and writes. Web-only section/update tools remain a slot. */
export function MagicTeaPartySummaryBody(props: MagicTeaPartySummaryBodyProps) {
  const disabled = !props.active || props.disabled || props.isSummarizing;
  return <div className="rounded-xl border border-pink-100 bg-white p-4 space-y-3">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm font-semibold text-gray-800">会话摘要</div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {props.isSummarizing ? <div className="flex items-center gap-2 text-xs font-semibold text-pink-700">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-pink-200 border-t-pink-600" aria-hidden="true" /><span>生成中…</span>
        </div> : null}
        <button type="button" className="rounded-lg border border-pink-200 bg-white px-3 py-1.5 text-xs font-semibold text-pink-700 hover:bg-pink-50 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled || !props.hasMessages} onClick={props.onGenerate} title="生成摘要会消耗额外 Token">生成/更新摘要</button>
        {props.onSave ? <button type="button" className="rounded-lg border border-pink-200 bg-white px-3 py-1.5 text-xs font-semibold text-pink-700 hover:bg-pink-50 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled || !props.dirty} onClick={props.onSave}>保存摘要</button> : null}
        {props.summary ? <button type="button" className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled} onClick={props.onClear}>清空</button> : null}
        <button type="button" className="text-xs text-pink-700 hover:underline" onClick={() => props.onCollapsedChange(!props.collapsed)}>{props.collapsed ? '展开' : '收起'}</button>
      </div>
    </div>
    {props.collapsed ? <div className="space-y-1 text-xs text-gray-500">
      <div>{props.active ? <>{props.summary.trim() ? '已有摘要' : '暂无摘要'}{props.collapsedDetails}</> : '尚未选择会话。'}</div>
      {props.updatedAt ? <div>更新时间：{new Date(props.updatedAt).toLocaleString()}</div> : null}
      {props.error ? <div className="text-xs text-red-600">摘要错误：{props.error}</div> : null}
    </div> : <>
      <div className="text-xs text-gray-500">{props.description}</div>
      {props.error ? props.renderError?.(props.error) ?? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{props.error}</div> : null}
      <textarea aria-label="会话摘要正文" className="input-field h-32 resize-y" value={props.summary} onChange={event => props.onChange(event.target.value)}
        placeholder="还没有摘要。点击“生成/更新摘要”自动生成，或手动填写。" disabled={!props.active || (props.editingDisabled ?? disabled)} />
      {props.updatedAt ? <div className="text-xs text-gray-500">更新时间：{new Date(props.updatedAt).toLocaleString()}</div> : null}
      {props.children}
    </>}
  </div>;
}
