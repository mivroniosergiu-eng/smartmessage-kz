import { Inject, Injectable } from '@nestjs/common'
import {
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  WA_LIFECYCLE_OWNER_RESULT_MAX_AGE_SECONDS,
  WA_LIFECYCLE_OWNER_RESULT_MAX_COUNT,
  createWaLifecycleOwnerJobId,
  createWaLifecycleOwnerQueueName,
  createWaLifecycleJobId,
  parseWaLifecycleOwnerCommandJobPayload,
  parseWaLifecycleInstanceJobPayload,
} from '@smartmessage/queue'
import type {
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

type WaLifecycleJobPayload = WaLifecycleInstanceJobPayload | WaLifecycleOwnerCommandJobPayload

const OWNER_COMMAND_ATTEMPTS = 8
const OWNER_COMMAND_BACKOFF_MS = 5_000
const OWNER_ACK_TIMEOUT_MS = 15_000

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

  async enqueueRenew(instanceId: string, ownership?: WaOwnership): Promise<unknown> {
    return this.enqueue(RENEW_WA_INSTANCE_JOB_NAME, instanceId, ownership)
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
    jobName: WaLifecycleJobName,
    instanceId: string,
    ownership?: WaOwnership,
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
      jobId = createWaLifecycleOwnerJobId(jobName, payload)
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
    try {
      await queueEvents.waitUntilReady()
      const directedJob = await directedQueue.add(jobName, payload, options)
      return await directedJob.waitUntilFinished(queueEvents, OWNER_ACK_TIMEOUT_MS)
    } finally {
      try {
        await queueEvents.close()
      } finally {
        await directedQueue.close()
      }
    }
  }
}
