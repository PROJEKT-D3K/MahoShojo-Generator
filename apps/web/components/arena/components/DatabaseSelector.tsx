'use client';
import Link from 'next/link';
import { MAX_COMBATANTS } from '../types';
import { ArenaCharacterDatabaseSelector, type ArenaCharacterDatabaseSelectorProps } from '@mahoshojo/ui-web/arena';
export function DatabaseSelector({ maxCombatants = MAX_COMBATANTS, ...props }: ArenaCharacterDatabaseSelectorProps) {
  return <ArenaCharacterDatabaseSelector {...props} maxCombatants={maxCombatants} loginLink={<Link href="/character-manager" className="battle-lite-link underline">登录后可访问私有数据卡</Link>} />;
}
