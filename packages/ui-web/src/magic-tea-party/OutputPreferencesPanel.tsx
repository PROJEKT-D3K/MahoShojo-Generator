'use client';

import type { ReactNode } from 'react';
import type { MagicTeaPartyChoiceCount, MagicTeaPartyOutputPlan, MagicTeaPartyOutputPlanMode, MagicTeaPartyPreferences, MagicTeaPartySession } from '@mahoshojo/domain/magic-tea-party/types';

export type MagicTeaPartyOutputPreferencesPatch = Partial<Pick<MagicTeaPartyPreferences,
  'userDisplayName' | 'outputFormat' | 'outputPlan' | 'language' | 'enableChoices' | 'choiceCount'>>;

export type MagicTeaPartyOutputPreferencesPanelProps = {
  activeSession: MagicTeaPartySession | null;
  preferences: MagicTeaPartyPreferences;
  onChange: (patch: MagicTeaPartyOutputPreferencesPatch) => void;
  disabled?: boolean;
  outputPlanSupported?: boolean;
  choicesHint?: ReactNode;
};

const CHOICE_COUNT_MIN = 2;
const CHOICE_COUNT_MAX = 16;
const clampChoiceCount = (value: number, fallback: MagicTeaPartyChoiceCount): MagicTeaPartyChoiceCount => {
  if (!Number.isFinite(value)) return fallback;
  const clamped = Math.max(CHOICE_COUNT_MIN, Math.min(CHOICE_COUNT_MAX, Math.floor(value)));
  return clamped as MagicTeaPartyChoiceCount;
};

