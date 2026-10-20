const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * 只解析既有模态 Tab 环绕目标，不安装监听器、移动焦点或判断弹层权属。
 * null 表示保持浏览器的内部 Tab 移动；空候选回到容器。
 * 候选规则沿用 BaseModal，不尝试在这里模拟 CSS 可见性或浏览器完整 Tab 顺序。
 */
export const resolveModalTabTarget = (
  container: HTMLElement | null,
  current: Element | null,
  backward: boolean,
): HTMLElement | null => {
  if (!container) return null;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => !element.matches(':disabled') && !element.hidden && element.getAttribute('aria-hidden') !== 'true');
  if (focusable.length === 0) return container;
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (backward && (current === first || !container.contains(current))) return last;
  if (!backward && (current === last || !container.contains(current))) return first;
  return null;
};
