import IORedis from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { RedisOwnerRegistry } from './owner-registry'

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6380/15'
const keyPrefix = `wa-owner-registry-test:${process.pid}:`

describe('RedisOwnerRegistry (integration)', () => {
  let redis: IORedis
  let registry: RedisOwnerRegistry

  beforeAll(async () => {
    redis = new IORedis(redisUrl, { maxRetriesPerRequest: null })
    registry = new RedisOwnerRegistry(redis, { keyPrefix })
    await redis.ping()
  })

  beforeEach(async () => {
    await cleanupKeys()
  })

  afterAll(async () => {
    await cleanupKeys()
    await redis.quit()
  })

  it('claims, renews, and releases ownership for the active worker', async () => {
    await expect(registry.claim('instance-a', 'worker-a', 1_000)).resolves.toEqual({
      claimed: true,
      owner: 'worker-a',
    })
    await expect(registry.getOwner('instance-a')).resolves.toBe('worker-a')

    await expect(registry.renew('instance-a', 'worker-a', 1_000)).resolves.toBe(true)
    await expect(registry.release('instance-a', 'worker-a')).resolves.toBe(true)
    await expect(registry.getOwner('instance-a')).resolves.toBeNull()
  })

  it('rejects a competing worker while the lease is alive', async () => {
    await registry.claim('instance-b', 'worker-a', 1_000)

    await expect(registry.claim('instance-b', 'worker-b', 1_000)).resolves.toEqual({
      claimed: false,
      owner: 'worker-a',
    })
    await expect(registry.getOwner('instance-b')).resolves.toBe('worker-a')
  })

  it('allows only one worker to win concurrent claims', async () => {
    const results = await Promise.all([
      registry.claim('instance-race', 'worker-a', 1_000),
      registry.claim('instance-race', 'worker-b', 1_000),
    ])

    const winners = results.filter((result) => result.claimed)
    expect(winners).toHaveLength(1)
    await expect(registry.getOwner('instance-race')).resolves.toBe(winners[0]?.owner)
    expect(results.every((result) => result.owner === winners[0]?.owner)).toBe(true)
  })

  it('does not release ownership for a non-owner worker', async () => {
    await registry.claim('instance-c', 'worker-a', 1_000)

    await expect(registry.release('instance-c', 'worker-b')).resolves.toBe(false)
    await expect(registry.getOwner('instance-c')).resolves.toBe('worker-a')
  })

  it('allows another worker to claim after the lease expires', async () => {
    await registry.claim('instance-d', 'worker-a', 30)

    await expect.poll(() => registry.getOwner('instance-d'), { interval: 20, timeout: 1_000 }).toBeNull()
    await expect(registry.claim('instance-d', 'worker-b', 1_000)).resolves.toEqual({
      claimed: true,
      owner: 'worker-b',
    })
  })

  async function cleanupKeys(): Promise<void> {
    const keys = await redis.keys(`${keyPrefix}*`)
    if (keys.length > 0) {
      await redis.del(...keys)
    }
  }
})
