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
  // 页脚分区渲染真实 ProductFooter。
  expect(container.querySelector('#showroom-footer footer, #showroom-footer .footer')).not.toBeNull();

  const openButton = [...container.querySelectorAll('button')]
    .find((button) => button.textContent === '打开示例对话框');
  expect(openButton).toBeDefined();
  act(() => { openButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});
