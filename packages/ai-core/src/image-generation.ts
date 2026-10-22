/** 图片任务的共同生命周期。网络、参数、凭据与持久化归各宿主 adapter。 */
export interface ImageGenerationImage {
  imageUrl: string;
  seed?: number;
  auditStatus?: number;
}

export interface ImageGenerationTaskStatus {
  state: 'pending' | 'succeeded' | 'failed';
  progress: number;
  statusDescription: string;
  image?: ImageGenerationImage;
  error?: string;
  providerStatus?: number;
}

export interface ImageGenerationPort {
  /** 调用至多一次；adapter 负责消费 signal，错误信息须可向用户展示。 */
  // eslint-disable-next-line no-unused-vars -- Host port signature, not runtime bindings.
  submit(signal?: AbortSignal): Promise<
    | { kind: 'complete'; image: ImageGenerationImage; statusDescription?: string }
    | { kind: 'task'; taskId: string }
  >;
  /** 仅查询原任务；不能在查询失败时隐式创建新任务。 */
  // eslint-disable-next-line no-unused-vars -- Host port signature, not runtime bindings.
  query?(taskId: string, signal?: AbortSignal): Promise<ImageGenerationTaskStatus>;
}

export interface ImageGenerationOptions {
  signal?: AbortSignal;
  // eslint-disable-next-line no-unused-vars -- Host callback signature, not runtime bindings.
  onProgress?: (progress: number, status: string) => void;
  resumeTaskId?: string;
  pollIntervalMs: number;
  /** 宿主可设置等待预算；省略表示无应用层轮询次数上限。 */
  maxPollAttempts?: number;
}

export interface ImageGenerationResult {
  success: boolean;
  outcome: 'completed' | 'failed' | 'stopped' | 'unresolved';
  imageUrl?: string;
  error?: string;
  seed?: number;
  auditStatus?: number;
  generateUuid?: string;
  generateStatus?: number;
  statusDescription?: string;
  percentCompleted?: number;
}

const abortError = () => new Error('已停止等待；这不代表远端生成任务已取消。');

/** 查询不产生新身份，可以立即停止等待；迟到 resolve/reject 均被消费。 */
function queryWithSignal(
  operation: () => Promise<ImageGenerationTaskStatus>,
  signal?: AbortSignal,
): Promise<ImageGenerationTaskStatus> {
  if (!signal) return operation();
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw abortError();
      return operation();
    }).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

function waitForPoll(intervalMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(abortError()); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, intervalMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * 只运行本次创建或恢复的原任务。查询故障、等待预算耗尽、创建响应不明都不是供应商失败。
 * submit 不与 abort 竞争丢弃返回值，以保留已经创建但迟到返回的 task ID；宿主应中止实际 I/O。
 */
export async function runImageGeneration(
  port: ImageGenerationPort,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const { signal, onProgress, resumeTaskId, pollIntervalMs, maxPollAttempts } = options;
  let taskId = resumeTaskId?.trim() || undefined;
  let providerStatus: number | undefined;
  let statusDescription: string | undefined;
  let progress = 0;
  let submissionStarted = false;
  const result = (outcome: ImageGenerationResult['outcome'], error?: string): ImageGenerationResult => ({
    success: outcome === 'completed', outcome,
    ...(error ? { error } : {}),
    ...(taskId ? { generateUuid: taskId } : {}),
    ...(providerStatus !== undefined ? { generateStatus: providerStatus } : {}),
    ...(statusDescription ? { statusDescription } : {}),
    percentCompleted: progress,
  });
  const report = (value: number, status: string) => {
    if (signal?.aborted) return;
    progress = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : progress;
    statusDescription = status;
    onProgress?.(progress, status);
  };
  const stopped = () => result('stopped', taskId
    ? '已停止等待；远端任务可能仍在生成，可继续查询原任务。'
    : submissionStarted
      ? '已停止等待；若请求已经发出，远端可能已生成或计费，请先核实生成记录。'
      : '已停止，未提交生成请求。');
  const complete = (image: ImageGenerationImage | undefined, status: string): ImageGenerationResult => {
    if (typeof image?.imageUrl !== 'string' || !image.imageUrl.trim()) {
      return result('unresolved', '生成结果缺少图片，请查询原任务或核实供应商记录，不要立即重新生成。');
    }
    report(100, status);
    if (signal?.aborted) return stopped();
    return {
      ...result('completed'),
      imageUrl: image.imageUrl,
      ...(typeof image.seed === 'number' && Number.isFinite(image.seed) ? { seed: image.seed } : {}),
      ...(typeof image.auditStatus === 'number' && Number.isFinite(image.auditStatus) ? { auditStatus: image.auditStatus } : {}),
    };
  };

  if (signal?.aborted) return stopped();
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0
    || (maxPollAttempts !== undefined && (!Number.isSafeInteger(maxPollAttempts) || maxPollAttempts < 1))) {
    return result('failed', '图片任务的轮询配置无效，未提交生成请求。');
  }
  if (resumeTaskId !== undefined && !taskId) return result('failed', '原任务 ID 为空，未提交生成请求。');

  try {
    if (!taskId) {
      report(0, '正在提交生成任务…');
      if (signal?.aborted) return stopped();
      submissionStarted = true;
      const submission = await port.submit(signal);
      if (submission.kind === 'task') taskId = submission.taskId.trim() || undefined;
      if (signal?.aborted) return stopped();
      if (submission.kind === 'complete') return complete(submission.image, submission.statusDescription ?? '生成完成！');
      if (!taskId) return result('unresolved', '未收到有效任务 ID，请先核实供应商记录，不要立即重新生成。');
    }

    if (!port.query) return result('unresolved', '当前渠道不支持查询此任务，请先核实供应商记录。');
    const query = port.query.bind(port);
    report(10, '任务已提交，开始查询状态…');
    let attempts = 0;
    while (maxPollAttempts === undefined || attempts < maxPollAttempts) {
      if (signal?.aborted) return stopped();
      const status = await queryWithSignal(() => query(taskId!, signal), signal);
      if (signal?.aborted) return stopped();
      providerStatus = status.providerStatus;
      report(status.progress, status.statusDescription);
      if (signal?.aborted) return stopped();
      if (status.state === 'failed') return result('failed', status.error || '供应商报告生成失败。');
      if (status.state === 'succeeded') return complete(status.image, status.statusDescription);
      attempts++;
      if (maxPollAttempts === undefined || attempts < maxPollAttempts) await waitForPoll(pollIntervalMs, signal);
    }
    return result('unresolved', '已达到本次等待上限，远端任务结果尚未确定，可继续查询原任务。');
  } catch (error) {
    if (signal?.aborted) return stopped();
    return result('unresolved', error instanceof Error ? error.message : '图片任务结果尚未确定，请先核实原任务。');
  }
}
