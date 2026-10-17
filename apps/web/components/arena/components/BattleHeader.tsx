'use client';

import Link from 'next/link';
import { AdvancedArenaHeader } from '@mahoshojo/ui-web/arena';
import { ThemeImage } from '@/components/shared/ThemeImage';

export function BattleHeader() {
  return <AdvancedArenaHeader Link={Link} draftSharing="shared" illustrationAvailable
    logo={<ThemeImage lightSrc="/arena-black.svg" darkSrc="/arena-white.svg" width={320} height={90} alt="魔法少女竞技场" />} />;
}
