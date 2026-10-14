import { createServer, type AddressInfo } from 'node:net';

/** Run before any connection/schema/queue is created, including existing helper calls. */
export function assertMetricsFixtureTargets(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    env.RUN_INTEGRATION_TESTS !== 'true' ||
    env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true' ||
    env.TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE !== 'amazon_asin_monitor_ci'
  )
    throw new Error(
      'Metrics native fixture requires explicit disposable CI opt-in',
    );
  for (const [key, database] of [
    ['DATABASE_URL', 'amazon_asin_monitor_ci'],
    ['COMPETITOR_DATABASE_URL', 'amazon_competitor_monitor_ci'],
  ]) {
    const url = new URL(env[key] ?? '');
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      (url.port && url.port !== '5432') ||
      url.pathname !== '/' + database ||
      url.search ||
      url.hash
    )
      throw new Error(
        'Metrics native fixture requires exact local PostgreSQL CI targets',
      );
  }
  const redis = new URL(env.REDIS_URL ?? '');
  if (
    redis.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(redis.hostname) ||
    (redis.port && redis.port !== '6379') ||
    redis.pathname !== '/15' ||
    redis.search ||
    redis.hash
  )
    throw new Error('Metrics native fixture requires local Redis DB 15');
}

export async function availableMetricsPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export async function scrapeWorker(port: number): Promise<string> {
  const response = await fetch('http://127.0.0.1:' + port + '/metrics', {
    signal: AbortSignal.timeout(2000),
  });
  if (
    response.status !== 200 ||
    !response.headers.get('content-type')?.includes('text/plain')
  )
    throw new Error('Worker metrics scrape unavailable');
  return response.text();
}

export function metricValue(
  text: string,
  suffix: string,
  labels: Record<string, string>,
): number {
  const name = 'amazon_asin_monitor_' + suffix;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name + '{')) continue;
    const match = line.match(/^([^ {]+)\{([^}]*)\} ([-+.0-9eE]+)$/);
    if (!match || match[1] !== name) continue;
    const actual = Object.fromEntries(
      [...match[2].matchAll(/([^=,]+)="([^"]*)"/g)].map((item) => [
        item[1],
        item[2],
      ]),
    );
    if (
      Object.keys(actual).length === Object.keys(labels).length &&
      Object.entries(labels).every(([key, value]) => actual[key] === value)
    )
      return Number(match[3]);
  }
  return 0;
}
