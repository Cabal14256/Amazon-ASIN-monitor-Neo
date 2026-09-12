import { randomUUID } from 'node:crypto';
import type {
  CatalogCheckIdentity,
  CatalogCheckStore,
  DeferredCatalogCheck,
} from './catalog-checker';
import {
  decodeCatalogVariantResult,
  MAX_CATALOG_BYTES,
  type CatalogVariantResult,
} from './catalog-variants';
import { abortError, SpApiError, waitFor } from './errors';
import { normalizeProductAsin } from './html-variants';
import type { QuotaRedisPort } from './quota-redis';
import { getRegionByCountry, normalizeCountry } from './request';

export const CATALOG_CACHE_MAX_ENTRIES = 256;
export const CATALOG_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const CATALOG_DEFERRED_MAX_ENTRIES = 2000;
const claimTtlMs = 1_200_000;

const READ = `
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'none' then return false end
if kind ~= 'hash' then return redis.error_reply('CATALOG_WRONGTYPE') end
if redis.call('HSTRLEN', KEYS[1], 'raw') > tonumber(ARGV[1]) then return false end
return redis.call('HGET', KEYS[1], 'raw')
`;
// Lua is atomic against interleaving, not a rollback mechanism. Validate all
// existing index metadata before the first mutation. Dynamic keys are constrained
// to this catalog prefix plus a validated country/ASIN member.
const WRITE = `
local types = {'hash', 'zset', 'hash'}
for i = 1, 3 do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= types[i] then return redis.error_reply('CATALOG_WRONGTYPE') end
end
local members = redis.call('ZRANGE', KEYS[2], 0, tonumber(ARGV[5]))
if #members > tonumber(ARGV[5]) or redis.call('HLEN', KEYS[3]) > tonumber(ARGV[5]) then return redis.error_reply('CATALOG_INDEX_INVALID') end
local total = 0
for _, member in ipairs(members) do
  if string.len(member) ~= 13 or not string.match(member, '^%u%u:[A-Z0-9]+$') then return redis.error_reply('CATALOG_INDEX_INVALID') end
  local size = tonumber(redis.call('HGET', KEYS[3], member))
  if not size or size < 0 or size > tonumber(ARGV[7]) then return redis.error_reply('CATALOG_INDEX_INVALID') end
  total = total + size
end
if redis.call('HLEN', KEYS[3]) ~= #members then return redis.error_reply('CATALOG_INDEX_INVALID') end
local mode = ARGV[1]
local previous = tonumber(redis.call('HGET', KEYS[3], ARGV[3])) or 0
if mode == 'write' and redis.call('HGET', KEYS[1], 'claim') ~= ARGV[2] then return 0 end
local now = redis.call('TIME')
local stamp = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local size = 0
if mode == 'write' then
  size = string.len(ARGV[8])
  redis.call('HSET', KEYS[1], 'raw', ARGV[8])
else
  redis.call('HSET', KEYS[1], 'claim', ARGV[2])
  redis.call('HDEL', KEYS[1], 'raw')
end
redis.call('PEXPIRE', KEYS[1], ARGV[9])
redis.call('ZADD', KEYS[2], stamp, ARGV[3])
redis.call('HSET', KEYS[3], ARGV[3], size)
total = total - previous + size
while redis.call('ZCARD', KEYS[2]) > tonumber(ARGV[5]) or total > tonumber(ARGV[6]) do
  local oldest = redis.call('ZRANGE', KEYS[2], 0, 0)[1]
  total = total - tonumber(redis.call('HGET', KEYS[3], oldest))
  redis.call('DEL', ARGV[4] .. oldest)
  redis.call('ZREM', KEYS[2], oldest)
  redis.call('HDEL', KEYS[3], oldest)
end
redis.call('PEXPIRE', KEYS[2], ARGV[10])
redis.call('PEXPIRE', KEYS[3], ARGV[10])
return 1
`;
const DEFER = `
local indexType = redis.call('TYPE', KEYS[1]).ok
local valueType = redis.call('TYPE', KEYS[2]).ok
if (indexType ~= 'none' and indexType ~= 'zset') or (valueType ~= 'none' and valueType ~= 'string') then return redis.error_reply('CATALOG_WRONGTYPE') end
local now = redis.call('TIME')
local stamp = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', stamp)
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('ZADD', KEYS[1], stamp + tonumber(ARGV[3]) * 1000, ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`;
const CLEAR_DEFERRED = `
local kind = redis.call('TYPE', KEYS[1]).ok
if kind ~= 'none' and kind ~= 'zset' then return redis.error_reply('CATALOG_WRONGTYPE') end
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
`;

/** Shared bounded cache and deferred coordination. The application owns Redis;
 * use a bounded, fail-fast connection (no offline queue or command replay).
 * Local admission is retained through actual completion of a timed-out command.
 */
