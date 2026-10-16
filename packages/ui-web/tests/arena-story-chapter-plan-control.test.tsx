// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BattleStoryChapterPlanControl, type BattleStoryChapterPlanControlProps } from '../src/arena-story-session';

let root: Root, container: HTMLDivElement, props: BattleStoryChapterPlanControlProps;
const render = async () => { await act(async () => root.render(<BattleStoryChapterPlanControl {...props} />)); };
const button = (text: string) => [...container.querySelectorAll('button')].find(node => node.textContent === text)!;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  props = { mode: 'auto', input: '', plan: null, locked: false, onModeChange: vi.fn(), onInputChange: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('shared next-story chapter planning view', () => {
  it.each([2, 3, 5, 8, 12])('selects %i chapters only after an explicit click', async count => {
    await render(); await render();
    expect(props.onModeChange).not.toHaveBeenCalled(); expect(props.onInputChange).not.toHaveBeenCalled();
    await act(async () => button(`${count} 章`).click());
    expect(props.onModeChange).toHaveBeenCalledExactlyOnceWith('custom');
    expect(props.onInputChange).toHaveBeenCalledExactlyOnceWith(String(count));
    props.mode = 'custom'; props.input = String(count); props.plan = { totalChapters: count, source: 'user', locked: false };
    await render(); expect(button(`${count} 章`).getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain(`用户设置｜0 / ${count}`);
  });
  it('preserves the input draft when switching between auto and unlimited', async () => {
    props.mode = 'custom'; props.input = '7'; await render();
    await act(async () => { button('自动').click(); button('不限制').click(); });
    expect(props.onModeChange).toHaveBeenNthCalledWith(1, 'auto'); expect(props.onModeChange).toHaveBeenNthCalledWith(2, 'none');
    expect(props.onInputChange).not.toHaveBeenCalled();
    props.mode = 'none'; await render(); expect(container.querySelector('input')!.value).toBe('');
  });
  it.each(['fixed', 'busy'] as const)('blocks all edits while %s without dispatching callbacks', async reason => {
    if (reason === 'fixed') { props.locked = true; props.plan = { totalChapters: 4, source: 'scenario', locked: true }; }
    else props.disabled = true;
    await render(); expect(container.querySelector('input')!.disabled).toBe(true);
    for (const item of container.querySelectorAll('button')) { expect(item.disabled).toBe(true); await act(async () => item.click()); }
    expect(props.onModeChange).not.toHaveBeenCalled(); expect(props.onInputChange).not.toHaveBeenCalled();
    if (reason === 'fixed') { expect(container.querySelector('input')!.value).toBe('4'); expect(container.textContent).toContain('情景卡固定｜0 / 4'); }
  });
  it('labels the input and its supplied validation error without advertising invalid input as unlimited', async () => {
    props.mode = 'custom'; props.input = '21'; props.error = '章节规划总数需为 1-20 的整数。'; await render();
    const input = container.querySelector('input')!;
    expect(container.querySelector('label')!.htmlFor).toBe(input.id); expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!.split(' ')[0]!)?.textContent).toBe(props.error);
    expect(container.textContent).toContain('请检查章节数'); expect(container.textContent).not.toContain('未设置章节上限时');
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '7'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(props.onModeChange).toHaveBeenCalledExactlyOnceWith('custom'); expect(props.onInputChange).toHaveBeenCalledExactlyOnceWith('7');
  });
  it('keeps ids unique across two mounted story products', async () => {
    await act(async () => root.render(<><BattleStoryChapterPlanControl {...props} /><BattleStoryChapterPlanControl {...props} /></>));
    const inputs = [...container.querySelectorAll('input')]; expect(new Set(inputs.map(node => node.id)).size).toBe(2);
  });
});
