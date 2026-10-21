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

it('修复草稿忽略占位但保留真实角色的原始索引', async () => {
  const { seedDesktopManualRepairDraft } = await import('../src/features/arena/manual-repair-panel');
  const { createInitialArenaDraft } = await import('../src/features/arena/session');
  const state = { draft: { ...createInitialArenaDraft(), combatants: [
    { type: 'random-canshou', id: 'slot', filename: '随机残兽' },
    { type: 'general-character', filename: '甲.json', isValid: false, isPreset: false, data: { name: '甲',
      arena_history: { entries: [{ impact: '原影响', metadata: { generation_id: 'generation' } }] } } },
  ] } } as import('../src/features/arena/session').ArenaSessionState;
  expect(JSON.parse(seedDesktopManualRepairDraft(state, 'generation')).impacts).toEqual([
    { combatantIndex: 1, characterName: '甲', impact: '原影响' },
  ]);
});
