import type { ReactNode } from 'react';

export interface GeneratedByUserBadgeViewProps {
  username?: string | null;
  variant?: 'dark' | 'light';
  label?: string;
  className?: string;
  badges?: ReactNode;
}

/** 署名由宿主提供，仅作展示，不赋予生成或签名权限。 */
export function GeneratedByUserBadgeView({ username, variant = 'dark', label = '生成者：', className = '', badges }: GeneratedByUserBadgeViewProps) {
  if (!username?.trim()) return null;
  const baseTextClass = variant === 'light' ? 'text-gray-700' : 'text-white/85';
  const labelClass = variant === 'light' ? 'text-gray-500' : 'text-white/55';
  const usernameClass = variant === 'light' ? 'text-gray-800' : 'text-white/90';
  return <div className={['w-full text-center text-xs drop-shadow', baseTextClass, className].filter(Boolean).join(' ')}>
    <div className={['leading-tight', labelClass].filter(Boolean).join(' ')}>{label}</div>
    <div className="mt-1 inline-flex flex-wrap items-center justify-center gap-1.5">
      <span className={['font-medium', usernameClass].filter(Boolean).join(' ')}>{username.trim()}</span>
    </div>
    {badges ? <div className="mt-2 inline-flex max-w-full flex-wrap items-center justify-center gap-1.5">{badges}</div> : null}
  </div>;
}
