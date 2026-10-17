import { createStreamReadWithTimeout, buildStreamSoftTimeoutMessage, DEFAULT_STREAM_READ_IDLE_TIMEOUT_MS, DEFAULT_STREAM_READ_TOTAL_TIMEOUT_MS } from '@mahoshojo/ai-core/stream-timeout';
import { ARENA_WEB_PACKAGE_META_ABSENT_MESSAGE, hasArenaWebPackageReport, type ArenaBattleReport, type ArenaMetadataStatus } from '@mahoshojo/ai-core/arena-generation';
import type { ArenaCompanionEnvelope, ArenaCompanionSuccessEnvelope } from '@mahoshojo/contracts/arena-companion';
import type { DesktopArenaHostedAnyRecoveryPointer, DesktopArenaHostedJsonCreateRequest } from '@mahoshojo/contracts/desktop-arena-hosted-json';
import type { ResolvedWebPackage } from '@mahoshojo/web-package';
import { ArenaHostedBridgeError, controlArenaHosted } from '../../platform/arena-hosted-bridge';
import { openArenaHostedJson, type ArenaHostedJsonReply } from '../../platform/arena-hosted-json-bridge';
import type { InvokeFn } from '../../platform/cloud-bridge';
import type { ArenaHostedContext, ArenaHostedDetails, ArenaHostedOutcome, ArenaHostedPartial } from './hosted';
import { validateHostedOutput, sameHostedPackageRef } from './hosted-output';
import { sanitizeArenaHostedErrorCode } from './hosted-error-diagnostic';

/** The full checked envelope is retained once. This projection reuses its strings for the shared report. */
export const projectArenaCompanionReportForView = (value: ArenaCompanionEnvelope): ArenaBattleReport | null => {
  if (!('report' in value.body) || !value.metadata) return null;
  const { aiReasoning, ...report } = value.body.report;
  return { ...report, reportFormat: value.metadata.reportFormat,
    ...(value.body.adjudicationResults ? { adjudicationResults: value.body.adjudicationResults } : {}),
    ...(aiReasoning ? { aiReasoning: aiReasoning.status === 'complete'
      ? { status: 'done' as const, source: 'unknown' as const, text: aiReasoning.text } : aiReasoning } : {}) };
};

/** Old saved error envelopes may have a public code but no recorded HTTP status. */
export const getArenaHostedErrorDiagnostic = (details: ArenaHostedDetails | null): { httpStatus: number | null; code: string | null } | null => {
  const body = details?.companion?.body;
  const diagnostic = details?.responseError;
  const code = diagnostic?.code ?? (body && !('report' in body) ? body.code : null);
  const httpStatus = diagnostic?.httpStatus;
  const safeCode = sanitizeArenaHostedErrorCode(code);
  const safeStatus = typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
  return safeStatus !== null || safeCode !== null ? { httpStatus: safeStatus, code: safeCode } : null;
};

/** A generation ID alone cannot bind an error's claimed status to this request. */
const hasBoundErrorIdentity = (reply: ArenaHostedJsonReply, requestId: string): boolean =>
  !('report' in reply.envelope.body) && Boolean(reply.envelope.body.generationId)
  && reply.envelope.body.generationId === reply.response.generationId
  && (reply.response.generationRequestId === requestId || reply.envelope.body.generationRequestId === requestId);

/** Display only the closed diagnostic code, never arbitrary server/provider diagnostics. */
const describeArenaHostedJsonFailure = (reply: ArenaHostedJsonReply, boundIdentity: boolean): string => {
  if ('report' in reply.envelope.body) throw new Error('expected companion error');
  const { status } = reply.envelope.body;
  const code = sanitizeArenaHostedErrorCode(reply.envelope.body.code);
  const http = reply.response.status;
  const identity = `HTTP ${http}${code ? ` · ${code}` : ''}`;
  if (status === 'completed' && boundIdentity) return `服务器任务已完成，但完整非流式报告未交付（${identity}）；可按原请求恢复正文，附加元数据可能缺失。`;
  const reason = http === 401 || http === 403 ? '账号身份或请求权限未通过验证，请检查登录状态'
    : http === 429 ? '请求频率或并发数已达限制，请稍后检查原请求'
    : http === 400 || http === 413 || http === 422 ? '请求参数未被服务器接受，请检查当前设置'
    : '服务器生成服务未完成本次交付，可按原请求检查状态';
  return `战报生成失败（${identity}）：${reason}。`;
};

