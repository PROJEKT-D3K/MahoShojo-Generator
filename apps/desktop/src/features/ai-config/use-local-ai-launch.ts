import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { LocalAiDiscoveryService } from '@mahoshojo/contracts/local-ai-discovery';
import type { LocalAiLaunchSnapshot } from '@mahoshojo/contracts/local-ai-launch';
import {
  cancelLocalAiLaunch, getLocalAiLaunchStatus, prepareLocalAiLaunch, startLocalAi, stopLocalAi,
} from '../../platform/local-ai-launch-bridge';

type Phase = 'idle' | 'preparing' | 'starting' | 'cancelling' | 'stopping' | 'recovering' | 'uncertain';
type Run = {
  identity: string; epoch: number; kind: 'prepare' | 'start' | 'cancel' | 'stop'; cancelled: boolean;
  operationId?: string; cancellation?: Promise<void>;
};
const runtime = { contractVersion: 1 as const, runtimeId: 'ollama' as const };
const transient = (value: LocalAiLaunchSnapshot | null) => Boolean(value && ['preparing', 'starting', 'stopping'].includes(value.state));
const pendingState = (value: LocalAiLaunchSnapshot | null) => transient(value) || value?.state === 'prepared';

/** In-memory UI coordination only. Native remains the authority for tickets and process ownership. */
export function useLocalAiLaunch(identity: string, enabled: boolean, onService: (service: LocalAiDiscoveryService | null) => void) {
  const [snapshot, setSnapshot] = useState<LocalAiLaunchSnapshot | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState('');
  const current = useRef({ identity, enabled, onService });
  current.current = { identity, enabled, onService };
  const epoch = useRef(0);
  const mounted = useRef(false);
  const last = useRef<{ identity: string; epoch: number; snapshot: LocalAiLaunchSnapshot } | null>(null);
  const run = useRef<Run | null>(null);
  const revision = useRef(0);
  const uncertainOperation = useRef<string | undefined>(undefined);
  const awaitingStart = useRef<string | undefined>(undefined);
  const refreshCurrent = useRef<(() => Promise<void>) | null>(null);

  const visible = (startedIdentity: string, startedEpoch: number) => mounted.current && current.current.enabled &&
    current.current.identity === startedIdentity && epoch.current === startedEpoch;
  const publish = (startedIdentity: string, startedEpoch: number, value: LocalAiLaunchSnapshot, fromCache = false) => {
    if (!visible(startedIdentity, startedEpoch)) return;
    last.current = { identity: startedIdentity, epoch: startedEpoch, snapshot: value };
    setSnapshot(value); setNotice('');
    // Cached status restores ownership controls, not a model list or newer HTTP evidence.
    if (!fromCache && value.service) current.current.onService(value.service);
    // A confirmed terminal state invalidates candidates even when read from cached status.
    else if (['stopped', 'cancelled', 'failed'].includes(value.state)) current.current.onService(null);
    if (value.operationId === awaitingStart.current && ['ready', 'external', 'stopped', 'cancelled', 'failed'].includes(value.state)) awaitingStart.current = undefined;
  };
  const markUncertain = (task: Run) => {
    if (run.current !== task) return;
    uncertainOperation.current = task.operationId;
    if (!visible(task.identity, task.epoch)) return;
    setPhase('uncertain');
    setNotice('尚未确认原操作结果，请查询状态，不要重复启动。');
  };
  const cancelTicket = async (task: Run, value?: LocalAiLaunchSnapshot): Promise<void> => {
    task.operationId ??= value?.operationId;
    if (task.cancellation) return task.cancellation;
    // A successful service survives closing. Native also refuses to cancel ready/external ownership.
    if (value && ['idle', 'ready', 'external', 'stopped', 'cancelled', 'failed'].includes(value.state)) {
      if (run.current === task) {
        publish(task.identity, task.epoch, value, task.kind !== 'start');
        if (visible(task.identity, task.epoch)) setPhase('idle');
      }
      return;
    }
    if (!task.operationId) return;
    const operationId = task.operationId;
    task.cancellation = (async () => {
      try {
        let cancelled: LocalAiLaunchSnapshot;
        try { cancelled = await cancelLocalAiLaunch(invoke, { ...runtime, operationId }); }
        catch {
          cancelled = await getLocalAiLaunchStatus(invoke);
          if (cancelled.operationId !== operationId) { markUncertain(task); return; }
        }
        if (run.current === task) {
          publish(task.identity, task.epoch, cancelled, task.kind !== 'start');
          if (visible(task.identity, task.epoch)) setPhase('idle');
        }
      } catch { markUncertain(task); }
    })();
    return task.cancellation;
  };
  const finishRun = (task: Run) => {
    const owned = run.current === task;
    if (owned) run.current = null;
    if (owned && !visible(task.identity, task.epoch) && mounted.current && current.current.enabled) void refreshCurrent.current?.();
  };
  const cancelPending = (startedIdentity?: string) => {
    const task = run.current;
    if (task && task.kind !== 'stop' && (!startedIdentity || task.identity === startedIdentity)) {
      task.cancelled = true;
      if (visible(task.identity, task.epoch)) { setPhase('cancelling'); setNotice(''); }
      // An unresolved prepare retains this continuation until its late ticket can be revoked.
      if (task.operationId) void cancelTicket(task).finally(() => finishRun(task));
      return;
    }
    const previous = last.current;
    if (!task && previous && (!startedIdentity || previous.identity === startedIdentity) &&
      ['preparing', 'prepared', 'starting'].includes(previous.snapshot.state)) {
      const cancellation: Run = { identity: previous.identity, epoch: previous.epoch, kind: 'cancel', cancelled: true, operationId: previous.snapshot.operationId };
      run.current = cancellation; revision.current += 1;
      if (visible(cancellation.identity, cancellation.epoch)) setPhase('cancelling');
      void cancelTicket(cancellation).finally(() => finishRun(cancellation));
    }
  };

  const refresh = async () => {
    if (!enabled || !mounted.current) return;
    const startedIdentity = identity; const startedEpoch = epoch.current; const version = ++revision.current;
    const task = run.current; const previous = last.current;
    const expectedOperation = task?.operationId ?? uncertainOperation.current ?? awaitingStart.current ??
      (previous?.identity === startedIdentity && previous.epoch === startedEpoch && pendingState(previous.snapshot) ? previous.snapshot.operationId : undefined);
    setPhase('recovering');
    try {
      const value = await getLocalAiLaunchStatus(invoke);
      if (!visible(startedIdentity, startedEpoch) || version !== revision.current || run.current !== task) return;
      if (expectedOperation && value.operationId !== expectedOperation) {
        uncertainOperation.current = expectedOperation;
        setPhase('uncertain'); setNotice('原操作仍未确认，请勿重复启动。'); return;
      }
      if (task) {
        task.operationId ??= value.operationId;
        if (task.cancelled && pendingState(value)) { await cancelTicket(task, value); finishRun(task); return; }
        // Do not release a command that has not yet registered or finished. A terminal cached result can recover a lost reply.
        if (['ready', 'external', 'stopped', 'cancelled', 'failed'].includes(value.state)) run.current = null;
      }
      uncertainOperation.current = undefined;
      publish(startedIdentity, startedEpoch, value, task?.kind !== 'start' && value.operationId !== awaitingStart.current);
      setPhase(task && run.current === task ? (task.cancelled ? 'cancelling' : task.kind === 'prepare' ? 'preparing' : task.kind === 'stop' ? 'stopping' : 'starting') : 'idle');
    } catch {
      if (visible(startedIdentity, startedEpoch) && version === revision.current) {
        uncertainOperation.current = expectedOperation;
        setPhase('uncertain'); setNotice('暂时无法确认状态，请查询后再操作。');
      }
    }
  };
  refreshCurrent.current = refresh;

  useEffect(() => {
    mounted.current = true; epoch.current += 1; revision.current += 1; setSnapshot(null); setNotice('');
    setPhase(run.current ? (run.current.cancelled ? 'cancelling' : 'recovering') : 'idle');
    if (enabled) void refresh();
    return () => { mounted.current = false; epoch.current += 1; revision.current += 1; cancelPending(identity); };
    // Only target/open/profile identity triggers cached recovery. Render flags never launch a process.
  }, [identity, enabled]);

  useEffect(() => {
    if (!enabled || run.current || !transient(snapshot) || phase !== 'idle') return;
    const timer = setTimeout(() => void refresh(), 500);
    return () => clearTimeout(timer);
    // Cached polling follows Native cleanup; it never dispatches HTTP/OS discovery.
  }, [identity, enabled, snapshot, phase]);

  const perform = async (kind: 'prepare' | 'start' | 'stop') => {
    if (!enabled || run.current || phase !== 'idle') return;
    const prior = last.current?.identity === identity && last.current.epoch === epoch.current ? last.current.snapshot : null;
    if (kind === 'prepare' && (pendingState(prior) || prior?.state === 'ready')) return;
    if (kind === 'start' && (prior?.state !== 'prepared' || !prior.installation || !prior.operationId)) return;
    if (kind === 'stop' && (!prior || !['ready', 'stopping'].includes(prior.state) || !prior.operationId)) return;
    const task: Run = { identity, epoch: epoch.current, kind, cancelled: false, operationId: kind === 'prepare' ? undefined : prior?.operationId };
    run.current = task; revision.current += 1; uncertainOperation.current = undefined;
    setPhase(kind === 'prepare' ? 'preparing' : kind === 'start' ? 'starting' : 'stopping'); setNotice('');
    if (kind === 'prepare') { last.current = null; setSnapshot(null); }
    if (kind === 'start') awaitingStart.current = task.operationId;
    if (kind === 'stop') current.current.onService(null);
    try {
      let value: LocalAiLaunchSnapshot;
      try {
        value = kind === 'prepare' ? await prepareLocalAiLaunch(invoke) : kind === 'start'
          ? await startLocalAi(invoke, { ...runtime, operationId: task.operationId!, installationId: prior!.installation!.installationId })
          : await stopLocalAi(invoke, { ...runtime, operationId: task.operationId! });
      } catch {
        // Transport rejection does not prove non-execution. Recover the original operation; never resend start.
        value = await getLocalAiLaunchStatus(invoke);
        if (task.operationId && value.operationId !== task.operationId) { markUncertain(task); return; }
      }
      task.operationId ??= value.operationId;
      if (task.cancelled) { await cancelTicket(task, value); return; }
      if (run.current === task) { publish(task.identity, task.epoch, value, task.kind !== 'start'); if (visible(task.identity, task.epoch)) setPhase('idle'); }
    } catch { markUncertain(task); }
    finally { finishRun(task); }
  };

  return {
    snapshot, phase, notice, busy: phase !== 'idle' || transient(snapshot), hasPending: pendingState(snapshot),
    prepare: () => perform('prepare'), start: () => perform('start'), stop: () => perform('stop'),
    cancelPending: () => cancelPending(), refresh,
  };
}
