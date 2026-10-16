// @vitest-environment jsdom
import React, { act, lazy, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import BattleDataModal from '@/components/BattleDataModal';
import { DeferredChunkBoundary } from '@/components/shared/DeferredChunkBoundary';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const loader = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve, calls: 0, mounts: 0 };
});
vi.mock('@/components/BattleDataModalContent', async () => {
  loader.calls += 1;
  await loader.promise;
  const ReactModule = await import('react');
  return { default: function Content({ isOpen }: { isOpen: boolean }) {
    const [filter, setFilter] = ReactModule.useState('');
    ReactModule.useEffect(() => { loader.mounts += 1; }, []);
    return isOpen ? <button onClick={() => setFilter('保留筛选')}>{filter || '修改筛选'}</button> : null;
  } };
});

test('关闭时不加载；首开等待可关闭；加载后重开保留实例和筛选', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const close = vi.fn();
  const render = async (isOpen: boolean) => act(async () => {
    root.render(<BattleDataModal isOpen={isOpen} onClose={close} selectedType="character" onSelectCard={() => {}} />);
  });
  try {
    await render(false);
    expect(loader.calls).toBe(0);
    await render(true);
    expect(loader.calls).toBe(1);
    expect(document.body.textContent).toContain('正在加载数据卡库');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(close).toHaveBeenCalledTimes(1);
    await render(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { loader.resolve(); await loader.promise; });
    await render(true);
    await vi.waitFor(() => expect(container.textContent).toContain('修改筛选'));
    await act(async () => container.querySelector('button')!.click());
    await render(false);
    await render(true);
    expect(container.textContent).toContain('保留筛选');
    expect(loader.calls).toBe(1);
    expect(loader.mounts).toBe(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('真实 lazy 拒绝只显示局部错误，Escape 关闭并保留父页面', async () => {
  const Broken = lazy(async () => { throw new Error('chunk unavailable'); });
  function Scene() {
    const [open, setOpen] = useState(true);
    return <><p>已有生成结果</p><DeferredChunkBoundary isOpen={open} onClose={() => setOpen(false)}><Broken /></DeferredChunkBoundary></>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => root.render(<Scene />));
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(container.textContent).toContain('已有生成结果');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('已有生成结果');
  } finally {
    await act(async () => root.unmount());
    errorLog.mockRestore();
    container.remove();
  }
});
