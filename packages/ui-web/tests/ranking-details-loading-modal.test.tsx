// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RankingDetailsLoadingModal, type RankingDetailsLoadingModalProps } from '../src/ranking/RankingDetailsLoadingModal';

let root: Root;
let container: HTMLDivElement;
let opener: HTMLButtonElement;
const onRetry = vi.fn(), onClose = vi.fn();
const render = (props: Partial<RankingDetailsLoadingModalProps> = {}) => act(() => {
  root.render(<RankingDetailsLoadingModal entityType="data_card" onRetry={onRetry} onClose={onClose} {...props} />);
});
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onRetry.mockReset(); onClose.mockReset();
  opener = document.createElement('button'); document.body.append(opener); opener.focus();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); opener.remove(); });

it.each([
  ['preset', '预设角色详情'],
  ['data_card', '数据卡详情'],
] as const)('labels the %s dialog by its actual entity type', (entityType, title) => {
  render({ entityType, pendingNotice: '历史榜单不代表当前正文' });
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(title);
  expect(dialog.textContent).toContain('历史榜单不代表当前正文');
  expect(dialog.querySelector('[role="status"]')?.textContent).toContain('正在加载角色详情');
  expect(dialog.querySelector('[role="alert"]')).toBeNull();
  expect(onRetry).not.toHaveBeenCalled();
});

it('projects a retryable error without starting requests, then returns to loading when the owner clears it', () => {
  render({ error: '读取失败', pendingNotice: '待审核版本仍在排队中' });
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('加载失败：读取失败');
  const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === '重试')!;
  act(() => retry.click());
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  render({ error: null, pendingNotice: '待审核版本仍在排队中' });
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('[role="status"]')).not.toBeNull();
  expect(document.body.textContent).toContain('待审核版本仍在排队中');
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it.each([undefined, '暂时离线'])('keeps Escape and close available during loading/error: %s', (error) => {
  render({ error, onClose: () => { onClose(); root.render(null); } });
  expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onRetry).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(opener);
});
