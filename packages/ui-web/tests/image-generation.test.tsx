// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ImageGenerationFeedback, ImageGenerationResultView } from '../src/image-generation';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('不伪造未知进度，停止等待只发送宿主回调，忙碌时不提供原任务查询', () => {
  const stop = vi.fn(); const resume = vi.fn();
  act(() => root.render(<ImageGenerationFeedback busy progress={null} statusText="正在生成" taskId="task-1" onStop={stop} onResume={resume} />));
  expect(container.querySelector('progress')?.hasAttribute('value')).toBe(false);
  expect(container.querySelector('[role=status]')?.textContent).toContain('暂无进度百分比');
  expect(stop).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
  const button = container.querySelector('button')!;
  expect(button.textContent).toBe('停止等待（已提交的任务可能仍会计费）');
  expect(button.type).toBe('button'); button.focus(); expect(document.activeElement).toBe(button);
  act(() => button.click()); expect(stop).toHaveBeenCalledTimes(1); expect(resume).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('继续查询原任务');
});

it('保留真实零进度并约束显示百分比，不把无效数值显示为进度', () => {
  act(() => root.render(<ImageGenerationFeedback busy progress={0} />));
  expect(container.querySelector('progress')?.getAttribute('value')).toBe('0');
  expect(container.textContent).toContain('0%');
  act(() => root.render(<ImageGenerationFeedback busy progress={150} />));
  expect(container.querySelector('progress')?.getAttribute('value')).toBe('100');
  act(() => root.render(<ImageGenerationFeedback busy progress={NaN} />));
  expect(container.querySelector('progress')?.hasAttribute('value')).toBe(false);
});

it('已知任务错误保留原 ID，只有显式点击才能查询；错误文本不作为 HTML', () => {
  const resume = vi.fn();
  const error = '连接中断\n<img src="https://invalid.example/tracker">';
  act(() => root.render(<ImageGenerationFeedback busy={false} progress={null} outcome="unresolved" error={error} taskId="task-1" onResume={resume} />));
  expect(container.querySelector('[role=alert]')?.textContent).toBe(error);
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('任务 ID：task-1');
  expect(resume).not.toHaveBeenCalled();
  const button = container.querySelector('button')!;
  expect(button.textContent).toBe('继续查询原任务');
  act(() => button.click()); expect(resume).toHaveBeenCalledTimes(1);
});

it('未知提交没有任务 ID 时不提供假恢复，完成结果不会残留空反馈框', () => {
  act(() => root.render(<ImageGenerationFeedback busy={false} progress={null} outcome="unresolved" onResume={() => {}} />));
  expect(container.textContent).toContain('任务可能已创建或计费');
  expect(container.textContent).toContain('勿立即重复生成');
  expect(container.querySelector('button')).toBeNull();
  act(() => root.render(<ImageGenerationFeedback busy={false} progress={100} outcome="completed" />));
  expect(container.childElementCount).toBe(0);
});

it('保留 seed=0 与显式下载，图片载入失败保留结果且新图片可正常展示', () => {
  const first = 'data:image/png;base64,aGVsbG8=';
  const second = 'data:image/png;base64,d29ybGQ=';
  act(() => root.render(<ImageGenerationResultView imageUrl={first} seed={0} download={{ filename: 'image-0.png' }} />));
  expect(container.textContent).toContain('种子值: 0');
  expect(container.querySelector('a')?.getAttribute('download')).toBe('image-0.png');
  expect(container.querySelector('a')?.getAttribute('href')).toBe(first);
  act(() => container.querySelector('img')!.dispatchEvent(new Event('error')));
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('图片加载失败，生成结果仍保留');
  expect(container.textContent).toContain('生成成功');
  expect(container.querySelector('a')?.getAttribute('href')).toBe(first);
  act(() => root.render(<ImageGenerationResultView imageUrl={second} />));
  expect(container.querySelector('img')?.getAttribute('src')).toBe(second);
  expect(container.querySelector('img')?.alt).toBe('生成的立绘');
  expect(container.querySelector('[role=alert]')).toBeNull();
  expect(container.querySelector('a')).toBeNull();
});

it('空图片地址不创建空 src 或下载链接', () => {
  act(() => root.render(<ImageGenerationResultView imageUrl=" " download={{ filename: 'empty.png' }} />));
  expect(container.querySelector('img,a')).toBeNull();
  expect(container.querySelector('[role=alert]')?.textContent).toContain('图片加载失败');
});
