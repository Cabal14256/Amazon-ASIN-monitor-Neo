/**
 * Test-only semantic model. It does not interpret or execute Lua.
 * Native Redis transport gates remain required to verify the production script.
 * Native oracles must separately execute the actual production scripts.
 */
export const ANALYTICS_CACHE_MODEL_MARKERS = {
  capture: '-- neo-analytics-cache-capture:v2',
  lookup: '-- neo-analytics-cache-lookup:v2',
  fill: '-- neo-analytics-cache-fill:v2',
  rotate: '-- neo-analytics-cache-rotate:v2',
} as const;

type Arguments = readonly (string | number)[];
type Stored =
  | { kind: 'string'; value: string; expiresAt?: number }
  | { kind: 'other'; expiresAt?: number };
type LegacyEval = (
  script: string,
  keys: string[],
  args: (string | number)[],
) => Promise<unknown>;
const token = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const integer = (value: string | number | undefined): number | undefined => {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
};

export function analyticsCacheRedisMemoryModel(options: {
  dataValues: Map<string, string>;
  legacyEval: LegacyEval;
  serverNow?: () => number;
}) {
  // Keep persistent metadata outside the old fixture's data-only values view.
  // Both maps belong to this shared Redis model, not to either API instance.
  const controls = new Map<string, Stored>();
  const dataExpiry = new Map<string, number>();
  const now = options.serverNow ?? Date.now;
  const diagnostics = {
    generationGets: 0,
    payloadGets: 0,
    modelTransitions: 0,
  };
  function current(key: string) {
    const value = controls.get(key);
    if (value?.expiresAt !== undefined && value.expiresAt <= now()) {
      controls.delete(key);
      return undefined;
    }
    return value;
  }
  function generation(key: string, candidate?: string): string | null {
    let value = current(key);
    if (!value && candidate !== undefined) {
      if (!token(candidate)) return null;
      // Simulates atomic missing-key NX only; never repairs an existing value.
      value = { kind: 'string', value: candidate };
      controls.set(key, value);
    }
    if (!value || value.kind !== 'string') return null;
    if (Buffer.byteLength(value.value) !== 64 || value.expiresAt !== undefined)
      return null;
    diagnostics.generationGets++;
    return token(value.value) ? value.value : null;
  }
  function payload(key: string, limit: number): string | null {
    const expires = dataExpiry.get(key);
    if (expires !== undefined && expires <= now()) {
      dataExpiry.delete(key);
      options.dataValues.delete(key);
    }
    const value = options.dataValues.get(key);
    if (value === undefined || Buffer.byteLength(value) > limit) return null;
    diagnostics.payloadGets++;
    return value;
  }
  async function evalModel(
    script: string,
    keys: readonly string[],
    args: Arguments,
  ) {
    const marker = script.split('\n', 1)[0];
    if (marker === ANALYTICS_CACHE_MODEL_MARKERS.capture) {
      if (keys.length !== 1 || args.length !== 1 || !token(args[0]))
        return null;
      const captured = generation(keys[0], args[0]);
      if (captured === null) return null;
      const serverTime = now();
      if (!Number.isSafeInteger(serverTime) || serverTime < 0) return null;
      diagnostics.modelTransitions++;
      return [captured, String(serverTime)];
    }
    if (marker === ANALYTICS_CACHE_MODEL_MARKERS.lookup) {
      const limit = integer(args[1]);
      if (
        keys.length !== 2 ||
        args.length !== 2 ||
        !token(args[0]) ||
        limit === undefined ||
        limit < 1 ||
        limit > 2 * 1024 * 1024
      )
        return null;
      const captured = generation(keys[0], args[0]);
      if (captured === null) return null;
      // Synchronous state transition: captured lease and payload are one model
      // operation. JSON/version/envelope checks stay in the real Cache class.
      const raw = payload(keys[1], limit);
      diagnostics.modelTransitions++;
      return [captured, raw];
    }
    if (marker === ANALYTICS_CACHE_MODEL_MARKERS.fill) {
      const ttl = integer(args[2]);
      if (
        keys.length !== 2 ||
        args.length !== 3 ||
        !token(args[0]) ||
        typeof args[1] !== 'string' ||
        Buffer.byteLength(args[1]) > 2 * 1024 * 1024 ||
        ttl === undefined ||
        ttl <= 0 ||
        ttl > 3600000
      )
        return 0;
      // No initialization on a fill: a missing or recreated control key fences
      // this old lease instead of allowing it to choose a new generation.
      if (generation(keys[0]) !== args[0]) return 0;
      options.dataValues.set(keys[1], args[1]);
      dataExpiry.set(keys[1], now() + ttl);
      diagnostics.modelTransitions++;
      return 'OK';
    }
    if (marker === ANALYTICS_CACHE_MODEL_MARKERS.rotate) {
      const ttl = integer(args[3]);
      const fixedDeadline = integer(args[4]);
      if (
        keys.length !== 2 ||
        args.length !== 5 ||
        !token(args[0]) ||
        !token(args[1]) ||
        args[0] === args[1] ||
        typeof args[2] !== 'string' ||
        args[2].length > 64 ||
        ttl === undefined ||
        ttl <= 0 ||
        ttl > 2592000 ||
        fixedDeadline === undefined ||
        fixedDeadline < 0
      )
        return -2;
      const captured = generation(keys[0]);
      if (captured === null) return -2;
      if (captured !== args[0]) return 0;
      // Fixed absolute Redis-server deadline computed once after capture ACK.
      // Delaying actual execution beyond it cannot be fixed by a new budget.
      const serverTime = now();
      if (
        !Number.isSafeInteger(serverTime) ||
        serverTime < 0 ||
        serverTime >= fixedDeadline
      )
        return -1;
      // All input/state checks precede writes. This models success isolation;
      // it is not a claim that Redis scripts provide rollback after arbitrary errors.
      controls.set(keys[0], { kind: 'string', value: args[1] });
      controls.set(keys[1], {
        kind: 'string',
        value: args[2],
        expiresAt: serverTime + ttl * 1000,
      });
      diagnostics.modelTransitions++;
      return 1;
    }
    // Original product scripts keep their original fixture behavior. A future
    // production script without one of the exact proposed markers must fail
    // rather than silently be modeled as a successful fence.
    if (
      keys.length === 1 &&
      (script.includes("redis.call('STRLEN', KEYS[1])") ||
        script === "return redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])")
    )
      return options.legacyEval(script, [...keys], [...args]);
    throw new Error('UNSUPPORTED_ANALYTICS_CACHE_MODEL_SCRIPT');
  }
  async function get(key: string): Promise<string | null> {
    const value = current(key);
    if (value) {
      if (value.kind !== 'string') throw new Error('MODEL_WRONGTYPE');
      return value.value;
    }
    return options.dataValues.get(key) ?? null;
  }
  return {
    controls,
    diagnostics,
    eval: evalModel,
    get,
    // Tests may inject wrong type/TTL/oversize control metadata explicitly.
    // Do not expose key/token/payload diagnostics through application logging.
  };
}
