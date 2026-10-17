'use client';

import Link from 'next/link';
import { BattleLiteHeader as SharedBattleLiteHeader } from '@mahoshojo/ui-web/arena';
import { ThemeImage } from '@/components/shared/ThemeImage';

export function BattleLiteHeader() {
  return <SharedBattleLiteHeader Link={Link} draftSharing="shared" illustrationAvailable
    logo={<ThemeImage lightSrc="/arena-black.svg" darkSrc="/arena-white.svg" width={300} height={84} alt="魔法少女竞技场" />} />;
}
