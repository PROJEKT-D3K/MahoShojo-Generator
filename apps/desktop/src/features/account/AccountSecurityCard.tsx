import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DesktopCloudAccountPage } from '@mahoshojo/contracts/desktop-ipc';
import { SettingsCard, SettingsFieldRow } from '@mahoshojo/ui-web/settings';
import { openCloudAccountPage } from '../../platform/external-links-bridge';

const openInBrowser = (page: DesktopCloudAccountPage) => openCloudAccountPage(invoke, { page });

export function AccountSecurityCard({ openPage = openInBrowser }: {
  openPage?: (page: DesktopCloudAccountPage) => Promise<void>;
}) {
  const [pending, setPending] = useState<DesktopCloudAccountPage | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
  const active = useRef(true);
  const opening = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const open = async (page: DesktopCloudAccountPage) => {
    if (opening.current) return;
    opening.current = true;
    setPending(page);
    setFeedback(null);
    try {
      await openPage(page);
      if (active.current) setFeedback({ error: false, message: '已请求系统浏览器打开，请在浏览器中继续并核对账号。' });
    } catch (cause) {
      if (active.current) setFeedback({ error: true, message: `系统浏览器打开失败：${cause instanceof Error ? cause.message : '请重试'}` });
    } finally {
      opening.current = false;
      if (active.current) setPending(null);
    }
  };

  const button = (page: DesktopCloudAccountPage, label: string) => <button
    type="button"
    disabled={pending !== null}
    onClick={() => { void open(page); }}
    className="ui-web-settings-motion rounded-md border border-(--app-border) px-3 py-1.5 text-xs font-medium text-(--app-text-muted) transition-colors enabled:hover:border-(--app-accent-strong) enabled:hover:text-(--app-accent-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--app-accent-strong) disabled:cursor-not-allowed disabled:opacity-50"
  >{pending === page ? '正在打开…' : label}</button>;

  return <SettingsCard title="账号安全" description="以下操作在系统浏览器中完成。浏览器可能登录了不同账号，请先核对。">
    <SettingsFieldRow label="安全设置" description="前往网页版管理账号安全，未登录时请先在浏览器中登录。" control={button('account-security', '在浏览器打开账号安全')} />
    <SettingsFieldRow label="找回密码" description="通过注册邮箱找回密码，无需先登录桌面端。" control={button('password-recovery', '在浏览器找回密码')} />
    {feedback && <p role={feedback.error ? 'alert' : 'status'} className={`mt-3 text-xs ${feedback.error ? 'text-red-700 dark:text-red-300' : 'text-(--app-text-subtle)'}`}>{feedback.message}</p>}
  </SettingsCard>;
}
