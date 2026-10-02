// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../auth/context';
import type { IdentityStore } from '../auth/identity';
import type { RouteAuthState } from '../auth/navigation';
import { AppShell } from './app-shell';

const navigate = vi.hoisted(() => vi.fn());
const routerState = vi.hoisted(() => ({ pathname: '/home' }));
vi.mock('@tanstack/react-router', async () => {
  const { forwardRef } = await import('react');
  return {
    useRouterState: () => routerState.pathname,
    Link: forwardRef<
      HTMLAnchorElement,
      ComponentPropsWithoutRef<'a'> & { to: string }
    >(function TestLink({ to, onClick, ...props }, ref) {
      return (
        <a
          {...props}
          ref={ref}
          href={to}
          onClick={(event) => {
            event.preventDefault();
            onClick?.(event);
            navigate(to);
          }}
        />
      );
    }),
  };
});

const authenticated = (
  permissions = ['asin:read', 'monitor:read', 'analytics:read'],
  mustChangePassword = false,
): RouteAuthState => ({
  status: 'authenticated',
  identity: {
    user: {
      id: 'command-operator',
      username: 'fixture',
      status: 'ACTIVE',
      force_password_change: false,
    },
    roles: [],
    permissions,
    mustChangePassword,
    passwordExpired: false,
  },
});

function fixture(initial = authenticated()) {
  let state = initial;
  const listeners = new Set<() => void>();
  const identity = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    logout: vi.fn(async () => undefined),
  } as unknown as IdentityStore;
  const value = {
    identity,
    runtime: {},
    announce: vi.fn(),
  } as unknown as AuthContextValue;
  const element = () => (
    <AuthContext.Provider value={value}>
      <AppShell title="Fixture workspace">
        <label>
          页面输入
          <input aria-label="页面输入" />
        </label>
        <button>页面操作</button>
      </AppShell>
    </AuthContext.Provider>
  );
  const view = render(element());
  return {
    ...view,
    changePath: (path: string) => {
      routerState.pathname = path;
      view.rerender(element());
    },
    update: (next: RouteAuthState) =>
      act(() => {
        state = next;
        for (const listener of listeners) listener();
      }),
  };
}

function open() {
  const trigger = screen.getByRole('button', { name: '打开命令面板' });
  trigger.focus();
  fireEvent.click(trigger);
  return {
    trigger,
    panel: screen.getByRole('dialog', { name: '跳转到页面' }),
    search: screen.getByRole('combobox', { name: '搜索页面名称或路径' }),
  };
}

beforeEach(() => {
  // jsdom does not implement the browser top layer. Only the native dialog
  // methods are shimmed; focus restoration, inert state and events run in React.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});
afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
  window.localStorage.clear();
  navigate.mockReset();
  routerState.pathname = '/home';
  vi.restoreAllMocks();
});

