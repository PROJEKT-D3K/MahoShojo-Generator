'use client';

import type { ComponentType, ReactNode } from 'react';
import { NAV_GROUPS } from '../navigation';

export type ArenaPageLinkProps = Readonly<{
  href: string;
  className?: string;
  children?: ReactNode;
}>;
export type ArenaPageLinkComponent = ComponentType<ArenaPageLinkProps>;

export type ArenaPageLinksProps = Readonly<{
  Link: ArenaPageLinkComponent;
  variant: 'lite' | 'full';
  className?: string;
  onNavigateExternal?: (href: string) => void;
}>;

const wantuArenaLink = NAV_GROUPS.flatMap((group) => group.items)
  .find((item) => item.label === '万途竞技场' && item.isExternal);

export function ArenaPageLinks({ Link, variant, className, onNavigateExternal }: ArenaPageLinksProps) {
  const linkClassName = className ?? 'battle-lite-link font-semibold';
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Link href={variant === 'lite' ? '/arena' : '/battle'} className={linkClassName}>
        {variant === 'lite' ? '进入完整版竞技场' : '切换到简洁版'}
      </Link>
      {variant === 'full' && wantuArenaLink ? (
        <a href={wantuArenaLink.href} target="_blank" rel="noopener noreferrer" className={linkClassName}
          onClick={onNavigateExternal ? (event) => { event.preventDefault(); onNavigateExternal(wantuArenaLink.href); } : undefined}>
          前往万途竞技场
        </a>
      ) : null}
    </div>
  );
}

export type ArenaRankingLinksProps = Readonly<{
  Link: ArenaPageLinkComponent;
  onOpenRankingModal?: () => void;
  className?: string;
}>;

export function ArenaRankingLinks({ Link, onOpenRankingModal, className }: ArenaRankingLinksProps) {
  return (
    <div className={className ?? 'flex items-center gap-3 text-sm flex-wrap'}>
      {onOpenRankingModal ? (
        <button type="button" onClick={onOpenRankingModal} className="battle-lite-link font-semibold">
          快速查看排行榜
        </button>
      ) : null}
      <Link href="/ranking" className="battle-lite-link">进入排行榜页</Link>
    </div>
  );
}
