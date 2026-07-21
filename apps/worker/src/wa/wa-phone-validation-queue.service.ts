import { Inject, Injectable } from '@nestjs/common'
import {
  VALIDATE_WA_PHONE_JOB_NAME,
  createWaPhoneValidationJobId,
  createWaPhoneValidationOwnerJobId,
  createWaPhoneValidationOwnerQueueName,
  parseWaPhoneValidationJobPayload,
  parseWaPhoneValidationOwnerJobPayload,
} from '@smartmessage/queue'
import type {
  WaPhoneValidationJobPayload,
  WaPhoneValidationOwnerJobPayload,
} from '@smartmessage/queue'

import {
  WA_PHONE_VALIDATION_QUEUE,
  WA_PHONE_VALIDATION_QUEUE_EVENTS_FACTORY,
  WA_PHONE_VALIDATION_QUEUE_FACTORY,
} from './wa.tokens'

const VALIDATION_ATTEMPTS = 8
const VALIDATION_BACKOFF_MS = 5_000
const OWNER_ACK_TIMEOUT_MS = 15_000
const OWNER_HANDLE_CLOSE_TIMEOUT_MS = 1_000
const OWNER_RESULT_MAX_AGE_SECONDS = 300
const OWNER_RESULT_MAX_COUNT = 1_000

interface ValidationJobOptions {
  attempts: number
  backoff?: { type: 'fixed'; delay: number }
  jobId: string
  removeOnComplete: true | { age: number; count: number }
  removeOnFail: number | true | { age: number; count: number }
}

interface ValidationQueuedJob {
  waitUntilFinished(events: ValidationQueueEventsPort, ttl: number): Promise<unknown>
}

interface ValidationQueuePort {
  add(
    name: typeof VALIDATE_WA_PHONE_JOB_NAME,
    data: WaPhoneValidationJobPayload | WaPhoneValidationOwnerJobPayload,
    options: ValidationJobOptions,
  ): Promise<unknown>
}

interface DirectedValidationQueuePort extends ValidationQueuePort {
  add(
    name: typeof VALIDATE_WA_PHONE_JOB_NAME,
    data: WaPhoneValidationOwnerJobPayload,
    options: ValidationJobOptions,
  ): Promise<ValidationQueuedJob>
  close(): Promise<void>
}

export interface ValidationQueueEventsPort {
  waitUntilReady(): Promise<unknown>
  close(): Promise<void>
}

export type WaPhoneValidationQueueFactory = (queueName: string) => DirectedValidationQueuePort
export type WaPhoneValidationQueueEventsFactory = (queueName: string) => ValidationQueueEventsPort

export class WaPhoneValidationOwnerAckTimeoutError extends Error {
  constructor(readonly queueName: string) {
    super(`WA phone validation owner acknowledgement timed out: ${queueName}`)
    this.name = 'WaPhoneValidationOwnerAckTimeoutError'
  }
}

@Injectable()
export class WaPhoneValidationQueueService {
  constructor(
    @Inject(WA_PHONE_VALIDATION_QUEUE) private readonly queue: ValidationQueuePort,
    @Inject(WA_PHONE_VALIDATION_QUEUE_FACTORY)
    private readonly queueFactory: WaPhoneValidationQueueFactory,
    @Inject(WA_PHONE_VALIDATION_QUEUE_EVENTS_FACTORY)
    private readonly queueEventsFactory: WaPhoneValidationQueueEventsFactory,
  ) {}

  async enqueue(contactId: string, teamId: string): Promise<unknown> {
    const payload = parseWaPhoneValidationJobPayload({ contactId, teamId })
    return this.queue.add(VALIDATE_WA_PHONE_JOB_NAME, payload, {
      attempts: VALIDATION_ATTEMPTS,
      backoff: { type: 'fixed', delay: VALIDATION_BACKOFF_MS },
      jobId: createWaPhoneValidationJobId(payload),
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
    })
  }

  async enqueueForOwner(payload: WaPhoneValidationOwnerJobPayload): Promise<unknown> {
    const parsed = parseWaPhoneValidationOwnerJobPayload(payload)
    const queueName = createWaPhoneValidationOwnerQueueName(parsed.expectedOwnerWorkerId)
    const directedQueue = this.queueFactory(queueName)
    const events = this.queueEventsFactory(queueName)
    const deadline = Date.now() + OWNER_ACK_TIMEOUT_MS
    try {
      await withinDeadline(events.waitUntilReady(), deadline, queueName)
      const job = await withinDeadline(
        directedQueue.add(VALIDATE_WA_PHONE_JOB_NAME, parsed, {
          attempts: 1,
          jobId: createWaPhoneValidationOwnerJobId(parsed),
          removeOnComplete: {
            age: OWNER_RESULT_MAX_AGE_SECONDS,
            count: OWNER_RESULT_MAX_COUNT,
          },
          removeOnFail: true,
        }),
        deadline,
        queueName,
      )
      return await withinDeadline(
        job.waitUntilFinished(events, remainingTime(deadline, queueName)),
        deadline,
        queueName,
      )
    } finally {
      await Promise.all([
        settleClose(() => events.close()),
        settleClose(() => directedQueue.close()),
      ])
    }
  }
}

async function settleClose(operation: () => Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, OWNER_HANDLE_CLOSE_TIMEOUT_MS)
    timeout.unref?.()
  })
  try {
    await Promise.race([
      Promise.resolve()
        .then(operation)
        .catch(() => undefined),
      deadline,
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function remainingTime(deadline: number, queueName: string): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new WaPhoneValidationOwnerAckTimeoutError(queueName)
  return remaining
}

async function withinDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  queueName: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new WaPhoneValidationOwnerAckTimeoutError(queueName)),
      remainingTime(deadline, queueName),
    )
    timeout.unref?.()
  })
  try {
    return await Promise.race([operation, expired])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
