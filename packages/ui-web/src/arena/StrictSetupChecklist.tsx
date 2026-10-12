export interface StrictSetupChecklistProps {
  reasons: readonly string[];
  /** Hosts may describe a narrower diagnostic, without claiming server eligibility. */
  title?: string;
  readyLabel?: string;
  readyMessage?: string;
}

/** Controlled display only: no account, season loading, configuration writes or generation. */
export function StrictSetupChecklist({
  reasons,
  title = '严格计分基础条件',
  readyLabel = '已就绪',
  readyMessage = '配置已对齐，可尝试计分。',
}: StrictSetupChecklistProps) {
  const ready = reasons.length === 0;
  return (
    <div className="rounded-xl border border-gray-200 bg-white/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-gray-900">{title}</div>
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${ready ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
          {ready ? readyLabel : `缺少 ${reasons.length} 项`}
        </span>
      </div>
      {ready ? <div className="mt-2 text-xs text-gray-600">{readyMessage}</div> : (
        <details className="group mt-2">
          <summary className="flex cursor-pointer items-center justify-between gap-2 text-xs font-medium text-gray-700 hover:text-gray-900 [&::-webkit-details-marker]:hidden">
            <span>查看缺少项</span>
            <span className="text-gray-400 transition-transform group-open:rotate-180">▾</span>
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-gray-700">
            {reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
