'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';

import { captureAuthIdentity, type AuthIdentity } from '@/lib/auth-identity';

import type {
  ArenaRoomHttpErrorCode,
  ArenaRoomSharedConfig,
} from '@mahoshojo/contracts/arena-room';

import { useBattleStore } from '@/components/arena/stores/useBattleStore';
import type {
  ArenaRoomController,
  ArenaRoomControllerState,
} from '@/lib/arena-room/controller';
import {
  applyArenaRoomAuthorityToBattleStore,
  ArenaRoomReconciliationAbortError,
  ArenaRoomReconciliationTransientError,
} from '@/lib/arena-room/host-reconciliation';
import { areArenaRoomSharedConfigsExactlyEqual } from '@/lib/arena-room/shared-config-equality';
import { verifyArenaContentOrigin } from '@/lib/arena/verify-origin';
import {
  areArenaRoomSharedConfigsEqual,
  arenaRoomHostWorkspaceAuthorityFromSession,
  type ArenaRoomHostWorkspace,
  type ArenaRoomHostWorkspaceAuthority,
  type ArenaRoomHostWorkspaceDirtyReason,
} from '@/lib/arena-room/host-workspace';
import { fetchPublicDataCardRowById } from '@/lib/public-card-cache/public-data-card-api';
import { buildArenaRoomHostWorkspaceBundleFromBattleState } from '@/lib/arena-room/shared-config';

export type ArenaRoomHostReconciliationState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{
      kind: 'synchronizing';
      action: 'auto' | 'publish' | 'sync-room';
    }>
  | Readonly<{
      kind: 'synced';
      refreshFailed?: boolean;
      revision: number;
      message: string;
    }>
  | Readonly<{
      kind: 'conflicted';
      revision: number;
      reasons: readonly ArenaRoomHostWorkspaceDirtyReason[];
      roomConfig: ArenaRoomSharedConfig;
      localConfig: ArenaRoomSharedConfig | null;
    }>
  | Readonly<{
      kind: 'error';
      code: ArenaRoomHostReconciliationErrorCode;
      message: string;
    }>;

export type ArenaRoomHostReconciliationErrorCode = Extract<
  ArenaRoomHttpErrorCode,
  'ROOM_GENERATION_RECONCILIATION_REQUIRED'
>;

export const ARENA_ROOM_HOST_RECONCILIATION_ERROR_CODE: ArenaRoomHostReconciliationErrorCode = (
  'ROOM_GENERATION_RECONCILIATION_REQUIRED'
);

export type ArenaRoomHostReconciliation = Readonly<{
  state: ArenaRoomHostReconciliationState;
  reconcilePublished(): void;
  publishLocal(): Promise<void>;
  syncRoom(): Promise<void>;
  dismiss(): void;
}>;

const authorityIdentity = (authority: ArenaRoomHostWorkspaceAuthority): string => (
  `${authority.roomId}\n${authority.roomEpoch}\n${authority.ownerUserId}`
);

const isSameAuthorityRevision = (
  left: ArenaRoomHostWorkspaceAuthority | null,
  right: ArenaRoomHostWorkspaceAuthority,
): boolean => Boolean(
  left
  && authorityIdentity(left) === authorityIdentity(right)
  && left.revision === right.revision,
);

const authorityKeyOf = (authority: ArenaRoomHostWorkspaceAuthority): string => (
  `${authorityIdentity(authority)}\n${authority.revision}`
);

const DEFAULT_RECONCILE_RETRY_DELAY_MS = 400;

const loadPublicCard = async (id: string): Promise<unknown> => {
  const result = await fetchPublicDataCardRowById(id, { fresh: true });
  if (result.kind === 'success') return result.card;
  throw result.kind === 'not-found'
    ? new Error(`公开数据卡 ${id} 已不存在`)
    : new ArenaRoomReconciliationTransientError(`公开数据卡 ${id} 暂时无法读取`);
};

/**
 * 语义 fence：host workspace bundle 只由这些 store 字段派生（见
 * buildArenaRoomHostWorkspaceBundle 的数据来源）。这些字段的引用不变即派生结果不变；
 * 不影响共享配置的 store 更新（流式文本、生成镜像、调试态等）不应中止正在进行的物化。
 * 之前用整个 useBattleStore state 对象做引用比较，任何无关更新都会让「需要异步拉取
 * 在线数据卡」的物化（例如成员随机匹配的公开角色）失败并停在半同步状态。
 */
