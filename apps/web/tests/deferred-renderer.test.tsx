// @vitest-environment jsdom
import React, { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { createDeferredRenderer } from '@/components/shared/createDeferredRenderer';
import { confirmDeferredPageReload } from '@/lib/client/loadDeferredModule';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('加载失败可局部重试；父生成状态不重挂载，期间最新正文及停止操作保留', async () => {
  type Props = { content: string; stop: () => void };
  const pending = deferred<{ default: React.ComponentType<Props> }>();
  const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({
    default: ({ content }: Props) => <article>{content}</article>,
  });
  const Renderer = createDeferredRenderer<Props>(load, {
    label: '测试战报',
    fallback: ({ content, stop }) => <><pre>{content}</pre><button onClick={stop}>停止</button></>,
  });
  const mount = vi.fn(), cleanup = vi.fn(), stop = vi.fn();
  function Owner({ content, visible }: { content: string; visible: boolean }) {
    const [draft, setDraft] = useState('我的未保存输入');
    useEffect(() => { mount(); return cleanup; }, []);
    return <><input value={draft} onChange={(event) => setDraft(event.target.value)} />
      {visible ? <Renderer content={content} stop={stop} /> : null}</>;
  }
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => root.render(<Owner visible={false} content="" />));
    expect(load).not.toHaveBeenCalled(); expect(mount).toHaveBeenCalledOnce();
    await act(async () => root.render(<Owner visible content="首段" />));
    expect(load).toHaveBeenCalledOnce(); expect(container.textContent).toContain('正在加载测试战报');
    await act(async () => root.render(<Owner visible content="最新正文" />));
    await act(async () => container.querySelector('button')!.click());
    expect(stop).toHaveBeenCalledOnce();
    await act(async () => pending.reject(new Error('renderer unavailable')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('加载失败');
    expect(container.textContent).toContain('最新正文');
    await act(async () => root.render(<Owner visible content="完成正文" />));
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '重试加载')!.click());
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.querySelector('article')?.textContent).toBe('完成正文');
    expect(container.querySelector('input')?.value).toBe('我的未保存输入');
    expect(mount).toHaveBeenCalledOnce(); expect(cleanup).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount()); container.remove(); errorLog.mockRestore();
  }
  expect(cleanup).toHaveBeenCalledOnce();
});

test('加载未完成时离开，不会因迟到的模块恢复旧页面', async () => {
  const pending = deferred<{ default: React.ComponentType }>();
  const rendered = vi.fn();
  const Renderer = createDeferredRenderer(() => pending.promise, { label: '战报' });
  const container = document.createElement('div'); const root = createRoot(container);
  await act(async () => root.render(<Renderer />));
  await act(async () => root.render(<div>其他页面</div>));
  await act(async () => pending.resolve({ default: () => { rendered(); return <div>旧战报</div>; } }));
  expect(container.textContent).toBe('其他页面'); expect(rendered).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test('重试成功后的新展示实例复用恢复的模块，不再读取首次失败的lazy缓存', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('chunk unavailable')).mockResolvedValue({ default: () => <p>已恢复</p> });
  const Renderer = createDeferredRenderer(load, { label: '战报' });
  const container = document.createElement('div'); const root = createRoot(container);
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => root.render(<Renderer />));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '重试加载')!.click());
    expect(container.textContent).toBe('已恢复');
    await act(async () => root.render(null));
    await act(async () => root.render(<Renderer />));
    expect(container.textContent).toBe('已恢复'); expect(load).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount()); errorLog.mockRestore();
  }
});

test('永久chunk失败保留原文和父草稿，自动重试有界且不刷新；多个实例手动重试共用请求', async () => {
  vi.useFakeTimers();
  type Props = { content: string };
  const error = Object.assign(new Error('Loading chunk 42 failed.'), { name: 'ChunkLoadError' });
  const load = vi.fn().mockRejectedValue(error);
  const Renderer = createDeferredRenderer<Props>(load, { label: '战报', fallback: ({ content }) => <pre>{content}</pre> });
  const mount = vi.fn(), cleanup = vi.fn();
  function Owner({ content }: Props) {
    useEffect(() => { mount(); return cleanup; }, []);
    return <><input defaultValue="未保存的草稿" /><Renderer content={content} /><Renderer content={content} /></>;
  }
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    await act(async () => root.render(<Owner content="首段正文" />));
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(load).toHaveBeenCalledTimes(3);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect(container.textContent).toContain('可能是网络问题');
    await act(async () => root.render(<Owner content="最新正文" />));
    expect(container.querySelector('pre')?.textContent).toBe('最新正文');
    expect(container.querySelector('input')?.value).toBe('未保存的草稿');
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '刷新页面')!.click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toMatch(/生成或多人会话/);
    expect(container.querySelector('pre')?.textContent).toBe('最新正文');

    const recovery = deferred<{ default: React.ComponentType<Props> }>();
    load.mockReturnValue(recovery.promise);
    await act(async () => [...container.querySelectorAll('button')]
      .filter((button) => button.textContent === '重试加载').forEach((button) => button.click()));
    expect(load).toHaveBeenCalledTimes(4);
    await act(async () => recovery.resolve({ default: ({ content }) => <article>{content}</article> }));
    expect(container.querySelectorAll('article')).toHaveLength(2);
    expect(container.querySelector('article')?.textContent).toBe('最新正文');
    expect(mount).toHaveBeenCalledOnce(); expect(cleanup).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); container.remove(); errorLog.mockRestore(); confirm.mockRestore(); vi.useRealTimers();
  }
});

test('离开页面后迟到的自动chunk重试不会重新挂载展示或触发刷新', async () => {
  vi.useFakeTimers();
  const rendered = vi.fn();
  const load = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Loading chunk 42 failed'), { name: 'ChunkLoadError' }))
    .mockResolvedValue({ default: () => { rendered(); return <p>旧战报</p>; } });
  const Renderer = createDeferredRenderer(load, { label: '战报' });
  const container = document.createElement('div'); const root = createRoot(container);
  const confirm = vi.spyOn(window, 'confirm');
  try {
    await act(async () => root.render(<Renderer />));
    await act(async () => root.render(<div>其他页面</div>));
    await act(async () => vi.runAllTimersAsync());
    expect(container.textContent).toBe('其他页面');
    expect(rendered).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); confirm.mockRestore(); vi.useRealTimers();
  }
});

test('刷新动作只在用户确认风险后执行，取消不刷新', () => {
  const reload = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  confirmDeferredPageReload(reload);
  expect(reload).not.toHaveBeenCalled();
  confirmDeferredPageReload(reload);
  expect(reload).toHaveBeenCalledOnce();
  confirm.mockRestore();
});
