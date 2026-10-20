import { getAuthSnapshot } from '@/lib/auth-client-store';
import { captureAuthIdentity } from '@/lib/auth-identity';

/** 截图只绑定当前会话范围，不改角色原作者或数字签名。 */
export function captureCharacterCardExportGuard(): () => boolean {
  const identity = captureAuthIdentity();
  const scope = () => {
    const state = getAuthSnapshot();
    return `${state.identityEpoch}:${state.user?.id ?? 'anonymous'}:${state.loading}`;
  };
  const captured = scope();
  const hasAccount = getAuthSnapshot().user !== null;
  return () => captured === scope() && (hasAccount ? identity.isCurrent() : identity.epoch === captureAuthIdentity().epoch);
}
