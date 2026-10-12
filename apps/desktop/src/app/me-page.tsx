// Desktop `/me`：账号、资料与只读服务器战报历史；身份与内容均按凭据世代隔离。

import { useCallback } from 'react';
import { BattleReportHistoryPanel } from '../features/battle-reports/BattleReportHistoryPanel';
import { AccountPanel } from '../features/account/AccountPanel';
import { ProfileSignaturePanel } from '../features/account/ProfileSignaturePanel';
import { useDesktopCloudSession } from '../features/account/use-desktop-cloud-session';
import { useTopbarAvatar } from '../features/account/use-topbar-avatar';

export function DesktopMe() {
  const { state: cloudSession, store: sessionStore } = useDesktopCloudSession();
  const account = cloudSession.account;
  const convergeSession = useCallback(() => { void sessionStore.refresh(); }, [sessionStore]);
  const avatarDataUrl = useTopbarAvatar(account, {
    onSessionRejected: convergeSession,
    credentialEpoch: sessionStore.getCredentialEpoch(),
  });

  const displayName = account?.displayName ?? account?.username ?? null;
  const initial = displayName?.slice(0, 1).toUpperCase() ?? '？';

  return (
    <div data-testid="page-me" className="magic-background-white">
      <div className="container">
        <div className="card flex flex-col gap-6">
          <section className="flex items-center gap-4">
            {avatarDataUrl ? (
              <img
                src={avatarDataUrl}
                alt={displayName ?? '账号头像'}
                className="h-14 w-14 rounded-full border border-(--app-border) object-cover"
              />
            ) : (
              <span className="inline-flex h-14 w-14 items-center justify-center rounded-full border border-(--app-border) bg-(--app-surface-muted) text-lg font-semibold text-(--app-text-muted)">
                {initial}
              </span>
            )}
            <div>
              <h1 className="text-xl font-bold">
                {displayName ?? '个人页'}
              </h1>
              {account !== null ? (
                <p className="text-sm text-(--app-text-muted)">@{account.username}</p>
              ) : (
                <p className="text-sm text-(--app-text-muted)">
                  登录云端账号后可同步消息与更多功能
                </p>
              )}
            </div>
          </section>

          <AccountPanel />
          <ProfileSignaturePanel />
          <BattleReportHistoryPanel />
        </div>
      </div>
    </div>
  );
}
