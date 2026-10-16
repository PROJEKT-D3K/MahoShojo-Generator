import { getAuthSnapshot } from '@/lib/auth-client-store';
import { captureAuthIdentity } from '@/lib/auth-identity';

/** Local application ownership only; this does not isolate people sharing one OS/browser profile. */
export const captureNarrativeDraftOwner = () => {
  const snapshot = getAuthSnapshot();
  const identity = captureAuthIdentity();
  const scope = snapshot.loading ? null : snapshot.user ? `account:${snapshot.user.id}` : 'anonymous';
  return {
    scope,
    isCurrent: () => {
      const current = getAuthSnapshot();
      return identity.isCurrent() && !current.loading
        && current.identityEpoch === snapshot.identityEpoch
        && (current.user ? `account:${current.user.id}` : 'anonymous') === scope;
    },
  };
};
