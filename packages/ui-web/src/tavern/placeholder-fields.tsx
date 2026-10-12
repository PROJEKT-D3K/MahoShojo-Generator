import { DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE, resolveTavernCharReplacement, TAVERN_CHAR_FALLBACK, type TavernPlaceholderPreference } from '@mahoshojo/domain/tavern-card';

/** Existing Web fields, controlled by the host; no storage or conversion side effects. */
export function TavernPlaceholderFields({ preference, onChange, name, disabled = false, description = '规则映射使用替换后的文本；酒馆原件保持不变。' }: {
  preference: TavernPlaceholderPreference; onChange: (next: TavernPlaceholderPreference) => void;
  name?: string; disabled?: boolean; description?: string;
}) {
  const resolvedChar = resolveTavernCharReplacement(name, preference);
  const patch = (value: Partial<TavernPlaceholderPreference>) => onChange({ ...preference, ...value });
  return <div>
    <div className="block text-sm font-semibold text-pink-700">占位符替换</div>
    <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-xl border border-pink-100 bg-white/80 p-3">
      <input aria-label="替换占位符" type="checkbox" className="mt-1" checked={preference.enabled} disabled={disabled} onChange={(event) => patch({ enabled: event.target.checked })} />
      <div className="min-w-0"><div className="text-sm text-gray-900">替换 <code>{'{{user}}'}</code> / <code>{'{{char}}'}</code></div><div className="mt-1 text-xs text-gray-600">{description}</div></div>
    </label>
    <div className="mt-3 grid gap-3">
      <div><div className="text-xs font-semibold text-gray-700"><code>{'{{user}}'}</code> →</div>
        <input aria-label="用户占位符替换文本" className="mt-1 w-full rounded-lg border border-pink-100 bg-white/80 px-3 py-2 text-sm text-gray-900" value={preference.userReplacement} onChange={(event) => patch({ userReplacement: event.target.value })} disabled={!preference.enabled || disabled} />
        <div className="mt-1 text-[11px] text-gray-500">默认：{DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE.userReplacement}</div>
      </div>
      <div><div className="flex items-center justify-between text-xs font-semibold text-gray-700"><span><code>{'{{char}}'}</code> →</span>
        <label className="flex items-center gap-2 text-[11px] font-normal text-gray-600"><input aria-label="使用角色名" type="checkbox" checked={preference.charReplacementMode === 'auto'} disabled={!preference.enabled || disabled} onChange={(event) => {
          const auto = event.target.checked;
          patch({ charReplacementMode: auto ? 'auto' : 'custom', ...(!auto && !preference.customCharReplacement.trim() ? { customCharReplacement: name?.trim() || TAVERN_CHAR_FALLBACK } : {}) });
        }} />使用角色名</label>
      </div>
        <input aria-label="角色占位符替换文本" className="mt-1 w-full rounded-lg border border-pink-100 bg-white/80 px-3 py-2 text-sm text-gray-900" value={preference.charReplacementMode === 'auto' ? resolvedChar : preference.customCharReplacement} onChange={(event) => patch({ customCharReplacement: event.target.value, charReplacementMode: 'custom' })} disabled={!preference.enabled || preference.charReplacementMode === 'auto' || disabled} />
        <div className="mt-1 text-[11px] text-gray-500">默认：角色名（{resolvedChar}）</div>
      </div>
    </div>
  </div>;
}
