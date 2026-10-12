// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSecurityCard } from '../src/features/account/AccountSecurityCard';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const deferred = () => {
  let resolve!: () => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('account security browser card', () => {
  it('uses shared settings markup and opens only after an explicit click', () => {
    const openPage = vi.fn(async () => {});
    act(() => root.render(<AccountSecurityCard openPage={openPage} />));
    expect(container.querySelector('section h3')?.textContent).toBe('账号安全');
    expect(container.querySelector('section')?.className).toContain('bg-(--app-surface)');
    expect(container.querySelectorAll('button.ui-web-settings-motion')).toHaveLength(2);
    expect(container.textContent).toContain('系统浏览器');
    expect(container.textContent).toContain('浏览器可能登录了不同账号');
    expect(openPage).not.toHaveBeenCalled();
  });
  it('blocks repeated clicks, reports failure and allows an explicit retry of either page', async () => {
    const pending = deferred();
    const openPage = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    act(() => root.render(<AccountSecurityCard openPage={openPage} />));
    const [security, recovery] = [...container.querySelectorAll('button')];
    act(() => { security!.click(); security!.click(); recovery!.click(); });
    expect(openPage).toHaveBeenCalledExactlyOnceWith('account-security');
    expect(security!.disabled).toBe(true); expect(recovery!.disabled).toBe(true);
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => pending.reject(new Error('无默认浏览器')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无默认浏览器');
    expect(security!.disabled).toBe(false);
    await act(async () => { recovery!.click(); });
    expect(openPage.mock.calls).toEqual([['account-security'], ['password-recovery']]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已请求系统浏览器打开');
  });
  it.each(['resolve', 'reject'] as const)('does not project late %s into a remounted card', async (finish) => {
    const pending = deferred(); const openPage = vi.fn(() => pending.promise);
    act(() => root.render(<AccountSecurityCard openPage={openPage} />));
    act(() => container.querySelector('button')!.click());
    act(() => root.render(null));
    act(() => root.render(<AccountSecurityCard openPage={openPage} />));
    await act(async () => finish === 'resolve' ? pending.resolve() : pending.reject(new Error('旧错误')));
    expect(container.querySelector('[role="alert"], [role="status"]')).toBeNull();
    expect(container.querySelector('button')?.disabled).toBe(false);
    expect(openPage).toHaveBeenCalledOnce();
  });
});
