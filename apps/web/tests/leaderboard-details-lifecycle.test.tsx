// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BaseModal } from '@mahoshojo/ui-web/modal';

vi.mock('@/components/DataCardDetailsModal', () => ({
  default: ({ card, onClose, pendingNotice }: { card: { name: string }; onClose: () => void; pendingNotice?: string }) =>
    <BaseModal isOpen title={card.name} onClose={onClose}><p>{pendingNotice}</p></BaseModal>,
}));
import { LeaderboardEntityDetailsModal, type LeaderboardEntityDetailsTarget } from '@/components/ranking/LeaderboardEntityDetailsModal';

let root: Root;
let container: HTMLDivElement;
let opener: HTMLButtonElement;
const fetcher = vi.fn();
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};
const target = (id: string): LeaderboardEntityDetailsTarget => ({ entityType: 'preset', entityId: id, displayName: id, pendingNotice: `${id} 的历史榜单提示` });
const render = (entity: LeaderboardEntityDetailsTarget | null) => act(async () => {
  root.render(<LeaderboardEntityDetailsModal isOpen={entity !== null} entity={entity} onClose={() => {
    root.render(<LeaderboardEntityDetailsModal isOpen={false} entity={null} onClose={() => {}} />);
  }} />);
});
const clickRetry = () => act(async () => {
  const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === '重试');
  expect(retry).toBeDefined();
  retry!.click();
});

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
  opener = document.createElement('button'); opener.textContent = '打开排行榜详情'; document.body.append(opener); opener.focus();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); opener.remove(); vi.unstubAllGlobals();
});

it('keeps the real Web loader retryable and closable without accepting its late response', async () => {
  const first = deferred<Response>();
  const retry = deferred<Response>();
  fetcher.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
  await render(target('pending.json'));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('预设角色详情');
  expect(document.querySelector('[role="status"]')?.textContent).toContain('正在加载角色详情');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve(new Response('', { status: 503 })));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('HTTP 503');
  expect(document.body.textContent).toContain('pending.json 的历史榜单提示');
  expect(document.querySelector('[role="status"]')).toBeNull();
  await clickRetry();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('[role="status"]')?.textContent).toContain('正在加载角色详情');
  const signal = fetcher.mock.lastCall?.[1].signal as AbortSignal;
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(signal.aborted).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(opener);
  await act(async () => retry.resolve(Response.json({ name: '迟到的原件' })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('keeps the newer entity and notice when the older Web request finishes after selection changes', async () => {
  const old = deferred<Response>();
  const current = deferred<Response>();
  fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await render(target('old.json'));
  const oldSignal = fetcher.mock.calls[0]![1].signal as AbortSignal;
  await render(target('current.json'));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => current.resolve(Response.json({ name: '新原件' })));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('current.json');
  await act(async () => old.resolve(new Response('', { status: 503 })));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('current.json 的历史榜单提示');
  expect(document.body.textContent).not.toContain('old.json');
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
