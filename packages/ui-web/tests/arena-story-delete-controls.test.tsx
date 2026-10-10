// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BattleStoryDeleteSessionControls, type BattleStoryDeleteSessionControlsProps } from '../src/arena-story-session';

let root: Root; let container: HTMLDivElement; let props: BattleStoryDeleteSessionControlsProps;
const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent === text)!;
const render = async () => { await act(async () => root.render(<BattleStoryDeleteSessionControls {...props} />)); };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  props = { target: { sessionId: 'A', title: '冻结目标 A', chapterCount: 501 }, onRequest: vi.fn(), onCancel: vi.fn(), onConfirm: vi.fn(), onExport: vi.fn(), onObserve: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it('renders frozen full target and defaults to a safe focused close without deleting', async () => {
  await render(); expect(document.body.textContent).toContain('共 501 章'); expect(document.body.textContent).toContain('其它已复制的分支');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭对话框');
  expect(props.onConfirm).not.toHaveBeenCalled();
  await act(async () => button('返回').click()); expect(props.onCancel).toHaveBeenCalledOnce(); expect(props.onConfirm).not.toHaveBeenCalled();
});
it('Escape and backdrop only cancel; export is a distinct explicit intent', async () => {
  await render();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(props.onCancel).toHaveBeenCalledOnce(); expect(props.onConfirm).not.toHaveBeenCalled();
  await act(async () => button('先导出').click()); expect(props.onExport).toHaveBeenCalledOnce();
  expect(props.onConfirm).not.toHaveBeenCalled();
});
it('busy mode disables repeated confirm, export, cancel and Escape effects', async () => {
  props.busy = true; await render();
  await act(async () => { button('正在删除…').click(); button('先导出').click(); button('返回').click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(props.onConfirm).not.toHaveBeenCalled(); expect(props.onExport).not.toHaveBeenCalled(); expect(props.onCancel).not.toHaveBeenCalled();
});
it('unknown exposes only observation and close, never a retry-delete control', async () => {
  props.mode = 'unknown'; await render();
  expect(button('确认删除本机会话')).toBeUndefined(); expect(button('先导出')).toBeUndefined();
  await act(async () => button('只读核对当前状态').click()); expect(props.onObserve).toHaveBeenCalledOnce(); expect(props.onConfirm).not.toHaveBeenCalled();
});
it('disabled reason explains pending work and blocks trigger and confirm', async () => {
  props.disabledReason = '请先处理未保存作品'; await render();
  await act(async () => { button('删除本机会话').click(); button('确认删除本机会话').click(); });
  expect(props.onRequest).not.toHaveBeenCalled(); expect(props.onConfirm).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('请先处理未保存作品');
});
it('closing an unknown dialog leaves a shared inline read-only check for the original A', async () => {
  props.mode = 'unknown'; props.open = false; await render();
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.body.textContent).toContain('冻结目标 A');
  expect(document.body.textContent).toContain('其它会话仍可正常使用');
  await act(async () => button('只读核对当前状态').click()); expect(props.onObserve).toHaveBeenCalledOnce(); expect(props.onConfirm).not.toHaveBeenCalled();
});
