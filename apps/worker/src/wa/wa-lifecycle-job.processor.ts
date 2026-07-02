import { Injectable } from '@nestjs/common'
import {
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  parseWaLifecycleInstanceJobPayload,
} from '@smartmessage/queue'
import type { Job } from '@smartmessage/queue'
import type { SessionState } from '@smartmessage/wa'

import { WaLifecycleCommandService } from './wa-lifecycle-command.service'

export interface StartWaInstanceJobResult {
  instanceId: string
  status: SessionState['status']
}

export interface StopWaInstanceJobResult {
  instanceId: string
  stopped: boolean
}

export interface RenewWaInstanceJobResult {
  instanceId: string
  renewed: boolean
}

export type WaLifecycleJobResult = StartWaInstanceJobResult | StopWaInstanceJobResult | RenewWaInstanceJobResult

@Injectable()
export class WaLifecycleJobProcessor {
  constructor(private readonly commands: WaLifecycleCommandService) {}

  async process(job: Pick<Job<unknown>, 'name' | 'data'>): Promise<WaLifecycleJobResult> {
    switch (job.name) {
      case START_WA_INSTANCE_JOB_NAME: {
        const payload = parseWaLifecycleInstanceJobPayload(job.data, START_WA_INSTANCE_JOB_NAME)
        const state = await this.commands.startInstance(payload.instanceId)

        return {
          instanceId: state.instanceId,
          status: state.status,
        }
      }
      case STOP_WA_INSTANCE_JOB_NAME: {
        const payload = parseWaLifecycleInstanceJobPayload(job.data, STOP_WA_INSTANCE_JOB_NAME)
        const stopped = await this.commands.stopInstance(payload.instanceId)

        return {
          instanceId: payload.instanceId,
          stopped,
        }
      }
      case RENEW_WA_INSTANCE_JOB_NAME: {
        const payload = parseWaLifecycleInstanceJobPayload(job.data, RENEW_WA_INSTANCE_JOB_NAME)
        const renewed = await this.commands.renewInstance(payload.instanceId)

        return {
          instanceId: payload.instanceId,
          renewed,
        }
      }
      default:
        throw new TypeError(`Unsupported WA lifecycle job: ${job.name}`)
    }
  }
}
