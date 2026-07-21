import 'reflect-metadata'

import { SEND_WA_TEXT_JOB_NAME } from '@smartmessage/queue'
import { describe, expect, it, vi } from 'vitest'

import { WaSingleSendQueueService } from './wa-single-send-queue.service'

describe('WaSingleSendQueueService', () => {
  it('enqueues a stable retrying single-send job and retains unreconciled failures', async () => {
    const { queue, service } = createService()

    await service.enqueue({
      instanceId: ' instance-1 ',
      contactId: ' contact-1 ',
      text: ' Hello ',
      idempotencyKey: ' request-1 ',
    })

    expect(queue.add).toHaveBeenCalledWith(
      SEND_WA_TEXT_JOB_NAME,
      {
        instanceId: 'instance-1',
        contactId: 'contact-1',
        text: 'Hello',
        idempotencyKey: 'request-1',
      },
      expect.objectContaining({
        attempts: 5,
        backoff: { type: 'fixed', delay: 5_000 },
        jobId: 'wa-single-send.send-wa-text.instance-1.contact-1.request-1.185f8db32271fe25',
        removeOnComplete: true,
        removeOnFail: { age: 604_800, count: 1_000 },
      }),
    )
  })

  it('routes a directed owner job and closes temporary BullMQ handles', async () => {
    const { directedQueue, events, service } = createService()
    const waitUntilFinished = vi
      .fn()
      .mockResolvedValue({ messageLogId: 'log-1', status: 'sent', providerMessageId: 'wa-1' })
    directedQueue.add.mockResolvedValue({ waitUntilFinished })

    await expect(
      service.enqueueForOwner({
        instanceId: 'instance-1',
        contactId: 'contact-1',
        text: 'Hello',
        idempotencyKey: 'request-1',
        messageLogId: 'log-1',
        teamId: 'team-1',
        phone: '+77001234567',
        expectedOwnerWorkerId: 'worker-1',
        expectedOwnerEpoch: '2',
      }),
    ).resolves.toMatchObject({ status: 'sent' })

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
    service: new WaSingleSendQueueService(
      queue,
      vi.fn(() => directedQueue),
      vi.fn(() => events),
    ),
  }
}
