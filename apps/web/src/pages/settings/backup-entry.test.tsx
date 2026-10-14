// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import { deferred, jsonResponse } from '../../lib/transport-fixtures';
import { createTransportRuntime } from '../../services/runtime';
import { BackupEntry } from './backup-entry';

vi.mock('./backup-panel', () => ({
  BackupPanel: () => <p>Verified backup workflow</p>,
}));
const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});
function fixture(
  response: Response | Promise<Response>,
  permissions = ['settings:write'],
) {
  const fetcher = vi.fn<typeof fetch>(async () => response);
  const runtime = createTransportRuntime({
    pageOrigin: 'https://app.test',
    baseURL: '/api/',
    fetch: fetcher,
  });
  runtimes.push(runtime);
  const state = {
    status: 'authenticated' as const,
    identity: {
      user: { id: 'fixture', username: 'fixture', status: 'ACTIVE' as const },
      sessionId: 'session',
      roles: [],
      permissions,
    },
  };
  const identity = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    refresh: vi.fn(),
  } as unknown as IdentityStore;
  const view = render(
    <AuthContext.Provider value={{ runtime, identity, announce: vi.fn() }}>
      <BackupEntry />
    </AuthContext.Provider>,
  );
  return { fetcher, runtime, view };
}
const capability = () =>
  jsonResponse({
    success: true,
    data: {
      protocol: 'neo-postgresql-backup-v1',
      format: 'custom',
      targets: ['primary', 'competitor'],
    },
  });
describe('backup service protocol admission', () => {
  it.each([
    jsonResponse({ success: false }, 404),
    jsonResponse({ success: true, data: [] }),
    jsonResponse({ success: true, data: { protocol: 'legacy-mysql' } }),
  ])(
    'keeps Legacy or unimplemented services unavailable without posting',
    async (response) => {
      const f = fixture(response);
      await screen.findByRole('button', { name: '重新确认备份服务' });
      expect(screen.queryByText('Verified backup workflow')).toBeNull();
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(f.fetcher.mock.calls[0][0]).toBe(
        'https://app.test/api/v1/backup/capabilities',
      );
      expect(f.fetcher.mock.calls[0][1]?.method).toBe('GET');
    },
  );
  it('mounts only after the configured service confirms both Neo targets and retries with GET', async () => {
    const pending = deferred<Response>();
    const f = fixture(pending.promise);
    expect(screen.queryByText('Verified backup workflow')).toBeNull();
    await act(async () => {
      pending.resolve(jsonResponse({}, 503));
    });
    fireEvent.click(
      await screen.findByRole('button', { name: '重新确认备份服务' }),
    );
    // A retry still cannot mount from the prior failure.
    await screen.findByRole('button', { name: '重新确认备份服务' });
    f.fetcher.mockResolvedValueOnce(capability());
    fireEvent.click(screen.getByRole('button', { name: '重新确认备份服务' }));
    await screen.findByText('Verified backup workflow');
    expect(
      f.fetcher.mock.calls.every(([, init]) => init?.method === 'GET'),
    ).toBe(true);
  });
  it('does not probe without the current settings write grant', async () => {
    const f = fixture(capability(), ['settings:read']);
    expect(screen.getByText('当前账号没有备份操作权限。')).toBeTruthy();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('aborts an old probe when the backup tab unmounts', async () => {
    const pending = deferred<Response>();
    const f = fixture(pending.promise);
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    f.view.unmount();
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    pending.resolve(capability());
  });
});
