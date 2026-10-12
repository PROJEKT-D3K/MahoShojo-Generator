import { Channel } from '@tauri-apps/api/core';
import {
  DESKTOP_ARENA_HOSTED_LIMITS,
  DesktopArenaHostedChannelEventSchema,
  DesktopArenaHostedErrorSchema,
  type DesktopArenaHostedError,
  DesktopArenaHostedControlRequestSchema,
  DesktopArenaHostedControlResponseSchema,
  DesktopArenaHostedDetachRequestSchema,
  DesktopArenaHostedStreamRequestSchema,
  DesktopArenaHostedRecoveryHintRequestSchema,
  DesktopArenaHostedRecoveryHintSchema,
  type DesktopArenaHostedRecoveryHintRequest,
  type DesktopArenaHostedRecoveryHint,
  parseDesktopArenaHostedSseBlock,
  type DesktopArenaHostedChannelEvent,
  type DesktopArenaHostedControlRequest,
  type DesktopArenaHostedControlResponse,
  type DesktopArenaHostedDetachRequest,
  type DesktopArenaHostedStreamRequest,
} from '@mahoshojo/contracts/desktop-arena-hosted';
import {
  DesktopArenaHostedStoryCreateRequestSchema, type DesktopArenaHostedStoryCreateRequest,
} from '@mahoshojo/contracts/desktop-arena-story-transport';
import type { InvokeFn } from './cloud-bridge';

export const ARENA_HOSTED_STREAM_COMMAND = 'arena_hosted_stream';
export const ARENA_HOSTED_CONTROL_COMMAND = 'arena_hosted_control';
export const ARENA_HOSTED_RECOVERY_HINT_COMMAND = 'arena_hosted_recovery_hint';
export const ARENA_HOSTED_DETACH_COMMAND = 'arena_hosted_detach';
export type ArenaHostedHandshake = Extract<DesktopArenaHostedChannelEvent, { kind: 'response' }>;
export interface ArenaHostedChannel { onmessage: (value: unknown) => void }
export class ArenaHostedBridgeError extends Error {
  constructor(readonly code: DesktopArenaHostedError['code'] | 'protocol' | 'transport', readonly dispatchState: 'not-dispatched' | 'unknown' = 'unknown', readonly intentOwnership: DesktopArenaHostedError['intentOwnership'] = 'unknown') {
    const messages: Partial<Record<DesktopArenaHostedError['code'] | 'protocol' | 'transport', string>> = {
      'capability-unavailable': '服务器尚未声明所选生成方式及身份保护所需协议，未开始生成。',
      'reconciliation-capability-unavailable': '角色更新服务尚未提供受支持的协议；可关闭角色写入后生成报告，已完成报告与原卡仍保留。',
      'reconciliation-output-too-large': '角色更新超过 16 MiB 接收上限；已完成报告与原卡仍保留。',
      'storage-unavailable': '原生恢复凭据无法保存或读取，请检查本机安全存储。',
      'scope-changed': '账号或当前请求身份已变化，原操作已停止。',
      'create-already-attempted': '该请求已尝试创建，请查找或续流，不重复创建。',
      'recovery-conflict': '原生恢复身份与本机指针不一致；清除页面指针不会清除该身份，也不会停止服务器。请保留原记录，不能换身份重试。',
      'recovery-unavailable': '原恢复凭据不可用，不能换身份恢复该请求。',
      'recovery-expired': '原恢复凭据已到期，不能重新创建原请求。',
      protocol: '服务器生成返回了不符合协议的数据，已保留收到的正文。',
    };
    super(messages[code] ?? '服务器连接或协议失败，已保留收到的正文。');
    this.name = 'ArenaHostedBridgeError';
  }
}
export const normalizeArenaHostedBridgeFailure = (cause: unknown): ArenaHostedBridgeError => {
  const parsed = DesktopArenaHostedErrorSchema.safeParse(cause);
  return parsed.success ? new ArenaHostedBridgeError(parsed.data.code, parsed.data.dispatchState, parsed.data.intentOwnership) : new ArenaHostedBridgeError('transport');
};
// The Native completion fence captures this check from the exact invocation arguments. Response
// consumption can end at C0's done event, so reader completion cannot stand in for IPC framing.
const streamCompletionChecks = new WeakMap<object, () => ArenaHostedBridgeError | null>();
export const getArenaHostedStreamCompletionCheck = (args: unknown): (() => ArenaHostedBridgeError | null) | undefined =>
  args !== null && typeof args === 'object' ? streamCompletionChecks.get(args) : undefined;
