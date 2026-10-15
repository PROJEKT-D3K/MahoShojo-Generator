import type { ReactNode } from 'react';

export type MePageFrameProps = {
  navigation?: ReactNode;
  sessionStatus?: ReactNode;
  profile?: ReactNode;
  notice?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
};

/** 宿主注入导航、会话和数据；共同页面结构不持有账号状态。 */
export function MePageFrame({ navigation, sessionStatus, profile, notice, children, footer }: MePageFrameProps) {
  return <div className="magic-background-white"><div className="container">
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">个人页</h1>
        <nav aria-label="个人页导航" className="flex flex-wrap items-center gap-3">{navigation}</nav>
      </div>
      {sessionStatus ? <div className="mt-3">{sessionStatus}</div> : null}
      {profile ? <div className="mt-3">{profile}</div> : null}
      {notice ? <div className="mt-4">{notice}</div> : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
    {footer}
  </div></div>;
}

/** 主提示与位置共源；宿主只补充真实可用的留档方式。 */
export function MeRetentionNotice({ children }: { children?: ReactNode }) {
  return <div className="rounded-xl border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900">
    提示：受资源限制，战报记录 <span className="font-semibold">随时可能被清理</span>，不保证长期保存。请及时留档。
    {children ? <span> {children}</span> : null}
  </div>;
}

export type MeProfileHeaderViewProps = {
  userId: number | string;
  displayName: string;
  identityAdornment?: ReactNode;
  avatarDataUrl?: string | null;
  avatarAction?: { onClick: () => void; disabled?: boolean; title?: string };
  /** undefined 表示尚未读取；空字符串才是已确认的空签名。 */
  signature: string | undefined;
  actions?: ReactNode;
  feedback?: ReactNode;
};

export function MeProfileHeaderView({ userId, displayName, identityAdornment, avatarDataUrl, avatarAction, signature, actions, feedback }: MeProfileHeaderViewProps) {
  const avatar = avatarDataUrl
    ? <img src={avatarDataUrl} alt="头像" className="h-full w-full object-cover" />
    : <span className="flex h-full w-full items-center justify-center text-lg font-bold text-gray-700">{displayName.trim().slice(0, 1).toUpperCase() || '?'}</span>;
  const avatarClass = 'relative block h-16 w-16 overflow-hidden rounded-2xl border bg-gradient-to-br from-pink-100 via-purple-100 to-blue-100';
  return <section aria-label="个人资料" className="rounded-2xl border border-gray-200 bg-white p-4 text-gray-900">
    <div className="flex items-start gap-4">
      <div className="shrink-0">
        {avatarAction ? <button type="button" className={`${avatarClass} group disabled:cursor-not-allowed disabled:opacity-70`} onClick={avatarAction.onClick} disabled={avatarAction.disabled} title={avatarAction.title}>
          {avatar}<span className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10" />
        </button> : <div className={avatarClass}>{avatar}</div>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 break-words [overflow-wrap:anywhere]">{identityAdornment ?? <span className="font-semibold text-gray-900">{displayName}</span>}</div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        <div className="mt-1 break-words text-xs text-gray-600">ID：{userId}</div>
        {signature !== undefined ? <div className="mt-2 rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-700">
          {signature ? <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{signature}</div> : <div className="text-gray-500">还没有个性签名，去「设置」里写一句话吧（会保存到账号）。</div>}
        </div> : null}
        {feedback ? <div className="mt-2">{feedback}</div> : null}
      </div>
    </div>
  </section>;
}
