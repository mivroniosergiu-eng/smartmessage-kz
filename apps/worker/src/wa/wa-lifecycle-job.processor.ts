import { Injectable } from '@nestjs/common'
import { START_WA_INSTANCE_JOB_NAME, parseStartWaInstanceJobPayload } from '@smartmessage/queue'
import type { Job } from '@smartmessage/queue'

import { WaLifecycleCommandService } from './wa-lifecycle-command.service'

export interface StartWaInstanceJobResult {
  instanceId: string
  status: string
}

@Injectable()
export class WaLifecycleJobProcessor {
  constructor(private readonly commands: WaLifecycleCommandService) {}

  async process(job: Pick<Job<unknown>, 'name' | 'data'>): Promise<StartWaInstanceJobResult> {
    if (job.name !== START_WA_INSTANCE_JOB_NAME) {
      throw new TypeError(`Unsupported WA lifecycle job: ${job.name}`)
    }

    const payload = parseStartWaInstanceJobPayload(job.data)
    const state = await this.commands.startInstance(payload.instanceId)

    return {
      instanceId: state.instanceId,
      status: state.status,
    }
  }
}