const abortError = () => new DOMException('已停止本机订阅；服务器终态仍需确认。', 'AbortError');

/** Detach is local only. It never substitutes for the server stop operation. */
export const detachArenaHosted = async (invoke: InvokeFn, scope: DesktopArenaHostedDetachRequest): Promise<void> => {
  const request = DesktopArenaHostedDetachRequestSchema.parse(scope);
  try { await invoke(ARENA_HOSTED_DETACH_COMMAND, { request }); }
  catch (cause) { throw normalizeArenaHostedBridgeFailure(cause); }
};

export const controlArenaHosted = async (invoke: InvokeFn, request: DesktopArenaHostedControlRequest): Promise<DesktopArenaHostedControlResponse> => {
  const parsed = DesktopArenaHostedControlRequestSchema.parse(request);
  let raw: unknown;
  try { raw = await invoke(ARENA_HOSTED_CONTROL_COMMAND, { request: parsed }); }
  catch (cause) { throw normalizeArenaHostedBridgeFailure(cause); }
  const result = DesktopArenaHostedControlResponseSchema.safeParse(raw);
  if (!result.success) throw new ArenaHostedBridgeError('protocol');
  return result.data;
};

/** Read-only local identity diagnosis. It neither contacts nor stops the server. */
export const readArenaHostedRecoveryHint = async (invoke: InvokeFn, value: DesktopArenaHostedRecoveryHintRequest): Promise<DesktopArenaHostedRecoveryHint> => {
  const request = DesktopArenaHostedRecoveryHintRequestSchema.parse(value);
  let raw: unknown;
  try { raw = await invoke(ARENA_HOSTED_RECOVERY_HINT_COMMAND, { request }); }
  catch (cause) { throw normalizeArenaHostedBridgeFailure(cause); }
  const parsed = DesktopArenaHostedRecoveryHintSchema.safeParse(raw);
  if (!parsed.success || parsed.data.product !== request.product) throw new ArenaHostedBridgeError('protocol');
  return parsed.data;
};

