import { AUTH_SESSION_KEY, REMEMBER_ME_KEY, TOKEN_KEY } from '../lib/session';
import { createTransportRuntime } from './runtime';

export const transport = createTransportRuntime({
  pageOrigin: window.location.origin,
  baseURL: import.meta.env.VITE_API_BASE_URL,
  onUnauthorized: () => {
    if (window.location.pathname !== '/login') {
      const target =
        window.location.pathname +
        window.location.search +
        window.location.hash;
      window.location.assign(`/login?redirect=${encodeURIComponent(target)}`);
    }
  },
});
// Creation is inert: no bootstrap request or WS until the auth context is migrated.
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
    transport.dispose();
  });
