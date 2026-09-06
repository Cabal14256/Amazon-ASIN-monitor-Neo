import { vi } from 'vitest';
import type { BrowserSocket } from './realtime';
import { SessionStore, type SessionEnvironment } from './session';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function sessionFixture() {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  let cookie = '';
  const area = (map: Map<string, string>) => ({
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  });
  const environment: SessionEnvironment = {
    local: () => area(local),
    session: () => area(session),
    readCookie: () => cookie,
    writeCookie: (value) => {
      cookie = value.includes('expires=') ? '' : value.split(';')[0];
    },
  };
  return {
    store: new SessionStore(environment),
    environment,
    local,
    session,
    setCookie: (value: string) => {
      cookie = value;
    },
  };
}
export class FakeSocket implements BrowserSocket {
  readyState = 0;
  bufferedAmount = 0;
  onopen: BrowserSocket['onopen'] = null;
  onmessage: BrowserSocket['onmessage'] = null;
  onclose: BrowserSocket['onclose'] = null;
  onerror: BrowserSocket['onerror'] = null;
  send = vi.fn<(value: string) => void>();
  close = vi.fn(() => {
    this.readyState = 2;
  });
  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  message(value: unknown) {
    this.onmessage?.({
      data: typeof value === 'string' ? value : JSON.stringify(value),
    } as MessageEvent);
  }
  ended(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}
export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
