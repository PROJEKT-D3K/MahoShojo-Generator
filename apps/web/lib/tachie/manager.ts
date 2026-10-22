import { runImageGeneration, type ImageGenerationPort, type ImageGenerationResult } from '@mahoshojo/ai-core/image-generation';
import { generateText2Image, getGenerateStatus, calculateProgress } from './liblib';
import { getStatusDescription, GenerateStatus } from './liblib/types';
import { generateModelScopeText2Image, getModelScopeTaskStatus } from './modelscope/api';
import { normalizeModelScopeToken } from './modelscope/error';
import { createNovelAIImageGenerator, DEFAULT_NOVELAI_SETTINGS, type NovelAISettings } from './novelai';

export type TachieSource = 'liblib' | 'modelscope' | 'novelai';
export type TachieGenerateMode = 'tachie' | 'illustration';

/** Web-only credentials and settings. The shared lifecycle never receives credentials. */
export interface TachieGenerationRequest {
  source: TachieSource;
  accessKey?: string;
  secretKey?: string;
  modelscopeToken?: string;
  modelscopeModel?: string;
  modelscopeSize?: string;
  novelaiToken?: string;
  novelaiSettings?: NovelAISettings;
  signal?: AbortSignal;
  resumeTaskId?: string;
  prompt: string;
  mode?: TachieGenerateMode;
  workflowUuid?: string;
  templateUuid?: string;
  promptNodeId?: number;
  negativePrompt?: string;
  negativePromptNodeId?: number;
}

// Additive client result: existing callbacks and local validation results stay compatible.
export type TachieGenerationResult = Omit<ImageGenerationResult, 'outcome'> & {
  outcome?: ImageGenerationResult['outcome'];
  prompt?: string;
};

const calculateModelScopeProgress = (status: string, attempts: number): number => {
  if (status === 'PENDING') return Math.min(10 + attempts * 3, 35);
  if (status === 'RUNNING') return Math.min(35 + attempts * 5, 90);
  if (status === 'SUCCEED') return 100;
  if (status === 'FAILED') return Math.min(35 + attempts * 4, 95);
  return Math.min(15 + attempts * 4, 88);
};

/** Host adapter only: routes and secrets stay here; create/query/stop ownership is shared. */
export async function generateTachieWithProgress(
  input: TachieGenerationRequest,
  onProgress?: (progress: number, status: string) => void,
): Promise<TachieGenerationResult> {
  const request = { ...input, novelaiSettings: input.novelaiSettings ? { ...input.novelaiSettings } : undefined };
  let attempts = 0;
  let port: ImageGenerationPort;
  if (request.source === 'liblib') {
    const accessKey = request.accessKey?.trim();
    const secretKey = request.secretKey?.trim();
    if (!accessKey || !secretKey) return { success: false, outcome: 'failed', error: '请填写 LibLib Access Key 和 Secret Key' };
    port = {
      submit: async (signal) => ({ kind: 'task', taskId: await generateText2Image(accessKey, secretKey, request.prompt, {
        mode: request.mode, workflowUuid: request.workflowUuid, templateUuid: request.templateUuid,
        promptNodeId: request.promptNodeId, negativePrompt: request.negativePrompt, negativePromptNodeId: request.negativePromptNodeId,
      }, signal) }),
      query: async (taskId, signal) => {
        const status = await getGenerateStatus(accessKey, secretKey, taskId, signal);
        const failed = status.generateStatus === GenerateStatus.FAILED || status.generateStatus === GenerateStatus.TIMEOUT;
        return {
          state: status.generateStatus === GenerateStatus.SUCCESS ? 'succeeded' : failed ? 'failed' : 'pending',
          progress: calculateProgress(status.generateStatus, attempts++),
          statusDescription: getStatusDescription(status.generateStatus), providerStatus: status.generateStatus,
          image: status.images?.[0], error: failed ? `生成失败: ${status.generateMsg || getStatusDescription(status.generateStatus)}` : undefined,
        };
      },
    };
  } else if (request.source === 'modelscope') {
    const token = normalizeModelScopeToken(request.modelscopeToken ?? '');
    if (!token) return { success: false, outcome: 'failed', error: '请填写 ModelScope Token' };
    port = {
      submit: async (signal) => ({ kind: 'task', taskId: await generateModelScopeText2Image(token, request.prompt, {
        model: request.modelscopeModel, size: request.modelscopeSize,
      }, signal) }),
      query: async (taskId, signal) => {
        const status = await getModelScopeTaskStatus(token, taskId, signal);
        return {
          state: status.taskStatus === 'SUCCEED' ? 'succeeded' : status.taskStatus === 'FAILED' ? 'failed' : 'pending',
          progress: calculateModelScopeProgress(status.taskStatus, attempts++), statusDescription: `ModelScope ${status.taskStatus}`,
          image: status.outputImages[0] ? { imageUrl: status.outputImages[0] } : undefined,
          error: status.taskStatus === 'FAILED' ? `生成失败: ${status.errorMessage || 'ModelScope 任务失败'}` : undefined,
        };
      },
    };
  } else if (request.source === 'novelai') {
    try {
      const generate = createNovelAIImageGenerator(
        request.novelaiToken ?? '', request.prompt,
        request.novelaiSettings ?? { ...DEFAULT_NOVELAI_SETTINGS, negativePrompt: request.negativePrompt ?? '' },
      );
      port = { submit: async (signal) => ({ kind: 'complete', image: await generate(signal) }) };
    } catch (error) {
      return { success: false, outcome: 'failed', error: error instanceof Error ? error.message : '图片参数无效，未提交请求' };
    }
  } else {
    return { success: false, outcome: 'failed', error: `不支持的生成源: ${request.source}` };
  }
  const result = await runImageGeneration(port, {
    signal: request.signal, resumeTaskId: request.resumeTaskId, onProgress,
    // Existing Web polling budgets; Desktop chooses its own policy at its adapter.
    pollIntervalMs: request.source === 'liblib' ? 12_000 : 10_000,
    maxPollAttempts: request.source === 'liblib' ? 30 : 60,
  });
  return result.success ? { ...result, prompt: request.prompt.trim() } : result;
}
