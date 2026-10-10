import type { BattleStoryRoleResolution } from '@mahoshojo/domain/arena-story-completed-output';
import { readJsonOrTextFromResponse, resolveApiErrorMessage } from '@/lib/client/apiError';
import { mergeUpdatedCombatantsIntoWorkingCombatants } from './battleStorySession';

export type WebBattleStoryRoleResult = {
  workingCombatants: Array<Record<string, unknown>>;
  role: BattleStoryRoleResolution;
  warning?: string;
};

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Headerless Web DTO only. No Desktop version header, response budget or signature inference. */
export async function resolveWebBattleStoryRoles(input: {
  body: string;
  headers: Headers;
  workingCombatants: Array<Record<string, unknown>>;
}): Promise<WebBattleStoryRoleResult> {
  const response = await fetch('/api/arena/update-combatants-after-stream', {
    method: 'POST', headers: input.headers, body: input.body,
  });
  if (!response.ok) {
    // The HTTP status already proves failure; an unreadable error body cannot turn it into success.
    const { payload } = await readJsonOrTextFromResponse(response).catch(() => ({ payload: null }));
    const errors = recordOf(payload)?.errors;
    const details = Array.isArray(errors) ? errors.flatMap((value) => {
      const message = recordOf(value)?.message;
      return typeof message === 'string' && message.trim() ? [message.trim()] : [];
    }) : [];
    const warning = `⚠️ 本章角色状态同步失败：${[
      resolveApiErrorMessage({ payload, fallback: '角色更新失败' }), ...details,
    ].join('；')}。已保留原角色状态。`;
    return { workingCombatants: input.workingCombatants, role: { status: 'http-failure', warning }, warning };
  }
  const payload = recordOf(await response.json());
  const updates = payload?.updatedCombatants;
  const seen = new Set<number>();
  if (payload?.success !== true || !Array.isArray(updates) || updates.some((value) => {
    const update = recordOf(value);
    const index = update?.combatantIndex;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0
      || index >= input.workingCombatants.length || seen.has(index)
      || !recordOf(update?.data) || typeof update?.isNative !== 'boolean') return true;
    seen.add(index);
    return false;
  }) || (payload.warnings !== undefined && (!Array.isArray(payload.warnings) || payload.warnings.some((value) => {
    const warning = recordOf(value);
    return !warning || typeof warning.message !== 'string';
  })))) throw new Error('角色同步响应格式无效，完整正文仍保留。');

  const warningMessage = Array.isArray(payload.warnings)
    ? payload.warnings.map((value) => String(recordOf(value)!.message).trim()).filter(Boolean).join('；') : '';
  const warning = warningMessage ? `⚠️ ${warningMessage}` : undefined;
  return {
    workingCombatants: mergeUpdatedCombatantsIntoWorkingCombatants(input.workingCombatants,
      updates as Array<{ combatantIndex: number; data: Record<string, unknown>; isNative: boolean }>),
    role: { status: 'accepted', ...(warning ? { warning } : {}) },
    ...(warning ? { warning } : {}),
  };
}
