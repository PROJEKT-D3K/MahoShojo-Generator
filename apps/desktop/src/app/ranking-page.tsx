import { useRouter } from '@tanstack/react-router';
import { RankingPageView, type RankingLinkProps } from '@mahoshojo/ui-web/ranking';
import { readDesktopRanking, useDesktopRankingQuery } from '../features/ranking/use-ranking-query';
import { navigateByProductHref, resolveInternalHrefForHashHistory } from './hash-history-fragment';

function RankingLink({ href, onClick, ...props }: RankingLinkProps) {
  const router = useRouter();
  return <a {...props} href={resolveInternalHrefForHashHistory(href)} onClick={(event) => {
    onClick?.(event);
    if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      void navigateByProductHref(router, href);
    }
  }} />;
}
export function DesktopRanking() {
  return <RankingPageView useRankingQuery={useDesktopRankingQuery} readRanking={readDesktopRanking} Link={RankingLink} />;
}
