import { useId } from 'react';
import type { DataCardTemplate } from '@mahoshojo/domain/data-cards';

const labels: Record<DataCardTemplate, string> = {
  general: '通用角色（最稳，推荐）',
  'general-scenario': '通用情景（规则映射推荐）',
  'magical-girl': '魔法少女',
  canshou: '残兽（保守填充）',
  scenario: '情景（结构化 JSON）',
};
export const TAVERN_WEB_IMPORT_TEMPLATES = ['general', 'general-scenario', 'magical-girl', 'canshou', 'scenario'] as const;
export const TAVERN_LOCAL_IMPORT_TEMPLATES = ['general', 'general-scenario', 'magical-girl', 'canshou', 'scenario'] as const;

/** Hosts explicitly declare supported templates; this control never launches conversion. */
export function TavernTemplateSelector<T extends DataCardTemplate>({ value, templates, disabled, onChange }: {
  value: T; templates: readonly T[]; disabled?: boolean; onChange: (template: T) => void;
}) {
  const id = useId();
  return <div>
    <label htmlFor={id} className="block text-sm font-semibold text-pink-700">导入为</label>
    <select id={id} className="mt-2 w-full rounded-xl border border-pink-100 bg-white/80 p-3 text-sm text-gray-900"
      value={value} disabled={disabled} onChange={(event) => {
        const selected = templates.find((template) => template === event.target.value);
        if (selected && !disabled) onChange(selected);
      }}>
      {templates.map((template) => <option key={template} value={template}>{labels[template]}</option>)}
    </select>
  </div>;
}
