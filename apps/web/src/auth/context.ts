import { createContext, useContext, useSyncExternalStore } from 'react';
import type { createTransportRuntime } from '../services/runtime';
import type { IdentityStore } from './identity';

export interface AuthContextValue {
  identity: IdentityStore;
  runtime: ReturnType<typeof createTransportRuntime>;
  announce: (message: string) => void;
}
export const AuthContext = createContext<AuthContextValue | undefined>(
  undefined,
);
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('缺少认证上下文');
  return context;
}
export function useIdentity() {
  const { identity } = useAuth();
  return useSyncExternalStore(
    identity.subscribe,
    identity.getSnapshot,
    identity.getSnapshot,
  );
}
