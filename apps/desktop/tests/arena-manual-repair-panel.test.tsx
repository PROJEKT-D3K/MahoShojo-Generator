// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CombatantRepairPanel } from '@mahoshojo/ui-web/arena-report-views';

it('共源手动面板仅显式应用；锁定时禁用编辑与应用，不提供伪 AI 操作', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'), root = createRoot(container), apply = vi.fn(); document.body.append(container);
  const render = (disabled: boolean) => <CombatantRepairPanel draft='{"impacts":[]}' onDraftChange={() => undefined} onApply={apply} disabled={disabled} />;
  try {
    await act(async () => root.render(render(false)));
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '应用修复')!;
    expect(container.textContent).not.toContain('AI 重新生成'); expect(apply).not.toHaveBeenCalled();
    await act(async () => root.render(render(true)));
    expect(container.querySelector('textarea')!.disabled).toBe(true); expect(button.disabled).toBe(true);
    await act(async () => button.click()); expect(apply).not.toHaveBeenCalled();
    await act(async () => root.render(render(false)));
    await act(async () => button.click()); expect(apply).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); container.remove(); }
});
