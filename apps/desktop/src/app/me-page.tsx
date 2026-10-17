// Me 只展示资料；编辑与离开保护留在 settings/account。
import { useCallback } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { MePageFrame, MeProfileHeaderView, MeRetentionNotice } from '@mahoshojo/ui-web/me';
import { Button, buttonClassName } from '@mahoshojo/ui-web/card-library';
import { ProductFooter } from '@mahoshojo/ui-web/shell';
import { BattleReportHistoryPanel } from '../features/battle-reports/BattleReportHistoryPanel';
import { useDesktopCloudSession } from '../features/account/use-desktop-cloud-session';
import { useMyProfile } from '../features/account/use-topbar-avatar';
import { useExternalLinks } from '../features/external-links/external-links-provider';
import { navigateByProductHref, resolveInternalHrefForHashHistory } from './hash-history-fragment';

export function DesktopMe() {
  const router = useRouter();
  const { openFixed } = useExternalLinks();
  const { state: cloudSession, store: sessionStore } = useDesktopCloudSession();
  const account = cloudSession.account;
  const epoch = sessionStore.getCredentialEpoch();
  const convergeSession = useCallback(() => {
    if (sessionStore.getCredentialEpoch() === epoch && sessionStore.getSnapshot().account?.userId === account?.userId) void sessionStore.refresh();
  }, [sessionStore, epoch, account?.userId]);
  const { profile, error, retry } = useMyProfile(account, epoch, convergeSession);

  return <div data-testid="page-me"><MePageFrame
    navigation={<><Link to="/settings" className={buttonClassName({ size: 'sm' })}>设置</Link><Link to="/" className={buttonClassName({ size: 'sm' })}>返回首页</Link></>}
    profile={account ? <MeProfileHeaderView
      userId={account.userId}
      displayName={account.displayName ?? account.username}
      avatarDataUrl={profile?.avatarDataUrl}
      signature={profile?.signature}
      actions={<Button size="sm" onClick={() => navigateByProductHref(router, '/settings?section=account')}>编辑资料</Button>}
      feedback={error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}<Button size="sm" className="ml-2" onClick={retry}>重新载入资料</Button></div> : profile?.signature === undefined ? <p className="text-xs text-gray-600">尚未取得完整资料<Button size="sm" className="ml-2" onClick={retry}>载入资料</Button></p> : null}
    /> : null}
    notice={<MeRetentionNotice>预览按现存内容展示，此页不保存本地副本。</MeRetentionNotice>}
    footer={<ProductFooter className="footer" assetSource={{ baseUrl: '/' }} onNavigateInternal={(href) => navigateByProductHref(router, href)} resolveInternalHref={resolveInternalHrefForHashHistory} onNavigateExternal={openFixed} />}
  ><BattleReportHistoryPanel /></MePageFrame></div>;
}
