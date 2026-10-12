import {
  createStreamReadWithTimeout, buildStreamSoftTimeoutMessage,
  DEFAULT_STREAM_READ_IDLE_TIMEOUT_MS, DEFAULT_STREAM_READ_TOTAL_TIMEOUT_MS,
} from '@mahoshojo/ai-core/stream-timeout';
import {
  DESKTOP_ARENA_HOSTED_LIMITS, parseDesktopArenaHostedSseBlock, type DesktopArenaHostedSseEvent,
} from '@mahoshojo/contracts/desktop-arena-hosted';
import type { GenerationRankingResponse } from '@mahoshojo/contracts/arena-generation-ranking';
import type { AiExecutionUsage } from '@mahoshojo/contracts/ai-execution';

export interface ArenaHostedStreamOutput {
  markdown: string;
  reasoning: string;
  usage?: AiExecutionUsage;
  serverStatus: string | null;
  ranking: GenerationRankingResponse | null;
  /** Preserve the wire telemetry, including nullable token counts and boolean flags. */
  telemetry: Extract<DesktopArenaHostedSseEvent, { event: 'telemetry' }>['data'] | null;
  metaEvent: Extract<DesktopArenaHostedSseEvent, { event: 'meta' | 'meta_error' }> | null;
  terminal: Extract<DesktopArenaHostedSseEvent, { event: 'done' | 'error' }> | null;
}
export const createArenaHostedStreamOutput = (): ArenaHostedStreamOutput => ({
  markdown: '', reasoning: '', serverStatus: null, ranking: null, telemetry: null, metaEvent: null, terminal: null,
});
export interface ArenaHostedStreamOutputOptions {
  /** An optional caller-owned accumulator keeps received originals available after a read failure. */
  output?: ArenaHostedStreamOutput;
  signal: AbortSignal;
  userStopReason: unknown;
  assertCurrent?: () => void;
  onEvent?: (event: DesktopArenaHostedSseEvent, output: ArenaHostedStreamOutput) => void;
  onSoftTimeout?: (message: string) => void;
}
const encoder = new TextEncoder();

/** Consume the existing C0 response only. Transport, headers, reconnects and success authority
 * remain with the caller; a delivered terminal does not prove the Native invoke has settled. */
export const collectArenaHostedStreamOutput = async (
  response: Response, options: ArenaHostedStreamOutputOptions,
): Promise<ArenaHostedStreamOutput> => {
  if (!response.ok || !response.body) throw new Error('服务器暂未提供可读取的战报，请稍后按原请求恢复。');
  const output = options.output ?? createArenaHostedStreamOutput();
  const generationId = response.headers.get('X-Mahoshojo-Generation-Id');
  if (output.ranking?.generationId !== generationId) output.ranking = null;
  const readWithTimeout = createStreamReadWithTimeout({ mode: 'soft', label: '战报流式生成',
    idleTimeoutMs: DEFAULT_STREAM_READ_IDLE_TIMEOUT_MS, totalTimeoutMs: DEFAULT_STREAM_READ_TOTAL_TIMEOUT_MS,
    onSoftTimeout: (event) => {
      if (!options.signal.aborted) options.onSoftTimeout?.(buildStreamSoftTimeoutMessage(event));
    } });
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    while (true) {
      const next = await readWithTimeout(reader); options.assertCurrent?.(); if (next.done) break;
      // C0 closes explicit-stop streams only after its bounded server acknowledgement.
      if (options.signal.aborted) { if (options.signal.reason === options.userStopReason) continue; break; }
      buffer += decoder.decode(next.value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary + 2); buffer = buffer.slice(boundary + 2);
        const event = parseDesktopArenaHostedSseBlock(block);
        if (event.event === 'markdown') output.markdown += event.data.chunk;
        else if (event.event === 'reasoning') output.reasoning += event.data.chunk;
        else if (event.event === 'snapshot') {
          output.markdown = event.data.markdown; output.reasoning = event.data.reasoning; output.serverStatus = event.data.status;
        } else if (event.event === 'ranking') {
          if (!output.terminal) output.ranking = event.data?.generationId === generationId ? event.data : null;
        } else if (event.event === 'meta' || event.event === 'meta_error') output.metaEvent = event;
        else if (event.event === 'done' || event.event === 'error') { output.terminal = event; output.serverStatus = event.data.status; }
        if (event.event === 'telemetry' || event.event === 'snapshot') {
          const telemetry = event.event === 'telemetry' ? event.data : event.data.telemetry;
          output.telemetry = telemetry ?? null;
          // Keep the existing display usage projection separate from the lossless telemetry.
          output.usage = telemetry && 'usage' in telemetry && telemetry.usage
            ? Object.fromEntries(Object.entries(telemetry.usage).filter(([, value]) => typeof value === 'number')) : undefined;
        }
        if (encoder.encode(output.markdown).byteLength + encoder.encode(output.reasoning).byteLength > DESKTOP_ARENA_HOSTED_LIMITS.outputContentBytes) throw new Error('战报正文超过 4 MiB 原输出预算。');
        options.onEvent?.(event, output); boundary = buffer.indexOf('\n\n');
      }
      if (encoder.encode(buffer).byteLength > DESKTOP_ARENA_HOSTED_LIMITS.eventWireBytes) throw new Error('生成事件超过协议预算。');
    }
    return output;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
};
