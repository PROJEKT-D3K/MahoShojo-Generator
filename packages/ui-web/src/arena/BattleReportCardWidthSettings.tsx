'use client';

import { useId } from 'react';
import {
  BATTLE_REPORT_CARD_WIDTH_MAX,
  BATTLE_REPORT_CARD_WIDTH_MIN,
  BATTLE_REPORT_CARD_WIDTH_PRESETS,
  normalizeBattleReportCardWidthMode,
  normalizeBattleReportCardWidthPx,
  resolveBattleReportCardPresetWidth,
  type BattleReportCardWidthSettingsValue,
} from './battle-report-card-width';

export type BattleReportCardWidthSettingsProps = {
  value: BattleReportCardWidthSettingsValue;
  onChange: (patch: Partial<BattleReportCardWidthSettingsValue>) => void;
  disabled?: boolean;
};

export function BattleReportCardWidthSettings({ value, onChange, disabled }: BattleReportCardWidthSettingsProps) {
  const id = useId();
  const widthMode = normalizeBattleReportCardWidthMode(value.battleReportCardWidthMode);
  const widthPx = normalizeBattleReportCardWidthPx(value.battleReportCardWidthPx);
  const matchedPresetWidth = resolveBattleReportCardPresetWidth(widthPx);

  return (
    <div className="input-group">
      <div id={`${id}-label`} className="input-label">战报卡片宽度</div>
      <fieldset aria-labelledby={`${id}-label`} className="min-w-0 border border-(--app-border) rounded-lg p-3">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex items-start gap-2 rounded-lg border border-(--app-border) bg-(--app-surface) p-3 text-sm text-(--app-text-muted)">
            <input
              type="radio"
              name={`${id}-mode`}
              className="mt-0.5 h-4 w-4 border-(--app-input-border) accent-(--app-accent-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--app-accent-strong)"
              aria-label="自动宽度"
              checked={widthMode === 'auto'}
              onChange={() => onChange({ battleReportCardWidthMode: 'auto' })}
              disabled={disabled}
            />
            <span className="block font-semibold text-(--app-text)">自动宽度</span>
          </label>

          <label className="flex items-start gap-2 rounded-lg border border-(--app-border) bg-(--app-surface) p-3 text-sm text-(--app-text-muted)">
            <input
              type="radio"
              name={`${id}-mode`}
              className="mt-0.5 h-4 w-4 border-(--app-input-border) accent-(--app-accent-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--app-accent-strong)"
              aria-label="手动指定宽度"
              checked={widthMode === 'manual'}
              onChange={() =>
                onChange({
                  battleReportCardWidthMode: 'manual',
                  battleReportCardWidthPx: widthPx,
                })
              }
              disabled={disabled}
            />
            <span className="block font-semibold text-(--app-text)">手动指定宽度</span>
          </label>
        </div>

        {widthMode === 'manual' && (
          <div className="mt-4 space-y-3">
            <div>
              <div className="text-xs font-semibold text-(--app-text-muted)">快速预设</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {BATTLE_REPORT_CARD_WIDTH_PRESETS.map((preset) => {
                  const isActive = matchedPresetWidth === preset.widthPx;
                  return (
                    <button
                      key={preset.widthPx}
                      aria-pressed={isActive}
                      type="button"
                      onClick={() => onChange({ battleReportCardWidthPx: preset.widthPx })}
                      disabled={disabled}
                      className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--app-accent-strong) disabled:cursor-not-allowed disabled:opacity-60 ${
                        isActive
                          ? 'border-(--app-accent-strong) bg-(--app-surface-80) text-(--app-text)'
                          : 'border-(--app-border) bg-(--app-surface) text-(--app-text-muted) hover:bg-(--app-surface-80)'
                      }`}
                    >
                      <span className="block font-semibold">
                        {preset.label} · {preset.widthPx}px
                      </span>
                      <span className="mt-0.5 block text-xs text-(--app-text-subtle)">{preset.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label htmlFor={`${id}-width`} className="block text-xs font-semibold text-(--app-text-muted)">自定义宽度（px）</label>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <input
                  id={`${id}-width`}
                  aria-label="自定义宽度（px）"
                  aria-describedby={`${id}-range`}
                  type="number"
                  min={BATTLE_REPORT_CARD_WIDTH_MIN}
                  max={BATTLE_REPORT_CARD_WIDTH_MAX}
                  step={10}
                  inputMode="numeric"
                  className="input-field w-32"
                  value={widthPx}
                  onChange={(event) =>
                    onChange({
                      battleReportCardWidthPx: normalizeBattleReportCardWidthPx(Number(event.target.value)),
                    })
                  }
                  disabled={disabled}
                />
                <span id={`${id}-range`} className="text-xs text-(--app-text-subtle)">
                  可选范围：{BATTLE_REPORT_CARD_WIDTH_MIN}px - {BATTLE_REPORT_CARD_WIDTH_MAX}px
                </span>
              </div>
            </div>

          </div>
        )}
      </fieldset>
    </div>
  );
}