/** One real JSON create. Recovery is injected as an existing C0 resume-only path, never a second create. */
export const runArenaHostedJson = async (
  invoke: InvokeFn, pointer: DesktopArenaHostedAnyRecoveryPointer, create: DesktopArenaHostedJsonCreateRequest,
  context: ArenaHostedContext, signal: AbortSignal, onPartial: ((partial: ArenaHostedPartial) => void) | undefined,
  frozenBase: ResolvedWebPackage | undefined, recover: () => Promise<ArenaHostedOutcome>,
): Promise<ArenaHostedOutcome> => {
  let generationId: string | null = null, markdown = '', reasoning = '';
  let details: ArenaHostedDetails = { connectionState: 'connecting', serverStatus: null, ranking: null, telemetry: null,
    metadataState: 'missing', headerMeta: null, recoveryCredentialState: 'stored', metaEvent: null, terminal: null,
    outputValidation: 'pending', validationMessage: null, restored: false, delivery: 'non-stream', companionState: 'unavailable', companion: null };
  const current = () => context.isCurrent?.() !== false;
  const assertCurrent = () => { if (!current()) throw new ArenaHostedBridgeError('scope-changed', 'not-dispatched'); };
  const partial = (): ArenaHostedPartial => ({ rawText: markdown, markdown, reasoning, hosted: { ...details } });
  const common = () => ({ ...partial(), hosted: { ...details, softTimeoutWarning: null }, generationId,
    requestId: pointer.requestId, scopeKey: context.scopeKey, mode: 'hosted' as const });
  const publish = () => { if (current() && !signal.aborted) onPartial?.(partial()); };
  const update = (state: DesktopArenaHostedAnyRecoveryPointer['state']) => {
    if (current()) context.recovery.update(pointer.requestId, { state, ...(generationId ? { generationId } : {}), updatedAt: (context.now ?? (() => new Date().toISOString()))() });
  };
  const scope = { product: pointer.product, requestId: pointer.requestId, actor: pointer.actor };
  const stop = async (): Promise<boolean> => {
    // The first HTTP headers may not exist yet. Resolve the original request before stopping its producer.
    // Timeout ends local waiting only; it does not pretend an already sent operation was revoked.
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => {
      assertCurrent();
      if (!generationId) {
        const found = await controlArenaHosted(invoke, { operation: 'lookup-request', ...scope });
        assertCurrent(); if (!active) return false;
        if (found.status !== 200 || !found.body.generationId || found.body.generationRequestId !== pointer.requestId) return false;
        generationId = found.body.generationId;
      }
      const reply = await controlArenaHosted(invoke, { operation: 'stop', ...scope, generationId, reason: 'user' });
      assertCurrent(); if (!active) return false;
      if (reply.body.generationRequestId && reply.body.generationRequestId !== pointer.requestId) return false;
      if (reply.body.generationId && reply.body.generationId !== generationId) return false;
      return reply.status === 202 || (reply.status >= 200 && reply.status < 300
        && (reply.body.cancelled === true || reply.body.status === 'cancelling' || reply.body.status === 'cancelled'));
    };
    try { return await Promise.race([attempt().catch(() => false), new Promise<false>(resolve => { timer = setTimeout(() => { active = false; resolve(false); }, 5000); })]); }
    finally { active = false; if (timer) clearTimeout(timer); }
  };
  let reader: ReadableStreamDefaultReader<ArenaHostedJsonReply> | undefined;
  let checkedReply = false;
  try {
    assertCurrent(); signal.throwIfAborted(); update('dispatched');
    let lastActivity = Date.now();
    const readWithTimeout = createStreamReadWithTimeout({ mode: 'soft', label: '战报非流式生成',
      idleTimeoutMs: DEFAULT_STREAM_READ_IDLE_TIMEOUT_MS, totalTimeoutMs: DEFAULT_STREAM_READ_TOTAL_TIMEOUT_MS,
      getLastActivityAtMs: () => lastActivity,
      onSoftTimeout: event => { if (!current() || signal.aborted) return; details = { ...details, softTimeoutWarning: buildStreamSoftTimeoutMessage(event) }; publish(); } });
    const pending = openArenaHostedJson(invoke, create, { signal, createChannel: context.createChannel,
      onActivity: () => { lastActivity = Date.now(); },
      onDelivered: reply => {
        assertCurrent(); signal.throwIfAborted(); checkedReply = true;
        // A fully checked original remains exportable if the Native invoke later rejects, but
        // cannot grant report/history/role authority or trigger an automatic recovery attempt.
        details = { ...details, companion: reply.envelope, companionState: 'unavailable' };
        const report = projectArenaCompanionReportForView(reply.envelope);
        if (report && 'report' in reply.envelope.body) {
          markdown = report.article.body; reasoning = reply.envelope.body.report.aiReasoning?.text ?? '';
        }
        publish();
      },
      onResponse: response => {
        assertCurrent(); signal.throwIfAborted();
        generationId = response.generationId ?? null;
        details = { ...details, recoveryCredentialState: response.recoveryCredentialState, connectionState: 'generating' }; update('generating'); publish();
      } });
    // Reuse the shared soft-timeout reader from dispatch, including the entire wait for first headers.
    reader = new ReadableStream<ArenaHostedJsonReply>({ start(controller) {
      void pending.then(value => { controller.enqueue(value); controller.close(); }, error => controller.error(error));
    } }).getReader();
    const next = await readWithTimeout(reader); assertCurrent(); signal.throwIfAborted();
    if (next.done) throw new ArenaHostedBridgeError('protocol');
    const reply = next.value; checkedReply = true; context.recovery.settlePrepared(pointer.requestId);
    details = { ...details, companion: reply.envelope, companionState: 'complete', softTimeoutWarning: null };
    if (!('report' in reply.envelope.body)) {
      const boundIdentity = hasBoundErrorIdentity(reply, pointer.requestId);
      details = { ...details, companionState: 'unavailable', connectionState: 'failed', serverStatus: boundIdentity ? reply.envelope.body.status ?? null : null,
        validationMessage: describeArenaHostedJsonFailure(reply, boundIdentity),
        responseError: { httpStatus: reply.response.status, code: sanitizeArenaHostedErrorCode(reply.envelope.body.code) } };
      const terminal = boundIdentity ? reply.envelope.body.status : null;
      update(terminal === 'completed' || terminal === 'failed' || terminal === 'cancelled' || terminal === 'producer_lost' ? terminal : 'unknown');
      return { ...common(), status: 'failed', message: details.validationMessage! };
    }
    const envelope = reply.envelope as ArenaCompanionSuccessEnvelope;
    if (envelope.metadata.reportFormat !== pointer.format || envelope.body.report.mode !== pointer.battleMode
      || (envelope.metadata.mode && envelope.metadata.mode !== pointer.battleMode)
      || Boolean(envelope.metadata.webPackageRef) !== Boolean(pointer.webPackageRef)
      || (envelope.metadata.webPackageRef && !sameHostedPackageRef(envelope.metadata.webPackageRef, pointer.webPackageRef!))) throw new ArenaHostedBridgeError('protocol');
    generationId = envelope.body.generationId;
    // Read the producer's checked envelope: fallback report fields are blank, before any view defaults or repair.
    const metaStatus: ArenaMetadataStatus = hasArenaWebPackageReport({ headline: envelope.body.report.headline, winner: envelope.body.report.officialReport.winner }) ? 'valid' : 'absent';
    const report = projectArenaCompanionReportForView(envelope)!; markdown = report.article.body; reasoning = envelope.body.report.aiReasoning?.text ?? '';
    details = { ...details, serverStatus: 'completed', connectionState: 'completed', metadataState: 'available' };
    const { renderSnapshot, ...validation } = await validateHostedOutput(pointer, markdown, report.webPackage, context, signal, assertCurrent, frozenBase);
    const packageFallback = Boolean(pointer.webPackageRef) && metaStatus === 'absent';
    details = { ...details, ...validation, ...(packageFallback && validation.outputValidation === 'valid'
      ? { validationMessage: ARENA_WEB_PACKAGE_META_ABSENT_MESSAGE } : {}) }; assertCurrent(); signal.throwIfAborted(); update('completed');
    return { ...common(), status: 'completed', metaStatus, report, renderSnapshot,
      usage: report.aiUsage ? Object.fromEntries(Object.entries(report.aiUsage).filter(([, value]) => typeof value === 'number')) : undefined,
      canAppendHistory: details.outputValidation === 'valid' };
  } catch (cause) {
    if (current() && cause instanceof ArenaHostedBridgeError && cause.intentOwnership === 'prior-retained' && cause.dispatchState === 'not-dispatched') context.recovery.rollbackPrepared(pointer.requestId);
    else context.recovery.settlePrepared(pointer.requestId);
    if (signal.aborted) {
      const accepted = signal.reason === 'arena-user-stop' && current() ? await stop() : false;
      details = { ...details, connectionState: accepted ? 'cancelled' : 'cancel_unconfirmed' }; update(accepted ? 'cancelled' : 'cancel_unconfirmed');
      return { ...common(), status: 'cancelled', message: accepted ? '服务器已受理停止请求，最终状态仍以恢复查询为准。' : '本机接收已停止；服务器终态尚未确认，可按原请求恢复。' };
    }
    if (current() && !checkedReply && cause instanceof ArenaHostedBridgeError && cause.dispatchState === 'unknown') {
      update('unknown'); return await recover();
    }
    // A checked envelope is exportable before invoke settles, but is not a server terminal.
    update(cause instanceof ArenaHostedBridgeError && cause.dispatchState === 'not-dispatched' ? 'failed' : 'unknown');
    return { ...common(), status: 'failed', message: cause instanceof ArenaHostedBridgeError ? cause.message : '完整战报校验未完成，可按原请求恢复。' };
  } finally { reader?.releaseLock(); }
};
