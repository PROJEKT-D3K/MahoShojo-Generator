import { useSyncExternalStore } from 'react';
import { GeneratedByUserBadgeView } from '@mahoshojo/ui-web/arena-report';
import { CHARACTER_CARD_EXPORTER_LABEL } from '@mahoshojo/ui-web/character-card';
import { getDesktopCloudSessionStore } from './use-desktop-cloud-session';

/** 只订阅既有账号投影，不触发验证；不推断卡片作者，也不写回角色数据。 */
export function DesktopCharacterCardExportBadge() {
  const store = getDesktopCloudSessionStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const account = state.verification === 'verified' && state.authFlow.kind === 'idle' ? state.account : null;
  const username = account ? account.username.trim() || `用户${account.userId}` : null;
  return <GeneratedByUserBadgeView username={username} label={CHARACTER_CARD_EXPORTER_LABEL} className="mt-3" />;
}

/** 只读既有会话，不触发验证或网络请求。匿名截图同样可正常导出。 */
export function captureDesktopCharacterCardExportGuard(): () => boolean {
  const store = getDesktopCloudSessionStore();
  const scope = () => {
    const state = store.getSnapshot();
    return `${store.getCredentialEpoch()}:${state.account?.userId ?? 'anonymous'}:${state.verification}:${state.authFlow.kind}`;
  };
  const captured = scope();
  return () => captured === scope();
}
