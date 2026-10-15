// @vitest-environment jsdom
import { act as reactAct } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { createReactActScope } from './helpers/react-act-scope';

it('drains the old act before unmount and does not resume its aborted test body', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const controller = new AbortController();
  const scope = createReactActScope(controller.signal);
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  let release!: () => void;
  let continued = false;
  const reason = new Error('original test timed out');
  const body = (async () => {
    await scope.act(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      root.render(<p>old</p>);
    });
    continued = true;
  })();
  const rejection = expect(body).rejects.toBe(reason);
  controller.abort(reason);
  let drained = false;
  const drain = scope.drain().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  release(); await drain; await rejection;
  expect(continued).toBe(false);
  await reactAct(async () => root.unmount()); container.remove();

  const nextScope = createReactActScope(new AbortController().signal);
  const nextContainer = document.createElement('div'); document.body.appendChild(nextContainer);
  const nextRoot = createRoot(nextContainer);
  try {
    await nextScope.act(() => nextRoot.render(<p>next</p>));
    expect(nextContainer.textContent).toBe('next');
    await expect(scope.act(() => nextRoot.render(<p>stale</p>))).rejects.toBe(reason);
    expect(nextContainer.textContent).toBe('next');
  } finally {
    await nextScope.drain();
    await reactAct(async () => nextRoot.unmount()); nextContainer.remove();
  }
});

it('preserves callback failures and rejects new work after cleanup', async () => {
  const scope = createReactActScope(new AbortController().signal);
  const reason = new Error('callback failed');
  await expect(scope.act(() => { throw reason; })).rejects.toBe(reason);
  await scope.drain();
  let called = false;
  await expect(scope.act(() => { called = true; })).rejects.toThrow('React test scope is closed');
  expect(called).toBe(false);
});
