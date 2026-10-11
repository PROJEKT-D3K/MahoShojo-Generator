// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopArenaStoryControls } from '../src/features/arena/story-controls';
import { DesktopArenaStorySession } from '../src/features/arena/story-session';
import { deferred, installStoryCrypto, StoryFixturePort, storyDraft, storyExecution } from './helpers/story-fixture';

installStoryCrypto();
let root: Root, container: HTMLDivElement, owner: DesktopArenaStorySession;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
const click = async (label: string) => { await act(async () => button(label).click()); };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  HTMLElement.prototype.scrollIntoView = vi.fn(); vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(async () => { await act(async () => root.unmount()); owner?.dispose(); container.remove(); vi.restoreAllMocks(); });
const mount = async (product: 'battle' | 'arena') => {
  const port = new StoryFixturePort(), execution = storyExecution(), draft = storyDraft(); let id = 0;
  owner = new DesktopArenaStorySession({ port, id: () => `view-${++id}`, exportMarkdown: async () => ({ absolutePath: 'unused', byteLength: 1 }) });
  owner.setExecutionScope('A'); await owner.start({ product, draft }, execution.prepare); const parent = owner.getSnapshot().active!;
  await owner.start({ product, draft }, execution.prepare); const child = owner.getSnapshot().active!;
  const value = { ...port.documents.get(`${child.id}:session`)!.value, title: '当前子会话', branchOf: { sessionId: parent.id, chapterId: parent.lastChapterId, chapterIndex: 1 } };
  port.documents.set(`${child.id}:session`, { value, bytes: Uint8Array.from(new TextEncoder().encode(JSON.stringify(value))) });
  await owner.refreshSessions(); port.describe.mockClear();
  await act(async () => root.render(<DesktopArenaStoryControls owner={owner} draft={draft} product={product} disabled={false} unavailableReason={null}
    onStart={vi.fn()} onContinue={vi.fn()} download={vi.fn()} onNavigateExternal={vi.fn()} />));
  return { port, execution, parent, child };
};
it.each(['battle', 'arena'] as const)('%s uses the shared modal and real owner read path without model/save calls', async product => {
  const { port, execution, parent, child } = await mount(product); const writes = port.begin.mock.calls.length;
  expect(port.describe).not.toHaveBeenCalled(); await click('查看分支链');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('当前子会话');
  expect(port.describe.mock.calls.map(call => call[0])).toEqual([child.id]);
  await click('读取上一级父会话');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('已读取到根会话');
  const parentButton = document.querySelector<HTMLButtonElement>('[aria-label="已知父链"] button')!;
  await act(async () => parentButton.click());
  expect(owner.getSnapshot().active?.id).toBe(parent.id); expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(port.begin).toHaveBeenCalledTimes(writes); expect(execution.requests).toHaveLength(2);
});
it('Escape closes an in-flight native-shaped read and a late result cannot reopen the shared modal', async () => {
  const { port } = await mount('arena'); const gate = deferred<void>();
  port.beforeRead = async descriptor => { if (descriptor.kind === 'session') await gate.promise; };
  await click('查看分支链');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('正在读取分支来源');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => { gate.resolve(); await Promise.resolve(); });
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(owner.branchReader.getSnapshot().activeSession).toBeNull();
});