export function MagicTeaPartyOutputPreferencesPanel({ activeSession, preferences, onChange, disabled = false, outputPlanSupported = false, choicesHint }: MagicTeaPartyOutputPreferencesPanelProps) {
  const currentUserDisplayName = activeSession?.settings.userDisplayName ?? preferences.userDisplayName;
  const currentOutputFormat = activeSession?.settings.outputFormat ?? preferences.outputFormat;
  const currentOutputPlan = activeSession?.settings.outputPlan ?? preferences.outputPlan;
  const currentLanguage = activeSession?.settings.language ?? preferences.language;
  const currentEnableChoices = activeSession?.settings.enableChoices ?? preferences.enableChoices;
  const currentChoiceCount = activeSession?.settings.choiceCount ?? preferences.choiceCount;
  const choiceCountValue = clampChoiceCount(currentChoiceCount, preferences.choiceCount);
  const applyChange = (patch: MagicTeaPartyOutputPreferencesPatch) => {
    if (!disabled) onChange(patch);
  };
  const handleChoiceCountChange = (nextValue: number) => {
    const choiceCount = clampChoiceCount(nextValue, choiceCountValue);
    applyChange({ choiceCount });
  };
  return (
      <fieldset disabled={disabled} className="min-w-0 rounded-xl border border-pink-100 bg-white p-4 space-y-3">
        <div className="text-sm font-semibold text-gray-800">输出偏好</div>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <label className="text-xs font-semibold text-gray-600">你的称呼（{'{{user}}'}）</label>
            <input
              className="input-field"
              value={currentUserDisplayName}
              onChange={(event) => {
                const raw = event.target.value.trim();
                let end = 20;
                if (raw.charCodeAt(end - 1) >= 0xd800 && raw.charCodeAt(end - 1) <= 0xdbff
                  && raw.charCodeAt(end) >= 0xdc00 && raw.charCodeAt(end) <= 0xdfff) end -= 1;
                const value = raw.slice(0, end);
                applyChange({ userDisplayName: value });
              }}
              placeholder="例如：旅人 / 记者 / 观众"
            />
          </div>

          <div className="grid gap-1">
            <label className="text-xs font-semibold text-gray-600">输出模式</label>
            <div className="flex items-center space-x-1 rounded-full bg-gray-200 p-1">
              {([
                { key: 'jsonl', label: 'JSONL', activeClass: 'text-sky-700' },
                { key: 'markdown', label: 'Markdown', activeClass: 'text-emerald-700' },
              ] as const).map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => {
                    const value = option.key;
                    applyChange({ outputFormat: value });
                  }}
                  className={`w-1/2 rounded-full py-2 text-sm font-semibold transition-colors duration-300 ${
                    currentOutputFormat === option.key
                      ? `bg-white shadow ${option.activeClass}`
                      : 'text-gray-600 hover:bg-gray-300'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {outputPlanSupported ? (
          <div className="rounded-lg border border-pink-100 bg-pink-50/60 px-3 py-2 text-xs text-gray-600">
            <div className="text-xs font-semibold text-gray-600">合并输出计划</div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <div className="grid gap-1">
                <label className="text-[11px] text-gray-600">选项</label>
                <select
                  className="input-field !h-8 !py-1 text-xs"
                  value={currentOutputPlan.choices}
                  onChange={(event) => {
                    const value = event.target.value as 'off' | 'auto' | 'on';
                    const outputPlan = { ...currentOutputPlan, choices: value };
                    const enableChoices = value !== 'off';
                    applyChange({ outputPlan, enableChoices });
                  }}
                >
                  <option value="off">关闭</option>
                  <option value="auto">自动</option>
                  <option value="on">强制</option>
                </select>
              </div>
              <div className="grid gap-1">
                <label className="text-[11px] text-gray-600">摘要</label>
                <select
                  className="input-field !h-8 !py-1 text-xs"
                  value={currentOutputPlan.summary}
                  onChange={(event) => {
                    const value = event.target.value as 'off' | 'auto' | 'on';
                    const outputPlan = { ...currentOutputPlan, summary: value };
                    applyChange({ outputPlan });
                  }}
                >
                  <option value="off">关闭</option>
                  <option value="auto">自动</option>
                  <option value="on">强制</option>
                </select>
              </div>
              <div className="grid gap-1">
                <label className="text-[11px] text-gray-600">更新草案</label>
                <select
                  className="input-field !h-8 !py-1 text-xs"
                  value={currentOutputPlan.updates}
                  onChange={(event) => {
                    const value = event.target.value as 'off' | 'auto' | 'on';
                    const outputPlan = { ...currentOutputPlan, updates: value };
                    applyChange({ outputPlan });
                  }}
                >
                  <option value="off">关闭</option>
                  <option value="auto">自动</option>
                  <option value="on">强制</option>
                </select>
              </div>
            </div>
            <div className="mt-2 text-[11px] text-gray-500">Markdown 模式下仅“强制”会自动补生成（额外调用，消耗更多 Tokens）。</div>
          </div>
          ) : null}

          <div className="grid gap-1">
            <label className="text-xs font-semibold text-gray-600">语言</label>
            <select
              className="input-field"
              value={currentLanguage}
              onChange={(event) => {
                const value = event.target.value as MagicTeaPartyPreferences['language'];
                applyChange({ language: value });
              }}
            >
              <option value="zh-CN">中文</option>
              <option value="ja-JP">日本語</option>
              <option value="en-US">English</option>
            </select>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-gray-600">启用选项</div>
              {choicesHint ? <div className="text-xs text-gray-500">{choicesHint}</div> : null}
            </div>
            <input
              type="checkbox"
              checked={Boolean(currentEnableChoices)}
              onChange={(event) => {
                const enableChoices = Boolean(event.target.checked);
                const choices: MagicTeaPartyOutputPlanMode = enableChoices
                  ? (currentOutputPlan.choices === 'off' ? 'auto' : currentOutputPlan.choices)
                  : 'off';
                const outputPlan: MagicTeaPartyOutputPlan = { ...currentOutputPlan, choices };
                applyChange(outputPlanSupported ? { enableChoices, outputPlan } : { enableChoices });
              }}
            />
          </div>

          <div className="grid gap-1">
            <label className="text-xs font-semibold text-gray-600">选项数量</label>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="h-8 w-8 shrink-0 rounded-md border border-pink-100 bg-white text-sm font-semibold text-gray-700 shadow-sm hover:bg-pink-50 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => handleChoiceCountChange(choiceCountValue - 1)}
                disabled={choiceCountValue <= CHOICE_COUNT_MIN}
                aria-label="减少选项数量"
              >
                -
              </button>
              <input
                type="range"
                min={CHOICE_COUNT_MIN}
                max={CHOICE_COUNT_MAX}
                step={1}
                value={choiceCountValue}
                onChange={(event) => handleChoiceCountChange(Number(event.target.value))}
                className="h-2 min-w-0 flex-1 cursor-pointer rounded-lg bg-pink-100 accent-pink-500"
                aria-label="选项数量滑块"
              />
              <button
                type="button"
                className="h-8 w-8 shrink-0 rounded-md border border-pink-100 bg-white text-sm font-semibold text-gray-700 shadow-sm hover:bg-pink-50 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => handleChoiceCountChange(choiceCountValue + 1)}
                disabled={choiceCountValue >= CHOICE_COUNT_MAX}
                aria-label="增加选项数量"
              >
                +
              </button>
              <input
                type="number"
                min={CHOICE_COUNT_MIN}
                max={CHOICE_COUNT_MAX}
                step={1}
                className="input-field !h-8 !w-16 !px-2 !py-1 text-center text-xs shrink-0"
                value={String(choiceCountValue)}
                onChange={(event) => handleChoiceCountChange(Number(event.target.value))}
              />
            </div>
            <div className="text-[11px] text-gray-500">范围 2~16</div>
          </div>
        </div>
      </fieldset>
  );
}
