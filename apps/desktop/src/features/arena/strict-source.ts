import { PRESET_LIST } from '@mahoshojo/domain/presets';
import type { ArenaDraft } from './session';

/** Current selection provenance only. No local marker is a server eligibility claim. */
export const isDesktopStrictSource = (card: ArenaDraft['combatants'][number]): boolean =>
  card.desktopSource === 'preset' && card.isPreset && PRESET_LIST.some(preset => preset.filename === card.filename)
  || card.desktopSource === 'online' && !card.isPreset && typeof card.sourceDataCardId === 'string' && !!card.sourceDataCardId.trim();

export function clearDesktopArenaSource(card: ArenaDraft['combatants'][number]): ArenaDraft['combatants'][number] {
  const { desktopSource: _source, ...rest } = card;
  return rest;
}

/** Applies to all new dispatches, including ordinary Hosted's automatic Strict detection. */
export function projectDesktopArenaCombatant(card: ArenaDraft['combatants'][number]): ArenaDraft['combatants'][number] {
  if (isDesktopStrictSource(card)) return card;
  const { sourceDataCardId: _id, sourceDataCardUpdatedAt: _updated, ...rest } = card;
  return { ...rest, isPreset: false };
}

/** Parser-derived type/display information must not replace a referenced source's exact body. */
export function retainDesktopArenaSelectionSource(items: ArenaDraft['combatants'], raw: unknown,
  source: { kind: 'online'; cardId: string } | { kind: 'preset'; filename: string }): ArenaDraft['combatants'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || items.length !== 1) throw new Error('角色来源不是单张完整角色卡，请重新选择。');
  const card = items[0]!;
  const { sourceDataCardId: _id, sourceDataCardUpdatedAt: _updated, ...rest } = card;
  return [{ ...rest, data: structuredClone(raw), isValid: false, desktopSource: source.kind, isPreset: source.kind === 'preset',
    ...(source.kind === 'preset' ? { filename: source.filename } : { sourceDataCardId: source.cardId }) }];
}
