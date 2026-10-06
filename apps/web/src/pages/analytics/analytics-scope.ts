import { createAccess } from '../../auth/access';
import { useIdentity } from '../../auth/context';

/** Identity/session keys prevent late data or cached results crossing readers. */
export function useAnalyticsScope() {
  const identity = useIdentity();
  if (identity.status !== 'authenticated') return null;
  const access = createAccess(identity.identity);
  if (!access.canReadAnalytics || access.mustChangePassword) return null;
  return [
    identity.identity.user.id,
    identity.identity.sessionId ?? null,
  ] as const;
}
