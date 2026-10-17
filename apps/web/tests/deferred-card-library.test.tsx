// @vitest-environment jsdom
import React, { act, lazy, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import BattleDataModal from '@/components/BattleDataModal';
import { DeferredChunkBoundary } from '@/components/shared/DeferredChunkBoundary';
import appDynamic from 'next/dist/shared/lib/app-dynamic';
import { createDeferredModuleLoader } from '@/lib/client/loadDeferredModule';

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

test('多人内联模块失败由局部边界承接，保留同页输出和输入', async () => {
  const Broken = lazy(async () => { throw Object.assign(new Error('Loading chunk 42 failed.'), { name: 'ChunkLoadError' }); });
  const container = document.createElement('div'); const root = createRoot(container);
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    await act(async () => root.render(<><input defaultValue="房间草稿" /><p>已有战报正文</p>
      <DeferredChunkBoundary mode="inline" label="多人房间"><Broken /></DeferredChunkBoundary></>));
    expect(container.textContent).toContain('多人房间加载失败');
    expect(container.textContent).toContain('已有战报正文');
    expect(container.querySelector('input')?.value).toBe('房间草稿');
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => container.querySelector('button')!.click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(container.querySelector('input')?.value).toBe('房间草稿');
  } finally {
    await act(async () => root.unmount()); errorLog.mockRestore(); confirm.mockRestore();
  }
});

test('实际Next app-dynamic保留ssr:false加载提示，耗尽重试后仅隔离多人模块', async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockRejectedValue(Object.assign(new Error('Loading chunk 42 failed.'), { name: 'ChunkLoadError' }));
  const Dynamic = appDynamic(createDeferredModuleLoader(load), {
    ssr: false,
    loading: () => <p role="status">正在加载多人房间…</p>,
  });
  const container = document.createElement('div'); const root = createRoot(container);
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => root.render(<><input defaultValue="同页草稿" />
      <DeferredChunkBoundary mode="inline" label="多人房间"><Dynamic /></DeferredChunkBoundary></>));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('正在加载多人房间…');
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(load).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('多人房间加载失败');
    expect(container.querySelector('input')?.value).toBe('同页草稿');
  } finally {
    await act(async () => root.unmount()); errorLog.mockRestore(); vi.useRealTimers();
  }
});
