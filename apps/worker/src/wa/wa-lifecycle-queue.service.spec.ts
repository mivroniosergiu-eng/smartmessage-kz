import 'reflect-metadata'

import {
  LOGOUT_WA_INSTANCE_JOB_NAME,
  RECOVER_RESTRICTED_WA_INSTANCE_JOB_NAME,
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
} from '@smartmessage/queue'
import { describe, expect, it, vi } from 'vitest'

import {
  WaLifecycleOwnerAckTimeoutError,
  WaLifecycleQueueService,
} from './wa-lifecycle-queue.service'

describe('WaLifecycleQueueService', () => {
  it('enqueueStart adds a normalized start job with deterministic job id', async () => {
    const { queue, service } = createService()

    await service.enqueueStart(' instance-1 ')

    expect(queue.add).toHaveBeenCalledWith(
      START_WA_INSTANCE_JOB_NAME,
      { instanceId: 'instance-1' },
      expect.objectContaining({
        jobId: 'wa-lifecycle.start-wa-instance.instance-1',
      }),
    )
  })

  it('enqueueStop adds a normalized stop job with deterministic job id', async () => {
    const { queue, service } = createService()

    await service.enqueueStop(' tenant 1/wa:primary ')

    expect(queue.add).toHaveBeenCalledWith(
      STOP_WA_INSTANCE_JOB_NAME,
      { instanceId: 'tenant 1/wa:primary' },
      expect.objectContaining({
        jobId: 'wa-lifecycle.stop-wa-instance.tenant%201%2Fwa%3Aprimary',
      }),
    )
  })

  it('enqueueLogout adds a durable normalized logout job', async () => {
    const { queue, service } = createService()

    await service.enqueueLogout(' instance-logout ')

    expect(queue.add).toHaveBeenCalledWith(
      LOGOUT_WA_INSTANCE_JOB_NAME,
      { instanceId: 'instance-logout' },
      expect.objectContaining({
        attempts: 8,
        backoff: { type: 'fixed', delay: 5_000 },
        jobId: 'wa-lifecycle.logout-wa-instance.instance-logout',
      }),
    )
  })

  it('enqueueRenew adds a normalized renew job with deterministic job id', async () => {
    const { queue, service } = createService()

    await service.enqueueRenew('instance-3')

    expect(queue.add).toHaveBeenCalledWith(
      RENEW_WA_INSTANCE_JOB_NAME,
      { instanceId: 'instance-3' },
      expect.objectContaining({
        attempts: 8,
        backoff: { type: 'fixed', delay: 5_000 },
        jobId: 'wa-lifecycle.renew-wa-instance.instance-3',
        removeOnComplete: true,
        removeOnFail: 100,
      }),
    )
  })

  it('enqueues restricted recovery durably at the exact future timestamp', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    try {
      const { queue, service } = createService()

      await service.enqueueRestrictedRecovery(
        ' instance.restricted/primary ',
        new Date('2026-07-15T13:00:00.000Z'),
      )

      expect(queue.add).toHaveBeenCalledWith(
        RECOVER_RESTRICTED_WA_INSTANCE_JOB_NAME,
        {
          instanceId: 'instance.restricted/primary',
          restrictedUntil: '2026-07-15T13:00:00.000Z',
        },
        {
          attempts: 8,
          backoff: { type: 'fixed', delay: 5_000 },
          delay: 3_600_000,
          jobId:
            'wa-lifecycle.recover-restricted-wa-instance.instance%2Erestricted%2Fprimary.1784120400000',
          removeOnComplete: true,
          removeOnFail: 100,
        },
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('enqueues an overdue restricted recovery immediately without a negative delay', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T14:00:00.000Z'))
    try {
      const { queue, service } = createService()

      await service.enqueueRestrictedRecovery(
        'instance-overdue',
        new Date('2026-07-15T13:00:00.000Z'),
      )

      expect(queue.add).toHaveBeenCalledWith(
        RECOVER_RESTRICTED_WA_INSTANCE_JOB_NAME,
        expect.objectContaining({ restrictedUntil: '2026-07-15T13:00:00.000Z' }),
        expect.objectContaining({ delay: 0 }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an invalid restricted recovery date before Queue.add', async () => {
    const { queue, service } = createService()

    await expect(
      service.enqueueRestrictedRecovery('instance-invalid-date', new Date(Number.NaN)),
    ).rejects.toThrow(
      'recover-restricted-wa-instance payload.restrictedUntil must be a canonical ISO timestamp',
    )
    expect(queue.add).not.toHaveBeenCalled()
  })

  it('invalid instanceId rejects before Queue.add', async () => {
    const { queue, service } = createService()

    await expect(service.enqueueStart('   ')).rejects.toThrow(
      'start-wa-instance payload.instanceId must be a non-empty string',
    )
    expect(queue.add).not.toHaveBeenCalled()
  })

  it('waits for the owner result before completing and closes both producer handles', async () => {
    const { directedJob, directedQueue, queueEvents, queueFactory, service } = createService()
    directedJob.waitUntilFinished.mockResolvedValueOnce({
      instanceId: 'instance-owned',
      stopped: true,
    })

    await expect(
      service.enqueueStop('instance-owned', { owner: 'worker/a', epoch: 7n }),
    ).resolves.toEqual({
      instanceId: 'instance-owned',
      stopped: true,
    })

    expect(queueFactory).toHaveBeenCalledWith('wa-lifecycle-owner.worker%2Fa')
    expect(queueEvents.waitUntilReady).toHaveBeenCalledOnce()
    expect(directedQueue.add).toHaveBeenCalledWith(
      STOP_WA_INSTANCE_JOB_NAME,
      {
        instanceId: 'instance-owned',
        expectedOwnerWorkerId: 'worker/a',
        expectedOwnerEpoch: '7',
      },
      expect.objectContaining({
        attempts: 1,
        jobId: 'wa-lifecycle-owner.stop-wa-instance.instance-owned.worker%2Fa.7',
        removeOnComplete: { age: 300, count: 1_000 },
        removeOnFail: true,
      }),
    )
    expect(directedJob.waitUntilFinished).toHaveBeenCalledWith(queueEvents, expect.any(Number))
    const ackTimeoutMs = directedJob.waitUntilFinished.mock.calls[0]?.[1]
    expect(ackTimeoutMs).toBeGreaterThan(0)
    expect(ackTimeoutMs).toBeLessThanOrEqual(15_000)
    expect(queueEvents.close).toHaveBeenCalledOnce()
    expect(directedQueue.close).toHaveBeenCalledOnce()
  })

  it('routes logout to a one-attempt exact owner job with retained acknowledgement', async () => {
    const { directedJob, directedQueue, service } = createService()
    directedJob.waitUntilFinished.mockResolvedValueOnce({
      instanceId: 'instance-owned-logout',
      loggedOut: true,
    })

    await expect(
      service.enqueueLogout('instance-owned-logout', { owner: 'worker/a', epoch: 12n }),
    ).resolves.toEqual({ instanceId: 'instance-owned-logout', loggedOut: true })

    expect(directedQueue.add).toHaveBeenCalledWith(
      LOGOUT_WA_INSTANCE_JOB_NAME,
      {
        instanceId: 'instance-owned-logout',
        expectedOwnerWorkerId: 'worker/a',
        expectedOwnerEpoch: '12',
      },
      expect.objectContaining({
        attempts: 1,
        jobId: 'wa-lifecycle-owner.logout-wa-instance.instance-owned-logout.worker%2Fa.12',
        removeOnComplete: { age: 300, count: 1_000 },
        removeOnFail: true,
      }),
    )
  })

  it('does not lose an owner result produced after a ten-second physical close', async () => {
    vi.useFakeTimers()
    try {
      const { directedJob, queueEvents, service } = createService()
      directedJob.waitUntilFinished.mockImplementationOnce(
        async (_queueEvents: unknown, timeoutMs: number) =>
          await new Promise((resolve, reject) => {
            const completion = setTimeout(
              () => resolve({ instanceId: 'instance-slow-close', stopped: true }),
              10_000,
            )
            setTimeout(() => {
              clearTimeout(completion)
              reject(new Error('owner ack timeout'))
            }, timeoutMs)
          }),
      )

      const result = service.enqueueStop('instance-slow-close', {
        owner: 'worker/slow',
        epoch: 11n,
      })
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(result).resolves.toEqual({
        instanceId: 'instance-slow-close',
        stopped: true,
      })
      expect(directedJob.waitUntilFinished).toHaveBeenCalledWith(queueEvents, 15_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains a late completed directed result for a generic retry', async () => {
    const { directedJob, directedQueue, service } = createService()
    const timeout = new Error('owner ack timeout')
    directedJob.waitUntilFinished
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ instanceId: 'instance-late', stopped: true })
    const ownership = { owner: 'worker/late', epoch: 13n }

    await expect(service.enqueueStop('instance-late', ownership)).rejects.toBe(timeout)
    await expect(service.enqueueStop('instance-late', ownership)).resolves.toEqual({
      instanceId: 'instance-late',
      stopped: true,
    })

    expect(directedQueue.add).toHaveBeenCalledTimes(2)
    for (const call of directedQueue.add.mock.calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({
          attempts: 1,
          jobId: 'wa-lifecycle-owner.stop-wa-instance.instance-late.worker%2Flate.13',
          removeOnComplete: { age: 300, count: 1_000 },
          removeOnFail: true,
        }),
      )
      expect(call[2]).not.toHaveProperty('backoff')
    }
  })

  it('propagates an owner ack timeout so the generic job can retry', async () => {
    const { directedJob, directedQueue, queueEvents, service } = createService()
    const timeout = new Error('owner ack timeout')
    directedJob.waitUntilFinished.mockRejectedValueOnce(timeout)

    await expect(
      service.enqueueRenew('instance-owned', { owner: 'worker-dead', epoch: 3n }, 'generic-job@1'),
    ).rejects.toBe(timeout)

    expect(queueEvents.close).toHaveBeenCalledOnce()
    expect(directedQueue.close).toHaveBeenCalledOnce()
  })

  it('uses one owner-ack deadline across readiness and result waiting', async () => {
    vi.useFakeTimers()
    try {
      const { directedJob, queueEvents, service } = createService()
      queueEvents.waitUntilReady.mockImplementationOnce(
        async () => await new Promise((resolve) => setTimeout(resolve, 10_000)),
      )
      directedJob.waitUntilFinished.mockResolvedValueOnce({
        instanceId: 'instance-deadline',
        stopped: true,
      })

      const result = service.enqueueStop('instance-deadline', {
        owner: 'worker-deadline',
        epoch: 8n,
      })
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(result).resolves.toMatchObject({ stopped: true })
      const remainingMs = directedJob.waitUntilFinished.mock.calls[0]?.[1]
      expect(remainingMs).toBeGreaterThan(0)
      expect(remainingMs).toBeLessThanOrEqual(5_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out owner readiness within the shared ack deadline and closes handles', async () => {
    vi.useFakeTimers()
    try {
      const { directedQueue, queueEvents, service } = createService()
      queueEvents.waitUntilReady.mockImplementationOnce(
        async () => await new Promise(() => undefined),
      )

      const result = service.enqueueStop('instance-readiness-timeout', {
        owner: 'worker-deadline',
        epoch: 9n,
      })
      const rejected = expect(result).rejects.toBeInstanceOf(WaLifecycleOwnerAckTimeoutError)
      await vi.advanceTimersByTimeAsync(15_000)

      await rejected
      expect(directedQueue.add).not.toHaveBeenCalled()
      expect(queueEvents.close).toHaveBeenCalledOnce()
      expect(directedQueue.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let stuck producer cleanup suppress the owner timeout and generic retry', async () => {
    vi.useFakeTimers()
    try {
      const { directedQueue, queueEvents, service } = createService()
      const never = new Promise<void>(() => undefined)
      queueEvents.waitUntilReady.mockImplementationOnce(
        async () => await new Promise(() => undefined),
      )
      queueEvents.close.mockImplementation(() => never)
      directedQueue.close.mockImplementation(() => never)

      const result = service.enqueueStop('instance-cleanup-timeout', {
        owner: 'worker-deadline',
        epoch: 10n,
      })
      const rejected = expect(result).rejects.toBeInstanceOf(WaLifecycleOwnerAckTimeoutError)
      await vi.advanceTimersByTimeAsync(16_000)

      await rejected
      expect(queueEvents.close).toHaveBeenCalledOnce()
      expect(directedQueue.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses a renew command id for retry but separates distinct renew commands', async () => {
    const { directedQueue, service } = createService()
    const ownership = { owner: 'worker-renew', epoch: 3n }

    await service.enqueueRenew('instance-renew', ownership, 'generic-job@100')
    await service.enqueueRenew('instance-renew', ownership, 'generic-job@100')
    await service.enqueueRenew('instance-renew', ownership, 'generic-job@200')

    const jobIds = directedQueue.add.mock.calls.map((call) => call[2].jobId)
    expect(jobIds[0]).toBe(jobIds[1])
    expect(jobIds[2]).not.toBe(jobIds[0])
  })

  it('adds stop and renew commands with bounded retries for owner discovery races', async () => {
    const { queue, service } = createService()

    await service.enqueueStop('instance-stop')
    await service.enqueueRenew('instance-renew')

    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      STOP_WA_INSTANCE_JOB_NAME,
      { instanceId: 'instance-stop' },
      expect.objectContaining({
        attempts: 8,
        backoff: { type: 'fixed', delay: 5_000 },
      }),
    )
    expect(queue.add).toHaveBeenNthCalledWith(
      2,
      RENEW_WA_INSTANCE_JOB_NAME,
      { instanceId: 'instance-renew' },
      expect.objectContaining({
        attempts: 8,
        backoff: { type: 'fixed', delay: 5_000 },
      }),
    )
  })

  it('detects only non-terminal start jobs as pending', async () => {
    const { queue, service } = createService()
    queue.getJob.mockResolvedValueOnce({ getState: vi.fn(async () => 'active') })

    await expect(service.hasPendingStart(' instance-starting ')).resolves.toBe(true)
    expect(queue.getJob).toHaveBeenCalledWith('wa-lifecycle.start-wa-instance.instance-starting')

    queue.getJob.mockResolvedValueOnce({ getState: vi.fn(async () => 'failed') })
    await expect(service.hasPendingStart('instance-failed')).resolves.toBe(false)

    queue.getJob.mockResolvedValueOnce(null)
    await expect(service.hasPendingStart('instance-absent')).resolves.toBe(false)
  })
})

function createService() {
  const queue = createQueueMock()
  const directedQueue = createQueueMock()
  const directedJob = {
    waitUntilFinished: vi.fn(async () => ({ instanceId: 'default', stopped: false })),
  }
  directedQueue.add.mockResolvedValue(directedJob)
  const queueEvents = {
    waitUntilReady: vi.fn(async () => queueEvents),
    close: vi.fn(async () => undefined),
  }
  const queueFactory = vi.fn(() => directedQueue)
  const queueEventsFactory = vi.fn(() => queueEvents)
  return {
    queue,
    directedJob,
    directedQueue,
    queueEvents,
    queueFactory,
    queueEventsFactory,
    service: new WaLifecycleQueueService(queue, queueFactory, queueEventsFactory),
  }
}

function createQueueMock(): QueueMock {
  return {
    add: vi.fn(async () => ({ id: 'job-1' })),
    close: vi.fn(async () => undefined),
    getJob: vi.fn(async () => null),
  }
}

interface QueueMock {
  add: ReturnType<typeof vi.fn<(name: string, data: unknown, options: unknown) => Promise<unknown>>>
  close: ReturnType<typeof vi.fn<() => Promise<void>>>
  getJob: ReturnType<
    typeof vi.fn<(jobId: string) => Promise<{ getState(): Promise<string> } | undefined | null>>
  >
}
