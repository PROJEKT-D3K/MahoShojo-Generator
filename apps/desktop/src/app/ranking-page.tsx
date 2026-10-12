import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { IpcLocalCardRepository } from '../platform/local-card-bridge';
import { createDesktopCardLibraryOnlinePort } from '../platform/card-library-host';
import { canOpenDesktopRankingDetails, DesktopRankingDetailsModal } from '../features/card-details/ranking-details-modal';
import { useRouter } from '@tanstack/react-router';
import { RankingPageView, type RankingLinkProps, type RankingDetailsTarget } from '@mahoshojo/ui-web/ranking';
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
  // 公开榜单及详情不订阅账号，不触发登录探测；仅显式保存时使用本机仓库。
  const host = useMemo(() => ({ online: createDesktopCardLibraryOnlinePort(invoke), local: { repository: new IpcLocalCardRepository(invoke) } }), []);
  const [entity, setEntity] = useState<RankingDetailsTarget | null>(null);
  return <><RankingPageView useRankingQuery={useDesktopRankingQuery} readRanking={readDesktopRanking} Link={RankingLink} onOpenEntityDetails={setEntity} canOpenEntityDetails={canOpenDesktopRankingDetails} /><DesktopRankingDetailsModal entity={entity} onClose={() => setEntity(null)} host={host} /></>;
}
