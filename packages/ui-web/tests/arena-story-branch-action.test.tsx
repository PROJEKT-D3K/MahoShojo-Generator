// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BattleStoryBranchAction, type BattleStoryBranchActionProps } from '../src/arena-story-session';

let container: HTMLDivElement;
let root: Root;
let props: BattleStoryBranchActionProps;
const button = () => container.querySelector('button')!;
const render = async () => { await act(async () => root.render(<BattleStoryBranchAction {...props} />)); };

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  props = { variant: 'tail', onClick: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('shared controlled story branch action', () => {
  it.each([
    ['tail', '创建分支', '以当前结尾为基础复制一条分支会话'],
    ['selected', '从第 7 章创建分支', '以当前所选章节为锚点创建新分支会话'],
  ] as const)('renders %s and invokes only its host callback on explicit click', async (variant, label, title) => {
    props.variant = variant; props.chapterIndex = 7;
    await render(); await render();
    expect(button().type).toBe('button'); expect(button().textContent).toBe(label);
    expect(button().title).toBe(title); expect(button().disabled).toBe(false);
    expect(props.onClick).not.toHaveBeenCalled();
    await act(async () => button().click()); expect(props.onClick).toHaveBeenCalledOnce();
  });

  it('uses a safe generic selected label until the host supplies the selected chapter', async () => {
    props.variant = 'selected'; props.disabled = true;
    await render(); expect(button().textContent).toBe('从所选章节创建分支');
    props.chapterIndex = 4; props.disabled = false;
    await render(); expect(button().textContent).toBe('从第 4 章创建分支');
    expect(props.onClick).not.toHaveBeenCalled();
  });

  it('keeps disabled state and explanation entirely host-controlled', async () => {
    props.disabled = true; props.title = '原保存结果待确认'; await render();
    expect(button().title).toBe('原保存结果待确认');
    await act(async () => button().click()); expect(props.onClick).not.toHaveBeenCalled();
    props.disabled = false; await render();
    await act(async () => button().click()); expect(props.onClick).toHaveBeenCalledOnce();
  });

  it.each(['tail', 'selected'] as const)('disables %s while busy, with busy label before cooldown', async (variant) => {
    props.variant = variant; props.busy = true; props.cooldownSeconds = 9; await render();
    expect(button().textContent).toBe(variant === 'tail' ? '正在分支...' : '正在创建分支...');
    expect(button().disabled).toBe(true); expect(button().getAttribute('aria-busy')).toBe('true');
    await act(async () => { button().click(); button().click(); }); expect(props.onClick).not.toHaveBeenCalled();
    props.busy = false; await render();
    expect(button().textContent).toBe('冷却中 9s'); expect(button().disabled).toBe(true);
  });

  it('uses only the supplied cooldown, including active zero, and leaves release to the host', async () => {
    props.cooldownSeconds = 2; await render();
    expect(button().textContent).toBe('冷却中 2s'); expect(button().title).toBe('冷却中，请等待 2 秒');
    props.cooldownSeconds = 0; await render();
    expect(button().textContent).toBe('冷却中 0s'); expect(button().disabled).toBe(true);
    await act(async () => button().click()); expect(props.onClick).not.toHaveBeenCalled();
    props.cooldownSeconds = null; await render();
    expect(button().textContent).toBe('创建分支'); expect(button().disabled).toBe(false);
    expect(props.onClick).not.toHaveBeenCalled();
  });

  it('preserves an explicit host title during cooldown and replaces callbacks without retaining old selection', async () => {
    props.title = '请先处理当前会话'; props.cooldownSeconds = 3; await render();
    expect(button().title).toBe('请先处理当前会话');
    const previous = props.onClick;
    props = { variant: 'selected', chapterIndex: 8, onClick: vi.fn() }; await render();
    await act(async () => button().click());
    expect(previous).not.toHaveBeenCalled(); expect(props.onClick).toHaveBeenCalledOnce();
    expect(button().textContent).toBe('从第 8 章创建分支');
  });
});
