export const TOKEN_KEY = 'token';
export const REMEMBER_ME_KEY = 'rememberMe';
export const AUTH_SESSION_KEY = 'authSession';
export const AUTH_HINT_COOKIE_NAME = 'amazon_asin_monitor_session';

export interface SessionEnvironment {
  local(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  session(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readCookie(): string;
  writeCookie(value: string): void;
}
const browser: SessionEnvironment = {
  local: () => window.localStorage,
  session: () => window.sessionStorage,
  readCookie: () => document.cookie,
  writeCookie: (value) => {
    document.cookie = value;
  },
};

/** Hints are UI state, never proof of authentication; the HttpOnly cookie is authoritative. */
export class SessionStore {
  private cleared = false;
  private memoryHint = false;
  private memoryRemembered: boolean | undefined;
  private generation = 0;
  constructor(private readonly environment = browser) {}
  get revision(): number {
    return this.generation;
  }
  refreshHints(): void {
    this.generation++;
    this.cleared = false;
    this.memoryHint = false;
    this.memoryRemembered = undefined;
  }
  private safely<T>(action: () => T): T | undefined {
    try {
      return action();
    } catch {
      return undefined;
    }
  }
  private read(area: 'local' | 'session', key: string): string | undefined {
    return (
      this.safely(() => this.environment[area]().getItem(key)) ?? undefined
    );
  }
  private remove(area: 'local' | 'session', key: string): void {
    this.safely(() => this.environment[area]().removeItem(key));
  }
  getLegacyToken(): string | null {
    if (this.cleared) return null;
    const value =
      this.read('local', TOKEN_KEY) || this.read('session', TOKEN_KEY);
    return value &&
      value.length <= 8192 &&
      !/[\r\n]/.test(value) &&
      !value.includes('\0')
      ? value
      : null;
  }
  hasSession(): boolean {
    if (this.cleared) return false;
    const cookie = this.safely(() => this.environment.readCookie()) ?? '';
    return Boolean(
      this.memoryHint ||
        this.getLegacyToken() ||
        this.read('local', AUTH_SESSION_KEY) ||
        this.read('session', AUTH_SESSION_KEY) ||
        cookie
          .split(';')
          .some((part) => part.trim() === `${AUTH_HINT_COOKIE_NAME}=1`),
    );
  }
  markAuthenticated(rememberMe = true): void {
    this.generation++;
    this.cleared = false;
    this.memoryHint = true;
    this.memoryRemembered = rememberMe;
    this.remove('local', TOKEN_KEY);
    this.remove('session', TOKEN_KEY);
    this.remove(rememberMe ? 'session' : 'local', AUTH_SESSION_KEY);
    this.safely(() =>
      this.environment[rememberMe ? 'local' : 'session']().setItem(
        AUTH_SESSION_KEY,
        '1',
      ),
    );
    this.safely(() =>
      this.environment.local().setItem(REMEMBER_ME_KEY, rememberMe ? '1' : '0'),
    );
    this.safely(() =>
      this.environment.writeCookie(
        `${AUTH_HINT_COOKIE_NAME}=1; path=/; samesite=lax`,
      ),
    );
  }
  clear(): void {
    this.generation++;
    this.cleared = true;
    this.memoryHint = false;
    this.memoryRemembered = false;
    for (const area of ['local', 'session'] as const) {
      for (const key of [TOKEN_KEY, AUTH_SESSION_KEY, REMEMBER_ME_KEY])
        this.remove(area, key);
    }
    this.safely(() =>
      this.environment.writeCookie(
        `${AUTH_HINT_COOKIE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; samesite=lax`,
      ),
    );
  }
  isRemembered(): boolean {
    return this.memoryRemembered ?? this.read('local', REMEMBER_ME_KEY) === '1';
  }
}
