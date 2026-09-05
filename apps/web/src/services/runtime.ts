import { QueryClient } from '@tanstack/react-query';
import { HttpClient, shouldRetryQuery } from '../lib/http';
import {
  RealtimeClient,
  webSocketURL,
  type BrowserSocket,
} from '../lib/realtime';
import { SessionStore } from '../lib/session';
import { AuthApi } from './auth';

export function createTransportRuntime(options: {
  pageOrigin: string;
  baseURL?: string;
  session?: SessionStore;
  fetch?: typeof fetch;
  socket?: (url: string) => BrowserSocket;
  onUnauthorized?: () => void;
}) {
  const session = options.session ?? new SessionStore();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30000, retry: shouldRetryQuery },
      mutations: { retry: false },
    },
  });
  const ws = new RealtimeClient({
    url: webSocketURL(options.baseURL, options.pageOrigin),
    hasSession: () => session.hasSession(),
    socket: options.socket,
  });
  const clearWork = () => {
    ws.disconnect();
    http.cancelAll();
    queryClient.clear();
  };
  const reset = () => {
    session.clear();
    clearWork();
  };
  const http = new HttpClient({
    ...options,
    session,
    onUnauthorized: () => {
      reset();
      options.onUnauthorized?.();
    },
  });
  const auth = new AuthApi(http, session, reset, clearWork);
  const refreshSession = () => {
    session.refreshHints();
    clearWork();
  };
  return {
    session,
    queryClient,
    ws,
    http,
    auth,
    reset,
    refreshSession,
    dispose: () => {
      ws.disconnect();
      http.close();
      queryClient.clear();
    },
  };
}
