import 'reflect-metadata'

import { describe, expect, it, vi } from 'vitest'

import {
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  type WaLifecycleJobName,
} from '@smartmessage/queue'

import type { PrismaWaAccountCommandGuard } from './prisma-wa-account-command.guard'
import { WaAccountCommandTargetNotFoundError } from './prisma-wa-account-command.guard'
import { WaLifecycleCommandQueueService } from './wa-lifecycle-command-queue.service'
import type { WaLifecycleQueueService } from './wa-lifecycle-queue.service'

describe('WaLifecycleCommandQueueService', () => {
  it('enqueueStart delegates only after the guard accepts the normalized target', async () => {
    const { guard, queueService, service } = createService()

    await service.enqueueStart(' instance-1 ')

    expect(guard.assertCommandableInstance).toHaveBeenCalledWith(' instance-1 ', START_WA_INSTANCE_JOB_NAME)
    expect(queueService.enqueueStart).toHaveBeenCalledWith('instance-1')
  })

  it('enqueueStop delegates only after the guard accepts the normalized target', async () => {
    const { guard, queueService, service } = createService()

    await service.enqueueStop(' instance-2 ')

    expect(guard.assertCommandableInstance).toHaveBeenCalledWith(' instance-2 ', STOP_WA_INSTANCE_JOB_NAME)
    expect(queueService.enqueueStop).toHaveBeenCalledWith('instance-2')
  })

  it('enqueueRenew delegates only after the guard accepts the normalized target', async () => {
    const { guard, queueService, service } = createService()

    await service.enqueueRenew(' instance-3 ')

    expect(guard.assertCommandableInstance).toHaveBeenCalledWith(' instance-3 ', RENEW_WA_INSTANCE_JOB_NAME)
    expect(queueService.enqueueRenew).toHaveBeenCalledWith('instance-3')
  })

  it('rejects missing accounts before delegating to the low-level queue producer', async () => {
    const error = new WaAccountCommandTargetNotFoundError('missing-instance')
    const { guard, queueService, service } = createService(error)

    await expect(service.enqueueStart('missing-instance')).rejects.toBe(error)

    expect(guard.assertCommandableInstance).toHaveBeenCalledWith('missing-instance', START_WA_INSTANCE_JOB_NAME)
    expect(queueService.enqueueStart).not.toHaveBeenCalled()
    expect(queueService.enqueueStop).not.toHaveBeenCalled()
    expect(queueService.enqueueRenew).not.toHaveBeenCalled()
  })
})

function createService(error?: Error): ServiceFixture {
  const guard = {
    assertCommandableInstance: vi.fn(async (instanceId: string, _jobName: WaLifecycleJobName) => {
      if (error) throw error

      return { instanceId: instanceId.trim() }
    }),
  }
  const queueService = {
    enqueueStart: vi.fn(async () => ({ id: 'start-job' })),
    enqueueStop: vi.fn(async () => ({ id: 'stop-job' })),
    enqueueRenew: vi.fn(async () => ({ id: 'renew-job' })),
  }

  return {
    guard,
    queueService,
    service: new WaLifecycleCommandQueueService(
      guard as unknown as PrismaWaAccountCommandGuard,
      queueService as unknown as WaLifecycleQueueService,
    ),
  }
}

interface ServiceFixture {
  guard: {
    assertCommandableInstance: ReturnType<
      typeof vi.fn<(instanceId: string, jobName: WaLifecycleJobName) => Promise<{ instanceId: string }>>
    >
  }
  queueService: {
    enqueueStart: ReturnType<typeof vi.fn<(instanceId: string) => Promise<unknown>>>
    enqueueStop: ReturnType<typeof vi.fn<(instanceId: string) => Promise<unknown>>>
    enqueueRenew: ReturnType<typeof vi.fn<(instanceId: string) => Promise<unknown>>>
  }
  service: WaLifecycleCommandQueueService
}
