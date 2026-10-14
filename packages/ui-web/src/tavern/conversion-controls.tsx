import { useId, type ReactNode } from 'react';
import { GenerationModeSwitcher, type GenerationMode } from '../details-controls/GenerationModeSwitcher';

export type TavernConversionMode = 'rules' | 'ai';

export interface TavernConversionControlsProps {
  mode: TavernConversionMode;
  onModeChange: (mode: TavernConversionMode) => void;
  disabled?: boolean;
  aiDisabledReason?: string;
  aiDescription?: ReactNode;
  language: string;
  languages: readonly { code: string; name: string }[];
  onLanguageChange: (language: string) => void;
  languageExpanded: boolean;
  onLanguageExpandedChange: (expanded: boolean) => void;
  generationMode: GenerationMode;
  onGenerationModeChange: (mode: GenerationMode) => void;
  generationModeDescription?: ReactNode;
  generationModeDisabledReasons?: Partial<Record<GenerationMode, string>>;
  generationModeOptionDescriptions?: Partial<Record<GenerationMode, string>>;
  provider: ReactNode;
  providerFootnote?: ReactNode;
}

/** Controlled presentation only; the host owns capabilities, requests, preferences and cooldown. */
export function TavernConversionControls(props: TavernConversionControlsProps) {
  const id = useId();
  return <>
    <div className="mt-4">
      <label className="block text-sm font-semibold text-pink-700">转换模式</label>
      <div className="mt-2 grid gap-2">
        <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-pink-100 bg-white/80 p-3">
          <input type="radio" name="tavern-convert-mode" className="mt-1"
            checked={props.mode === 'rules'} onChange={() => props.onModeChange('rules')} disabled={props.disabled} />
          <div className="min-w-0">
            <div className="text-sm text-gray-900">规则映射（不调用 AI）</div>
            <div className="mt-1 text-xs text-gray-600">稳定、可解释、不会发起网络请求。</div>
          </div>
        </label>
        <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-pink-100 bg-white/80 p-3">
          <input type="radio" name="tavern-convert-mode" className="mt-1"
            checked={props.mode === 'ai'} onChange={() => props.onModeChange('ai')}
            disabled={props.disabled || props.aiDisabledReason !== undefined}
            aria-describedby={props.aiDisabledReason !== undefined ? `${id}-ai-unavailable` : undefined} />
          <div className="min-w-0">
            <div className="text-sm text-gray-900">AI 深度转换（可选）</div>
            <div className="mt-1 text-xs text-gray-600">
              {props.aiDescription ?? '结构化质量更高，但会发送裁剪后的输入包到生成接口；输出会通过 schema 校验。'}
            </div>
            {props.aiDisabledReason !== undefined ? <div id={`${id}-ai-unavailable`} className="mt-1 text-xs text-gray-600">{props.aiDisabledReason}</div> : null}
          </div>
        </label>
      </div>
    </div>
    {props.mode === 'ai' ? <div className="mt-4 rounded-xl border border-pink-100 bg-white/60 p-3">
      <div className="grid gap-3">
        <div className="rounded-xl border border-pink-100 bg-white/70 p-3">
          <button type="button" className="flex w-full items-center justify-between text-left text-sm font-semibold text-pink-700"
            onClick={() => props.onLanguageExpandedChange(!props.languageExpanded)} disabled={props.disabled}
            aria-expanded={props.languageExpanded} aria-controls={`${id}-language`}>
            <span>生成语言</span><span className="text-xs">{props.languageExpanded ? '▲' : '▼'}</span>
          </button>
          {props.languageExpanded ? <div id={`${id}-language`} className="mt-3">
            <select aria-label="生成语言" className="w-full rounded-xl border border-pink-100 bg-white/80 p-3 text-sm text-gray-900"
              value={props.language} onChange={(event) => props.onLanguageChange(event.target.value)} disabled={props.disabled}>
              {props.languages.map((language) => <option key={language.code} value={language.code}>{language.name}</option>)}
            </select>
          </div> : <div id={`${id}-language`} className="mt-2 text-xs text-gray-600">当前：{props.language}</div>}
        </div>
        <div className="rounded-xl border border-pink-100 bg-white/70 p-3">
          <GenerationModeSwitcher label="生成方式" value={props.generationMode} disabled={props.disabled} helper={false}
            onChange={props.onGenerationModeChange} disabledReasons={props.generationModeDisabledReasons}
            optionDescriptions={props.generationModeOptionDescriptions} />
          {props.generationModeDescription != null ? <div className="mt-2 text-xs text-gray-600">{props.generationModeDescription}</div> : null}
        </div>
      </div>
      <div className="mt-3">
        {props.provider}
        {props.providerFootnote != null ? <div className="mt-2 text-xs text-gray-600">{props.providerFootnote}</div> : null}
      </div>
    </div> : null}
  </>;
}
