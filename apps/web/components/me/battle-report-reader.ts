import { useSyncExternalStore } from 'react';
import { BattleReportDetailSchema, BattleReportListSchema, type BattleReportDetail, type BattleReportList } from '@mahoshojo/contracts/battle-report-history';
import { authStorage } from '@/lib/auth';
import { getAuthSnapshot, subscribeAuthSnapshot, type User } from '@/lib/auth-client-store';

// Stable across host remounts, different for same-account sign-in. No credential enters a query key.
const identityEpochs = new WeakMap<User, number>();
let nextEpoch = 0;
export function useBattleReportIdentity() {
  const user = useSyncExternalStore(subscribeAuthSnapshot, () => getAuthSnapshot().user, () => null);
  if (user && !identityEpochs.has(user)) identityEpochs.set(user, ++nextEpoch);
  return { user, scope: user ? `${user.id}:${identityEpochs.get(user)}` : null };
}
export const isBattleReportIdentityCurrent = (user: User | null): user is User => user !== null && getAuthSnapshot().user === user;

export async function readBattleReport<K extends 'list' | 'detail'>(kind: K, path: string, user: User | null, signal: AbortSignal, generationId?: string): Promise<K extends 'list' ? BattleReportList : BattleReportDetail> {
  const assertCurrent = () => {
    if (!isBattleReportIdentityCurrent(user) || signal.aborted) throw new Error('账号或请求已变化，请重新载入战报');
  };
  assertCurrent();
  const init = await authStorage.buildAuthenticatedRequestInit({ method: 'GET', signal, redirect: 'error', cache: 'no-store' });
  assertCurrent();
  let response: Response;
  try { response = await fetch(path, init); }
  catch { assertCurrent(); throw new Error('战报网络请求失败，请检查连接后重试'); }
  assertCurrent();
  // Fixed diagnostics: do not render arbitrary upstream error pages or secrets.
  if (response.status === 401) throw new Error('登录已失效，请重新登录后载入战报');
  if (response.status === 403) throw new Error('当前账号无权查看该战报');
  if (response.status === 404) throw new Error('战报记录不存在或已清理');
  if (response.status === 409) throw new Error('账号已变化，请重新载入战报');
  if (!response.ok) throw new Error('战报服务暂时不可用，请稍后重试');
  const raw: unknown = await response.json().catch(() => { throw new Error('服务器战报响应无法识别，请稍后重试'); });
  assertCurrent();
  const parsed = (kind === 'list' ? BattleReportListSchema : BattleReportDetailSchema).safeParse(raw);
  if (!parsed.success) throw new Error('服务器战报读取协议不兼容，请更新服务后重试');
  if (parsed.data.viewerUserId !== user!.id) throw new Error('战报返回账号不匹配，已忽略内容');
  const params = new URL(path, 'https://history.invalid').searchParams;
  if (('record' in parsed.data && parsed.data.record.id !== generationId)
    || ('records' in parsed.data && (parsed.data.page !== Number(params.get('page')) || parsed.data.pageSize !== Number(params.get('pageSize'))))) {
    throw new Error('战报返回目标不匹配，已忽略内容');
  }
  return parsed.data as K extends 'list' ? BattleReportList : BattleReportDetail;
}
