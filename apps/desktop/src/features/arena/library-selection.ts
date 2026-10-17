import { buildAdjudicationSourceKey } from '@mahoshojo/domain/arena-adjudication-events';
import { getCombatantCardLibrarySelectionId } from '@mahoshojo/domain/arena-file-parser';
import { buildArenaMaterialState } from '@mahoshojo/domain/arena-materials';
import type { CardLibrarySelectionContext } from '@mahoshojo/ui-web/card-library';
import { addAdvancedAuxScenario, removeAdvancedAuxScenarios, setAdvancedMainScenario } from './advanced-input';
import { arenaItemName, parseArenaScenario } from './input';
import { arenaReferenceCount, type ArenaDraft } from './session';
import { ARENA_CANONICAL_CAPABILITIES } from '@mahoshojo/contracts/arena-capabilities';

/** Reference uploads may contain opaque IDs; only the explicit library marker selects a row. */
export const getArenaReferenceSelectionId = (value: unknown): string | null => getCombatantCardLibrarySelectionId({
  cardLibrarySelectionId: value && typeof value === 'object' ? (value as { cardLibrarySelectionId?: unknown }).cardLibrarySelectionId : undefined,
});

export function resolveArenaLibrarySource(context: CardLibrarySelectionContext) {
  const selectionId = getArenaReferenceSelectionId({ cardLibrarySelectionId: context.rowSelectionId ?? context.selectionId });
  if (!selectionId) throw new Error('卡库来源身份不匹配，请重新选择。');
  const onlineId = context.storageLocation === 'cloud' && context.cloudCardId?.trim() ? context.cloudCardId.trim() : null;
  if (onlineId && context.selectionId !== `cloud:${onlineId}`) throw new Error('卡库来源身份不匹配，请重新选择。');
  return { selectionId, onlineId };
}

export function applyArenaLibraryReferenceSelection(
  draft: ArenaDraft,
  purpose: 'scenario' | 'auxScenario' | 'material',
  selected: boolean,
  context: CardLibrarySelectionContext,
  options: { advanced: boolean; createId: () => string; onWarning: (message: string) => void },
): ArenaDraft {
  const { selectionId, onlineId } = resolveArenaLibrarySource(context);
  const existing = purpose === 'auxScenario' ? draft.auxScenarios : purpose === 'material' ? draft.materials : [];
  const indices = existing.flatMap((item, index) => getArenaReferenceSelectionId(item) === selectionId ? [index] : []);
  if (!selected) {
    if (!indices.length) return draft;
    return purpose === 'auxScenario' ? removeAdvancedAuxScenarios(draft, indices)
      : { ...draft, materials: draft.materials.filter((_, index) => !indices.includes(index)) };
  }
  if (indices.length) return draft;
  if (!context.rawSourceData) throw new Error('卡库未提供完整原文，请重新选择。');
  if (purpose === 'material') {
    if (arenaReferenceCount(draft) >= ARENA_CANONICAL_CAPABILITIES.maxReferenceItemsSanity) throw new Error('参考项超过 256 项，未导入新素材。');
    const { sourceDataCardId: _untrustedId, sourceDataCardUpdatedAt: _untrustedUpdated, ...material } = buildArenaMaterialState({
      payload: context.rawSourceData, id: options.createId(), isNative: false,
    });
    return { ...draft, materials: [...draft.materials, { ...material, cardLibrarySelectionId: selectionId,
      ...(onlineId ? { sourceDataCardId: onlineId, ...(context.cloudCardUpdatedAt ? { sourceDataCardUpdatedAt: context.cloudCardUpdatedAt } : {}) } : {}),
    }] };
  }
  const content = parseArenaScenario(JSON.stringify(context.rawSourceData));
  const sourceKey = buildAdjudicationSourceKey({ sourceDataCardId: onlineId ?? context.selectionId }) ?? undefined;
  if (purpose === 'scenario') return options.advanced
    ? setAdvancedMainScenario(draft, content, null, options.onWarning, sourceKey)
    : { ...draft, scenario: { content, fileName: null }, scenarioDisplayName: arenaItemName(content) };
  if (!options.advanced) throw new Error('当前页面未开放辅助情景。');
  const next = addAdvancedAuxScenario(draft, content, null, options.createId(), options.onWarning, sourceKey);
  return { ...next, auxScenarios: next.auxScenarios.map((item, index) => index === next.auxScenarios.length - 1
    ? { ...item, cardLibrarySelectionId: selectionId } : item) };
}
