import { Inject, Injectable } from '@nestjs/common'
import {
  LOGOUT_WA_INSTANCE_JOB_NAME,
  RECOVER_RESTRICTED_WA_INSTANCE_JOB_NAME,
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  WA_LIFECYCLE_OWNER_RESULT_MAX_AGE_SECONDS,
  WA_LIFECYCLE_OWNER_RESULT_MAX_COUNT,
  createRecoverRestrictedWaInstanceJobId,
  createWaLifecycleOwnerJobId,
  createWaLifecycleOwnerQueueName,
  createWaLifecycleJobId,
  parseRecoverRestrictedWaInstanceJobPayload,
  parseWaLifecycleOwnerCommandJobPayload,
  parseWaLifecycleInstanceJobPayload,
} from '@smartmessage/queue'
import type {
  RecoverRestrictedWaInstanceJobPayload,
  WaLifecycleInstanceJobPayload,
  WaLifecycleJobName,
  WaLifecycleOwnerCommandJobPayload,
} from '@smartmessage/queue'
import type { WaOwnership } from '@smartmessage/wa'

import {
  WA_LIFECYCLE_QUEUE,
  WA_LIFECYCLE_QUEUE_EVENTS_FACTORY,
  WA_LIFECYCLE_QUEUE_FACTORY,
} from './wa.tokens'

type WaLifecycleJobPayload =
  | WaLifecycleInstanceJobPayload
  | WaLifecycleOwnerCommandJobPayload
  | RecoverRestrictedWaInstanceJobPayload
type WaLifecycleCommandJobName = Exclude<
  WaLifecycleJobName,
  typeof RECOVER_RESTRICTED_WA_INSTANCE_JOB_NAME
>

const OWNER_COMMAND_ATTEMPTS = 8
const OWNER_COMMAND_BACKOFF_MS = 5_000
const RESTRICTED_RECOVERY_ATTEMPTS = 8
const RESTRICTED_RECOVERY_BACKOFF_MS = 5_000
const OWNER_ACK_TIMEOUT_MS = 15_000
const OWNER_HANDLE_CLOSE_TIMEOUT_MS = 1_000

export class WaLifecycleOwnerAckTimeoutError extends Error {
  constructor(readonly queueName: string) {
    super(`WA lifecycle owner acknowledgement timed out: ${queueName}`)
    this.name = 'WaLifecycleOwnerAckTimeoutError'
  }
}

interface WaLifecycleQueuePort {
  add(
    name: WaLifecycleJobName,
    data: WaLifecycleJobPayload,
    options: WaLifecycleJobOptions,
  ): Promise<unknown>
  getJob(jobId: string): Promise<WaLifecycleQueuedJob | undefined | null>
}

interface WaLifecycleQueuedJob {
  getState(): Promise<string>
  waitUntilFinished(queueEvents: WaLifecycleQueueEventsPort, ttl: number): Promise<unknown>
}

interface WaLifecycleDirectedQueuePort extends WaLifecycleQueuePort {
  add(
    name: WaLifecycleJobName,
    data: WaLifecycleJobPayload,
    options: WaLifecycleJobOptions,
  ): Promise<WaLifecycleQueuedJob>
  close(): Promise<void>
}

export type WaLifecycleQueueFactory = (queueName: string) => WaLifecycleDirectedQueuePort

export interface WaLifecycleQueueEventsPort {
  waitUntilReady(): Promise<unknown>
  close(): Promise<void>
}

export type WaLifecycleQueueEventsFactory = (queueName: string) => WaLifecycleQueueEventsPort

interface WaLifecycleJobOptions {
  attempts: number
  backoff?: {
    type: 'fixed'
    delay: number
  }
  delay?: number
  jobId: string
  removeOnComplete: true | { age: number; count: number }
  removeOnFail: number | true
}

@Injectable()
export class WaLifecycleQueueService {
  constructor(
    @Inject(WA_LIFECYCLE_QUEUE) private readonly queue: WaLifecycleQueuePort,
    @Inject(WA_LIFECYCLE_QUEUE_FACTORY) private readonly queueFactory: WaLifecycleQueueFactory,
    @Inject(WA_LIFECYCLE_QUEUE_EVENTS_FACTORY)
    private readonly queueEventsFactory: WaLifecycleQueueEventsFactory,
  ) {}

  async enqueueStart(instanceId: string): Promise<unknown> {
    return this.enqueue(START_WA_INSTANCE_JOB_NAME, instanceId)
  }

  async enqueueStop(instanceId: string, ownership?: WaOwnership): Promise<unknown> {
    return this.enqueue(STOP_WA_INSTANCE_JOB_NAME, instanceId, ownership)
  }

  async enqueueLogout(instanceId: string, ownership?: WaOwnership): Promise<unknown> {
    return this.enqueue(LOGOUT_WA_INSTANCE_JOB_NAME, instanceId, ownership)
  }

