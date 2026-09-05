import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisTaskRepository } from '../src/repositories/redis-task-repository';

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';
describe.skipIf(!enabled)('Neo task registry / real Redis', () => {
  const prefix = `fixture-task-registry-${randomUUID()}`;
  const config = {
    BULL_PREFIX: prefix,
    TASK_META_TTL_SECONDS: 604800,
    TASK_USER_MAX_ITEMS: 200,
  };
  const connectionOptions = {
    lazyConnect: true,
    commandTimeout: 2000,
    connectTimeout: 2000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    autoResendUnfulfilledCommands: false,
  };
  const redis = new Redis(
    process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/15',
    connectionOptions,
  );
  const peer = new Redis(
    process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/15',
    connectionOptions,
  );
  const keys = new Set<string>();
  const metaKey = (id: string) =>
    `${prefix}:neo:task:meta:${encodeURIComponent(id)}`;
  const userKey = (id: string) =>
    `${prefix}:neo:task:user:${encodeURIComponent(id)}`;
  const repository = new RedisTaskRepository(redis, config);
  const other = new RedisTaskRepository(peer, config);
  const create = async (
    taskId: string,
    userId = 'fixture-owner',
    repo = repository,
  ) => {
    keys.add(metaKey(taskId));
    keys.add(userKey(userId));
    return repo.create({ taskId, userId, taskType: 'export' });
  };
  beforeAll(async () => {
    await Promise.all([redis.connect(), peer.connect()]);
  });
  afterAll(async () => {
    try {
      if (redis.status === 'ready' && keys.size) await redis.del(...keys);
    } finally {
      redis.disconnect();
      peer.disconnect();
    }
  });
  it('preserves default TTL, shared reads, immutable owner and Legacy namespace isolation', async () => {
    const legacy = `task:meta:${prefix}-independent`;
    keys.add(legacy);
    await redis.set(legacy, 'unchanged', 'EX', 60);
    const task = await create('shared');
    expect(await other.read('shared')).toEqual(task);
    expect(await redis.ttl(metaKey('shared'))).toBeGreaterThan(604790);
    expect(await redis.ttl(userKey('fixture-owner'))).toBeGreaterThan(604790);
    await expect(
      other.create({ taskId: 'shared', userId: 'foreign', taskType: 'export' }),
    ).rejects.toMatchObject({ code: 'TASK_EXISTS' });
    expect(await other.listUser('foreign')).toEqual([]);
    expect(await redis.get(legacy)).toBe('unchanged');
  });
  it('does not lose cancellation across two concurrent writers and never regresses terminal results', async () => {
    for (let round = 0; round < 20; round++) {
      const id = `race-${round}`;
      await create(id, 'race-owner');
      await Promise.all([
        repository.mutate(id, { kind: 'progress', progress: 40 }),
        other.mutate(id, { kind: 'cancel-request' }),
      ]);
      expect(await other.read(id)).toMatchObject({
        status: 'cancelling',
        progress: 40,
        revision: 2,
      });
      expect((await other.read(id))?.cancelRequestedAt).not.toBeNull();
      await Promise.all([
        repository.mutate(id, { kind: 'completed', result: { rows: 12 } }),
        other.mutate(id, { kind: 'failed', message: 'fixture failure' }),
      ]);
      const terminal = await other.read(id);
      expect(['completed', 'failed']).toContain(terminal?.status);
      expect(terminal?.revision).toBe(3);
      expect(await repository.mutate(id, { kind: 'processing' })).toEqual(
        terminal,
      );
    }
  });
  it('filters the bounded user index without overlooking older active tasks and trims to the configured cap', async () => {
    const small = new RedisTaskRepository(redis, {
      ...config,
      TASK_USER_MAX_ITEMS: 10,
    });
    await create('old-active', 'index-owner', small);
    for (let index = 0; index < 8; index++) {
      const id = `done-${index}`;
      await create(id, 'index-owner', small);
      await small.mutate(id, { kind: 'completed' });
    }
    expect(
      (await small.listUser('index-owner', { limit: 1, status: 'active' })).map(
        (t) => t.taskId,
      ),
    ).toEqual(['old-active']);
    for (let index = 0; index < 8; index++)
      await create(`new-${index}`, 'index-owner', small);
    expect(await redis.zcard(userKey('index-owner'))).toBe(10);
    expect(await small.listUser('another-owner')).toEqual([]);
  });
  it('lets metadata expire without reviving a task from a stale index or another process', async () => {
    await create('expires', 'expiry-owner');
    await redis.pexpire(metaKey('expires'), 30);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await other.read('expires')).toBeNull();
    expect(await other.listUser('expiry-owner')).toEqual([]);
    expect(await other.mutate('expires', { kind: 'completed' })).toBeNull();
    expect(await redis.exists(metaKey('expires'))).toBe(0);
  });
  it('checks index type before writing metadata and explicitly rejects an unavailable connection', async () => {
    keys.add(userKey('wrongtype-owner'));
    keys.add(metaKey('wrongtype'));
    await redis.set(userKey('wrongtype-owner'), 'fixture wrong type', 'EX', 60);
    await expect(create('wrongtype', 'wrongtype-owner')).rejects.toThrow(
      'TASK_REGISTRY_WRONGTYPE',
    );
    expect(await redis.exists(metaKey('wrongtype'))).toBe(0);
    const disconnected = new Redis(
      process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/15',
      connectionOptions,
    );
    const unavailable = new RedisTaskRepository(disconnected, config);
    try {
      await expect(
        unavailable.create({
          taskId: 'offline',
          userId: 'offline',
          taskType: 'export',
        }),
      ).rejects.toThrow();
    } finally {
      disconnected.disconnect();
    }
    expect(await redis.exists(metaKey('offline'))).toBe(0);
  });
});
