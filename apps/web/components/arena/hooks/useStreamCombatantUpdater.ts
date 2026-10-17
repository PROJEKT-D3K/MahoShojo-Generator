// components/arena/hooks/useStreamCombatantUpdater.ts

import { useState, useCallback, useRef } from 'react';
import { getLogger } from '@/lib/logger';
import { withArenaGenerationActorToken } from '@/lib/arena/resumable-generation-client';
import { authStorage, type OwnedAuthHeaders } from '@/lib/auth';
import { captureAuthIdentity } from '@/lib/auth-identity';
import {
  applyArenaReconciliationUpdates,
  buildArenaReconciliationRetryPayload,
  projectArenaReconciliationCombatants,
  type ArenaReconciliationRetryCombatant,
} from '@mahoshojo/domain/arena-reconciliation';
import { useBattleStore } from '../stores/useBattleStore';
import type { BattleStoreState, CombatantData, UpdatedCombatantData } from '../types';

const log = getLogger('stream-combatant-updater');

interface UpdateCombatantsPayload {
  generationId?: string;
  combatants: any[];
}

interface UpdateCombatantsOptions {
  canCommit?: () => boolean;
  auth?: OwnedAuthHeaders;
}

/**
 * Hook：流式生成后安全更新角色数据
 */
export const useStreamCombatantUpdater = () => {
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const latestInvocation = useRef<symbol | null>(null);

  const setCombatants = useBattleStore((state: BattleStoreState) => state.setCombatants);
  const setUpdatedCombatants = useBattleStore((state: BattleStoreState) => state.setUpdatedCombatants);

  /**
   * 安全地更新角色数据
   *
   * 流程：
   * 1. 调用服务端 API，在服务端验证原生性并重新签名
   * 2. 接收签名后的数据
   * 3. 更新本地状态
   */
  const updateWithPayload = useCallback(async (
    buildPayload: () => UpdateCombatantsPayload | Promise<UpdateCombatantsPayload>,
    options: UpdateCombatantsOptions = {},
  ) => {
    const invocation = Symbol();
    latestInvocation.current = invocation;
    const initialIdentity = captureAuthIdentity();
    let auth = options.auth;
    const isLatestInvocation = () => latestInvocation.current === invocation;
    const canCommit = () => isLatestInvocation()
      && (auth?.identity ?? initialIdentity).isCurrent()
      && (!options.canCommit || options.canCommit());
    const assertCanCommit = () => {
      if (!canCommit()) throw new Error('角色更新上下文已变化，已丢弃过期的服务器响应。');
    };
    setIsUpdating(true);
    setUpdateError(null);

    try {
      assertCanCommit();
      auth ??= await authStorage.getOwnedAuthHeaders(initialIdentity);
      assertCanCommit();
      const payload = await buildPayload();
      assertCanCommit();
      const submittedSnapshot = JSON.stringify(projectArenaReconciliationCombatants(
        payload.combatants as ArenaReconciliationRetryCombatant[],
      ));
      const headers = withArenaGenerationActorToken({
        'Content-Type': 'application/json',
        ...auth.headers,
      });
      const execute = async () => {
        const response = await fetch('/api/arena/update-combatants-after-stream', {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });

        if (!canCommit()) {
          void response.body?.cancel().catch(() => {});
          assertCanCommit();
        }
        if (!response.ok) {
          const errorData = await response.json();
          assertCanCommit();
          const details = Array.isArray(errorData.errors)
            ? errorData.errors.flatMap((value: unknown) => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
              const message = (value as { message?: unknown }).message;
              return typeof message === 'string' && message.trim() ? [message.trim()] : [];
            })
            : [];
          throw new Error([
            errorData.error || '更新角色数据失败',
            ...details,
          ].join('；'));
        }
        const result = await response.json();
        assertCanCommit();
        return result;
      };
      const result = await execute();

      const currentCombatants = useBattleStore.getState().combatants;
      const currentSnapshot = JSON.stringify(projectArenaReconciliationCombatants(
        currentCombatants.filter((combatant): combatant is CombatantData => 'data' in combatant),
      ));
      if (!canCommit() || currentSnapshot !== submittedSnapshot) {
        throw new Error('角色更新上下文已变化，已丢弃过期的服务器响应。');
      }

      if (result.updatedCombatants && result.updatedCombatants.length > 0) {
        const projection = applyArenaReconciliationUpdates(currentCombatants, result.updatedCombatants);
        setUpdatedCombatants(projection.updatedCombatants as UpdatedCombatantData[]);
        setCombatants(projection.combatants);
        log.info('成功更新角色数据', { count: result.updatedCombatants.length });
      } else if (Array.isArray(result.updatedCombatants)) {
        setUpdatedCombatants([]);
      }

      if (Array.isArray(result.warnings) && result.warnings.length > 0) {
        const warningMessage = result.warnings.flatMap((value: unknown) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const message = (value as { message?: unknown }).message;
          return typeof message === 'string' && message.trim() ? [message.trim()] : [];
        }).join('；');
        if (warningMessage) {
          log.warn('部分角色未能同步', { warningMessage });
          setUpdateError(`部分角色未能同步：${warningMessage}`);
        }
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      if (canCommit()) {
        log.error('更新角色数据失败', { error: errorMessage });
        setUpdateError(errorMessage);
      }
      throw error;
    } finally {
      if (isLatestInvocation()) setIsUpdating(false);
    }
  }, [setCombatants, setUpdatedCombatants]);

  const updateCombatants = useCallback((
    payload: UpdateCombatantsPayload,
    options: UpdateCombatantsOptions = {},
  ) => updateWithPayload(() => payload, options), [updateWithPayload]);

  /** generationId 对应的 report / impacts / 写入策略全部以服务器冻结值为准。 */
  const updateFromMarkdown = useCallback(
    async (
      _markdown: string,
      combatants: CombatantData[],
      _mode: string,
      _settings: {
        userGuidance: string;
        writeArenaHistory: boolean;
        writeCurrentState: boolean;
      },
      _scenario?: any,
      _metaOverride?: {
        report?: { headline?: string; winner?: string };
        impacts?: Array<{
          characterName: string;
          impact?: string;
          currentStateSummary?: string;
        }>;
      },
      generationId?: string | null,
      options: UpdateCombatantsOptions = {},
    ) => {
      if (!generationId) throw new Error('缺少服务器 generationId，无法同步角色状态。');
      return updateWithPayload(
        () => buildArenaReconciliationRetryPayload(generationId, combatants),
        options,
      );
    },
    [updateWithPayload]
  );

  const retryGenerationUpdate = useCallback(
    async (
      generationId: string,
      combatants: CombatantData[],
      canCommit?: () => boolean,
      auth?: OwnedAuthHeaders,
    ) => (
      updateWithPayload(
        () => buildArenaReconciliationRetryPayload(generationId, combatants),
        { canCommit, auth },
      )
    ),
    [updateWithPayload]
  );

  return {
    updateCombatants,
    updateFromMarkdown,
    retryGenerationUpdate,
    isUpdating,
    updateError,
  };
};
