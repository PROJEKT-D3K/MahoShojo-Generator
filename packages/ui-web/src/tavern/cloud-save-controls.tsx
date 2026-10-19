import { formatKilobytes, MAX_DATA_CARD_BYTES } from '@mahoshojo/domain/data-card-size';
import type { TavernCloudSaveBuildResult, TavernCloudSavePreset } from '@mahoshojo/domain/tavern-card/cloud';

export interface TavernCloudSaveControlsProps {
  preset: TavernCloudSavePreset;
  onPresetChange: (preset: TavernCloudSavePreset) => void;
  preview: TavernCloudSaveBuildResult | { error: string } | null;
  disabled?: boolean;
}

const presets: readonly { value: TavernCloudSavePreset; label: string }[] = [
  { value: 'standard', label: '标准' },
  { value: 'light', label: '轻量' },
  { value: 'minimal', label: '极简' },
];

/** Presentation only: author, payload, save authority and original data remain host-owned. */
export function TavernCloudSaveControls({ preset, onPresetChange, preview, disabled }: TavernCloudSaveControlsProps) {
  return <div className="rounded-xl border border-pink-100 bg-white/60 p-3">
    <div className="text-sm font-semibold text-pink-700">保存到档案馆（可选）</div>
    <div role="group" aria-label="云端保存预设" className="mt-2 grid gap-2 md:grid-cols-3">
      {presets.map((option) => <button key={option.value} type="button" disabled={disabled}
        aria-pressed={preset === option.value} onClick={() => onPresetChange(option.value)}
        className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition disabled:opacity-50 ${
          preset === option.value ? 'border-pink-300 bg-pink-50 text-pink-700 shadow-sm' : 'border-slate-200 text-slate-600 hover:border-pink-300 hover:text-pink-700'
        }`}>
        {option.label}
      </button>)}
    </div>
    <p className="mt-2 text-xs text-gray-600">
      云端副本始终不含 _tavern.raw，当前转换结果与本地原件不受影响。标准保留转换正文；轻量会按字段截断正文，极简还会清空对话样例并精简元数据。请明确选择可接受的内容损耗。
    </p>
    {preview ? <div className="mt-3 text-xs text-gray-600" aria-live="polite">
      {'error' in preview ? <div className="text-red-600">预估失败：{preview.error}</div> : <>
        <div>
          预估写入大小：{formatKilobytes(preview.estimatedBytes)}KB / {MAX_DATA_CARD_BYTES / 1024}KB
          {preview.overLimit ? <span className="ml-2 font-semibold text-red-600">超限</span> : null}
        </div>
        <p className="mt-1">预估包含作者信息；实际保存仍受服务端大小、配额与权限校验约束。</p>
        {preview.warnings.length > 0 ? <ul className="mt-2 list-disc space-y-1 pl-5">
          {preview.warnings.map((warning, index) => <li key={`tavern-cloud-warning-${index}`}>{warning}</li>)}
        </ul> : null}
      </>}
    </div> : <div className="mt-3 text-xs text-gray-600">生成后会在此处显示体积预估与裁剪提示。</div>}
  </div>;
}
