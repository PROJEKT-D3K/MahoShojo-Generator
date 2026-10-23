// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { MagicTeaPartySessionList } from '../src/magic-tea-party/SessionList';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe('shared explicit loaded Tea selection', () => {
  it('protects pinned/current rows, clears hidden selection on paging/search, and keeps malformed pins regular', async () => {
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const change = vi.fn(); const view = vi.fn(); const pin = vi.fn();
    try {
      await act(async () => root.render(<MagicTeaPartySessionList sessions={[
        { id: 'current', title: '当前', updatedAt: 1 }, { id: 'pinned', title: '置顶', updatedAt: 2, pinnedAt: 5 },
        { id: 'invalid', title: '异常旧值', updatedAt: 3, pinnedAt: 1.25 },
        ...Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, title: `会话${i}`, updatedAt: 4 }))]}
        activeSessionId="current" onCreateSession={() => {}} onSelectSession={() => {}} onDeleteSession={() => {}}
        onToggleSessionPin={pin} pinnedCollapsed={false} recentCollapsed={false} onPinnedCollapsedChange={() => {}} onRecentCollapsedChange={() => {}}
        selectedSessionIds={[]} onSelectionChange={change} onSelectionViewChange={view} listScope="loaded" />));
      const input = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="选择清理 ${label}"]`)!;
      expect(input('当前').disabled).toBe(true); expect(input('置顶').disabled).toBe(true); expect(input('异常旧值').disabled).toBe(false);
      await act(async () => input('异常旧值').click()); expect(change).toHaveBeenLastCalledWith(['invalid']);
      const row = input('异常旧值').closest('label')!.parentElement!;
      expect([...row.querySelectorAll('button')].some(button => button.textContent?.trim() === '置顶')).toBe(true);
      const next = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === '下一页')!;
      await act(async () => next.click()); expect(view).toHaveBeenCalledTimes(1);
      const search = container.querySelector<HTMLInputElement>('input[type="text"]')!;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '会话'); search.dispatchEvent(new Event('input', { bubbles: true })); });
      expect(view).toHaveBeenCalledTimes(2);
      expect(pin).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
