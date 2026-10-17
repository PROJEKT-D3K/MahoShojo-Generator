'use client';

import Link from 'next/link';
import { ArenaRankingLinks as SharedArenaRankingLinks, type ArenaRankingLinksProps } from '@mahoshojo/ui-web/arena';

export function ArenaRankingLinks(props: Omit<ArenaRankingLinksProps, 'Link'>) {
  return <SharedArenaRankingLinks {...props} Link={Link} />;
}
