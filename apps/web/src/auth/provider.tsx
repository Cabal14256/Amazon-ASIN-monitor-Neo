import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AuthContext, type AuthContextValue } from './context';

export function AuthProvider({
  identity,
  runtime,
  children,
}: Pick<AuthContextValue, 'identity' | 'runtime'> & { children: ReactNode }) {
  const [notice, setNotice] = useState('');
  const announce = useCallback((message: string) => setNotice(message), []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    identity.start();
    return () => identity.stop();
  }, [identity]);
  const value = useMemo(
    () => ({ identity, runtime, announce }),
    [identity, runtime, announce],
  );
  return (
    <AuthContext.Provider value={value}>
      {children}
      {notice && (
        <div
          role="status"
          className="fixed inset-x-4 top-4 z-50 mx-auto flex max-w-md items-center justify-between gap-4 rounded-panel border border-border bg-card px-5 py-4 text-sm shadow-lg"
        >
          <span>{notice}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setNotice('')}
            className="grid size-8 shrink-0 place-content-center rounded-pill hover:bg-muted"
          >
            ×
          </button>
        </div>
      )}
    </AuthContext.Provider>
  );
}