/** Native transport adapter only; C0 owns cursor deduplication and all reconnect decisions. */
export const openArenaHostedStream = (
  invoke: InvokeFn,
  value: DesktopArenaHostedStreamRequest | DesktopArenaHostedStoryCreateRequest,
  options: { signal?: AbortSignal; onResponse?: (response: ArenaHostedHandshake) => void; createChannel?: () => ArenaHostedChannel } = {},
): Promise<Response> => {
  const request = value.operation === 'create-story-stream'
    ? DesktopArenaHostedStoryCreateRequestSchema.parse(value)
    : DesktopArenaHostedStreamRequestSchema.parse(value);
  if (options.signal?.aborted) return Promise.reject(abortError());
  const encoder = new TextEncoder();
  let nextSequence = 0, fragmentBytes = 0, fragment = '';
  let responded = false, acceptsSse = false, ended = false, detached = false;
  let nativeSettled = false, channelEnded = false, completedTerminal = false;
  let completionError: ArenaHostedBridgeError | null = null;
  let generationId = request.operation === 'resume' ? request.generationId : null;
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  let resolveResponse!: (response: Response) => void, rejectResponse!: (error: unknown) => void;
  const result = new Promise<Response>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  const detach = () => {
    if (detached) return; detached = true;
    void detachArenaHosted(invoke, { product: request.product, requestId: request.requestId }).catch(() => undefined);
  };
  const finish = (error?: unknown) => {
    if (error) completionError ??= error instanceof ArenaHostedBridgeError ? error : new ArenaHostedBridgeError('transport');
    if (ended) return;
    ended = true; fragment = ''; fragmentBytes = 0;
    options.signal?.removeEventListener('abort', onAbort);
    if (!responded) rejectResponse(error ?? new ArenaHostedBridgeError('protocol'));
    try { if (error) streamController.error(error); else streamController.close(); } catch { /* Consumer already cancelled. */ }
  };
  const onAbort = () => { detach(); finish(abortError()); };
  const body = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; },
    cancel() { detach(); finish(); },
  });
  const channel = options.createChannel?.() ?? new Channel<unknown>();
  const invocationArgs = { request, onEvent: channel };
  streamCompletionChecks.set(invocationArgs, () => completionError ?? (nativeSettled && responded && channelEnded && (!acceptsSse || completedTerminal)
    ? null : new ArenaHostedBridgeError('protocol')));
  channel.onmessage = (raw) => {
    if (nativeSettled || completionError) return;
    if (channelEnded) { detach(); finish(new ArenaHostedBridgeError('protocol')); return; }
    const parsed = DesktopArenaHostedChannelEventSchema.safeParse(raw);
    if (!parsed.success || parsed.data.requestId !== request.requestId || parsed.data.sequence !== nextSequence) {
      detach(); finish(new ArenaHostedBridgeError('protocol')); return;
    }
    nextSequence += 1;
    const event = parsed.data;
    try {
      if (event.kind === 'response') {
        if (responded) throw new ArenaHostedBridgeError('protocol');
        if (event.generationRequestId && event.generationRequestId !== request.requestId) throw new ArenaHostedBridgeError('protocol');
        if (request.operation === 'resume' && event.generationId && event.generationId !== request.generationId) throw new ArenaHostedBridgeError('protocol');
        generationId = event.generationId ?? generationId;
        const headers = new Headers();
        if (event.generationId) headers.set('X-Mahoshojo-Generation-Id', event.generationId);
        if (event.generationRequestId) headers.set('X-Mahoshojo-Generation-Request-Id', event.generationRequestId);
        if (event.payloadHash) headers.set('X-Mahoshojo-Generation-Payload-Hash', event.payloadHash);
        const success = event.status >= 200 && event.status < 300;
        headers.set('Content-Type', success ? 'text/event-stream' : 'application/json');
        const responseBody = [204, 205, 304].includes(event.status) ? null : success ? body : JSON.stringify(event.body ?? {});
        const response = new Response(responseBody, { status: event.status, headers });
        options.onResponse?.(event);
        acceptsSse = success && responseBody !== null;
        responded = true; resolveResponse(response);
      } else if (event.kind === 'sse-fragment') {
        if (!responded || !acceptsSse || completedTerminal) throw new ArenaHostedBridgeError('protocol');
        fragmentBytes += encoder.encode(event.text).byteLength;
        if (fragmentBytes > DESKTOP_ARENA_HOSTED_LIMITS.eventWireBytes) throw new ArenaHostedBridgeError('protocol');
        fragment += event.text;
        if (event.final) {
          const parsed = parseDesktopArenaHostedSseBlock(fragment);
          if (parsed.event === 'done' && parsed.data.status === 'completed' && parsed.data.ok) completedTerminal = true;
          if (parsed.event === 'ranking') {
            const ranking = parsed.data?.generationId === generationId ? parsed.data : null;
            // Never send the original string after validating a stripping public projection.
            fragment = `id: ${parsed.id}\nevent: ranking\ndata: ${JSON.stringify(ranking)}\n\n`;
          }
          // A cancelled reader stops local delivery only. Validate all remaining Channel frames
          // until the original invoke settles, including the explicit stream-end and its sequence.
          if (!ended) streamController.enqueue(encoder.encode(fragment)); fragment = ''; fragmentBytes = 0;
        }
      } else {
        if (!responded || fragment) throw new ArenaHostedBridgeError('protocol');
        channelEnded = true;
        finish();
      }
    } catch { detach(); finish(new ArenaHostedBridgeError('protocol')); }
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) { onAbort(); return result; }
  void invoke(ARENA_HOSTED_STREAM_COMMAND, invocationArgs).then(
    () => { nativeSettled = true; if (!channelEnded) finish(new ArenaHostedBridgeError('protocol')); },
    (cause: unknown) => { nativeSettled = true; finish(normalizeArenaHostedBridgeFailure(cause)); },
  );
  return result;
};
