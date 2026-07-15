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
    const claim = await registry.claim('instance-a', 'worker-a', 1_000)
    expect(claim).toEqual({
      claimed: true,
      owner: 'worker-a',
      epoch: 1n,
    })
    await expect(registry.getOwner('instance-a')).resolves.toBe('worker-a')
    await expect(registry.getOwnership('instance-a')).resolves.toEqual({
      owner: 'worker-a',
      epoch: 1n,
    })

    await expect(registry.renew('instance-a', 'worker-a', 1_000, claim.epoch)).resolves.toBe(true)
    await expect(registry.release('instance-a', 'worker-a', claim.epoch)).resolves.toBe(true)
    await expect(registry.getOwner('instance-a')).resolves.toBeNull()
    await expect(registry.getOwnership('instance-a')).resolves.toBeNull()
  })

  it('rejects a competing worker while the lease is alive', async () => {
    await registry.claim('instance-b', 'worker-a', 1_000)

    await expect(registry.claim('instance-b', 'worker-b', 1_000)).resolves.toEqual({
      claimed: false,
      owner: 'worker-a',
      epoch: 1n,
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

    await expect(registry.release('instance-c', 'worker-b', 1n)).resolves.toBe(false)
    await expect(registry.getOwner('instance-c')).resolves.toBe('worker-a')
  })

  it('does not let a non-owner worker renew a live lease', async () => {
    await registry.claim('instance-renew-foreign', 'worker-a', 30)

    await expect(registry.renew('instance-renew-foreign', 'worker-b', 1_000, 1n)).resolves.toBe(
      false,
    )
    await expect
      .poll(() => registry.getOwner('instance-renew-foreign'), { interval: 20, timeout: 1_000 })
      .toBeNull()
    await expect(registry.claim('instance-renew-foreign', 'worker-b', 1_000)).resolves.toEqual({
      claimed: true,
      owner: 'worker-b',
      epoch: 2n,
    })
  })

  it('allows another worker to claim after the lease expires', async () => {
    await registry.claim('instance-d', 'worker-a', 30)

    await expect
      .poll(() => registry.getOwner('instance-d'), { interval: 20, timeout: 1_000 })
      .toBeNull()
    await expect(registry.claim('instance-d', 'worker-b', 1_000)).resolves.toEqual({
      claimed: true,
      owner: 'worker-b',
      epoch: 2n,
    })
  })

  it('keeps encoded instance keys independent', async () => {
    await expect(registry.claim('team A/wa:1', 'worker-a', 1_000)).resolves.toEqual({
      claimed: true,
      owner: 'worker-a',
      epoch: 1n,
    })
    await expect(registry.claim('team A/wa:2', 'worker-b', 1_000)).resolves.toEqual({
      claimed: true,
      owner: 'worker-b',
      epoch: 1n,
    })

    await expect(registry.getOwner('team A/wa:1')).resolves.toBe('worker-a')
    await expect(registry.getOwner('team A/wa:2')).resolves.toBe('worker-b')
  })

  it('rejects empty instance ids', async () => {
    await expect(registry.claim('', 'worker-a', 1_000)).rejects.toThrow(
      'instanceId must be a non-empty string',
    )
    await expect(registry.claim('   ', 'worker-a', 1_000)).rejects.toThrow(
      'instanceId must be a non-empty string',
    )
    await expect(registry.renew('', 'worker-a', 1_000, 1n)).rejects.toThrow(
      'instanceId must be a non-empty string',
    )
    await expect(registry.release('', 'worker-a', 1n)).rejects.toThrow(
      'instanceId must be a non-empty string',
    )
    await expect(registry.getOwner('   ')).rejects.toThrow('instanceId must be a non-empty string')
  })

  it('rejects empty worker ids', async () => {
    await expect(registry.claim('instance-empty-worker', '', 1_000)).rejects.toThrow(
      'workerId must be a non-empty string',
    )
    await expect(registry.claim('instance-empty-worker', '   ', 1_000)).rejects.toThrow(
      'workerId must be a non-empty string',
    )
    await expect(registry.renew('instance-empty-worker', '', 1_000, 1n)).rejects.toThrow(
      'workerId must be a non-empty string',
    )
    await expect(registry.release('instance-empty-worker', '   ', 1n)).rejects.toThrow(
      'workerId must be a non-empty string',
    )
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid ttlMs value %s',
    async (ttlMs) => {
      await expect(registry.claim('instance-invalid-ttl', 'worker-a', ttlMs)).rejects.toThrow(
        'ttlMs must be a positive safe integer',
      )
      await expect(registry.renew('instance-invalid-ttl', 'worker-a', ttlMs, 1n)).rejects.toThrow(
        'ttlMs must be a positive safe integer',
      )
    },
  )

  it('rejects stale renew and release after a newer ownership epoch wins', async () => {
    const first = await registry.claim('instance-fenced', 'worker-a', 30)
    await expect
      .poll(() => registry.getOwner('instance-fenced'), { interval: 20, timeout: 1_000 })
      .toBeNull()
    const second = await registry.claim('instance-fenced', 'worker-a', 1_000)

    expect(second.epoch).toBeGreaterThan(first.epoch)
    await expect(registry.renew('instance-fenced', 'worker-a', 1_000, first.epoch)).resolves.toBe(
      false,
    )
    await expect(registry.release('instance-fenced', 'worker-a', first.epoch)).resolves.toBe(false)
    await expect(registry.getOwner('instance-fenced')).resolves.toBe('worker-a')
  })

  it('advances a reset Redis fence above the persistence floor in one claim', async () => {
    const claim = await registry.claim('instance-floor', 'worker-a', 1_000, 9n)

    expect(claim).toEqual({ claimed: true, owner: 'worker-a', epoch: 10n })
    await expect(registry.getOwnership('instance-floor')).resolves.toEqual({
      owner: 'worker-a',
      epoch: 10n,
    })
  })

  it('compares persistence floors as decimal strings above JavaScript safe integers', async () => {
    const floor = 9_007_199_254_740_993n

    const claim = await registry.claim('instance-large-floor', 'worker-a', 1_000, floor)

    expect(claim).toEqual({ claimed: true, owner: 'worker-a', epoch: floor + 1n })
  })

  async function cleanupKeys(): Promise<void> {
    const keys = await redis.keys(`${keyPrefix}*`)
    if (keys.length > 0) {
      await redis.del(...keys)
    }
  }
})
