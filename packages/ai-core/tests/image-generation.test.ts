import { afterEach, describe, expect, it, vi } from 'vitest';
import { runImageGeneration, type ImageGenerationImage, type ImageGenerationPort, type ImageGenerationTaskStatus } from '@mahoshojo/ai-core/image-generation';

const image = { imageUrl: 'data:image/png;base64,fixture', seed: 0, auditStatus: 0 };
const pending: ImageGenerationTaskStatus = { state: 'pending', progress: 35, statusDescription: 'RUNNING', providerStatus: 2 };
const success: ImageGenerationTaskStatus = { state: 'succeeded', progress: 100, statusDescription: '生成完成！', image, providerStatus: 5 };
const makePort = () => ({
  submit: vi.fn<ImageGenerationPort['submit']>().mockResolvedValue({ kind: 'task', taskId: 'task-1' }),
  query: vi.fn<NonNullable<ImageGenerationPort['query']>>().mockResolvedValue(success),
});
const deferred = <T>() => {
  // eslint-disable-next-line no-unused-vars -- Deferred resolver signature, not a runtime binding.
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());

describe('image generation lifecycle', () => {
  it('提交一次后只轮询原任务，并保留图片、零 seed 与供应商状态', async () => {
    vi.useFakeTimers();
    const port = makePort();
    port.query.mockResolvedValueOnce(pending);
    const progress = vi.fn();
    const running = runImageGeneration(port, { pollIntervalMs: 100, onProgress: progress });
    await vi.advanceTimersByTimeAsync(100);
    expect(await running).toMatchObject({ success: true, outcome: 'completed', ...image, generateUuid: 'task-1', generateStatus: 5, percentCompleted: 100 });
    expect(port.submit).toHaveBeenCalledTimes(1);
    expect(port.query.mock.calls.map(call => call[0])).toEqual(['task-1', 'task-1']);
    expect(progress).toHaveBeenLastCalledWith(100, '生成完成！');
  });

  it('恢复只查询给定原任务，不创建请求', async () => {
    const port = makePort();
    expect(await runImageGeneration(port, { resumeTaskId: ' original ', pollIntervalMs: 100 })).toMatchObject({ outcome: 'completed', generateUuid: 'original' });
    expect(port.submit).not.toHaveBeenCalled();
    expect(port.query).toHaveBeenCalledWith('original', undefined);
  });

  it('支持直接返回图片的同步渠道', async () => {
    const submit = vi.fn<ImageGenerationPort['submit']>().mockResolvedValue({ kind: 'complete', image });
    expect(await runImageGeneration({ submit }, { pollIntervalMs: 0 })).toMatchObject({ success: true, outcome: 'completed', ...image });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('开始前取消不调用供应商', async () => {
    const controller = new AbortController(); controller.abort();
    const port = makePort();
    expect(await runImageGeneration(port, { signal: controller.signal, pollIntervalMs: 100 })).toMatchObject({ outcome: 'stopped', success: false });
    expect(port.submit).not.toHaveBeenCalled();
    expect(port.query).not.toHaveBeenCalled();
  });

  it('取消立即打断轮询间隔并保留已知任务 ID', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const port = makePort(); port.query.mockResolvedValue(pending);
    const running = runImageGeneration(port, { signal: controller.signal, pollIntervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await running).toMatchObject({ outcome: 'stopped', generateUuid: 'task-1', generateStatus: 2 });
    expect(vi.getTimerCount()).toBe(0);
    expect(port.query).toHaveBeenCalledTimes(1);
    expect(port.submit).toHaveBeenCalledTimes(1);
  });

  it('取消查询时立即退出，迟到成功不更新进度或产出图片', async () => {
    const controller = new AbortController();
    const queried = deferred<ImageGenerationTaskStatus>();
    const port = makePort(); port.query.mockReturnValue(queried.promise);
    const progress = vi.fn();
    const running = runImageGeneration(port, { signal: controller.signal, resumeTaskId: 'task-1', pollIntervalMs: 100, onProgress: progress });
    await Promise.resolve();
    controller.abort();
    expect(await running).toMatchObject({ outcome: 'stopped', generateUuid: 'task-1' });
    const calls = progress.mock.calls.length;
    queried.resolve(success);
    await Promise.resolve();
    expect(progress).toHaveBeenCalledTimes(calls);
    expect(port.submit).not.toHaveBeenCalled();
  });

  it('恢复后在查询真正开始前取消，不再触发查询 I/O', async () => {
    const controller = new AbortController();
    const port = makePort();
    const running = runImageGeneration(port, { signal: controller.signal, resumeTaskId: 'task-1', pollIntervalMs: 100 });
    controller.abort();
    expect((await running).outcome).toBe('stopped');
    expect(port.query).not.toHaveBeenCalled();
  });

  it('取消提交后迟到的任务 ID 仍被保留，不再查询或重新提交', async () => {
    const controller = new AbortController();
    const submitted = deferred<Awaited<ReturnType<ImageGenerationPort['submit']>>>();
    const port = makePort(); port.submit.mockReturnValue(submitted.promise);
    const running = runImageGeneration(port, { signal: controller.signal, pollIntervalMs: 100 });
    controller.abort(); submitted.resolve({ kind: 'task', taskId: 'late-task' });
    expect(await running).toMatchObject({ outcome: 'stopped', generateUuid: 'late-task' });
    expect(port.query).not.toHaveBeenCalled();
    expect(port.submit).toHaveBeenCalledTimes(1);
  });

  it('同步渠道取消后的迟到图片不作为完成结果', async () => {
    const controller = new AbortController();
    const submitted = deferred<Awaited<ReturnType<ImageGenerationPort['submit']>>>();
    const running = runImageGeneration({ submit: () => submitted.promise }, { signal: controller.signal, pollIntervalMs: 100 });
    controller.abort(); submitted.resolve({ kind: 'complete', image });
    const result = await running;
    expect(result.outcome).toBe('stopped');
    expect(result.imageUrl).toBeUndefined();
  });

  it('查询断网保留原任务，结果不明而非供应商失败', async () => {
    const port = makePort(); port.query.mockRejectedValue(new Error('网络中断'));
    expect(await runImageGeneration(port, { pollIntervalMs: 100 })).toMatchObject({ success: false, outcome: 'unresolved', generateUuid: 'task-1', error: '网络中断' });
    expect(port.submit).toHaveBeenCalledTimes(1);
    expect(port.query).toHaveBeenCalledTimes(1);
  });

  it('创建响应丢失保守返回结果不明，不自动重试', async () => {
    const port = makePort(); port.submit.mockRejectedValue(new Error('响应丢失'));
    expect(await runImageGeneration(port, { pollIntervalMs: 100 })).toMatchObject({ outcome: 'unresolved', error: '响应丢失' });
    expect(port.submit).toHaveBeenCalledTimes(1);
    expect(port.query).not.toHaveBeenCalled();
  });

  it('宿主等待预算耗尽保留原任务，不冒充远端失败', async () => {
    vi.useFakeTimers();
    const port = makePort(); port.query.mockResolvedValue(pending);
    const running = runImageGeneration(port, { pollIntervalMs: 100, maxPollAttempts: 2 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await running).toMatchObject({ outcome: 'unresolved', generateUuid: 'task-1', generateStatus: 2, percentCompleted: 35 });
    expect(port.query).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('未配置等待上限时允许继续原任务，随后可取消', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const port = makePort(); port.query.mockResolvedValue(pending);
    const running = runImageGeneration(port, { signal: controller.signal, pollIntervalMs: 100 });
    await vi.advanceTimersByTimeAsync(6_100);
    expect(port.query.mock.calls.length).toBeGreaterThan(60);
    controller.abort();
    expect((await running).outcome).toBe('stopped');
    expect(port.submit).toHaveBeenCalledTimes(1);
  });

  it('只将供应商明确失败映射为 failed', async () => {
    const port = makePort();
    port.query.mockResolvedValue({ state: 'failed', progress: 48, statusDescription: 'FAILED', error: '供应商拒绝任务', providerStatus: 6 });
    expect(await runImageGeneration(port, { pollIntervalMs: 100 })).toMatchObject({ outcome: 'failed', generateUuid: 'task-1', generateStatus: 6, error: '供应商拒绝任务' });
  });

  it('成功响应缺少图片时保留原任务为结果不明', async () => {
    const port = makePort(); port.query.mockResolvedValue({ ...success, image: undefined });
    expect(await runImageGeneration(port, { pollIntervalMs: 100 })).toMatchObject({ outcome: 'unresolved', generateUuid: 'task-1', success: false });
  });

  it('图片载荷的额外字段不能覆盖生命周期和任务身份', async () => {
    const port = makePort();
    const extra = { ...image, success: false, outcome: 'failed', generateUuid: 'injected', error: 'injected', privateField: 'hidden' };
    port.query.mockResolvedValue({ ...success, image: extra });
    const result = await runImageGeneration(port, { pollIntervalMs: 100 });
    expect(result).toMatchObject({ ...image, success: true, outcome: 'completed', generateUuid: 'task-1' });
    expect(result).not.toHaveProperty('error');
    expect(result).not.toHaveProperty('privateField');
  });

  it.each([42, null, {}, '   '])('无效 imageUrl %j 保留任务为结果不明', async imageUrl => {
    const port = makePort();
    port.query.mockResolvedValue({ ...success, image: { imageUrl } as ImageGenerationImage });
    expect(await runImageGeneration(port, { pollIntervalMs: 100 })).toMatchObject({ outcome: 'unresolved', generateUuid: 'task-1', success: false });
  });

  it.each([{ pollIntervalMs: -1 }, { pollIntervalMs: Infinity }, { pollIntervalMs: 10, maxPollAttempts: 0 }, { pollIntervalMs: 10, resumeTaskId: ' ' }])('非法宿主配置不提交请求 %j', async options => {
    const port = makePort();
    expect((await runImageGeneration(port, options)).outcome).toBe('failed');
    expect(port.submit).not.toHaveBeenCalled();
  });
});
