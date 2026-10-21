'use client';
import type { ReactNode } from 'react';
import { CollapsibleSection } from '../creator/CollapsibleSection';

/** Hosts own drafts, confirmations and execution; this view never calls a provider. */
export function CombatantRepairPanel({ draft, onDraftChange, onApply, disabled, applying, applied, error, notice, aiControls, storageKey }: {
  draft: string; onDraftChange: (value: string) => void; onApply: () => void;
  disabled?: boolean; applying?: boolean; applied?: boolean; error?: string | null; notice?: string | null;
  aiControls?: ReactNode; storageKey?: string;
}) {
  return <CollapsibleSection title="自定义修复本次角色变化"
    description={`${aiControls ? 'AI 只生成可编辑草稿；' : ''}应用后会得到 unsigned、non-canonical 的当前会话副本`}
    defaultOpen={false} keepMounted="after-open" storageKey={storageKey} variant="panel">
    <div className="space-y-3 text-sm text-gray-700">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
        修复原生角色或 preset/DataCard 时，会创建非原生可编辑版本；服务器不会重新签名，源角色也不会被自动覆盖。
      </div>
      {applied && <div className="rounded-lg border border-purple-200 bg-purple-50 p-3 text-purple-800">
        当前 roster 已应用本次自定义修复。同 generation 的服务器权威重试已禁用；生成新战报后会恢复。
      </div>}
      {aiControls}
      <label className="block"><span className="mb-1 block font-medium text-gray-700">手动编辑修复草稿</span>
        <textarea aria-label="手动编辑修复草稿" value={draft} onChange={event => onDraftChange(event.target.value)} rows={12} spellCheck={false} disabled={disabled || applying}
          className="w-full rounded-lg border border-gray-300 bg-white p-3 font-mono text-xs leading-5 text-gray-800 outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
          placeholder={'{"impacts":[{"combatantIndex":0,"characterName":"角色名","impact":"修复后的历战影响"}]}'} />
      </label>
      <div className="text-xs text-gray-500">可只提交需要修改的角色。重名角色必须保留 combatantIndex；也可粘贴 MAHOSHOJO_ARENA_META 内容。</div>
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-green-700">{notice}</div>}
      <div className="flex justify-end"><button type="button" onClick={onApply} disabled={disabled || applying || !draft.trim()}
        className="rounded-lg bg-purple-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-60">{applying ? '应用中...' : '应用修复'}</button></div>
    </div>
  </CollapsibleSection>;
}