describe('workspace command navigation', () => {
  it('opens a labelled dialog, isolates the background and restores trigger focus', () => {
    fixture();
    document.body.style.overflow = 'auto';
    const { panel, trigger, search } = open();
    expect(document.activeElement).toBe(search);
    expect(screen.getByLabelText('页面输入').closest('[inert]')).not.toBeNull();
    expect(panel.closest('[inert]')).toBeNull();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(
      within(panel).getByRole('button', { name: '关闭命令面板' }),
    );
    expect(screen.queryByRole('dialog', { name: '跳转到页面' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByLabelText('页面输入').closest('[inert]')).toBeNull();
    expect(document.body.style.overflow).toBe('auto');
  });

  it.each(['ctrlKey', 'metaKey'])(
    'opens with %s+K and returns focus to the original field on Escape',
    (modifier) => {
      fixture();
      const origin = screen.getByLabelText('页面输入');
      origin.focus();
      const event = new KeyboardEvent('keydown', {
        key: 'K',
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      });
      fireEvent(origin, event);
      expect(event.defaultPrevented).toBe(true);
      const search = screen.getByRole('combobox');
      expect(document.activeElement).toBe(search);
      fireEvent.keyDown(search, { key: 'Escape' });
      expect(document.activeElement).toBe(origin);
      expect(screen.queryByRole('dialog', { name: '跳转到页面' })).toBeNull();
    },
  );

  it('filters by name or path, wraps arrow selection and opens only the selected route', () => {
    fixture();
    const { panel, search } = open();
    fireEvent.change(search, { target: { value: 'ASIN' } });
    expect(within(panel).getAllByRole('option')).toHaveLength(3);
    const activeId = () => search.getAttribute('aria-activedescendant');
    expect(document.getElementById(activeId()!)?.getAttribute('href')).toBe(
      '/asin',
    );
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(document.getElementById(activeId()!)?.getAttribute('href')).toBe(
      '/competitor-asin',
    );
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.getElementById(activeId()!)?.getAttribute('href')).toBe(
      '/asin',
    );
    fireEvent.change(search, { target: { value: ' /monitor-history ' } });
    expect(within(panel).getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/monitor-history');
    expect(screen.queryByRole('dialog', { name: '跳转到页面' })).toBeNull();
  });

  it.each(['ctrlKey', 'metaKey'])(
    'keeps the open panel focused during repeated %s+K and closes on a new press',
    (modifier) => {
      fixture();
      const { panel, search, trigger } = open();
      const repeated = new KeyboardEvent('keydown', {
        key: 'k',
        [modifier]: true,
        repeat: true,
        bubbles: true,
        cancelable: true,
      });
      fireEvent(search, repeated);
      expect(repeated.defaultPrevented).toBe(true);
      expect(screen.getByRole('dialog', { name: '跳转到页面' })).toBe(panel);
      expect(document.activeElement).toBe(search);
      fireEvent.keyDown(search, { key: 'k', [modifier]: true });
      expect(screen.queryByRole('dialog', { name: '跳转到页面' })).toBeNull();
      expect(document.activeElement).toBe(trigger);
    },
  );

  it('closes on route changes and releases background isolation and scrolling', () => {
    const f = fixture();
    document.body.style.overflow = 'auto';
    open();
    f.changePath('/asin');
    expect(screen.queryByRole('dialog', { name: '跳转到页面' })).toBeNull();
    expect(screen.getByLabelText('页面输入').closest('[inert]')).toBeNull();
    expect(document.body.style.overflow).toBe('auto');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps one result in the Tab order and moves focused result links with arrows', () => {
    fixture();
    const { panel } = open();
    const results = within(panel).getAllByRole('option');
    expect(results.filter((item) => item.tabIndex === 0)).toHaveLength(1);
    act(() => results[0].focus());
    fireEvent.keyDown(results[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(results[1]);
    expect(results[1].getAttribute('aria-selected')).toBe('true');
    expect(results.filter((item) => item.tabIndex === 0)).toHaveLength(1);
    fireEvent.click(results[1]);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/tasks');
  });

  it('wraps Tab between the selected result and close button in both directions', () => {
    fixture();
    const { panel, search } = open();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const selected = within(panel).getByRole('option', { selected: true });
    const close = within(panel).getByRole('button', { name: '关闭命令面板' });
    act(() => selected.focus());
    const forward = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    fireEvent(selected, forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    const backward = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(close, backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(selected);
    for (const [target, shiftKey] of [
      [close, false],
      [search, false],
      [search, true],
      [selected, true],
    ] as const) {
      const internal = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      fireEvent(target, internal);
      expect(internal.defaultPrevented).toBe(false);
    }
  });

  it('wraps Tab between search and close when there are no results', () => {
    fixture();
    const { panel, search } = open();
    fireEvent.change(search, { target: { value: '不存在的页面' } });
    const close = within(panel).getByRole('button', { name: '关闭命令面板' });
    const forward = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    fireEvent(search, forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    const backward = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(close, backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search);
  });

  it('explains empty results and resets search when reopened', () => {
    fixture();
    const { panel, search } = open();
    fireEvent.change(search, { target: { value: '不存在的页面' } });
    expect(within(panel).queryAllByRole('option')).toHaveLength(0);
    expect(search.hasAttribute('aria-activedescendant')).toBe(false);
    expect(within(panel).getByRole('status').textContent).toContain(
      '没有匹配的可访问页面',
    );
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: 'Escape' });
    const again = open();
    expect(again.search).toHaveProperty('value', '');
    expect(within(again.panel).getAllByRole('option').length).toBeGreaterThan(
      0,
    );
  });

  it('excludes unavailable and ungranted pages using the current navigation policy', () => {
    fixture(authenticated(['analytics:read']));
    const { panel } = open();
    expect(
      within(panel)
        .getAllByRole('option')
        .map((item) => item.getAttribute('href')),
    ).toEqual(['/home', '/tasks', '/profile']);
  });

  it('reacts to revoked permissions and the password gate before Enter can navigate', () => {
    const f = fixture();
    const { panel, search } = open();
    fireEvent.change(search, { target: { value: '/asin' } });
    expect(within(panel).getAllByRole('option').length).toBeGreaterThan(0);
    f.update(authenticated(['monitor:read']));
    expect(within(panel).queryAllByRole('option')).toHaveLength(0);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.change(search, { target: { value: '' } });
    f.update(authenticated(['asin:read'], true));
    expect(
      within(panel)
        .getAllByRole('option')
        .map((item) => item.getAttribute('href')),
    ).toEqual(['/profile']);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/profile');
  });

  it('closes and clears background isolation on loss of verified identity', () => {
    const f = fixture();
    open();
    f.update({ status: 'loading' });
    expect(screen.queryByRole('dialog', { name: '跳转到页面' })).toBeNull();
    expect(screen.getByLabelText('页面输入').closest('[inert]')).toBeNull();
    expect(screen.getByRole('button', { name: '打开命令面板' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    f.update(authenticated());
    expect(screen.queryByRole('dialog', { name: '跳转到页面' })).toBeNull();
  });

  it.each(['dialog', 'alertdialog'])(
    'does not steal a shortcut from an open %s',
    (role) => {
      fixture();
      const other = document.createElement('div');
      other.setAttribute('role', role);
      other.setAttribute('aria-modal', 'true');
      document.body.append(other);
      try {
        const event = new KeyboardEvent('keydown', {
          key: 'k',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        });
        fireEvent(other, event);
        expect(event.defaultPrevented).toBe(false);
        expect(screen.queryByRole('dialog', { name: '跳转到页面' })).toBeNull();
        other.hidden = true;
        fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
        expect(screen.getByRole('dialog', { name: '跳转到页面' })).toBeTruthy();
      } finally {
        other.remove();
      }
    },
  );

  it('does not open over a native modal or the mobile sidebar', () => {
    fixture();
    const other = document.createElement('dialog');
    document.body.append(other);
    other.showModal();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.queryByRole('dialog', { name: '跳转到页面' })).toBeNull();
    other.close();
    other.remove();
    fireEvent.click(screen.getByRole('button', { name: '打开导航' }));
    const nav = screen.getByRole('dialog', { name: '主导航' });
    fireEvent.keyDown(nav, { key: 'k', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: '打开命令面板' }));
    expect(screen.queryByRole('dialog', { name: '跳转到页面' })).toBeNull();
    fireEvent.click(within(nav).getByRole('button', { name: '关闭导航' }));
    open();
    const menu = screen.getByRole('button', { name: '打开导航' });
    expect(menu).toHaveProperty('disabled', true);
    fireEvent.click(menu);
    expect(screen.queryByRole('dialog', { name: '主导航' })).toBeNull();
  });

  it('ignores composition, repeats, Alt and unmodified K', () => {
    fixture();
    for (const flags of [
      {},
      { ctrlKey: true, altKey: true },
      { ctrlKey: true, repeat: true },
      { metaKey: true, isComposing: true },
    ]) {
      fireEvent.keyDown(document, { key: 'k', ...flags });
      expect(screen.queryByRole('dialog', { name: '跳转到页面' })).toBeNull();
    }
  });
});
