// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BattleStoryActions, BattleStoryChapterDirectory, BattleStoryChapterReader,
  BattleStorySessionDirectory, type BattleStoryChapterReadViewState,
} from '../src/arena-story-session';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('directories render summary projections and never choose a new row on refresh or pagination', async () => {
  const onSelect = vi.fn();
  const rows = [{ id: 'one', title: '第一章', description: '首章' }, { id: 'two', title: '第二章', description: '续写' }];
  const render = (next: typeof rows) => root.render(<BattleStoryChapterDirectory rows={next} count={1000} selectedId="one" onSelect={onSelect} footer={<button>下一页</button>} />);
  await act(async () => render(rows));
  expect(container.textContent).toContain('共 1000 章');
  expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toContain('第一章');
  await act(async () => render([...rows, { id: 'three', title: '第三章', description: '续写' }]));
  expect(onSelect).not.toHaveBeenCalled();
  expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toContain('第一章');
  await act(async () => (container.querySelectorAll('button')[1] as HTMLButtonElement).click());
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('two');
  // Controlled state does not invent a selection while the host processes the intent.
  expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toContain('第一章');
});

it('session directory exposes independent loading/errors while preserving valid rows and host pagination', async () => {
  const onSelect = vi.fn();
  const render = (error?: string) => root.render(<BattleStorySessionDirectory rows={[{ id: 'A', title: '会话 A' }]} selectedId="A" onSelect={onSelect} loading error={error} footer={<button>重试下一页</button>} />);
  await act(async () => render());
  const focused = container.querySelector('button')!; focused.focus();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => render('翻页读取失败\n已读取目录仍保留'));
  expect(container.querySelector('[role="status"]')?.textContent).toBe('正在读取...');
  expect(container.querySelector('.error-message[role="alert"] .whitespace-pre-wrap')?.textContent).toBe('翻页读取失败\n已读取目录仍保留');
  expect(document.activeElement).toBe(focused);
  expect(onSelect).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-pressed="true"]')?.textContent).toBe('会话 A');
  expect(container.textContent).toContain('重试下一页');
  expect(container.textContent).not.toContain('本地还没有');
});

describe('selected chapter state', () => {
  it('drops A title, content and actions while B loads or fails, then renders only B slots', async () => {
    const stateA: BattleStoryChapterReadViewState = {
      status: 'loaded', identity: { sessionId: 'session-A', chapterId: 'chapter-A' },
      title: 'A 标题', content: <article>A 正文</article>, actions: <button>A 动作</button>, footer: <aside>A 元数据</aside>,
    };
    const retry = vi.fn();
    const render = (state: BattleStoryChapterReadViewState) => root.render(<BattleStoryChapterReader state={state} emptyContent="尚未选择章节" errorActions={<button onClick={retry}>重试</button>} />);
    await act(async () => render(stateA));
    expect(container.textContent).toBe('A 标题A 动作A 正文A 元数据');
    const identity = { sessionId: 'session-B', chapterId: 'chapter-B' };
    await act(async () => render({ status: 'loading', identity }));
    expect(container.querySelector('[data-story-chapter-id]')?.getAttribute('data-story-chapter-id')).toBe('chapter-B');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('正在读取章节...');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('A ');
    await act(async () => render({ status: 'error', identity, message: 'B 读取失败' }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('B 读取失败重试');
    const error = container.querySelector('.error-message[role="alert"]')!;
    expect(error.querySelector('.whitespace-pre-wrap')?.textContent).toBe('B 读取失败');
    expect(retry).not.toHaveBeenCalled();
    const retryButton = error.querySelector('button')!; retryButton.focus();
    expect(document.activeElement).toBe(retryButton);
    await act(async () => retryButton.click()); expect(retry).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('A ');
    await act(async () => render({ status: 'loaded', identity, title: 'B 标题', content: <article>B 正文</article> }));
    expect(container.textContent).toBe('B 标题B 正文');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => render({ status: 'unloaded' }));
    expect(container.textContent).toBe('章节预览尚未选择章节');
    expect(container.querySelector('[data-story-chapter-id]')).toBeNull();
  });

  it('leaves operation callbacks and disabled states entirely with the host', async () => {
    const action = vi.fn();
    await act(async () => root.render(<BattleStoryActions><button disabled onClick={action}>继续续写</button><button onClick={action}>导出</button></BattleStoryActions>));
    await act(async () => { container.querySelectorAll('button').forEach((button) => button.click()); });
    expect(action).toHaveBeenCalledTimes(1);
  });
});
