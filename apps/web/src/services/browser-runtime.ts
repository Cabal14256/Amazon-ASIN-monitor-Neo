import { IdentityStore } from '../auth/identity';
import { AUTH_SESSION_KEY, REMEMBER_ME_KEY, TOKEN_KEY } from '../lib/session';
import { createTransportRuntime } from './runtime';

export const transport = createTransportRuntime({
  pageOrigin: window.location.origin,
  baseURL: import.meta.env.VITE_API_BASE_URL,
});
export const identity = new IdentityStore(transport);
// Construction remains inert; the AuthProvider/router starts verification.
const synchronize = (event: StorageEvent) => {
  if (
    event.key === null ||
    [AUTH_SESSION_KEY, REMEMBER_ME_KEY, TOKEN_KEY].includes(event.key)
  )
    transport.refreshSession();
};
window.addEventListener('storage', synchronize);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    window.removeEventListener('storage', synchronize);
    identity.stop();
    transport.dispose();
  });
