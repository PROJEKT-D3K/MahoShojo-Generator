import type { ReactNode } from 'react';

export interface ScenarioResultActionsProps {
  saveActions: ReactNode;
  saveFeedback?: ReactNode;
  exportActions: ReactNode;
  exportControl?: ReactNode;
  sizeIndicator?: ReactNode;
}

/** 结构化情景统一先保存、后导出；宿主保留云端反馈、文件通道与容量限制。 */
export function ScenarioResultActions({ saveActions, saveFeedback, exportActions, exportControl, sizeIndicator }: ScenarioResultActionsProps) {
  return <div className="mt-6 space-y-4" data-testid="scenario-result-actions">
    <section aria-label="保存数据卡" className="space-y-3">
      <h3 className="text-lg font-medium">保存数据卡</h3>
      <div className="flex flex-col gap-2">{saveActions}</div>
      {saveFeedback && <div className="space-y-2 text-sm">{saveFeedback}</div>}
    </section>
    <section aria-label="保存原始数据" className="space-y-3 [&>*]:min-w-0">
      <h3 className="text-lg font-medium">导出与复制</h3>
      <div className="flex flex-col gap-2 md:flex-row md:items-end [&>*]:min-w-0 [&>*]:flex-1">{exportActions}</div>
      {exportControl}
      {sizeIndicator}
    </section>
  </div>;
}