export class RedisCatalogCheckStore implements CatalogCheckStore {
  private readonly prefix: string;
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(
    private readonly redis: Pick<QuotaRedisPort, 'status' | 'eval'>,
    prefix: string,
    private readonly timeoutMs = 1000,
  ) {
    if (
      typeof prefix !== 'string' ||
      !prefix.trim() ||
      prefix.length > 200 ||
      /[\x00-\x20]/.test(prefix.trim()) ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 5000
    )
      throw new SpApiError('INVALID_CONFIG');
    this.prefix = `${prefix.trim()}:neo:catalog`;
  }
  private member(identity: CatalogCheckIdentity): string {
    if (!['primary', 'competitor'].includes(identity.owner))
      throw new SpApiError('INVALID_INPUT');
    return `${normalizeCountry(identity.country)}:${normalizeProductAsin(
      identity.asin,
    )}`;
  }
  private async command(
    script: string,
    keys: string[],
    args: (string | number)[],
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) throw new SpApiError('CLOSED');
    if (signal.aborted) throw new SpApiError('CANCELLED');
    if (this.redis.status !== 'ready') throw new SpApiError('DEPENDENCY_ERROR');
    if (this.active.size >= 64) throw new SpApiError('CAPACITY');
    const controller = new AbortController();
    this.active.add(controller);
    const abort = () => controller.abort(new SpApiError('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new SpApiError('TIMEOUT')),
      this.timeoutMs,
    );
    const work = Promise.resolve()
      .then(async () => {
        if (controller.signal.aborted) throw abortError(controller.signal);
        const value = await this.redis.eval(
          script,
          keys.length,
          ...keys,
          ...args,
        );
        if (controller.signal.aborted) throw abortError(controller.signal);
        return value;
      })
      .catch((error: unknown) => {
        throw error instanceof SpApiError
          ? error
          : new SpApiError('DEPENDENCY_ERROR');
      })
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.active.delete(controller);
      });
    return waitFor(work, controller.signal);
  }
  async read(
    identity: CatalogCheckIdentity,
    signal: AbortSignal,
  ): Promise<CatalogVariantResult | undefined> {
    const member = this.member(identity);
    const raw = await this.command(
      READ,
      [`${this.prefix}:cache:${member}`],
      [MAX_CATALOG_BYTES],
      signal,
    );
    if (raw === null || raw === false) return undefined;
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_CATALOG_BYTES)
      throw new SpApiError('INVALID_RESPONSE');
    try {
      return decodeCatalogVariantResult(
        JSON.parse(raw),
        identity.asin,
        normalizeCountry(identity.country),
      );
    } catch {
      return undefined;
    }
  }
  private async mutate(
    identity: CatalogCheckIdentity,
    token: string,
    raw: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const member = this.member(identity);
    const base = `${this.prefix}:cache:`;
    const outcome = await this.command(
      WRITE,
      [
        `${base}${member}`,
        `${this.prefix}:cache-index`,
        `${this.prefix}:cache-sizes`,
      ],
      [
        raw === undefined ? 'claim' : 'write',
        token,
        member,
        base,
        CATALOG_CACHE_MAX_ENTRIES,
        CATALOG_CACHE_MAX_BYTES,
        MAX_CATALOG_BYTES,
        raw ?? '',
        raw === undefined ? claimTtlMs : 600_000,
        claimTtlMs,
      ],
      signal,
    );
    if (outcome !== 0 && outcome !== 1)
      throw new SpApiError('INVALID_RESPONSE');
  }
  async claim(
    identity: CatalogCheckIdentity,
    signal: AbortSignal,
  ): Promise<string> {
    const token = randomUUID();
    await this.mutate(identity, token, undefined, signal);
    return token;
  }
  async write(
    identity: CatalogCheckIdentity,
    claim: string,
    result: CatalogVariantResult,
    ttlSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        claim,
      ) ||
      ttlSeconds !== 600
    )
      throw new SpApiError('INVALID_INPUT');
    const decoded = decodeCatalogVariantResult(
      result,
      identity.asin,
      normalizeCountry(identity.country),
    );
    await this.mutate(identity, claim, JSON.stringify(decoded), signal);
  }
  /** Call after committing status. Also fences an older in-flight response. */
  async invalidate(
    identity: CatalogCheckIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    await this.claim(identity, signal);
  }
  private deferredKeys(identity: CatalogCheckIdentity) {
    const member = this.member(identity);
    const index = `${this.prefix}:deferred:${getRegionByCountry(
      identity.country,
    )}:${identity.owner}`;
    return { member, keys: [index, `${index}:item:${member}`] };
  }
  async defer(
    value: DeferredCatalogCheck,
    ttlSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { member, keys } = this.deferredKeys(value);
    if (
      ttlSeconds !== 3600 ||
      value.region !== getRegionByCountry(value.country) ||
      !Number.isSafeInteger(value.deferredAt) ||
      value.deferredAt < 0 ||
      !Number.isInteger(value.retryCount) ||
      value.retryCount < 0 ||
      value.retryCount > 10 ||
      !/^SP-API [A-Z_]+(?: \([1-5]\d\d\))?$/.test(value.error)
    )
      throw new SpApiError('INVALID_INPUT');
    const raw = JSON.stringify({
      asin: normalizeProductAsin(value.asin),
      country: normalizeCountry(value.country),
      region: value.region,
      owner: value.owner,
      error: value.error,
      deferredAt: value.deferredAt,
      retryCount: value.retryCount,
    });
    if (Buffer.byteLength(raw) > 512) throw new SpApiError('BODY_TOO_LARGE');
    const outcome = await this.command(
      DEFER,
      keys,
      [member, raw, ttlSeconds, CATALOG_DEFERRED_MAX_ENTRIES],
      signal,
    );
    if (outcome === 0) throw new SpApiError('CAPACITY');
    if (outcome !== 1) throw new SpApiError('INVALID_RESPONSE');
  }
  async clearDeferred(
    identity: CatalogCheckIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    const { member, keys } = this.deferredKeys(identity);
    const outcome = await this.command(CLEAR_DEFERRED, keys, [member], signal);
    if (outcome !== 1) throw new SpApiError('INVALID_RESPONSE');
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.active)
      controller.abort(new SpApiError('CLOSED'));
  }
}
