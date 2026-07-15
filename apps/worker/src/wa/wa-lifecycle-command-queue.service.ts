import { Injectable } from '@nestjs/common'
import {
  LOGOUT_WA_INSTANCE_JOB_NAME,
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
} from '@smartmessage/queue'

import { PrismaWaAccountCommandGuard } from './prisma-wa-account-command.guard'
import { WaLifecycleQueueService } from './wa-lifecycle-queue.service'

@Injectable()
export class WaLifecycleCommandQueueService {
  constructor(
    private readonly commandGuard: PrismaWaAccountCommandGuard,
    private readonly queueService: WaLifecycleQueueService,
  ) {}

  async enqueueStart(instanceId: string): Promise<unknown> {
    const target = await this.commandGuard.assertCommandableInstance(
      instanceId,
      START_WA_INSTANCE_JOB_NAME,
    )

    return this.queueService.enqueueStart(target.instanceId)
  }

  async enqueueStop(instanceId: string): Promise<unknown> {
    const target = await this.commandGuard.assertCommandableInstance(
      instanceId,
      STOP_WA_INSTANCE_JOB_NAME,
    )

    return this.queueService.enqueueStop(target.instanceId)
  }

  async enqueueLogout(instanceId: string): Promise<unknown> {
    const target = await this.commandGuard.assertCommandableInstance(
      instanceId,
      LOGOUT_WA_INSTANCE_JOB_NAME,
    )

    return this.queueService.enqueueLogout(target.instanceId)
  }

  async enqueueRenew(instanceId: string): Promise<unknown> {
    const target = await this.commandGuard.assertCommandableInstance(
      instanceId,
      RENEW_WA_INSTANCE_JOB_NAME,
    )

    return this.queueService.enqueueRenew(target.instanceId)
  }
}
