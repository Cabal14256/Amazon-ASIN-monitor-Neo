import { createAccess } from '../../auth/access';
import type { RouteAuthState } from '../../auth/navigation';

/** An authorization change retires every read and cached result in this scope. */
export function workbenchScope(auth: RouteAuthState, revision: number) {
  if (auth.status !== 'authenticated') return null;
  const access = createAccess(auth.identity);
  if (!access.canReadASIN || access.mustChangePassword) return null;
  return JSON.stringify([
    auth.identity.user.id,
    auth.identity.sessionId ?? null,
    revision,
    [...auth.identity.permissions].sort(),
  ]);
}
