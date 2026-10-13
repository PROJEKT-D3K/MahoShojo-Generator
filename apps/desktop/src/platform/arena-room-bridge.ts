import { Channel } from '@tauri-apps/api/core';
import {
  DESKTOP_ROOM_ERROR_MESSAGE, DESKTOP_ROOM_IPC_COMMANDS, DESKTOP_ROOM_IPC_LIMITS,
  DesktopRoomAckResponseSchema, DesktopRoomActionSchema, DesktopRoomAcceptedResponseSchema,
  DesktopRoomAttachRequestSchema, DesktopRoomAttachResponseSchema,
  DesktopRoomDetachResponseSchema, DesktopRoomErrorSchema, DesktopRoomNotificationSchema,
  DesktopRoomPullResponseSchema, DesktopRoomRequestSchema,
  DesktopRoomSubscribeRequestSchema, DesktopRoomSubscribeResponseSchema,
  parseDesktopRoomBatch,
  type DesktopRoomAttachResponse, type DesktopRoomBatch, type DesktopRoomError,
  type DesktopRoomErrorCode, type DesktopRoomHttpAction, type DesktopRoomHttpOperation,
  type DesktopRoomAvailableNotification, type DesktopRoomRevokedNotification, type DesktopRoomNotification,
} from '@mahoshojo/contracts/desktop-room-ipc';
import type { InvokeFn } from './cloud-bridge';

export interface ArenaRoomChannel { onmessage: (message: unknown) => void }
export interface ArenaRoomAcceptance {
  readonly signal: AbortSignal;
  /** Recheck immediately before installing state after any await. */
  readonly isCurrent: () => boolean;
}
export interface ArenaRoomBridgeOptions {
  /** Resolve true only after bounded state installation/queue acceptance has succeeded. */
  acceptBatch: (batch: DesktopRoomBatch, context: ArenaRoomAcceptance) => boolean | Promise<boolean>;
  /** Runs only after the exact Native ACK is confirmed; safe boundary for replacing a subscription. */
  onAcknowledged?: (batch: DesktopRoomBatch, context: ArenaRoomAcceptance) => void;
  isCurrent: () => boolean;
  /** Read the immutable main-frame document-start nonce; omission disables retired ACKs. */
  getDocumentNonce?: () => string | undefined;
  onError?: (error: ArenaRoomBridgeError) => void;
  createChannel?: () => ArenaRoomChannel;
}
export class ArenaRoomBridgeError extends Error {
  readonly code: DesktopRoomErrorCode;
  readonly outcome: DesktopRoomError['outcome'];
  readonly serverCode?: DesktopRoomError['serverCode'];
  readonly requestId?: string | null;
  readonly operation?: DesktopRoomHttpOperation | 'subscribe';
  constructor(code: DesktopRoomErrorCode, outcome: DesktopRoomError['outcome'] = 'not-applicable', serverCode?: DesktopRoomError['serverCode'], request?: { requestId: string; operation: DesktopRoomHttpOperation } | { requestId: null; operation: 'subscribe' }) {
    super(DESKTOP_ROOM_ERROR_MESSAGE);
    this.name = 'ArenaRoomBridgeError';
    this.code = code; this.outcome = outcome; this.serverCode = serverCode;
    this.requestId = request?.requestId; this.operation = request?.operation;
  }
}
export const normalizeArenaRoomFailure = (cause: unknown, outcome: DesktopRoomError['outcome'] = 'not-applicable'): ArenaRoomBridgeError => {
  if (cause instanceof ArenaRoomBridgeError) return cause;
  const parsed = DesktopRoomErrorSchema.safeParse(cause);
  return parsed.success
    ? new ArenaRoomBridgeError(parsed.data.code, parsed.data.outcome, parsed.data.serverCode)
    : new ArenaRoomBridgeError('internal-error', outcome);
};

interface Scope {
  generation: number;
  expectedUserId: number;
  documentNonce: string;
  handle?: string;
  subscriptionId?: string;
  retiredSubscriptionId?: string;
  delivery: number;
  controller: AbortController;
  notification?: DesktopRoomAvailableNotification;
  deferredNotifications: Map<string, DesktopRoomNotification>;
  revokedError?: ArenaRoomBridgeError;
  revokedRetirementGeneration?: number;
  revokedDeliveries: Set<string>;
  flight: boolean;
  sequence?: number;
  lastAcknowledged: number;
}