const BUNDLE_SOURCE_FIELD_KEYS = [
  'battleMode',
  'reportFormat',
  'webPackageRef',
  'combatants',
  'teams',
  'scenario',
  'auxScenarios',
  'materials',
  'storyLength',
  'customStoryLength',
  'selectedLanguage',
  'settings',
] as const;

const captureBundleSourceRefs = (
  state: ReturnType<typeof useBattleStore.getState>,
): readonly unknown[] => BUNDLE_SOURCE_FIELD_KEYS.map((key) => state[key]);

const sameBundleSourceRefs = (
  left: readonly unknown[],
  right: readonly unknown[],
): boolean => left.length === right.length
  && left.every((value, index) => value === right[index]);

const isRetryableReconciliationError = (error: unknown): boolean => (
  error instanceof ArenaRoomReconciliationAbortError
  || error instanceof ArenaRoomReconciliationTransientError
);

const currentAuthority = (
  controller: ArenaRoomController,
): ArenaRoomHostWorkspaceAuthority | null => (
  arenaRoomHostWorkspaceAuthorityFromSession(controller.getSnapshot().session)
);

const configPublishBlocksDraft = (controller: ArenaRoomController): boolean => {
  const snapshot = controller.getSnapshot();
  return snapshot.configPublishPending || snapshot.configPublishResultUnknown || Boolean(snapshot.configTracking);
};

const reconciliationErrorState = (
  error: unknown,
  fallback: string,
): Extract<ArenaRoomHostReconciliationState, { readonly kind: 'error' }> => Object.freeze({
  kind: 'error',
  code: ARENA_ROOM_HOST_RECONCILIATION_ERROR_CODE,
  message: error instanceof Error && error.message.trim() ? error.message : fallback,
});

