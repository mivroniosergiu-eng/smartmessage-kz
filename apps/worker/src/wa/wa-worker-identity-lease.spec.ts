import { randomUUID } from 'node:crypto'

import { createConnection } from '@smartmessage/queue'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  WaWorkerIdentityConflictError,
  WaWorkerIdentityLease,
  WaWorkerIdentityLeaseLostError,
  WaWorkerIdentityRenewalTimeoutError,
} from './wa-worker-identity-lease'

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6380/14'
const keyPrefix = `wa-worker-identity-test:${process.pid}:${randomUUID()}:`

describe('WaWorkerIdentityLease (Redis integration)', () => {
  const redis = createConnection(redisUrl)
  const leases: WaWorkerIdentityLease[] = []

  beforeAll(async () => {
    await redis.ping()
  })

  beforeEach(async () => {
    for (const lease of leases.splice(0)) lease.stopRenewal()
    await cleanupKeys()
  })

  afterAll(async () => {
    for (const lease of leases.splice(0)) lease.stopRenewal()
    await cleanupKeys()
    await redis.quit()
  })

  it('fails closed on a live conflict without taking over the configured worker id', async () => {
    const first = createLease('worker-slot-a', 1_000, 'process-token-a')
    const competing = createLease('worker-slot-a', 1_000, 'process-token-b')

    await first.acquire()

    await expect(competing.acquire()).rejects.toBeInstanceOf(WaWorkerIdentityConflictError)
    await expect(redis.get(`${keyPrefix}worker-slot-a`)).resolves.toBe('process-token-a')
    await expect(first.release()).resolves.toBe(true)
  })

  it('allows the same deployment slot to be reacquired after the old physical process expires', async () => {
    const expired = createLease('worker-slot-expiry', 40, 'process-token-old')
    const replacement = createLease('worker-slot-expiry', 1_000, 'process-token-new')
    await expired.acquire()

    await expect
      .poll(() => redis.get(`${keyPrefix}worker-slot-expiry`), { interval: 20, timeout: 1_000 })
      .toBeNull()
    await expect(replacement.acquire()).resolves.toBeUndefined()
    await expect(redis.get(`${keyPrefix}worker-slot-expiry`)).resolves.toBe('process-token-new')
  })

  it('does not let a stale physical-process token renew or release a replacement lease', async () => {
    const stale = createLease('worker-slot-stale', 40, 'process-token-stale')
    const current = createLease('worker-slot-stale', 1_000, 'process-token-current')
    await stale.acquire()
    await expect
      .poll(() => redis.get(`${keyPrefix}worker-slot-stale`), { interval: 20, timeout: 1_000 })
      .toBeNull()
    await current.acquire()

    await expect(stale.renew()).resolves.toBe(false)
    await expect(stale.release()).resolves.toBe(false)
    await expect(redis.get(`${keyPrefix}worker-slot-stale`)).resolves.toBe(
      'process-token-current',
    )
  })

  it('calls onLost exactly once when an exact-token renewal is rejected', async () => {
    const onLost = vi.fn()
    const lease = createLease('worker-slot-lost', 40, 'process-token-lost')
    await lease.acquire()
    await lease.startRenewal(onLost)
    await redis.set(`${keyPrefix}worker-slot-lost`, 'foreign-process-token', 'PX', 1_000)

    await expect.poll(() => onLost.mock.calls.length, { interval: 20, timeout: 1_000 }).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(onLost).toHaveBeenCalledTimes(1)
    expect(onLost).toHaveBeenCalledWith(expect.any(WaWorkerIdentityLeaseLostError))
  })

  it('fails startRenewal when the acquired startup lease already expired', async () => {
    const onLost = vi.fn()
    const lease = createLease('worker-slot-startup-expired', 40, 'process-token-startup')
    await lease.acquire()
    await expect
      .poll(() => redis.get(`${keyPrefix}worker-slot-startup-expired`), {
        interval: 20,
        timeout: 1_000,
      })
      .toBeNull()

    await expect(lease.startRenewal(onLost)).rejects.toBeInstanceOf(
      WaWorkerIdentityLeaseLostError,
    )
    await expect.poll(() => onLost.mock.calls.length).toBe(1)
  })

  it('does not report ownership loss after renewal has been explicitly stopped', async () => {
    const onLost = vi.fn()
    const lease = createLease('worker-slot-stopped', 40, 'process-token-stopped')
    await lease.acquire()
    await lease.startRenewal(onLost)
    lease.stopRenewal()
    await redis.set(`${keyPrefix}worker-slot-stopped`, 'foreign-process-token', 'PX', 1_000)

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(onLost).not.toHaveBeenCalled()
  })

  it('reports a Redis renewal error once and unreferences the periodic timer', async () => {
    vi.useFakeTimers()
    try {
      const interval = { unref: vi.fn() }
      const deadline = { unref: vi.fn() }
      const timer = {
        setInterval: vi.fn((handler: () => void) => {
          setTimeout(handler, 10)
          return interval
        }),
        clearInterval: vi.fn(),
        setTimeout: vi.fn(() => deadline),
        clearTimeout: vi.fn(),
      }
      const redisError = new Error('redis unavailable')
      const client = {
        eval: vi
          .fn<() => Promise<unknown>>()
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(1)
          .mockRejectedValue(redisError),
        get: vi.fn(async () => null),
      }
      const onLost = vi.fn()
      const lease = new WaWorkerIdentityLease({
        workerId: 'worker-slot-error',
        redis: client,
        ttlMs: 30,
        keyPrefix,
        tokenFactory: () => 'process-token-error',
        timer,
      })

      await lease.acquire()
      await lease.startRenewal(onLost)
      await vi.advanceTimersByTimeAsync(10)

      expect(interval.unref).toHaveBeenCalledOnce()
      expect(deadline.unref).toHaveBeenCalledTimes(2)
      expect(timer.clearTimeout).toHaveBeenCalledTimes(2)
      expect(onLost).toHaveBeenCalledOnce()
      expect(onLost).toHaveBeenCalledWith(redisError)
      await vi.advanceTimersByTimeAsync(100)
      expect(onLost).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails an immediate hanging renewal at TTL/3 and reports loss once', async () => {
    vi.useFakeTimers()
    try {
      const never = new Promise<unknown>(() => undefined)
      const client = {
        eval: vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(1).mockReturnValueOnce(never),
        get: vi.fn(async () => null),
      }
      const onLost = vi.fn()
      const lease = new WaWorkerIdentityLease({
        workerId: 'worker-slot-immediate-hang',
        redis: client,
        ttlMs: 30,
        tokenFactory: () => 'process-token-immediate-hang',
      })
      await lease.acquire()

      const renewal = lease.startRenewal(onLost)
      const renewalResult = expect(renewal).rejects.toBeInstanceOf(
        WaWorkerIdentityRenewalTimeoutError,
      )
      await vi.advanceTimersByTimeAsync(9)
      expect(onLost).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      await renewalResult
      expect(onLost).toHaveBeenCalledOnce()
      expect(onLost).toHaveBeenCalledWith(expect.any(WaWorkerIdentityRenewalTimeoutError))
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails a periodic hanging renewal before TTL and ignores its late Redis result', async () => {
    vi.useFakeTimers()
    try {
      let resolveLateRenewal!: (value: unknown) => void
      const lateRenewal = new Promise<unknown>((resolve) => {
        resolveLateRenewal = resolve
      })
      const client = {
        eval: vi
          .fn<() => Promise<unknown>>()
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(1)
          .mockReturnValueOnce(lateRenewal),
        get: vi.fn(async () => null),
      }
      const onLost = vi.fn()
      const lease = new WaWorkerIdentityLease({
        workerId: 'worker-slot-periodic-hang',
        redis: client,
        ttlMs: 30,
        tokenFactory: () => 'process-token-periodic-hang',
      })
      await lease.acquire()
      await lease.startRenewal(onLost)

      await vi.advanceTimersByTimeAsync(19)
      expect(onLost).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(onLost).toHaveBeenCalledOnce()
      expect(onLost).toHaveBeenCalledWith(expect.any(WaWorkerIdentityRenewalTimeoutError))

      resolveLateRenewal(1)
      await vi.runAllTimersAsync()
      expect(onLost).toHaveBeenCalledOnce()
      await expect(lease.startRenewal(onLost)).rejects.toThrow('lease is not acquired')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a hanging renewal deadline without reporting loss when explicitly stopped', async () => {
    vi.useFakeTimers()
    try {
      const never = new Promise<unknown>(() => undefined)
      const client = {
        eval: vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(1).mockReturnValueOnce(never),
        get: vi.fn(async () => null),
      }
      const onLost = vi.fn()
      const lease = new WaWorkerIdentityLease({
        workerId: 'worker-slot-stopped-hang',
        redis: client,
        ttlMs: 30,
        tokenFactory: () => 'process-token-stopped-hang',
      })
      await lease.acquire()

      const renewal = lease.startRenewal(onLost)
      lease.stopRenewal()
      await vi.advanceTimersByTimeAsync(30)

      await expect(renewal).resolves.toBeUndefined()
      expect(onLost).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid ttlMs %s',
    (ttlMs) => {
      expect(
        () =>
          new WaWorkerIdentityLease({
            workerId: 'worker-slot-invalid',
            redis,
            ttlMs,
          }),
      ).toThrow('ttlMs must be a positive safe integer')
    },
  )

  function createLease(
    workerId: string,
    ttlMs: number,
    token: string,
  ): WaWorkerIdentityLease {
    const lease = new WaWorkerIdentityLease({
      workerId,
      redis,
      ttlMs,
      keyPrefix,
      tokenFactory: () => token,
    })
    leases.push(lease)
    return lease
  }

  async function cleanupKeys(): Promise<void> {
    const keys = await redis.keys(`${keyPrefix}*`)
    if (keys.length > 0) await redis.del(...keys)
  }
})
