// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { StrictSetupChecklist } from '../src/arena';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
afterEach(() => { roots.splice(0).forEach((root) => act(() => root.unmount())); });
const render = (props: Parameters<typeof StrictSetupChecklist>[0]) => {
  const element = document.createElement('div'); const root = createRoot(element); roots.push(root);
  act(() => root.render(<StrictSetupChecklist {...props} />)); return element;
};
describe('controlled Strict basic checklist', () => {
  it('keeps Web labels and reason order without adding actions or network ownership', () => {
    const ready = render({ reasons: [] });
    expect(ready.textContent).toBe('严格计分基础条件已就绪配置已对齐，可尝试计分。');
    const missing = render({ reasons: ['需要先登录', '<img src="https://untrusted.invalid">'] });
    expect(missing.textContent).toContain('缺少 2 项');
    expect([...missing.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['需要先登录', '<img src="https://untrusted.invalid">']);
    expect(missing.querySelector('details')?.open).toBe(false);
    expect(missing.querySelector('button, img')).toBeNull();
  });
  it('lets the Desktop host describe configuration without claiming server eligibility', () => {
    const element = render({ reasons: [], title: '基础检查', readyLabel: '基础配置已对齐', readyMessage: '服务器资格仍未知。' });
    expect(element.textContent).toBe('基础检查基础配置已对齐服务器资格仍未知。');
    expect(element.textContent).not.toContain('可尝试计分');
  });
});
