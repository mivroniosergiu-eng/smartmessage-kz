import { Injectable } from '@nestjs/common'

import { PrismaWaAccountCommandGuard } from './prisma-wa-account-command.guard'
import { WaLifecycleQueueService } from './wa-lifecycle-queue.service'

@Injectable()
export class WaLifecycleCommandQueueService {
  constructor(
    private readonly commandGuard: PrismaWaAccountCommandGuard,
    private readonly queueService: WaLifecycleQueueService,
  ) {}

  async enqueueStart(instanceId: string): Promise<unknown> {
    const target = await this.commandGuard.assertCommandableInstance(instanceId)

    return this.queueService.enqueueStart(target.instanceId)
  }

  async enqueueStop(instanceId: string): Promise<unknown> {
    const target = await this.commandGuard.assertCommandableInstance(instanceId)

    return this.queueService.enqueueStop(target.instanceId)
  }

  async enqueueRenew(instanceId: string): Promise<unknown> {
    const target = await this.commandGuard.assertCommandableInstance(instanceId)

    return this.queueService.enqueueRenew(target.instanceId)
  }
}
