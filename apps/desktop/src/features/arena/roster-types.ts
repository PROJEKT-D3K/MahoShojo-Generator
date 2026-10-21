import type { ArenaRandomCombatantPlaceholder } from '@mahoshojo/domain/arena-random-combatants';
import type { ArenaDirectInput } from './direct';

export type ArenaRealCombatant = ArenaDirectInput['combatants'][number] & { desktopSource?: 'online' | 'preset'; cardLibrarySelectionId?: string };
export type ArenaDraftCombatant = ArenaRealCombatant | ArenaRandomCombatantPlaceholder;
export const isArenaRealCombatant = (card: ArenaDraftCombatant): card is ArenaRealCombatant => 'data' in card;
/** 草稿占位符只属于编辑器，任何发送/正文处理路径都必须先物化。 */
export function requireArenaRealCombatants(cards: readonly ArenaDraftCombatant[]): readonly ArenaRealCombatant[] {
  if (!cards.every(isArenaRealCombatant)) throw new Error('随机角色尚未生成，请先在单人对战中生成随机角色后重试。');
  return cards;
}
