import 'reflect-metadata'

import {
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
} from '@smartmessage/queue'
import { describe, expect, it, vi } from 'vitest'

import { WaLifecycleQueueService } from './wa-lifecycle-queue.service'

describe('WaLifecycleQueueService', () => {
  it('enqueueStart adds a normalized start job with deterministic job id', async () => {
    const queue = createQueueMock()
    const service = new WaLifecycleQueueService(queue)

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
    const queue = createQueueMock()
    const service = new WaLifecycleQueueService(queue)

    await service.enqueueStop(' tenant 1/wa:primary ')

    expect(queue.add).toHaveBeenCalledWith(
      STOP_WA_INSTANCE_JOB_NAME,
      { instanceId: 'tenant 1/wa:primary' },
      expect.objectContaining({
        jobId: 'wa-lifecycle.stop-wa-instance.tenant%201%2Fwa%3Aprimary',
      }),
    )
  })

  it('enqueueRenew adds a normalized renew job with deterministic job id', async () => {
    const queue = createQueueMock()
    const service = new WaLifecycleQueueService(queue)

    await service.enqueueRenew('instance-3')

    expect(queue.add).toHaveBeenCalledWith(
      RENEW_WA_INSTANCE_JOB_NAME,
      { instanceId: 'instance-3' },
      expect.objectContaining({
        attempts: 1,
        jobId: 'wa-lifecycle.renew-wa-instance.instance-3',
        removeOnComplete: true,
        removeOnFail: 100,
      }),
    )
  })

  it('invalid instanceId rejects before Queue.add', async () => {
    const queue = createQueueMock()
    const service = new WaLifecycleQueueService(queue)

    await expect(service.enqueueStart('   ')).rejects.toThrow(
      'start-wa-instance payload.instanceId must be a non-empty string',
    )
    expect(queue.add).not.toHaveBeenCalled()
  })
})

function createQueueMock(): QueueMock {
  return {
    add: vi.fn(async () => ({ id: 'job-1' })),
  }
}

interface QueueMock {
  add: ReturnType<typeof vi.fn<(name: string, data: unknown, options: unknown) => Promise<unknown>>>
}
