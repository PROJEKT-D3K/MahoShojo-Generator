// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ShowroomView } from '../src/showroom';
import { SHOWROOM_SECTIONS } from '../src/showroom/sections';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('renders every registered section, the real result card, and a working modal sample', () => {
  act(() => root.render(<ShowroomView />));

  for (const section of SHOWROOM_SECTIONS) {
    expect(container.querySelector(`#showroom-${section.id}`), `缺 ${section.id} 分区`).not.toBeNull();
  }
  // 结果卡分区渲染的是真实 MagicalGirlCard（.result-card 来自 product-shell.css）。
  expect(container.querySelector('#showroom-result-surfaces .result-card')).not.toBeNull();
  const results = container.querySelector('#showroom-result-surfaces')!;
  expect(results.textContent).toContain('模型：showroom-example-model');
  expect(results.textContent).toContain('输入 120｜推理 30｜输出 60');
  expect(results.querySelector('img[src="/arena-white.svg"]')).not.toBeNull();
  expect(results.querySelector('[data-testid="arena-web-result"] pre')?.textContent).toBe('<main>样板间战报</main>');
  expect(results.querySelector('[data-testid="arena-web-result"] main, iframe')).toBeNull();
  // 页脚分区渲染真实 ProductFooter。
  expect(container.querySelector('#showroom-footer footer, #showroom-footer .footer')).not.toBeNull();

  const openButton = [...container.querySelectorAll('button')]
    .find((button) => button.textContent === '打开示例对话框');
  expect(openButton).toBeDefined();
  act(() => { openButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});

it('uses production story error views with multiline copy, an explicit read action and the real branch modal', () => {
  act(() => root.render(<ShowroomView />));
  const sample = container.querySelector('[aria-label="故事读取错误样板"]')!;
  expect(sample.querySelectorAll('.error-message[role=alert]')).toHaveLength(2);
  expect(sample.querySelector('[data-story-read-status=error] .whitespace-pre-wrap')?.textContent).toContain('\n');
  const button = (label: string) => [...sample.querySelectorAll('button')].find(node => node.textContent === label)!;
  act(() => button('模拟重读本章').click());
  expect(sample.querySelector('[data-story-read-status=loaded]')?.textContent).toContain('已读取示例正文');
  expect(sample.querySelector('[data-story-read-status=loaded] [role=alert]')).toBeNull();
  act(() => button('重置章节错误样板').click());
  expect(sample.querySelector('[data-story-read-status=error] .error-message')).not.toBeNull();
  act(() => button('打开分支读取错误样板').click());
  expect(document.querySelector('[role=dialog] .error-message[role=alert] .whitespace-pre-wrap')?.textContent).toBe('示例：分支来源读取失败\n原故事仍保留。');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭对话框');
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role=dialog]')).toBeNull();
});
