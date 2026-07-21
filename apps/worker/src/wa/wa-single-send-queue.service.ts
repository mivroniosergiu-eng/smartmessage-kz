import { Inject, Injectable } from '@nestjs/common'
import {
  SEND_WA_TEXT_JOB_NAME,
  createWaSingleSendJobId,
  createWaSingleSendOwnerJobId,
  createWaSingleSendOwnerQueueName,
  parseWaSingleSendJobPayload,
  parseWaSingleSendOwnerJobPayload,
} from '@smartmessage/queue'
import type { WaSingleSendJobPayload, WaSingleSendOwnerJobPayload } from '@smartmessage/queue'

import {
  WA_SINGLE_SEND_QUEUE,
  WA_SINGLE_SEND_QUEUE_EVENTS_FACTORY,
  WA_SINGLE_SEND_QUEUE_FACTORY,
} from './wa.tokens'

const OWNER_ACK_TIMEOUT_MS = 20_000
const HANDLE_CLOSE_TIMEOUT_MS = 1_000

interface QueueEventsPort {
  waitUntilReady(): Promise<unknown>
  close(): Promise<void>
}
interface QueuedJob {
  waitUntilFinished(events: QueueEventsPort, ttl: number): Promise<unknown>
}
interface GenericQueuePort {
  add(
    name: typeof SEND_WA_TEXT_JOB_NAME,
    data: WaSingleSendJobPayload,
    options: object,
  ): Promise<unknown>
}
interface OwnerQueuePort {
  add(
    name: typeof SEND_WA_TEXT_JOB_NAME,
    data: WaSingleSendOwnerJobPayload,
    options: object,
  ): Promise<QueuedJob>
  close(): Promise<void>
}
export type WaSingleSendQueueFactory = (queueName: string) => OwnerQueuePort
export type WaSingleSendQueueEventsFactory = (queueName: string) => QueueEventsPort

@Injectable()
export class WaSingleSendQueueService {
  constructor(
    @Inject(WA_SINGLE_SEND_QUEUE) private readonly queue: GenericQueuePort,
    @Inject(WA_SINGLE_SEND_QUEUE_FACTORY) private readonly queueFactory: WaSingleSendQueueFactory,
    @Inject(WA_SINGLE_SEND_QUEUE_EVENTS_FACTORY)
    private readonly eventsFactory: WaSingleSendQueueEventsFactory,
  ) {}

  enqueue(input: WaSingleSendJobPayload): Promise<unknown> {
    const payload = parseWaSingleSendJobPayload(input)
    return this.queue.add(SEND_WA_TEXT_JOB_NAME, payload, {
      attempts: 5,
      backoff: { type: 'fixed', delay: 5_000 },
      jobId: createWaSingleSendJobId(payload),
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
    })
  }

  async enqueueForOwner(input: WaSingleSendOwnerJobPayload): Promise<unknown> {
    const payload = parseWaSingleSendOwnerJobPayload(input)
    const queueName = createWaSingleSendOwnerQueueName(payload.expectedOwnerWorkerId)
    const queue = this.queueFactory(queueName)
    const events = this.eventsFactory(queueName)
    const deadline = Date.now() + OWNER_ACK_TIMEOUT_MS
    try {
      await within(events.waitUntilReady(), deadline)
      const job = await within(
        queue.add(SEND_WA_TEXT_JOB_NAME, payload, {
          attempts: 1,
          jobId: createWaSingleSendOwnerJobId(payload),
          removeOnComplete: { age: 300, count: 1_000 },
          removeOnFail: true,
        }),
        deadline,
      )
      return await within(job.waitUntilFinished(events, remaining(deadline)), deadline)
    } finally {
      await Promise.all([settle(() => events.close()), settle(() => queue.close())])
    }
  }
}

function remaining(deadline: number): number {
  const value = deadline - Date.now()
  if (value <= 0) throw new Error('WA single-send owner acknowledgement timed out')
  return value
}

async function within<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('WA single-send owner acknowledgement timed out')),
          remaining(deadline),
        )
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function settle(operation: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      operation().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, HANDLE_CLOSE_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
