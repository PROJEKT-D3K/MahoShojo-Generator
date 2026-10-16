import { Fragment, type ReactNode } from 'react';

import { shouldInterceptInternalLinkClick } from '../../link-click';
import type { InternalLinkRenderProps } from '../../markdown/MarkdownBlock';
import { BackHomeLink } from '../../shell/BackHomeLink';

export interface EncyclopediaHeaderLinksProps {
  readonly onNavigate?: (href: string) => void;
  readonly resolveInternalHref?: (href: string) => string;
  /** 宿主链接优先接管渲染与导航，接收未转换的产品路径（例如 Next Link）。 */
  readonly renderLink?: (props: InternalLinkRenderProps) => ReactNode;
}

/** 百科页头的共同入口；路由和离开保护由宿主承担。 */
export function EncyclopediaHeaderLinks({
  onNavigate,
  resolveInternalHref,
  renderLink,
}: EncyclopediaHeaderLinksProps) {
  return (
    <>
      <BackHomeLink
        href={renderLink ? '/' : resolveInternalHref?.('/') ?? '/'}
        onNavigate={onNavigate ? () => onNavigate('/') : undefined}
        renderLink={renderLink}
      />
      {[
        { href: '/arena', children: '竞技场' },
        { href: '/ranking', children: '排行榜' },
      ].map((link) => {
        const props = { ...link, className: 'text-blue-600 hover:underline' };
        return (
          <Fragment key={link.href}>
            {renderLink ? renderLink(props) : (
              <a
                {...props}
                href={resolveInternalHref?.(link.href) ?? link.href}
                onClick={onNavigate ? (event) => {
                  if (!shouldInterceptInternalLinkClick(event)) return;
                  event.preventDefault();
                  onNavigate(link.href);
                } : undefined}
              />
            )}
          </Fragment>
        );
      })}
    </>
  );
}
