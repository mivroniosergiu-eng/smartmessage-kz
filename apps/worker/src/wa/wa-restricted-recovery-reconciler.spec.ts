import { describe, expect, it, vi } from 'vitest'

import { PrismaClient, WaAccountStatus } from '@smartmessage/db'

import type { WaLifecycleQueueService } from './wa-lifecycle-queue.service'
import { WaRestrictedRecoveryReconciler } from './wa-restricted-recovery-reconciler'

describe('WaRestrictedRecoveryReconciler', () => {
  it('schedules only restricted accounts with a deadline in deterministic order', async () => {
    const firstDeadline = new Date('2026-07-15T12:00:00.000Z')
    const sharedDeadline = new Date('2026-07-15T13:00:00.000Z')
    const findMany = vi.fn(async () => [
      { instanceId: 'restricted-first', restrictedUntil: firstDeadline },
      { instanceId: 'restricted-a', restrictedUntil: sharedDeadline },
      { instanceId: 'restricted-b', restrictedUntil: sharedDeadline },
    ])
    const enqueueRestrictedRecovery = vi.fn(async () => undefined)
    const reconciler = new WaRestrictedRecoveryReconciler(
      createQueueService(enqueueRestrictedRecovery),
      createDb(findMany),
    )

    await expect(reconciler.reconcile()).resolves.toBeUndefined()

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: WaAccountStatus.RESTRICTED,
        restrictedUntil: { not: null },
      },
      select: { instanceId: true, restrictedUntil: true },
      orderBy: [{ restrictedUntil: 'asc' }, { instanceId: 'asc' }],
    })
    expect(enqueueRestrictedRecovery.mock.calls).toEqual([
      ['restricted-first', firstDeadline],
      ['restricted-a', sharedDeadline],
      ['restricted-b', sharedDeadline],
    ])
  })

  it('does not schedule a defensive null deadline returned by the persistence boundary', async () => {
    const findMany = vi.fn(async () => [
      { instanceId: 'restricted-without-deadline', restrictedUntil: null },
    ])
    const enqueueRestrictedRecovery = vi.fn(async () => undefined)
    const reconciler = new WaRestrictedRecoveryReconciler(
      createQueueService(enqueueRestrictedRecovery),
      createDb(findMany),
    )

    await reconciler.reconcile()

    expect(enqueueRestrictedRecovery).not.toHaveBeenCalled()
  })

  it('propagates enqueue failures and stops before reporting a partial pass', async () => {
    const deadline = new Date('2026-07-15T12:00:00.000Z')
    const findMany = vi.fn(async () => [
      { instanceId: 'restricted-failing', restrictedUntil: deadline },
      { instanceId: 'restricted-after-failure', restrictedUntil: deadline },
    ])
    const enqueueError = new Error('redis unavailable')
    const enqueueRestrictedRecovery = vi.fn(async () => Promise.reject(enqueueError))
    const reconciler = new WaRestrictedRecoveryReconciler(
      createQueueService(enqueueRestrictedRecovery),
      createDb(findMany),
    )

    await expect(reconciler.reconcile()).rejects.toBe(enqueueError)
    expect(enqueueRestrictedRecovery).toHaveBeenCalledOnce()
    expect(enqueueRestrictedRecovery).toHaveBeenCalledWith('restricted-failing', deadline)
  })

  it('replays the same inputs on repeated reconciliation for queue job-id deduplication', async () => {
    const deadline = new Date('2026-07-15T12:00:00.000Z')
    const findMany = vi.fn(async () => [
      { instanceId: 'restricted-repeat', restrictedUntil: deadline },
    ])
    const enqueueRestrictedRecovery = vi.fn(async () => undefined)
    const reconciler = new WaRestrictedRecoveryReconciler(
      createQueueService(enqueueRestrictedRecovery),
      createDb(findMany),
    )

    await reconciler.reconcile()
    await reconciler.reconcile()

    expect(enqueueRestrictedRecovery.mock.calls).toEqual([
      ['restricted-repeat', deadline],
      ['restricted-repeat', deadline],
    ])
  })
})

function createQueueService(
  enqueueRestrictedRecovery: (instanceId: string, restrictedUntil: Date) => Promise<unknown>,
): WaLifecycleQueueService {
  return { enqueueRestrictedRecovery } as WaLifecycleQueueService
}

function createDb(
  findMany: () => Promise<Array<{ instanceId: string; restrictedUntil: Date | null }>>,
): PrismaClient {
  return { waAccount: { findMany } } as unknown as PrismaClient
}
