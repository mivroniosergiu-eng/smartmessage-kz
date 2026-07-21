import 'reflect-metadata'

import {
  VALIDATE_WA_PHONE_JOB_NAME,
  WA_PHONE_VALIDATION_QUEUE_NAME,
  createConnection,
  createQueue,
  createQueueEvents,
  createWorker,
  createWaPhoneValidationJobId,
  createWaPhoneValidationOwnerQueueName,
} from '@smartmessage/queue'
import type {
  WaPhoneValidationJobPayload,
  WaPhoneValidationOwnerJobPayload,
} from '@smartmessage/queue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WaPhoneValidationJobProcessor } from './wa-phone-validation-job.processor'
import { WaPhoneValidationQueueService } from './wa-phone-validation-queue.service'

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6380'
const teamId = 'phone-validation-queue-integration-team'
const contactId = 'phone-validation-queue-integration-contact'
const instanceId = 'phone-validation-queue-integration-instance'
const ownerWorkerId = 'phone-validation-queue-integration-owner'
const phone = '+77001234567'

describe('validate-phone BullMQ integration', () => {
  const resources: Array<{ close: () => Promise<unknown> }> = []

  afterEach(async () => {
    while (resources.length > 0) {
      await resources.pop()?.close()
    }
  })

  it('deduplicates a job, reconciles final failure, and allows a new run after ERROR', async () => {
    const connection = createConnection(redisUrl)
    const workerConnection = createConnection(redisUrl)
    const ownerWorkerConnection = createConnection(redisUrl)
    resources.push(
      { close: () => connection.quit() },
      { close: () => workerConnection.quit() },
      { close: () => ownerWorkerConnection.quit() },
    )

    const queue = createQueue<WaPhoneValidationJobPayload>(
      WA_PHONE_VALIDATION_QUEUE_NAME,
      connection,
    )
    const ownerQueueName = createWaPhoneValidationOwnerQueueName(ownerWorkerId)
    const ownerQueue = createQueue<WaPhoneValidationOwnerJobPayload>(ownerQueueName, connection)
    const queueEvents = createQueueEvents(WA_PHONE_VALIDATION_QUEUE_NAME, connection)
    resources.push(
      { close: () => queue.close() },
      { close: () => ownerQueue.close() },
      { close: () => queueEvents.close() },
    )
    await queue.obliterate({ force: true })
    await ownerQueue.obliterate({ force: true })
    await queueEvents.waitUntilReady()

    let status: 'error' | 'in_progress' | 'confirmed' = 'in_progress'
    const repository = {
      prepare: vi.fn(async (_contactId: string, _teamId: string, validationRunId: string) => {
        status = 'in_progress'
        return { contactId, teamId, phone, validationRunId }
      }),
      complete: vi.fn(async () => {
        status = 'confirmed'
      }),
      markError: vi.fn(async () => {
        status = 'error'
      }),
      markRunError: vi.fn(async () => {
        status = 'error'
      }),
      assertOwnerTarget: vi.fn(async () => undefined),
    }
    const selector = {
      select: vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary selector failure'))
        .mockResolvedValue({
          instanceId,
          ownership: { owner: ownerWorkerId, epoch: 1n },
        }),
    }
    const ownerRegistry = {
      getOwnership: vi.fn(async () => ({ owner: ownerWorkerId, epoch: 1n })),
    }
    const validator = {
      validate: vi.fn(async () => ({ instanceId, phone, status: 'confirmed' as const })),
    }
    const queueService = new WaPhoneValidationQueueService(
      queue as never,
      (name) => createQueue<WaPhoneValidationOwnerJobPayload>(name, connection) as never,
      (name) => createQueueEvents(name, connection) as never,
    )
    const processor = new WaPhoneValidationJobProcessor(
      repository as never,
      selector as never,
      queueService,
      validator,
      ownerRegistry,
      ownerWorkerId,
    )

    const ownerWorker = createWorker<unknown, unknown>(
      ownerQueueName,
      (job) => processor.process(job),
      ownerWorkerConnection,
      { autorun: false },
    )
    const genericWorker = createWorker<unknown, unknown>(
      WA_PHONE_VALIDATION_QUEUE_NAME,
      (job) => processor.process(job),
      workerConnection,
      { autorun: false },
    )
    resources.push(
      { close: () => ownerWorker.close(true) },
      { close: () => genericWorker.close(true) },
    )
    ownerWorker.run()
    genericWorker.run()

    const firstPayload = { contactId, teamId }
    const firstJob = await queue.add(VALIDATE_WA_PHONE_JOB_NAME, firstPayload, {
      attempts: 1,
      jobId: createWaPhoneValidationJobId(firstPayload),
      removeOnComplete: true,
      removeOnFail: true,
    })
    await expect(firstJob.waitUntilFinished(queueEvents, 5_000)).rejects.toThrow(
      'temporary selector failure',
    )
    await waitFor(async () => !(await queue.getJob(firstJob.id ?? '')))
    expect(status).toBe('error')

    const retryJob = (await queueService.enqueue(contactId, teamId)) as Awaited<
      ReturnType<typeof queue.add>
    >
    const duplicateJob = (await queueService.enqueue(contactId, teamId)) as Awaited<
      ReturnType<typeof queue.add>
    >
    expect(duplicateJob.id).toBe(retryJob.id)
    await expect(retryJob.waitUntilFinished(queueEvents, 10_000)).resolves.toMatchObject({
      contactId,
      status: 'confirmed',
    })
    expect(status).toBe('confirmed')
    expect(validator.validate).toHaveBeenCalledOnce()
    expect(repository.complete).toHaveBeenCalledOnce()
  }, 30_000)
})

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for BullMQ state')
}
