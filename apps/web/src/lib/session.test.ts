import { describe, expect, it } from 'vitest';
import { AUTH_HINT_COOKIE_NAME, SessionStore } from './session';
import { sessionFixture } from './transport-fixtures';

describe('Cookie session migration', () => {
  it.each([true, false])(
    'writes only hints, never new access tokens (remember=%s)',
    (remember) => {
      const f = sessionFixture();
      f.local.set('token', 'legacy-private');
      f.session.set('token', 'legacy-private-session');
      f.store.markAuthenticated(remember);
      expect(f.store.getLegacyToken()).toBeNull();
      expect(f.store.hasSession()).toBe(true);
      expect(f.store.isRemembered()).toBe(remember);
      expect((remember ? f.local : f.session).get('authSession')).toBe('1');
      expect((remember ? f.session : f.local).has('authSession')).toBe(false);
      expect(JSON.stringify([...f.local, ...f.session])).not.toContain(
        'private',
      );
    },
  );
  it('keeps the Legacy token compatibility order and rejects header injection', () => {
    const f = sessionFixture();
    f.local.set('token', 'local-fixture');
    f.session.set('token', 'session-fixture');
    expect(f.store.getLegacyToken()).toBe('local-fixture');
    f.local.delete('token');
    expect(f.store.getLegacyToken()).toBe('session-fixture');
    f.session.set('token', 'unsafe\r\nheader');
    expect(f.store.getLegacyToken()).toBeNull();
  });
  it('recognizes the hint cookie, but not another name or a forged value', () => {
    const f = sessionFixture();
    for (const cookie of [
      `x${AUTH_HINT_COOKIE_NAME}=1`,
      `${AUTH_HINT_COOKIE_NAME}=0`,
      `${AUTH_HINT_COOKIE_NAME}=`,
    ]) {
      f.setCookie(cookie);
      expect(f.store.hasSession()).toBe(false);
    }
    f.setCookie(`other=1; ${AUTH_HINT_COOKIE_NAME}=1`);
    expect(f.store.hasSession()).toBe(true);
    f.store.clear();
    expect(f.store.hasSession()).toBe(false);
  });
  it('clears all hints and legacy tokens and monotonically changes the session revision', () => {
    const f = sessionFixture();
    const revision = f.store.revision;
    f.store.markAuthenticated();
    f.store.clear();
    expect(f.local.size).toBe(0);
    expect(f.session.size).toBe(0);
    expect(f.store.revision).toBe(revision + 2);
    expect(f.store.isRemembered()).toBe(false);
  });
  it('does not throw when storage/cookies are blocked; local logout overrides stale persisted hints', () => {
    const denied = () => {
      throw new Error('storage denied');
    };
    const store = new SessionStore({
      local: denied,
      session: denied,
      readCookie: () => `${AUTH_HINT_COOKIE_NAME}=1`,
      writeCookie: denied,
    });
    expect(store.hasSession()).toBe(true);
    store.markAuthenticated(false);
    expect(store.hasSession()).toBe(true);
    store.clear();
    expect(store.hasSession()).toBe(false);
    expect(store.getLegacyToken()).toBeNull();
    store.markAuthenticated(true);
    expect(store.hasSession()).toBe(true);
  });
  it('can be inspected during SSR without a browser global', () => {
    const store = new SessionStore();
    expect(store.hasSession()).toBe(false);
    expect(store.getLegacyToken()).toBeNull();
  });
});
