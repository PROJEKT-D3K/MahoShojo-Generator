import { inferCombatantType } from '@mahoshojo/domain/arena-character-validator';
import { getCombatantTypeLabel } from '@mahoshojo/domain/arena-file-parser';
import { arenaItemName } from './input';
import type { ArenaSessionState } from './session';

/** 仅投影结果快照供展示/下载；key 不赋予本地保存或云端写入资格。 */
export function projectDesktopRoleUpdates(state: Pick<ArenaSessionState, 'hosted' | 'hostedGenerationId' | 'roleUpdates' | 'candidates'>) {
  const hosted = Boolean(state.hosted);
  const generationId = hosted ? state.hostedGenerationId : state.candidates?.generationId;
  const items = hosted ? state.roleUpdates.items : state.candidates?.characterEffects ?? [];
  return items.map(item => {
    const history = item.data.arena_history as { entries?: { impact?: unknown }[] } | undefined;
    const impact = Array.isArray(history?.entries) ? history.entries.at(-1)?.impact : null;
    const summary = (item.data.current_state as { summary?: unknown } | undefined)?.summary;
    const signature = typeof item.data.signature === 'string' && item.data.signature.length > 0;
    const provenance = !signature ? '未签名' : hosted && 'isNative' in item && item.isNative && state.roleUpdates.status !== 'restored'
      ? '官方签名（服务器更新）' : '含签名字段（本机未验证）';
    return {
      key: JSON.stringify([hosted ? 'hosted' : 'direct', generationId ?? 'restored', item.combatantIndex]),
      displayName: arenaItemName(item.data),
      typeLabel: `${getCombatantTypeLabel(inferCombatantType(item.data))} · ${provenance}`,
      impact: typeof impact === 'string' ? impact : null,
      currentStateSummary: typeof summary === 'string' ? summary : null,
      data: item.data,
      selection: generationId ? { generationId, combatantIndex: item.combatantIndex, data: item.data } : null,
    };
  });
}
