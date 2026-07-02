import { Inject, Injectable } from '@nestjs/common'
import {
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  createWaLifecycleJobId,
  parseWaLifecycleInstanceJobPayload,
} from '@smartmessage/queue'
import type { WaLifecycleInstanceJobPayload, WaLifecycleJobName } from '@smartmessage/queue'

import { WA_LIFECYCLE_QUEUE } from './wa.tokens'

interface WaLifecycleQueuePort {
  add(name: WaLifecycleJobName, data: WaLifecycleInstanceJobPayload, options: WaLifecycleJobOptions): Promise<unknown>
}

interface WaLifecycleJobOptions {
  attempts: 1
  jobId: string
  removeOnComplete: true
  removeOnFail: number
}

@Injectable()
export class WaLifecycleQueueService {
  constructor(@Inject(WA_LIFECYCLE_QUEUE) private readonly queue: WaLifecycleQueuePort) {}

  async enqueueStart(instanceId: string): Promise<unknown> {
    return this.enqueue(START_WA_INSTANCE_JOB_NAME, instanceId)
  }

  async enqueueStop(instanceId: string): Promise<unknown> {
    return this.enqueue(STOP_WA_INSTANCE_JOB_NAME, instanceId)
  }

  async enqueueRenew(instanceId: string): Promise<unknown> {
    return this.enqueue(RENEW_WA_INSTANCE_JOB_NAME, instanceId)
  }

  private async enqueue(jobName: WaLifecycleJobName, instanceId: string): Promise<unknown> {
    const payload = parseWaLifecycleInstanceJobPayload({ instanceId }, jobName)

    return this.queue.add(jobName, payload, {
      attempts: 1,
      jobId: createWaLifecycleJobId(jobName, payload),
      removeOnComplete: true,
      removeOnFail: 100,
    })
  }
}
