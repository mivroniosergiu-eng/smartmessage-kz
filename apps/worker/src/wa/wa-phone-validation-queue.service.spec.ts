import 'reflect-metadata'

import { VALIDATE_WA_PHONE_JOB_NAME } from '@smartmessage/queue'
import { describe, expect, it, vi } from 'vitest'

import { WaPhoneValidationQueueService } from './wa-phone-validation-queue.service'

describe('WaPhoneValidationQueueService', () => {
  it('enqueues one durable retrying job per team contact', async () => {
    const { queue, service } = createService()

    await service.enqueue(' contact.1 ', ' team/a ')

    expect(queue.add).toHaveBeenCalledWith(
      VALIDATE_WA_PHONE_JOB_NAME,
      { contactId: 'contact.1', teamId: 'team/a' },
      {
        attempts: 8,
        backoff: { type: 'fixed', delay: 5_000 },
        jobId: 'validate-phone.validate-wa-phone.team%2Fa.contact%2E1',
        removeOnComplete: true,
        removeOnFail: { age: 604_800, count: 1_000 },
      },
    )
  })

  it('routes exact owner-generation work and waits for its result', async () => {
    const { directedQueue, events, service } = createService()
    const result = { contactId: 'contact-1', status: 'confirmed' }
    const waitUntilFinished = vi.fn().mockResolvedValue(result)
    directedQueue.add.mockResolvedValue({ waitUntilFinished })

    await expect(
      service.enqueueForOwner({
        contactId: 'contact-1',
        teamId: 'team-1',
        validationRunId: 'run-1',
        instanceId: 'instance-1',
        phone: '+77001234567',
        expectedOwnerWorkerId: 'worker-1',
        expectedOwnerEpoch: '9',
      }),
    ).resolves.toEqual(result)

    expect(directedQueue.add).toHaveBeenCalledWith(
      VALIDATE_WA_PHONE_JOB_NAME,
      expect.objectContaining({ expectedOwnerEpoch: '9' }),
      expect.objectContaining({
        attempts: 1,
        jobId:
          'validate-phone-owner.validate-wa-phone.team-1.contact-1.run-1.instance-1.%2B77001234567.worker-1.9',
      }),
    )
    expect(waitUntilFinished).toHaveBeenCalledWith(events, expect.any(Number))
    expect(events.close).toHaveBeenCalledOnce()
    expect(directedQueue.close).toHaveBeenCalledOnce()
  })
})

function createService() {
  const queue = { add: vi.fn() }
  const directedQueue = { add: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }
  const events = {
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
  return {
    queue,
    directedQueue,
    events,
    service: new WaPhoneValidationQueueService(
      queue,
      vi.fn(() => directedQueue),
      vi.fn(() => events),
    ),
  }
}
