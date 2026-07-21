import 'reflect-metadata'

import {
  WA_SINGLE_SEND_QUEUE_NAME,
  createConnection,
  createQueue,
  createQueueEvents,
  createWorker,
  createWaSingleSendOwnerQueueName,
} from '@smartmessage/queue'
import type { WaSingleSendJobPayload, WaSingleSendOwnerJobPayload } from '@smartmessage/queue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WaSingleSendJobProcessor } from './wa-single-send-job.processor'
import { WaSingleSendQueueService } from './wa-single-send-queue.service'

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6380'

describe('WA single-send BullMQ integration', () => {
  const resources: Array<{ close: () => Promise<unknown> }> = []
  afterEach(async () => {
    while (resources.length) await resources.pop()?.close()
  })

  it('deduplicates duplicate enqueue and invokes the mock sender once through exact owner queue', async () => {
    const connection = createConnection(redisUrl)
    const genericConnection = createConnection(redisUrl)
    const ownerConnection = createConnection(redisUrl)
    resources.push(
      { close: () => connection.quit() },
      { close: () => genericConnection.quit() },
      { close: () => ownerConnection.quit() },
    )
    const queue = createQueue<WaSingleSendJobPayload>(WA_SINGLE_SEND_QUEUE_NAME, connection)
    const ownerWorkerId = 'single-send-integration-owner'
    const ownerQueueName = createWaSingleSendOwnerQueueName(ownerWorkerId)
    const ownerQueue = createQueue<WaSingleSendOwnerJobPayload>(ownerQueueName, connection)
    const events = createQueueEvents(WA_SINGLE_SEND_QUEUE_NAME, connection)
    resources.push(
      { close: () => queue.close() },
      { close: () => ownerQueue.close() },
      { close: () => events.close() },
    )
    await queue.obliterate({ force: true })
    await ownerQueue.obliterate({ force: true })
    await events.waitUntilReady()

    const repository = {
      prepare: vi.fn(async (payload: WaSingleSendJobPayload) => ({
        ...payload,
        messageLogId: 'log-1',
        teamId: 'team-1',
        phone: '+77001234567',
        ownerWorkerId,
        ownershipEpoch: 1n,
      })),
      assertOwnerTarget: vi.fn(async () => undefined),
      claimDispatch: vi.fn(async () => true),
      markSent: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
      markRequestFailed: vi.fn(async () => undefined),
    }
    const registry = { getOwnership: vi.fn(async () => ({ owner: ownerWorkerId, epoch: 1n })) }
    const sender = {
      send: vi.fn(async () => ({ messageId: 'mock-provider-1', status: 'accepted' as const })),
    }
    const service = new WaSingleSendQueueService(
      queue as never,
      (name) => createQueue<WaSingleSendOwnerJobPayload>(name, connection) as never,
      (name) => createQueueEvents(name, connection) as never,
    )
    const processor = new WaSingleSendJobProcessor(
      repository as never,
      service,
      sender,
      registry,
      { handleDisconnect: vi.fn() } as never,
      ownerWorkerId,
    )
    const genericWorker = createWorker<unknown, unknown>(
      WA_SINGLE_SEND_QUEUE_NAME,
      (job) => processor.process(job),
      genericConnection,
      { autorun: false },
    )
    const ownerWorker = createWorker<unknown, unknown>(
      ownerQueueName,
      (job) => processor.process(job),
      ownerConnection,
      { autorun: false },
    )
    resources.push(
      { close: () => genericWorker.close(true) },
      { close: () => ownerWorker.close(true) },
    )
    void genericWorker.run()
    void ownerWorker.run()

    const payload = {
      instanceId: 'instance-1',
      contactId: 'contact-1',
      text: 'hello',
      idempotencyKey: 'request-1',
    }
    const first = (await service.enqueue(payload)) as Awaited<ReturnType<typeof queue.add>>
    const duplicate = (await service.enqueue(payload)) as Awaited<ReturnType<typeof queue.add>>
    expect(duplicate.id).toBe(first.id)
    await expect(first.waitUntilFinished(events, 10_000)).resolves.toEqual({
      messageLogId: 'log-1',
      status: 'sent',
      providerMessageId: 'mock-provider-1',
    })
    expect(sender.send).toHaveBeenCalledOnce()
    expect(repository.markSent).toHaveBeenCalledOnce()
  }, 30_000)
})
