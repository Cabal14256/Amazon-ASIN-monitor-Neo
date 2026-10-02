// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../auth/context';
import type { IdentityStore } from '../auth/identity';
import type { RouteAuthState } from '../auth/navigation';
import {
  deferred,
  jsonResponse,
  sessionFixture,
} from '../lib/transport-fixtures';
import { createTransportRuntime } from '../services/runtime';
import { AppShell } from './app-shell';
import { SYSTEM_ALERT_QUERY_KEY } from './system-announcement';

vi.mock('@tanstack/react-router', async () => {
  const { forwardRef } = await import('react');
  return {
    useRouterState: () => '/home',
    Link: forwardRef<
      HTMLAnchorElement,
      ComponentPropsWithoutRef<'a'> & { to: string }
    >(function FixtureLink({ to, ...props }, ref) {
      return <a {...props} href={to} ref={ref} />;
    }),
  };
});

const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
beforeEach(() => {
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
});
afterEach(() => {
  cleanup();
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  document.body.style.overflow = '';
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function fixture(fetcher: typeof fetch) {
  let state: Extract<RouteAuthState, { status: 'authenticated' }> = {
    status: 'authenticated',
    identity: {
      user: {
        id: 'announcement-operator',
        username: 'Fixture',
        status: 'ACTIVE',
        force_password_change: false,
      },
      roles: [],
      permissions: ['asin:read'],
      mustChangePassword: false,
      passwordExpired: false,
    },
  };
  const listeners = new Set<() => void>();
  const identity = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    logout: vi.fn(async () => undefined),
  } as unknown as IdentityStore;
  const runtime = createTransportRuntime({
    pageOrigin: 'https://app.test',
    baseURL: '/api/',
    fetch: fetcher,
    session: sessionFixture().store,
  });
  runtime.queryClient.setDefaultOptions({ queries: { retryDelay: 0 } });
  runtimes.push(runtime);
  const value = {
    identity,
    runtime,
    announce: vi.fn(),
  } satisfies AuthContextValue;
  const element = () => (
    <AuthContext.Provider value={value}>
      <AppShell title="公告验收工作台">
        <h1>页面内容</h1>
        <label>
          页面输入
          <input aria-label="页面输入" />
        </label>
      </AppShell>
    </AuthContext.Provider>
  );
  return {
    ...render(element()),
    runtime,
    element,
    updateIdentity: () =>
      act(() => {
        state = {
          ...state,
          identity: {
            ...state.identity,
            user: {
              ...state.identity.user,
              id: 'next-owner',
              username: 'Next fixture',
            },
          },
        };
        for (const listener of listeners) listener();
      }),
  };
}

const response = (message: string, type = 'info') =>
  jsonResponse({ success: true, errorCode: 0, data: { message, type } });

describe('AppShell public deployment announcements', () => {
  it.each([
    ['info', 'status', 'text-status-info'],
    ['success', 'status', 'text-status-success'],
    ['warning', 'alert', 'text-status-warning'],
    ['error', 'alert', 'text-status-danger'],
    ['future-kind', 'status', 'text-status-info'],
  ])('renders %s as readable safe feedback', async (type, role, color) => {
    fixture(async () => response('系统维护通知', type));
    const notice = await screen.findByRole(role, { name: '系统公告' });
    expect(notice.textContent).toBe('系统维护通知');
    expect(notice.className).toContain(color);
    expect(screen.getByRole('heading', { name: '页面内容' })).toBeTruthy();
  });

  it.each(['', ' \n\t '])(
    'hides empty messages %j without replacing page content',
    async (message) => {
      const f = fixture(async () => response(message));
      await waitFor(() =>
        expect(
          f.runtime.queryClient.getQueryState(SYSTEM_ALERT_QUERY_KEY)?.status,
        ).toBe('success'),
      );
      expect(screen.queryByLabelText('系统公告')).toBeNull();
      expect(screen.getByRole('heading', { name: '页面内容' })).toBeTruthy();
    },
  );

  it('renders text literally and preserves line breaks', async () => {
    const text = '<img src=x onerror=alert(1)>\n中文维护说明';
    fixture(async () => response(text));
    const notice = await screen.findByRole('status', { name: '系统公告' });
    expect(notice.querySelector('p')?.textContent).toBe(text);
    expect(notice.querySelector('img')).toBeNull();
  });

  it('refreshes changed and removed configuration through the existing query', async () => {
    let message = '第一版维护通知';
    const fetcher = vi.fn<typeof fetch>(async () => response(message));
    const f = fixture(fetcher);
    await screen.findByText(message);
    const input = screen.getByLabelText('页面输入');
    input.focus();
    message = '第二版维护通知';
    await act(() =>
      f.runtime.queryClient.invalidateQueries({
        queryKey: SYSTEM_ALERT_QUERY_KEY,
      }),
    );
    await screen.findByText(message);
    expect(document.activeElement).toBe(input);
    expect(screen.queryByText('第一版维护通知')).toBeNull();
    message = '';
    await act(() =>
      f.runtime.queryClient.invalidateQueries({
        queryKey: SYSTEM_ALERT_QUERY_KEY,
      }),
    );
    await waitFor(() => expect(screen.queryByLabelText('系统公告')).toBeNull());
    expect(document.activeElement).toBe(input);
  });

  it('reads configuration again on remount even when the public cache is fresh', async () => {
    let message = '离页前的公告';
    const fetcher = vi.fn<typeof fetch>(async () => response(message));
    const f = fixture(fetcher);
    await screen.findByText(message);
    f.unmount();
    message = '离页期间更新的公告';
    render(f.element());
    await screen.findByText(message);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('离页前的公告')).toBeNull();
  });

  it('keeps the page usable on query failure and can recover afterward', async () => {
    let healthy = false;
    const f = fixture(async () =>
      healthy
        ? response('接口已恢复')
        : jsonResponse({ errorMessage: 'Unavailable' }, 503),
    );
    await waitFor(() =>
      expect(
        f.runtime.queryClient.getQueryState(SYSTEM_ALERT_QUERY_KEY)?.status,
      ).toBe('error'),
    );
    expect(screen.queryByLabelText('系统公告')).toBeNull();
    fireEvent.change(screen.getByLabelText('页面输入'), {
      target: { value: '继续工作' },
    });
    expect((screen.getByLabelText('页面输入') as HTMLInputElement).value).toBe(
      '继续工作',
    );
    healthy = true;
    await act(() =>
      f.runtime.queryClient.invalidateQueries({
        queryKey: SYSTEM_ALERT_QUERY_KEY,
      }),
    );
    await screen.findByText('接口已恢复');
  });

  it('hides outdated warnings after a failed refresh without logging out the owner', async () => {
    let healthy = true;
    const f = fixture(async () =>
      healthy
        ? response('过期维护窗口', 'warning')
        : jsonResponse({ errorMessage: 'Unavailable' }, 401),
    );
    await screen.findByRole('alert', { name: '系统公告' });
    healthy = false;
    await act(() =>
      f.runtime.queryClient.invalidateQueries({
        queryKey: SYSTEM_ALERT_QUERY_KEY,
      }),
    );
    await waitFor(() => expect(screen.queryByLabelText('系统公告')).toBeNull());
    expect(screen.getByRole('link', { name: 'Fixture' })).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: '打开命令面板',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    f.updateIdentity();
    expect(screen.getByRole('link', { name: 'Next fixture' })).toBeTruthy();
    expect(screen.queryByText('过期维护窗口')).toBeNull();
  });

  it('stays in the inert background when the command dialog opens', async () => {
    fixture(async () => response('公告与命令面板并存'));
    const notice = await screen.findByRole('status', { name: '系统公告' });
    const trigger = screen.getByRole('button', { name: '打开命令面板' });
    trigger.focus();
    fireEvent.click(trigger);
    const panel = screen.getByRole('dialog', { name: '跳转到页面' });
    expect(panel.closest('[inert]')).toBeNull();
    expect(notice.closest('[inert]')).not.toBeNull();
    expect(document.activeElement).toBe(within(panel).getByRole('combobox'));
    fireEvent.click(
      within(panel).getByRole('button', { name: '关闭命令面板' }),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it('cancels the actual HTTP read when the shell unmounts and ignores a late response', async () => {
    const late = deferred<Response>();
    let signal: AbortSignal | undefined;
    const f = fixture(async (_url, options) => {
      signal = options?.signal ?? undefined;
      return late.promise;
    });
    await waitFor(() => expect(signal).toBeDefined());
    f.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      late.resolve(response('迟到旧公告'));
      await late.promise;
    });
    expect(screen.queryByText('迟到旧公告')).toBeNull();
    expect(
      f.runtime.queryClient.getQueryData(SYSTEM_ALERT_QUERY_KEY),
    ).toBeUndefined();
  });
});
