import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig, snapshotConfig } from '../src/config';
import { pause } from '../src/errors';
import { LwaTokenService } from '../src/lwa';
import type { HttpResponse } from '../src/types';
import { deferred, fixture, response, tokenResponse } from './fixtures';

const services: LwaTokenService[] = [];
const setup = () => {
  const f = fixture();
  f.client.close();
  const service = new LwaTokenService(f.source, f.transport, f.logger, f.now);
  services.push(service);
  return { ...f, service, signal: new AbortController().signal };
};
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  vi.useRealTimers();
});

describe('configuration and LWA token lifecycle', () => {
  it('preserves DB regional > DB global > env regional > env global precedence', () => {
    const env = {
      SP_API_LWA_CLIENT_ID: 'global-env',
      SP_API_EU_LWA_CLIENT_ID: 'eu-env',
      SP_API_USE_AWS_SIGNATURE: 'true',
    };
    expect(resolveConfig(env).regions.US.lwaClientId).toBe('global-env');
    expect(resolveConfig(env).regions.EU.lwaClientId).toBe('eu-env');
    const db = {
      SP_API_LWA_CLIENT_ID: 'global-db',
      SP_API_EU_LWA_CLIENT_ID: ' eu-db ',
      SP_API_USE_AWS_SIGNATURE: false,
    };
    const config = resolveConfig(env, db);
    expect(config.regions.US.lwaClientId).toBe('global-db');
    expect(config.regions.EU.lwaClientId).toBe('eu-db');
    expect(config.useAwsSignature).toBe(false);
  });
  it('copies immutable credentials and rejects oversized/header-injecting config', () => {
    const f = setup();
    const config = snapshotConfig(f.config);
    f.config.regions.US.lwaClientId = 'changed';
    expect(config.regions.US.lwaClientId).toBe('fixture-client');
    expect(Object.isFrozen(config.regions.US)).toBe(true);
    for (const value of ['x\r\ny', 'x'.repeat(4097)]) {
      f.config.regions.US.lwaClientSecret = value;
      expect(() => snapshotConfig(f.config)).toThrow('INVALID_CONFIG');
    }
  });
  it('keeps an explicit empty DB signing flag disabled instead of falling through to env true', () => {
    const env = { SP_API_USE_AWS_SIGNATURE: 'true' };
    for (const value of ['', false, 'false', '0', 1]) {
      expect(
        resolveConfig(env, { SP_API_USE_AWS_SIGNATURE: value }).useAwsSignature,
      ).toBe(false);
    }
    for (const value of [null, undefined]) {
      expect(
        resolveConfig(env, { SP_API_USE_AWS_SIGNATURE: value }).useAwsSignature,
      ).toBe(true);
    }
  });
  it('single-flights 20 callers per region and shares only within the same region', async () => {
    const f = setup();
    const gate = deferred<HttpResponse>();
    f.transport.request.mockReturnValue(gate.promise);
    const outcomes = ['US', 'EU'].flatMap((region) =>
      Array.from({ length: 20 }, () =>
        f.service.get(region as 'US' | 'EU', f.signal),
      ),
    );
    await vi.waitFor(() =>
      expect(f.transport.request).toHaveBeenCalledTimes(2),
    );
    gate.resolve(tokenResponse());
    const tokens = await Promise.all(outcomes);
    expect(
      tokens.every((entry) => entry.token === 'fixture-access-token'),
    ).toBe(true);
    await f.service.get('US', f.signal);
    expect(f.transport.request).toHaveBeenCalledTimes(2);
    const input = f.transport.request.mock.calls[0][0];
    expect(input.url.href).toBe('https://api.amazon.com/auth/o2/token');
    const body = new URLSearchParams(input.body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_secret')).toBe('fixture-secret');
  });
  it('refreshes at the legacy 60-second safety margin, with no negative TTL', async () => {
    const f = setup();
    const base = f.now();
    await f.service.get('US', f.signal);
    f.now.mockReturnValue(base + 3539_999);
    await f.service.get('US', f.signal);
    expect(f.transport.request).toHaveBeenCalledTimes(1);
    f.now.mockReturnValue(base + 3540_000);
    await f.service.get('US', f.signal);
    expect(f.transport.request).toHaveBeenCalledTimes(2);
    f.service.invalidate();
    f.transport.request.mockResolvedValue(
      response({ access_token: 'short-token', expires_in: 30 }),
    );
    await f.service.get('US', f.signal);
    await f.service.get('US', f.signal);
    expect(f.transport.request).toHaveBeenCalledTimes(4);
  });
  it.each([401, 400])(
    'reloads once after invalid credentials (%s) and never logs tokens',
    async (status) => {
      const f = setup();
      f.transport.request
        .mockResolvedValueOnce(
          response(
            { error: 'invalid_client', error_description: 'fixture-secret' },
            status,
          ),
        )
        .mockResolvedValueOnce(tokenResponse());
      await f.service.get('US', f.signal);
      expect(f.source.reload).toHaveBeenCalledTimes(1);
      const logs = JSON.stringify(
        Object.values(f.logger).flatMap((fn) => fn.mock.calls),
      );
      expect(logs).not.toContain('fixture-secret');
      expect(logs).not.toContain('fixture-access-token');
      expect(logs).not.toContain('fixture-refresh');
    },
  );
  it('does not loop indefinitely after a failed config reload or retry unrelated failures', async () => {
    const f = setup();
    f.transport.request.mockResolvedValue(
      response({ error: 'invalid_grant' }, 400),
    );
    await expect(f.service.get('US', f.signal)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(f.source.reload).toHaveBeenCalledTimes(1);
    expect(f.transport.request).toHaveBeenCalledTimes(2);
    f.transport.request.mockResolvedValue(response({}, 500));
    await expect(f.service.get('US', f.signal)).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(f.source.reload).toHaveBeenCalledTimes(1);
    expect(f.transport.request).toHaveBeenCalledTimes(3);
  });
  it('does not cancel a shared refresh when one subscriber cancels', async () => {
    const f = setup();
    const gate = deferred<HttpResponse>();
    f.transport.request.mockReturnValue(gate.promise);
    const first = new AbortController();
    const cancelled = f.service
      .get('US', first.signal)
      .catch((error: unknown) => error);
    const kept = f.service.get('US', f.signal);
    await vi.waitFor(() =>
      expect(f.transport.request).toHaveBeenCalledTimes(1),
    );
    first.abort();
    expect(await cancelled).toMatchObject({ code: 'CANCELLED' });
    expect(f.transport.request.mock.calls[0][0].signal.aborted).toBe(false);
    gate.resolve(tokenResponse());
    expect((await kept).token).toBe('fixture-access-token');
  });
  it('does not cache a late result after invalidation and retains a single actual refresh', async () => {
    const f = setup();
    const gate = deferred<HttpResponse>();
    f.transport.request.mockReturnValueOnce(gate.promise);
    const pending = f.service
      .get('US', f.signal)
      .catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(f.transport.request).toHaveBeenCalledTimes(1),
    );
    f.service.invalidate();
    gate.resolve(tokenResponse());
    expect(await pending).toMatchObject({ code: 'CANCELLED' });
    await f.service.get('US', f.signal);
    expect(f.transport.request).toHaveBeenCalledTimes(2);
  });
  it('rotates changed regional credentials without reusing the old cached token', async () => {
    const f = setup();
    await f.service.get('US', f.signal);
    f.config.regions.US.refreshToken = 'rotated-fixture';
    f.transport.request.mockResolvedValueOnce(
      response({ access_token: 'rotated-access' }),
    );
    expect((await f.service.get('US', f.signal)).token).toBe('rotated-access');
    expect(
      new URLSearchParams(f.transport.request.mock.calls[1][0].body).get(
        'refresh_token',
      ),
    ).toBe('rotated-fixture');
  });
  it('waits for old actual I/O before rotating, even when the old credentials fail', async () => {
    const f = setup();
    const gate = deferred<HttpResponse>();
    f.transport.request.mockReturnValueOnce(gate.promise);
    const old = f.service.get('US', f.signal).catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(f.transport.request).toHaveBeenCalledTimes(1),
    );
    f.config.regions.US.refreshToken = 'rotated-fixture';
    const fresh = f.service.get('US', f.signal);
    await Promise.resolve();
    expect(f.transport.request).toHaveBeenCalledTimes(1);
    gate.resolve(response({}, 500));
    expect(await old).toMatchObject({ statusCode: 500 });
    expect((await fresh).token).toBe('fixture-access-token');
    expect(f.transport.request).toHaveBeenCalledTimes(2);
  });
  it('aborts actual refresh I/O at ten seconds independently of the caller deadline', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.transport.request.mockImplementationOnce(async (input) => {
      await pause(60000, input.signal);
      return tokenResponse();
    });
    const outcome = f.service
      .get('US', f.signal)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await outcome).toMatchObject({ code: 'TIMEOUT' });
    expect(f.transport.request.mock.calls[0][0].signal.aborted).toBe(true);
    await f.service.get('US', f.signal);
    expect(f.transport.request).toHaveBeenCalledTimes(2);
  });
  it('does not start a refresh if close happens during config retrieval', async () => {
    const f = setup();
    const gate = deferred<typeof f.config>();
    f.source.get.mockReturnValueOnce(gate.promise);
    const outcome = f.service
      .get('US', f.signal)
      .catch((error: unknown) => error);
    f.service.close();
    gate.resolve(f.config);
    expect(await outcome).toMatchObject({ code: 'CLOSED' });
    expect(f.transport.request).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { access_token: 'x\r\ny' },
    { access_token: 'x'.repeat(2049) },
    { access_token: 'ok', expires_in: 0 },
    { access_token: 'ok', expires_in: 86401 },
    { access_token: 'ok', token_type: 'basic' },
  ])(
    'rejects malformed token replies without caching (%j)',
    async (payload) => {
      const f = setup();
      f.transport.request.mockResolvedValueOnce(response(payload));
      await expect(f.service.get('US', f.signal)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
      await f.service.get('US', f.signal);
      expect(f.transport.request).toHaveBeenCalledTimes(2);
    },
  );
  it('rejects missing or template credentials before HTTP', async () => {
    const f = setup();
    f.config.regions.US.refreshToken = 'your_refresh_token';
    await expect(f.service.get('US', f.signal)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    expect(f.transport.request).not.toHaveBeenCalled();
  });
});