  async enqueueRenew(
    instanceId: string,
    ownership?: WaOwnership,
    commandId?: string,
  ): Promise<unknown> {
    return this.enqueue(RENEW_WA_INSTANCE_JOB_NAME, instanceId, ownership, commandId)
  }

  async enqueueRestrictedRecovery(instanceId: string, restrictedUntil: Date): Promise<unknown> {
    const restrictedUntilMs = restrictedUntil.getTime()
    const payload = parseRecoverRestrictedWaInstanceJobPayload({
      instanceId,
      restrictedUntil: Number.isFinite(restrictedUntilMs) ? restrictedUntil.toISOString() : '',
    })
    const delay = Math.max(0, restrictedUntilMs - Date.now())

    return this.queue.add(RECOVER_RESTRICTED_WA_INSTANCE_JOB_NAME, payload, {
      attempts: RESTRICTED_RECOVERY_ATTEMPTS,
      backoff: { type: 'fixed', delay: RESTRICTED_RECOVERY_BACKOFF_MS },
      delay,
      jobId: createRecoverRestrictedWaInstanceJobId(payload),
      removeOnComplete: true,
      removeOnFail: 100,
    })
  }

  async hasPendingStart(instanceId: string): Promise<boolean> {
    const payload = parseWaLifecycleInstanceJobPayload({ instanceId }, START_WA_INSTANCE_JOB_NAME)
    const job = await this.queue.getJob(createWaLifecycleJobId(START_WA_INSTANCE_JOB_NAME, payload))
    if (!job) return false

    const state = await job.getState()
    return (
      state === 'active' ||
      state === 'waiting' ||
      state === 'delayed' ||
      state === 'prioritized' ||
      state === 'waiting-children'
    )
  }

  private async enqueue(
    jobName: WaLifecycleCommandJobName,
    instanceId: string,
    ownership?: WaOwnership,
    commandId?: string,
  ): Promise<unknown> {
    let payload: WaLifecycleJobPayload = parseWaLifecycleInstanceJobPayload({ instanceId }, jobName)
    let jobId = createWaLifecycleJobId(jobName, payload)
    if (ownership) {
      if (jobName === START_WA_INSTANCE_JOB_NAME) {
        throw new TypeError('start-wa-instance cannot be routed to an owner queue')
      }
      payload = parseWaLifecycleOwnerCommandJobPayload(
        {
          instanceId,
          expectedOwnerWorkerId: ownership.owner,
          expectedOwnerEpoch: ownership.epoch.toString(),
        },
        jobName,
      )
      jobId = createWaLifecycleOwnerJobId(jobName, payload, commandId)
    }
    const options: WaLifecycleJobOptions = ownership
      ? {
          attempts: 1,
          jobId,
          removeOnComplete: {
            age: WA_LIFECYCLE_OWNER_RESULT_MAX_AGE_SECONDS,
            count: WA_LIFECYCLE_OWNER_RESULT_MAX_COUNT,
          },
          removeOnFail: true,
        }
      : {
          attempts: jobName === START_WA_INSTANCE_JOB_NAME ? 1 : OWNER_COMMAND_ATTEMPTS,
          jobId,
          removeOnComplete: true,
          removeOnFail: 100,
        }
    if (!ownership && jobName !== START_WA_INSTANCE_JOB_NAME) {
      options.backoff = { type: 'fixed', delay: OWNER_COMMAND_BACKOFF_MS }
    }
    if (!ownership) return this.queue.add(jobName, payload, options)

    const queueName = createWaLifecycleOwnerQueueName(ownership.owner)
    const directedQueue = this.queueFactory(queueName)
    const queueEvents = this.queueEventsFactory(queueName)
    const deadline = Date.now() + OWNER_ACK_TIMEOUT_MS
    try {
      await withinOwnerAckDeadline(queueEvents.waitUntilReady(), deadline, queueName)
      const directedJob = await withinOwnerAckDeadline(
        directedQueue.add(jobName, payload, options),
        deadline,
        queueName,
      )
      const remainingMs = remainingOwnerAckTime(deadline, queueName)
      return await withinOwnerAckDeadline(
        directedJob.waitUntilFinished(queueEvents, remainingMs),
        deadline,
        queueName,
      )
    } finally {
      await Promise.all([
        settleOwnerHandleClose(() => queueEvents.close()),
        settleOwnerHandleClose(() => directedQueue.close()),
      ])
    }
  }
}

async function settleOwnerHandleClose(operation: () => Promise<void>): Promise<void> {
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
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function remainingOwnerAckTime(deadline: number, queueName: string): number {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) throw new WaLifecycleOwnerAckTimeoutError(queueName)
  return remainingMs
}

async function withinOwnerAckDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  queueName: string,
): Promise<T> {
  const timeoutMs = remainingOwnerAckTime(deadline, queueName)
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new WaLifecycleOwnerAckTimeoutError(queueName)), timeoutMs)
    timeout.unref?.()
  })
  try {
    return await Promise.race([operation, expired])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