/** Native-only transport. No fetch, WebSocket, implicit attach or mutation retry. */
export const createArenaRoomBridge = (invoke: InvokeFn, options: ArenaRoomBridgeOptions) => {
  // Bounds both outstanding framework invokes and retained not-yet-dispatched arguments.
  // Consumer acceptance happens outside this lane; teardown never waits for it.
  type Invocation = { command: string; args: Record<string, unknown>; valid?: () => boolean; resolve: (value: unknown) => void; reject: (error: unknown) => void };
  const pending: Invocation[] = [];
  let invoking = false;
  const drain = () => {
    if (invoking || !pending.length) return;
    const next = pending.shift()!;
    invoking = true;
    void Promise.resolve().then(() => {
      if (next.valid && !next.valid()) throw new ArenaRoomBridgeError('scope-changed', 'not-applied');
      return invoke(next.command, next.args);
    }).then(next.resolve, next.reject).finally(() => {
      invoking = false; queueMicrotask(drain);
    });
  };
  const nativeInvoke = (command: string, args: Record<string, unknown>, valid?: () => boolean): Promise<unknown> => new Promise((resolve, reject) => {
    if (pending.length >= 16) {
      if (command !== DESKTOP_ROOM_IPC_COMMANDS.detach) { reject(new ArenaRoomBridgeError('busy', 'not-applied')); return; }
      let index = pending.length - 1;
      while (index >= 0 && pending[index]!.command === DESKTOP_ROOM_IPC_COMMANDS.detach) index -= 1;
      if (index < 0) { reject(new ArenaRoomBridgeError('busy', 'not-applied')); return; }
      pending.splice(index, 1)[0]!.reject(new ArenaRoomBridgeError('busy', 'not-applied'));
    }
    const task = { command, args, valid, resolve, reject };
    if (command === DESKTOP_ROOM_IPC_COMMANDS.detach) pending.unshift(task);
    else pending.push(task);
    drain();
  });
  let generation = 0;
  let scope: Scope | undefined;
  const callerCurrent = () => { try { return options.isCurrent(); } catch { return false; } };
  const current = (candidate: Scope, delivery = candidate.delivery) => {
    try { return scope === candidate && generation === candidate.generation
      && delivery === candidate.delivery && !candidate.controller.signal.aborted && callerCurrent(); }
    catch { return false; }
  };
  const detachHandle = async (handle: string) => {
    try {
      const response = await nativeInvoke(DESKTOP_ROOM_IPC_COMMANDS.detach, { request: { handle } });
      if (!DesktopRoomDetachResponseSchema.safeParse(response).success) throw new ArenaRoomBridgeError('invalid-response');
    } catch { /* Retirement is local and synchronous even if Native has already revoked this handle. */ }
  };
  const retire = () => {
    const previous = scope;
    generation += 1;
    const retiredGeneration = generation;
    scope = undefined;
    if (previous) {
      previous.controller.abort();
      previous.notification = undefined;
      for (const notification of previous.deferredNotifications.values()) {
        if (notification.type === 'revoked') revoke(previous, notification);
      }
      previous.deferredNotifications.clear();
      if (previous.handle) void detachHandle(previous.handle);
    }
    return retiredGeneration;
  };
  const fail = (candidate: Scope, error: ArenaRoomBridgeError) => {
    if (scope !== candidate) return;
    const retiredGeneration = retire();
    if (candidate.revokedError === error) candidate.revokedRetirementGeneration = retiredGeneration;
    try { options.onError?.(error); } catch { /* Consumer diagnostics cannot revive a retired scope. */ }
  };
  const invalid = () => new ArenaRoomBridgeError('invalid-response');
  const sameDocument = (candidate: Scope) => {
    try { return options.getDocumentNonce?.() === candidate.documentNonce; } catch { return false; }
  };
  const changedDocument = (candidate: Scope) => {
    try { const nonce = options.getDocumentNonce?.(); return nonce !== undefined && nonce !== candidate.documentNonce; }
    catch { return true; }
  };
  const releaseRetired = async (candidate: Scope, batch: Pick<DesktopRoomBatch, 'handle' | 'subscriptionId' | 'batchId' | 'sequence'>) => {
    if (!sameDocument(candidate)) return;
    try {
      // A verified discarded batch releases only its exact original delivery debt.
      // This does not reinstall state, renew scope, or dispatch a network operation.
      const raw = await nativeInvoke(DESKTOP_ROOM_IPC_COMMANDS.request, { request: {
        handle: batch.handle, request: { kind: 'ack', subscriptionId: batch.subscriptionId,
          batchId: batch.batchId, sequence: batch.sequence },
      } }, () => sameDocument(candidate));
      const result = DesktopRoomAckResponseSchema.safeParse(raw);
      if (!result.success || result.data.handle !== batch.handle || result.data.subscriptionId !== batch.subscriptionId
        || result.data.batchId !== batch.batchId || result.data.sequence !== batch.sequence) return;
    } catch { /* Unconfirmed retirement keeps Native's debt; never retry the ACK. */ }
  };
  const pump = async (candidate: Scope): Promise<void> => {
    if (!current(candidate) || candidate.flight || !candidate.notification
      || !candidate.handle || !candidate.subscriptionId) return;
    const notification = candidate.notification;
    candidate.notification = undefined;
    candidate.flight = true;
    candidate.sequence = notification.sequence;
    const delivery = candidate.delivery, handle = candidate.handle, subscriptionId = candidate.subscriptionId;
    const context = { signal: candidate.controller.signal, isCurrent: () => current(candidate, delivery) };
    try {
      let raw = await nativeInvoke(DESKTOP_ROOM_IPC_COMMANDS.request, { request: {
        handle, request: { kind: 'pull', subscriptionId },
      } }, context.isCurrent);
      // Drop raw/validation copies before an arbitrarily delayed consumer acceptance.
      const decode = (value: unknown) => {
        const parsed = DesktopRoomPullResponseSchema.safeParse(value);
        if (!parsed.success) throw invalid();
        if (parsed.data.kind === 'empty') {
          if (parsed.data.handle !== handle || parsed.data.subscriptionId !== subscriptionId) throw invalid();
          return undefined;
        }
        try { return parseDesktopRoomBatch(parsed.data.batch, candidate.expectedUserId); } catch { throw invalid(); }
      };
      const batch = decode(raw);
      raw = undefined;
      if (!batch) return;
      if (batch.handle !== handle || batch.subscriptionId !== subscriptionId || batch.sequence !== notification.sequence
        || batch.sequence <= candidate.lastAcknowledged) throw invalid();
      if (!context.isCurrent()) { await releaseRetired(candidate, batch); return; }
      // Exactly one complete bounded batch is retained while the consumer is awaiting capacity.
      const accepted = await options.acceptBatch(batch, context);
      if (!context.isCurrent()) { await releaseRetired(candidate, batch); return; }
      if (accepted !== true) throw new ArenaRoomBridgeError('backpressure');
      const ack = await nativeInvoke(DESKTOP_ROOM_IPC_COMMANDS.request, { request: {
        handle, request: { kind: 'ack', subscriptionId, batchId: batch.batchId, sequence: batch.sequence },
      } }, context.isCurrent);
      if (!context.isCurrent()) return;
      const result = DesktopRoomAckResponseSchema.safeParse(ack);
      if (!result.success || result.data.handle !== handle || result.data.subscriptionId !== subscriptionId
        || result.data.batchId !== batch.batchId || result.data.sequence !== batch.sequence || !result.data.accepted) throw invalid();
      candidate.lastAcknowledged = batch.sequence;
      // The receipt is now irreversible. A consumer failure may retire this scope,
      // but must never undo the ACK, retry it, or replay the acknowledged mutation.
      const acknowledgedContext = { signal: context.signal, isCurrent: () => context.isCurrent() && sameDocument(candidate) };
      try { if (acknowledgedContext.isCurrent()) options.onAcknowledged?.(batch, acknowledgedContext); }
      catch {
        if (acknowledgedContext.isCurrent()) fail(candidate, new ArenaRoomBridgeError('internal-error'));
      }
    } catch (cause) {
      if (context.isCurrent()) fail(candidate, cause instanceof ArenaRoomBridgeError ? cause : normalizeArenaRoomFailure(cause));
    } finally {
      if (current(candidate, delivery)) {
        candidate.flight = false;
        candidate.sequence = undefined;
        if (candidate.notification) void pump(candidate);
      }
    }
  };
  const revoke = (candidate: Scope, notification: DesktopRoomRevokedNotification) => {
    if (notification.handle !== candidate.handle) return;
    const key = JSON.stringify([notification.subscriptionId, notification.batchId, notification.sequence]);
    if (candidate.revokedDeliveries.has(key)) return;
    // Bounded duplicate fencing also applies to captured callbacks after retirement.
    if (candidate.revokedDeliveries.size >= 16) {
      if (notification.subscriptionId !== candidate.subscriptionId || !current(candidate)) return;
      const oldest = candidate.revokedDeliveries.values().next().value;
      if (oldest !== undefined) candidate.revokedDeliveries.delete(oldest);
    }
    candidate.revokedDeliveries.add(key);
    if (notification.subscriptionId === candidate.subscriptionId && current(candidate)) {
      const error = new ArenaRoomBridgeError(notification.error.code, notification.error.outcome,
        notification.error.serverCode, notification);
      candidate.revokedError = error;
      fail(candidate, error);
    }
    // A terminal notification owns separate debt; never treat this as body acceptance.
    void releaseRetired(candidate, notification);
  };
  const notify = (candidate: Scope, raw: unknown) => {
    const live = current(candidate);
    if (changedDocument(candidate)) return;
    if (!live && scope !== candidate && !sameDocument(candidate)) return;
    const result = DesktopRoomNotificationSchema.safeParse(raw);
    if (!result.success) { if (live) fail(candidate, invalid()); return; }
    const notification = result.data;
    if (candidate.handle && notification.handle !== candidate.handle) return;
    if (notification.subscriptionId === candidate.retiredSubscriptionId) {
      if (notification.type === 'revoked') revoke(candidate, notification);
      return;
    }
    if (live && candidate.handle && candidate.subscriptionId === undefined) {
      const buffered = candidate.deferredNotifications.get(notification.subscriptionId);
      if (buffered?.type === 'revoked') return;
      if (!buffered && candidate.deferredNotifications.size >= 16) { fail(candidate, new ArenaRoomBridgeError('backpressure')); return; }
      // At most one small notification per pending subscription; a terminal notification wins.
      candidate.deferredNotifications.set(notification.subscriptionId, notification);
      return;
    }
    if (notification.type === 'revoked') { revoke(candidate, notification); return; }
    if (!live) return;
    if (candidate.handle && notification.handle !== candidate.handle) return;
    if (notification.subscriptionId === candidate.retiredSubscriptionId) return;
    if (candidate.subscriptionId && notification.subscriptionId !== candidate.subscriptionId) return;
    if (notification.sequence <= candidate.lastAcknowledged || notification.sequence === candidate.sequence) return;
    if (candidate.notification) {
      if (JSON.stringify(candidate.notification) === JSON.stringify(notification)) return;
      fail(candidate, new ArenaRoomBridgeError('backpressure')); return;
    }
    candidate.notification = notification;
    void pump(candidate);
  };
  return {
    /** Caller owns the immutable document-start nonce and explicit attach intent counter. */
    async attach(raw: unknown): Promise<DesktopRoomAttachResponse> {
      retire();
      const parsed = DesktopRoomAttachRequestSchema.safeParse(raw);
      if (!parsed.success) throw new ArenaRoomBridgeError('invalid-request', 'not-applied');
      const candidate: Scope = { generation, expectedUserId: parsed.data.expectedUserId, documentNonce: parsed.data.documentNonce, delivery: 0,
        controller: new AbortController(), flight: false, lastAcknowledged: -1, revokedDeliveries: new Set(), deferredNotifications: new Map() };
      scope = candidate;
      if (!current(candidate)) { retire(); throw new ArenaRoomBridgeError('scope-changed'); }
      let channel: ArenaRoomChannel;
      try {
        channel = options.createChannel?.() ?? new Channel<unknown>();
        channel.onmessage = (message) => notify(candidate, message);
      } catch { retire(); throw new ArenaRoomBridgeError('internal-error', 'not-applied'); }
      let response: unknown;
      try { response = await nativeInvoke(DESKTOP_ROOM_IPC_COMMANDS.attach, { request: parsed.data, onEvent: channel }, () => current(candidate)); }
      catch (cause) {
        if (!current(candidate)) throw new ArenaRoomBridgeError('scope-changed');
        retire(); throw normalizeArenaRoomFailure(cause);
      }
      const result = DesktopRoomAttachResponseSchema.safeParse(response);
      if (!result.success) { if (current(candidate)) retire(); throw invalid(); }
      if (!current(candidate)) { void detachHandle(result.data.handle); throw new ArenaRoomBridgeError('scope-changed'); }
      candidate.handle = result.data.handle; candidate.subscriptionId = result.data.subscriptionId;
      if (candidate.notification && (candidate.notification.handle !== candidate.handle
        || candidate.notification.subscriptionId !== candidate.subscriptionId)) candidate.notification = undefined;
      void pump(candidate);
      return result.data;
    },
    async request(raw: DesktopRoomHttpAction) {
      const candidate = scope;
      const action = DesktopRoomActionSchema.safeParse(raw);
      if (!action.success || action.data.kind === 'ack' || action.data.kind === 'pull') throw new ArenaRoomBridgeError('invalid-request', 'not-applied');
      if (!candidate?.handle || !candidate.subscriptionId || !current(candidate)) throw new ArenaRoomBridgeError('scope-changed', 'not-applied');
      const delivery = candidate.delivery;
      const outcome = action.data.kind === 'discover' || action.data.kind === 'session' ? 'not-applicable' : 'unknown';
      const payload = DesktopRoomRequestSchema.safeParse({ handle: candidate.handle, request: action.data });
      if (!payload.success) throw new ArenaRoomBridgeError('invalid-request', 'not-applied');
      let response: unknown;
      try { response = await nativeInvoke(DESKTOP_ROOM_IPC_COMMANDS.request, { request: payload.data }, () => current(candidate, delivery)); }
      catch (cause) {
        if (!current(candidate, delivery)) throw new ArenaRoomBridgeError('scope-changed', outcome);
        throw normalizeArenaRoomFailure(cause, outcome);
      }
      const result = DesktopRoomAcceptedResponseSchema.safeParse(response);
      if (!current(candidate, delivery)) {
        const revoked = candidate.revokedError;
        const operation = action.data.kind === 'resume-create' ? 'create' : action.data.kind;
        if (result.success && result.data.handle === candidate.handle && result.data.subscriptionId === candidate.subscriptionId
          && revoked && revoked.requestId === result.data.requestId && revoked.operation === operation
          && generation === candidate.revokedRetirementGeneration
          && callerCurrent() && !changedDocument(candidate)) throw revoked;
        throw new ArenaRoomBridgeError('scope-changed', outcome);
      }
      if (!result.success || result.data.handle !== candidate.handle || result.data.subscriptionId !== candidate.subscriptionId) throw new ArenaRoomBridgeError('invalid-response', outcome);
      return result.data;
    },
    async subscribe(roomId: string, expectedRoomEpoch: string) {
      // Even an explicitly rejected new intent supersedes a retired request's diagnostic.
      generation += 1;
      if (scope) scope.generation = generation;
      const candidate = scope;
      if (!candidate?.handle || !current(candidate)) throw new ArenaRoomBridgeError('scope-changed', 'not-applied');
      const parsed = DesktopRoomSubscribeRequestSchema.safeParse({ handle: candidate.handle, roomId, expectedRoomEpoch });
      if (!parsed.success) throw new ArenaRoomBridgeError('invalid-request', 'not-applied');
      // Fence callbacks before the first await; an old acceptance can no longer ack/install.
      candidate.delivery += 1;
      candidate.controller.abort(); candidate.controller = new AbortController();
      candidate.retiredSubscriptionId = candidate.subscriptionId ?? candidate.retiredSubscriptionId;
      candidate.subscriptionId = undefined; candidate.notification = undefined;
      for (const notification of candidate.deferredNotifications.values()) {
        if (notification.type === 'revoked') revoke(candidate, notification);
      }
      candidate.deferredNotifications.clear();
      candidate.flight = false; candidate.sequence = undefined; candidate.lastAcknowledged = -1;
      const delivery = candidate.delivery;
      let response: unknown;
      try { response = await nativeInvoke(DESKTOP_ROOM_IPC_COMMANDS.subscribe, { request: parsed.data }, () => current(candidate, delivery)); }
      catch (cause) {
        if (!current(candidate, delivery)) throw new ArenaRoomBridgeError('scope-changed');
        retire(); throw normalizeArenaRoomFailure(cause);
      }
      const result = DesktopRoomSubscribeResponseSchema.safeParse(response);
      if (!result.success || result.data.handle !== candidate.handle) {
        if (current(candidate, delivery)) retire();
        throw invalid();
      }
      const buffered = candidate.deferredNotifications.get(result.data.subscriptionId);
      candidate.deferredNotifications.delete(result.data.subscriptionId);
      if (!current(candidate, delivery)) {
        if (buffered?.type === 'revoked') revoke(candidate, buffered);
        throw new ArenaRoomBridgeError('scope-changed');
      }
      candidate.subscriptionId = result.data.subscriptionId;
      for (const notification of candidate.deferredNotifications.values()) {
        if (notification.type === 'revoked') revoke(candidate, notification);
      }
      candidate.deferredNotifications.clear();
      if (buffered) notify(candidate, buffered);
      if (!current(candidate, delivery)) throw (generation === candidate.revokedRetirementGeneration && callerCurrent() && !changedDocument(candidate) ? candidate.revokedError : undefined) ?? new ArenaRoomBridgeError('scope-changed');
      void pump(candidate);
      return result.data;
    },
    /** Invalidates synchronously; Native detach is best-effort and never means server leave. */
    detach: () => { retire(); },
  };
};

