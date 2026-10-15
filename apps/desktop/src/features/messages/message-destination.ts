import { MAX_DESKTOP_EXTERNAL_URL_LENGTH, DesktopOpenCloudMessagePageRequestSchema, type DesktopOpenCloudMessagePageRequest } from '@mahoshojo/contracts/desktop-ipc';
import { DELIVERED_ROUTES } from '../../app/delivered-routes';

export type MessageDestination =
  | { kind: 'local'; href: string }
  | { kind: 'browser'; request: DesktopOpenCloudMessagePageRequest }
  | { kind: 'unavailable'; reason: string };

const unavailable: MessageDestination = { kind: 'unavailable', reason: '该消息目标暂时无法在 Desktop 打开，请前往网页版消息中心查看。' };

/** 只分流消息产品路径；普通内容外链仍走既有确认策略。 */
export function resolveMessageDestination(href: string): MessageDestination {
  if (href.length > MAX_DESKTOP_EXTERNAL_URL_LENGTH || !href.startsWith('/') || href.startsWith('//') || /[\\\p{White_Space}\p{Cc}]/u.test(href)
    || new TextEncoder().encode(href).length > MAX_DESKTOP_EXTERNAL_URL_LENGTH) return unavailable;
  const path = href.split(/[?#]/u)[0]!;
  // 不让 URL/router 的解码、点段归一化把未声明路径变成已授权目标。
  if (path.includes('%') || path.split('/').some(part => part === '.' || part === '..')) return unavailable;
  if ((path !== '/encyclopedia/[slug]' && DELIVERED_ROUTES.includes(path)) || (/^\/encyclopedia\/[^/]+$/u.test(path) && path !== '/encyclopedia/[slug]')) {
    return { kind: 'local', href };
  }
  if (href.includes('#')) return unavailable;
  const query = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
  if (path === '/investigation' && query === '') return { kind: 'browser', request: { page: 'investigation' } };
  if (path !== '/report-appeals') return unavailable;
  try { decodeURIComponent(query); } catch { return unavailable; }
  const entries = [...new URLSearchParams(query)];
  if (entries.length > 1 || (entries.length === 1 && !['appealId', 'reportCaseId'].includes(entries[0]![0]))) return unavailable;
  const request = DesktopOpenCloudMessagePageRequestSchema.safeParse({ page: 'report-appeals', ...Object.fromEntries(entries) });
  return request.success ? { kind: 'browser', request: request.data } : unavailable;
}
