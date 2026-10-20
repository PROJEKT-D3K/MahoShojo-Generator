// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { resolveModalTabTarget } from '../src/modal/tab-focus';

it('目标解析无焦点副作用，排除显式禁用、fieldset继承禁用、hidden及aria-hidden候选', () => {
  const container = document.createElement('div');
  container.innerHTML = '<button id="first">首项</button><button id="middle">中间</button><button id="last">末项</button><button disabled>禁用</button><fieldset disabled><input><button>继承禁用</button></fieldset><button hidden>隐藏</button><button aria-hidden="true">隐藏语义</button>';
  document.body.append(container);
  try {
    const first = container.querySelector<HTMLElement>('#first')!;
    const middle = container.querySelector<HTMLElement>('#middle')!;
    const last = container.querySelector<HTMLElement>('#last')!;
    middle.focus();
    expect(resolveModalTabTarget(container, first, true)).toBe(last);
    expect(resolveModalTabTarget(container, last, false)).toBe(first);
    expect(resolveModalTabTarget(container, middle, false)).toBeNull();
    expect(resolveModalTabTarget(container, middle, true)).toBeNull();
    expect(resolveModalTabTarget(container, document.body, false)).toBe(first);
    expect(resolveModalTabTarget(container, document.body, true)).toBe(last);
    expect(document.activeElement).toBe(middle);
  } finally { container.remove(); }
});

it('空候选回到容器，单候选双向环绕，缺少容器不接管', () => {
  const container = document.createElement('div');
  expect(resolveModalTabTarget(container, null, false)).toBe(container);
  expect(resolveModalTabTarget(container, null, true)).toBe(container);
  container.innerHTML = '<button>唯一</button>';
  const only = container.firstElementChild as HTMLButtonElement;
  expect(resolveModalTabTarget(container, only, false)).toBe(only);
  expect(resolveModalTabTarget(container, only, true)).toBe(only);
  expect(resolveModalTabTarget(null, only, false)).toBeNull();
});