/** One-slot bounded inbox for consumers that cannot immediately install a whole batch. */
export const createArenaRoomInbox = () => {
  let queued: { batch: DesktopRoomBatch; context: ArenaRoomAcceptance; discard: () => void } | undefined;
  let waiting: { batch: DesktopRoomBatch; context: ArenaRoomAcceptance; resolve: (accepted: boolean) => void; cancel: () => void } | undefined;
  let closed = false;
  const size = (batch: DesktopRoomBatch) => new TextEncoder().encode(JSON.stringify({ kind: 'batch', batch })).byteLength;
  const install = (batch: DesktopRoomBatch, context: ArenaRoomAcceptance): boolean => {
    if (closed || context.signal.aborted || !context.isCurrent()) return false;
    const discard = () => {
      if (queued?.batch !== batch) return;
      context.signal.removeEventListener('abort', discard);
      queued = undefined;
      promote();
    };
    queued = { batch, context, discard };
    context.signal.addEventListener('abort', discard, { once: true });
    return true;
  };
  const promote = () => {
    if (!waiting || queued) return;
    const next = waiting; waiting = undefined;
    next.context.signal.removeEventListener('abort', next.cancel);
    next.resolve(install(next.batch, next.context));
  };
  return {
    acceptBatch(batch: DesktopRoomBatch, context: ArenaRoomAcceptance): boolean | Promise<boolean> {
      if (closed || !context.isCurrent() || context.signal.aborted || size(batch) > DESKTOP_ROOM_IPC_LIMITS.batchBytes) return false;
      if (!queued) return install(batch, context);
      if (waiting) return false;
      return new Promise<boolean>((resolve) => {
        const cancel = () => {
          if (waiting?.batch === batch) waiting = undefined;
          context.signal.removeEventListener('abort', cancel); resolve(false);
        };
        waiting = { batch, context, resolve, cancel };
        context.signal.addEventListener('abort', cancel, { once: true });
        if (context.signal.aborted) cancel();
      });
    },
    take(): DesktopRoomBatch | undefined {
      const result = queued;
      result?.context.signal.removeEventListener('abort', result.discard);
      queued = undefined;
      promote();
      return result && !result.context.signal.aborted && result.context.isCurrent() ? result.batch : undefined;
    },
    close() {
      closed = true;
      queued?.context.signal.removeEventListener('abort', queued.discard);
      queued = undefined;
      waiting?.cancel();
    },
  };
};
