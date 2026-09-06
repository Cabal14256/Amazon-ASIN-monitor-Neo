import { QueryClient } from '@tanstack/react-query';
import { HttpClient, shouldRetryQuery } from '../lib/http';
import {
  RealtimeClient,
  webSocketURL,
  type BrowserSocket,
} from '../lib/realtime';
import { SessionStore } from '../lib/session';
import { AuthApi } from './auth';
import { TaskApi } from './tasks';

export type SessionEvent = 'login' | 'reset' | 'refresh' | 'dispose';

export function createTransportRuntime(options: {
  pageOrigin: string;
  baseURL?: string;
  session?: SessionStore;
  fetch?: typeof fetch;
  socket?: (url: string) => BrowserSocket;
  onUnauthorized?: () => void;
}) {
  const session = options.session ?? new SessionStore();
  const sessionListeners = new Set<(event: SessionEvent) => void>();
  let verifiedSession = false;
  const notify = (event: SessionEvent) => {
    for (const listener of sessionListeners) {
      try {
        listener(event);
      } catch {
        /* An observer cannot interrupt session cleanup. */
      }
    }
  };
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30000, retry: shouldRetryQuery },
      mutations: { retry: false },
    },
  });
  const ws = new RealtimeClient({
    url: webSocketURL(options.baseURL, options.pageOrigin),
    hasSession: () => verifiedSession || session.hasSession(),
    socket: options.socket,
  });
  const clearWork = () => {
    verifiedSession = false;
    tasks.cancelWaits();
    ws.disconnect();
    http.cancelAll();
    queryClient.clear();
  };
  const reset = () => {
    session.clear();
    clearWork();
    notify('reset');
  };
  const http = new HttpClient({
    ...options,
    session,
    onUnauthorized: () => {
      reset();
      options.onUnauthorized?.();
    },
  });
  const auth = new AuthApi(http, session, reset, () => {
    clearWork();
    notify('login');
  });
  const tasks = new TaskApi(http, ws);
  const refreshSession = () => {
    session.refreshHints();
    clearWork();
    notify('refresh');
  };
  return {
    session,
    queryClient,
    ws,
    http,
    auth,
    tasks,
    reset,
    refreshSession,
    clearUserWork: clearWork,
    subscribeSession: (listener: (event: SessionEvent) => void) => {
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    },
    // The auth context calls this only after a successful current-user response.
    // A valid HttpOnly cookie need not have a matching readable hint cookie.
    connectVerifiedSession: () => {
      verifiedSession = true;
      ws.connect();
    },
    pauseRealtime: () => {
      verifiedSession = false;
      ws.disconnect();
    },
    dispose: () => {
      verifiedSession = false;
      notify('dispose');
      sessionListeners.clear();
      tasks.cancelWaits();
      ws.disconnect();
      http.close();
      queryClient.clear();
    },
  };
}
