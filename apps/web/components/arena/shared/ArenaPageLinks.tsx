'use client';

import Link from 'next/link';
import { ArenaPageLinks as SharedArenaPageLinks, type ArenaPageLinksProps } from '@mahoshojo/ui-web/arena';

export function ArenaPageLinks(props: Omit<ArenaPageLinksProps, 'Link' | 'onNavigateExternal'>) {
  return <SharedArenaPageLinks {...props} Link={Link} />;
}
