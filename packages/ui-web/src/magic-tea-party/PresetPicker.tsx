'use client';

import { MAGIC_TEA_PARTY_PRESETS, type MagicTeaPartyPresetId, type MagicTeaPartyPresetProjection } from '@mahoshojo/ai-core/magic-tea-party';

export type MagicTeaPartyPresetPickerProps = {
  selectedPresetId?: string | null;
  onCreateSession: (presetId: MagicTeaPartyPresetId | null) => void;
  /** Requests a preview; the host must not persist until its confirmation flow completes. */
  onSelectPreset?: (presetId: MagicTeaPartyPresetId) => void;
  preview?: MagicTeaPartyPresetProjection | null;
  onConfirmPreset?: () => void;
  onCancelPreset?: () => void;
  disabled?: boolean;
};

export function MagicTeaPartyPresetPicker({ selectedPresetId, onCreateSession, onSelectPreset, preview,
  onConfirmPreset, onCancelPreset, disabled = false }: MagicTeaPartyPresetPickerProps) {
  return (
    <fieldset disabled={disabled} className="min-w-0 rounded-xl border border-pink-100 bg-white p-4 space-y-3">
      <legend className="text-sm font-semibold text-gray-800">预设情景</legend>
      <div className="text-xs text-gray-600">新建会话</div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="rounded-lg border border-pink-200 px-3 py-2 text-xs hover:bg-pink-50"
          onClick={() => { if (!disabled) onCreateSession(null); }}>新建普通茶会</button>
        {MAGIC_TEA_PARTY_PRESETS.map(preset => (
          <button key={preset.id} type="button" className="rounded-lg border border-pink-200 px-3 py-2 text-xs hover:bg-pink-50"
            onClick={() => { if (!disabled) onCreateSession(preset.id); }}>新建{preset.title}</button>
        ))}
      </div>
      {onSelectPreset ? <>
        <div className="text-xs text-gray-600">当前会话预设，选择后预览并确认</div>
        <div className="grid gap-2">
          {MAGIC_TEA_PARTY_PRESETS.map(preset => {
            const selected = selectedPresetId === preset.id;
            return (
              <button key={preset.id} type="button" aria-pressed={selected}
                className={`rounded-xl border px-4 py-3 text-left transition-colors ${selected ? 'border-pink-300 bg-pink-50 text-pink-800' : 'border-pink-200 bg-white hover:bg-pink-50'}`}
                onClick={() => { if (!disabled) onSelectPreset(preset.id); }}
                title={selected ? '再次点击可取消预设' : '预览并应用预设'}>
                <span className="flex items-start justify-between gap-2">
                  <span className="text-sm font-semibold text-pink-800">{preset.title}</span>
                  {selected ? <span className="text-[10px] font-semibold text-pink-600">已选</span> : null}
                </span>
                <span className="mt-1 block text-xs text-gray-600">{preset.description}</span>
              </button>
            );
          })}
        </div>
      </> : null}
      {preview ? (
        <div role="region" aria-label="预设变更预览" aria-live="polite" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-gray-700 space-y-2">
          <div className="font-semibold">{preview.action === 'remove' ? '取消' : '应用'}「{preview.preset.title}」</div>
          {preview.action === 'apply' ? <ul className="list-disc space-y-1 pl-4">
            <li>风格改为「{preview.preset.title}」，启用 A.R.E.N.A. 世界书。</li>
            <li>输出改为 {preview.patch.settings.outputFormat === 'jsonl' ? 'JSONL' : 'Markdown'}，{preview.patch.settings.enableChoices ? `启用 ${preview.patch.settings.choiceCount} 个行动选项（${preview.patch.settings.outputPlan?.choices === 'on' ? '每轮必须输出' : '必要时输出'}）` : '关闭行动选项'}。</li>
            <li>主情景替换为「{preview.patch.scenario?.title}」，清空所有辅助情景。</li>
          </ul> : <ul className="list-disc space-y-1 pl-4">
            <li>停止使用预设风格和预设世界书。</li>
            <li>移除预设主情景和预设辅助情景，保留手动添加的情景。</li>
            <li>输出格式和行动选项设置保持不变。</li>
          </ul>}
          <div>角色、聊天历史、摘要和输入草稿保持不变。</div>
          <div className="flex gap-2">
            {onConfirmPreset ? <button type="button" className="rounded-lg bg-pink-600 px-3 py-2 text-white"
              onClick={() => { if (!disabled) onConfirmPreset(); }}>{preview.action === 'remove' ? '确认取消预设' : '确认应用预设'}</button> : null}
            {onCancelPreset ? <button type="button" className="rounded-lg border border-gray-300 px-3 py-2"
              onClick={() => { if (!disabled) onCancelPreset(); }}>返回，不更改</button> : null}
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}
