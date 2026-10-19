// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BattleStoryBranchChainModal, projectBattleStoryBranchSession, type BattleStoryBranchChainModalProps } from '../src/arena-story-session';

let root: Root; let container: HTMLDivElement; let props: BattleStoryBranchChainModalProps;
const view = (id: string, parent?: string) => projectBattleStoryBranchSession({ id, title: `故事${id}`, updatedAt: 1,
  ...(parent ? { branchOf: { sessionId: parent, chapterIndex: 2, chapterTitle: '锚点' } } : {}) });
const render = async () => { await act(async () => root.render(<BattleStoryBranchChainModal {...props} />)); };
const text = () => document.querySelector('[role="dialog"]')?.textContent ?? '';
const row = (title: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent?.startsWith(title))!;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  props = { isOpen: true, sessions: [view('A'), view('B', 'A'), view('C', 'B')], activeSession: view('B', 'A'), onSelectSession: vi.fn(), onClose: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it('shares the actual parent/child modal, source labels and explicit navigation without automatic effects', async () => {
  await render(); expect(text()).toContain('已读取到根会话'); expect(text()).toContain('已加载的子分支'); expect(text()).toContain('来源：第 2 章《锚点》');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭对话框'); expect(props.onSelectSession).not.toHaveBeenCalled();
  await act(async () => row('故事A').click()); expect(props.onSelectSession).toHaveBeenCalledExactlyOnceWith('A'); expect(props.onClose).toHaveBeenCalledOnce();
});
it('current row and Escape close without selecting or writing anything', async () => {
  await render(); await act(async () => row('故事B').click()); expect(props.onSelectSession).not.toHaveBeenCalled();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(props.onClose).toHaveBeenCalledTimes(2);
});
it('does not label an incomplete parent chain as root or claim no children exist', async () => {
  props.sessions = []; props.activeSession = view('B', 'outside-page'); await render();
  expect(text()).toContain('不能据此认定已删除'); expect(text()).toContain('outside-page'); expect(text()).not.toContain('根会话');
  expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
  expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toContain('不能据此认定已删除');
  expect(text()).toContain('当前已加载目录中没有子分支记录'); expect(text()).not.toContain('当前会话没有子分支');
});
it('shows cycle and damaged-link states, and only host-provided controls can read another record', async () => {
  props.activeSession = view('B', 'B'); props.sessions = []; await render(); expect(text()).toContain('循环分支来源');
  props.activeSession = projectBattleStoryBranchSession({ id: 'bad', title: '坏记录', updatedAt: 0, branchOf: { sessionId: 'A' } });
  await render(); expect(text()).toContain('记录不完整或损坏'); expect(text()).not.toContain('根会话');
});
it('can show an incremental parent read and cancel while loading, with no fake empty or missing result', async () => {
  props.activeSession = null; props.sessions = []; props.loading = true; props.showChildren = false;
  await render(); expect(text()).toContain('正在读取分支来源'); expect(text()).not.toContain('尚未选择'); expect(text()).not.toContain('根会话');
  expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
  const focused = document.activeElement;
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(props.onClose).toHaveBeenCalledOnce();
  props.loading = false; props.error = '读取时来源目前不存在\n原选择仍保留'; await render(); expect(text()).toContain(props.error); expect(text()).not.toContain('尚未选择');
  expect(document.querySelector('.error-message[role="alert"] .whitespace-pre-wrap')?.textContent).toBe(props.error);
  expect(document.activeElement).toBe(focused); expect(props.onSelectSession).not.toHaveBeenCalled();
});
it('projects bounded title fields without retaining the complete session or mutating it', () => {
  const source = { id: 'long', title: '星'.repeat(100000), updatedAt: 1, branchLabel: '光'.repeat(100000), branchOf: { sessionId: 'A', chapterIndex: 1, chapterTitle: '月'.repeat(100000) }, secret: 'not a view field' };
  const projected = projectBattleStoryBranchSession(source);
  expect(projected).not.toHaveProperty('secret'); expect(new TextEncoder().encode(projected.title).byteLength).toBeLessThanOrEqual(192);
  expect(new TextEncoder().encode(projected.branchLabel).byteLength).toBeLessThanOrEqual(192);
  expect(projected.parent.kind === 'parent' && new TextEncoder().encode(projected.parent.chapterTitle).byteLength).toBeLessThanOrEqual(192);
  expect(source.title).toHaveLength(100000);
});