export const useArenaRoomHostReconciliation = ({
  controller,
  controllerState,
  hostWorkspace,
  retryDelayMs,
  identity: suppliedIdentity,
}: {
  readonly controller: ArenaRoomController;
  readonly identity?: AuthIdentity;
  readonly controllerState: ArenaRoomControllerState;
  readonly hostWorkspace: ArenaRoomHostWorkspace;
  /** 自动同步重试间隔；测试可传 0。 */
  readonly retryDelayMs?: number;
}): ArenaRoomHostReconciliation => {
  const identity = useMemo(() => suppliedIdentity ?? captureAuthIdentity(), [suppliedIdentity]);
  const [stored, setStored] = useState<{ identity: AuthIdentity; state: ArenaRoomHostReconciliationState }>({
    identity, state: { kind: 'idle' },
  });
  const setState = useCallback((next: SetStateAction<ArenaRoomHostReconciliationState>) => {
    if (!identity.isCurrent()) return;
    setStored((previous) => ({
      identity,
      state: typeof next === 'function'
        ? next(previous.identity === identity ? previous.state : { kind: 'idle' })
        : next,
    }));
  }, [identity]);
  const observedAuthorityRef = useRef<ArenaRoomHostWorkspaceAuthority | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);
  const actionLockRef = useRef(false);
  const refreshedAuthorityKeyRef = useRef<string | null>(null);
  const operationGenerationRef = useRef(0);
  // Observing an unresolved request must never install its authority over the draft.
  // Keep this guard after the explicit fresh read, until a deliberate publish/sync.
  const preserveDraftRef = useRef(Boolean(controllerState.configDraftPreserved));

  const installAuthority = useCallback(async (
    authority: ArenaRoomHostWorkspaceAuthority,
    action: 'auto' | 'sync-room',
    operationGeneration: number,
    expectedSourceRefs?: readonly unknown[],
  ): Promise<boolean> => {
    if (!identity.isCurrent() || configPublishBlocksDraft(controller)) return false;
    setState({ kind: 'synchronizing', action });
    const battleStateAtStart = useBattleStore.getState();
    const sourceRefsAtStart = captureBundleSourceRefs(battleStateAtStart);
    if (expectedSourceRefs && !sameBundleSourceRefs(expectedSourceRefs, sourceRefsAtStart)) {
      throw new ArenaRoomReconciliationAbortError('读取房间配置期间本地内容已变化，未覆盖新的本地修改');
    }
    const currentBundle = await buildArenaRoomHostWorkspaceBundleFromBattleState(
      battleStateAtStart,
    );
    if (!identity.isCurrent() || configPublishBlocksDraft(controller)) return false;
    const roomStart = hostWorkspace.startFromRoom(authority);
    await applyArenaRoomAuthorityToBattleStore(authority.sharedConfig, {
      currentBundle,
      loadPublicCard,
      hostLocalPayloads: roomStart?.hostLocalPayloads,
      verifyOrigin: verifyArenaContentOrigin,
      commitIf: () => (
        identity.isCurrent()
        && !configPublishBlocksDraft(controller)
        && operationGenerationRef.current === operationGeneration
        && sameBundleSourceRefs(sourceRefsAtStart, captureBundleSourceRefs(useBattleStore.getState()))
        && isSameAuthorityRevision(currentAuthority(controller), authority)
      ),
    });
    if (
      (!identity.isCurrent() || configPublishBlocksDraft(controller) || operationGenerationRef.current !== operationGeneration)
      || !isSameAuthorityRevision(currentAuthority(controller), authority)
    ) return false;
    const synchronizedState = useBattleStore.getState();
    const synchronizedRefs = captureBundleSourceRefs(synchronizedState);
    const synchronizedBundle = await buildArenaRoomHostWorkspaceBundleFromBattleState(
      synchronizedState,
    );
    if (
      (!identity.isCurrent() || configPublishBlocksDraft(controller) || operationGenerationRef.current !== operationGeneration)
      || !sameBundleSourceRefs(synchronizedRefs, captureBundleSourceRefs(useBattleStore.getState()))
      || !isSameAuthorityRevision(currentAuthority(controller), authority)
    ) {
      throw new ArenaRoomReconciliationAbortError('房间配置同步期间状态已变化，未覆盖新的本地修改');
    }
    if (!areArenaRoomSharedConfigsEqual(
      synchronizedBundle.sharedConfig,
      authority.sharedConfig,
    )) {
      // 写入后本地仍与权威不一致：交给重试重新判定 dirty/clean，
      // 真实本地修改会以 conflicted 呈现给房主，而不是永久卡在半同步。
      throw new ArenaRoomReconciliationAbortError('同步后的本地配置仍与当前房间配置不一致');
    }
    hostWorkspace.capturePublished(authority, synchronizedBundle);
    refreshedAuthorityKeyRef.current = authorityKeyOf(authority);
    setState({
      kind: 'synced',
      revision: authority.revision,
      message: action === 'auto'
        ? '房间配置已更新，并同步到 Arena 编辑区'
        : '已放弃本地冲突修改并同步当前房间配置',
    });
    return true;
  }, [controller, hostWorkspace, identity, setState]);

  const runAutoReconcile = useCallback((): void => {
    if (!identity.isCurrent() || actionLockRef.current) return;
    // Read live controller state: an old effect must not clear a new request's guard.
    const live = controller.getSnapshot();
    if (live.configDraftPreserved === false && !live.configTracking && !live.configPublishResultUnknown) {
      preserveDraftRef.current = false;
    }
    if (configPublishBlocksDraft(controller)) { preserveDraftRef.current = true; return; }
    const authority = currentAuthority(controller);
    if (preserveDraftRef.current && authority) {
      const operation = ++operationGenerationRef.current;
      const sourceRefs = captureBundleSourceRefs(useBattleStore.getState());
      void buildArenaRoomHostWorkspaceBundleFromBattleState(useBattleStore.getState()).then((bundle) => {
        if (!identity.isCurrent() || operation !== operationGenerationRef.current
          || configPublishBlocksDraft(controller)
          || !isSameAuthorityRevision(currentAuthority(controller), authority)
          || !sameBundleSourceRefs(sourceRefs, captureBundleSourceRefs(useBattleStore.getState()))) return;
        const comparison = hostWorkspace.compare(authority, bundle);
        setState({ kind: 'conflicted', revision: authority.revision,
          reasons: comparison.kind === 'dirty' ? comparison.reasons : [],
          roomConfig: authority.sharedConfig, localConfig: bundle.sharedConfig });
      }).catch((error) => {
        if (identity.isCurrent() && operation === operationGenerationRef.current) {
          setState(reconciliationErrorState(error, '比较保留的本地草稿失败'));
        }
      });
      return;
    }
    if (!authority) {
      operationGenerationRef.current += 1;
      observedAuthorityRef.current = null;
      refreshedAuthorityKeyRef.current = null;
      inFlightKeyRef.current = null;
      setState({ kind: 'idle' });
      return;
    }
    const previous = observedAuthorityRef.current;
    if (!previous || authorityIdentity(previous) !== authorityIdentity(authority)) {
      // 首次观察若已捕获发布基线，也需检查 latest 归一化带来的正文漂移。
      operationGenerationRef.current += 1;
      observedAuthorityRef.current = authority;
      inFlightKeyRef.current = null;
      setState({ kind: 'idle' });
      if (!hostWorkspace.needsOnlineRefresh?.(authority)) return;
    }
    // observed 只表示「看见过」；是否仍需同步以「已成功落定的基线」为准。
    // 若以 observed 判定，自动同步失败的当前 revision 会被视为已处理，
    // 瞬时错误后将永远无法对同一 revision 重试。
    observedAuthorityRef.current = authority;
    const settledAuthority = hostWorkspace.settledAuthority();
    if (
      settledAuthority
      && authorityIdentity(settledAuthority) === authorityIdentity(authority)
      && settledAuthority.revision >= authority.revision
      && (!hostWorkspace.needsOnlineRefresh?.(authority)
        || refreshedAuthorityKeyRef.current === authorityKeyOf(authority))
    ) return;
    const key = authorityKeyOf(authority);
    if (inFlightKeyRef.current === key) return;
    const operationGeneration = ++operationGenerationRef.current;
    inFlightKeyRef.current = key;
    setState({ kind: 'synchronizing', action: 'auto' });
    void (async () => {
      try {
        // 同一 revision 的自动同步最多尝试 3 次：fence 中止或在线数据卡暂时读取失败时
        // 自动重试，避免「服务器已接受、房主工作区仍旧」的半同步状态；重试会重新判定
        // dirty/clean，真实本地修改会收敛为 conflicted，权威确实失效时保持 error。
        const maxAttempts = 3;
        for (let attempt = 1; ; attempt += 1) {
          try {
            const stateBeforeComparison = useBattleStore.getState();
            const comparisonSourceRefs = captureBundleSourceRefs(stateBeforeComparison);
            const bundle = await buildArenaRoomHostWorkspaceBundleFromBattleState(
              stateBeforeComparison,
            );
            if ((!identity.isCurrent() || operationGenerationRef.current !== operationGeneration)) return;
            if (!sameBundleSourceRefs(comparisonSourceRefs, captureBundleSourceRefs(useBattleStore.getState()))) {
              throw new ArenaRoomReconciliationAbortError('检查房间配置期间本地内容已变化');
            }
            const settled = hostWorkspace.settledAuthority();
            // 脏判定只参照「已成功落定的基线」；从未安装过的中间 revision
            // 不构成房主本地修改。没有落定基线时退回旧行为（与上一个观察对比）。
            const reference = settled && authorityIdentity(settled) === authorityIdentity(authority)
              ? settled
              : previous ?? authority;
            const comparison = hostWorkspace.compare(reference, bundle);
            if ((!identity.isCurrent() || operationGenerationRef.current !== operationGeneration)) return;
            if (comparison.kind === 'dirty') {
              setState({
                kind: 'conflicted',
                revision: authority.revision,
                reasons: comparison.reasons,
                roomConfig: authority.sharedConfig,
                localConfig: bundle.sharedConfig,
              });
              return;
            }
            if (settled && isSameAuthorityRevision(settled, authority)
              && areArenaRoomSharedConfigsExactlyEqual(bundle.sharedConfig, authority.sharedConfig)) {
              refreshedAuthorityKeyRef.current = key;
              setState({ kind: 'idle' });
              return;
            }
            await installAuthority(authority, 'auto', operationGeneration);
            return;
          } catch (error) {
            if (
              (!identity.isCurrent() || operationGenerationRef.current !== operationGeneration)
              || !isSameAuthorityRevision(currentAuthority(controller), authority)
            ) return;
            if (attempt >= maxAttempts || !isRetryableReconciliationError(error)) {
              const failure = reconciliationErrorState(error, '自动同步房间配置失败');
              setState(isSameAuthorityRevision(hostWorkspace.settledAuthority(), authority)
                ? { kind: 'synced', refreshFailed: true, revision: authority.revision, message: `房间配置已保存；Arena 编辑区暂未刷新，可手动同步重试：${failure.message}` }
                : failure);
              return;
            }
            await new Promise<void>((resolve) => {
              setTimeout(resolve, retryDelayMs !== undefined
                ? retryDelayMs
                : DEFAULT_RECONCILE_RETRY_DELAY_MS * attempt);
            });
            if (
              (!identity.isCurrent() || operationGenerationRef.current !== operationGeneration)
              || !isSameAuthorityRevision(currentAuthority(controller), authority)
            ) return;
          }
        }
      } finally {
        if (inFlightKeyRef.current === key) inFlightKeyRef.current = null;
      }
    })();
  }, [controller, hostWorkspace, identity, installAuthority, retryDelayMs, setState]);

  const publishLocal = useCallback(async (): Promise<void> => {
    if (!identity.isCurrent() || actionLockRef.current) return;
    if (configPublishBlocksDraft(controller)) { preserveDraftRef.current = true; return; }
    const authority = currentAuthority(controller);
    if (!authority) return;
    const operationGeneration = ++operationGenerationRef.current;
    actionLockRef.current = true;
    setState({ kind: 'synchronizing', action: 'publish' });
    let publishConfirmed = false;
    try {
      const stateAtBuildStart = useBattleStore.getState();
      const sourceRefsAtBuildStart = captureBundleSourceRefs(stateAtBuildStart);
      const bundle = await buildArenaRoomHostWorkspaceBundleFromBattleState(
        stateAtBuildStart,
      );
      if (!sameBundleSourceRefs(sourceRefsAtBuildStart, captureBundleSourceRefs(useBattleStore.getState()))) {
        throw new ArenaRoomReconciliationAbortError('准备发布期间本地内容已变化，请确认最新修改后重试');
      }
      const beforePublishState = controller.getSnapshot();
      const beforePublishAuthority = arenaRoomHostWorkspaceAuthorityFromSession(beforePublishState.session);
      const expectedControlSeq = beforePublishState.session?.snapshot.controlSeq;
      if (
        !beforePublishAuthority
        || authorityIdentity(beforePublishAuthority) !== authorityIdentity(authority)
        || beforePublishAuthority.revision !== authority.revision
        || expectedControlSeq === undefined
      ) {
        throw new ArenaRoomReconciliationAbortError('房间权威状态已变化，请先同步最新房间配置');
      }
      const result = await controller.publishConfig({
        expectedRoomEpoch: authority.roomEpoch,
        expectedRevision: authority.revision,
        expectedControlSeq,
        sharedConfig: bundle.sharedConfig,
      });
      if (result.kind !== 'confirmed') throw result.error;
      const published = arenaRoomHostWorkspaceAuthorityFromSession(result.session);
      if (
        !published
        || (!identity.isCurrent() || operationGenerationRef.current !== operationGeneration)
        || authorityIdentity(published) !== authorityIdentity(authority)
        || published.revision < authority.revision
        || !areArenaRoomSharedConfigsEqual(published.sharedConfig, bundle.sharedConfig)
      ) {
        throw new Error('房间尚未确认配置更新结果，请重新连接并核对');
      }
      hostWorkspace.capturePublished(published, bundle);
      refreshedAuthorityKeyRef.current = null;
      setState({
        kind: 'synced',
        revision: published.revision,
        message: '房间配置已更新',
      });
      publishConfirmed = true;
    } catch (error) {
      if ((!identity.isCurrent() || operationGenerationRef.current !== operationGeneration)) return;
      setState(reconciliationErrorState(error, '更新房间配置失败'));
    } finally {
      if (identity.isCurrent()) actionLockRef.current = false;
      if (publishConfirmed && identity.isCurrent()) {
        preserveDraftRef.current = false;
        // 仅确认成功后才对账；明确拒绝与结果未知都不能借旧缓存自动物化。
        runAutoReconcile();
      }
    }
  }, [controller, hostWorkspace, identity, runAutoReconcile, setState]);

  const syncRoom = useCallback(async (): Promise<void> => {
    if (!identity.isCurrent() || actionLockRef.current) return;
    if (configPublishBlocksDraft(controller)) { preserveDraftRef.current = true; return; }
    const initialAuthority = currentAuthority(controller);
    if (!initialAuthority) return;
    const operationGeneration = ++operationGenerationRef.current;
    const expectedSourceRefs = captureBundleSourceRefs(useBattleStore.getState());
    actionLockRef.current = true;
    setState({ kind: 'synchronizing', action: 'sync-room' });
    try {
      const refreshedSession = await controller.refreshSession();
      if ((!identity.isCurrent() || operationGenerationRef.current !== operationGeneration)) return;
      if (!sameBundleSourceRefs(expectedSourceRefs, captureBundleSourceRefs(useBattleStore.getState()))) {
        throw new ArenaRoomReconciliationAbortError('读取房间配置期间本地内容已变化，未覆盖新的本地修改');
      }
      const refreshedAuthority = currentAuthority(controller);
      const responseAuthority = arenaRoomHostWorkspaceAuthorityFromSession(refreshedSession);
      if (
        !refreshedAuthority
        || !responseAuthority
        || refreshedAuthority.roomId !== initialAuthority.roomId
        || refreshedAuthority.ownerUserId !== initialAuthority.ownerUserId
        || authorityIdentity(responseAuthority) !== authorityIdentity(refreshedAuthority)
        || (refreshedAuthority.roomEpoch === responseAuthority.roomEpoch
          && refreshedAuthority.revision < responseAuthority.revision)
      ) {
        throw new ArenaRoomReconciliationAbortError('读取到的房间身份或版本已变化，请重新确认房间状态');
      }
      if (configPublishBlocksDraft(controller)) return;
      if (await installAuthority(refreshedAuthority, 'sync-room', operationGeneration, expectedSourceRefs)) {
        controller.acknowledgeConfigDraftSync?.(refreshedSession);
        preserveDraftRef.current = false;
      }
    } catch (error) {
      if ((!identity.isCurrent() || operationGenerationRef.current !== operationGeneration)) return;
      setState(reconciliationErrorState(error, '同步房间配置失败'));
    } finally {
      if (identity.isCurrent()) actionLockRef.current = false;
    }
  }, [controller, identity, installAuthority, setState]);

  useEffect(() => {
    operationGenerationRef.current += 1;
    observedAuthorityRef.current = null;
    inFlightKeyRef.current = null;
    refreshedAuthorityKeyRef.current = null;
    actionLockRef.current = false;
    preserveDraftRef.current = Boolean(controller.getSnapshot().configDraftPreserved);
    setState({ kind: 'idle' });
    return () => { operationGenerationRef.current += 1; };
  }, [controller, identity, setState]);

  // 只依赖 authority 身份 + revision：proposal.resolved / member 变动等
  // 同 revision 的 session 更新不得取消正在进行的配置物化。
  const authorityKey = useMemo(() => {
    const session = controllerState.session;
    if (!session || session.self.role !== 'host') return null;
    return `${session.roomId}\n${session.roomEpoch}\n${session.self.userId}\n${session.snapshot.revision}`;
  }, [controllerState.session]);

  useEffect(() => {
    if (controllerState.configPublishResultUnknown || controllerState.configTracking) {
      preserveDraftRef.current = true;
      operationGenerationRef.current += 1;
      inFlightKeyRef.current = null;
      setState({ kind: 'idle' });
      return;
    }
    runAutoReconcile();
  }, [authorityKey, controllerState.configPublishResultUnknown, controllerState.configTracking, runAutoReconcile, setState]);

  return {
    state: stored.identity === identity && identity.isCurrent() ? stored.state : { kind: 'idle' },
    reconcilePublished() {
      if (!identity.isCurrent()) return;
      refreshedAuthorityKeyRef.current = null;
      runAutoReconcile();
    },
    publishLocal,
    syncRoom,
    dismiss() {
      setState({ kind: 'idle' });
    },
  };
};
