import { Injectable } from '@nestjs/common'
import { prisma, WaAccountStatus, type PrismaClient } from '@smartmessage/db'

import { WaLifecycleQueueService } from './wa-lifecycle-queue.service'

@Injectable()
export class WaRestrictedRecoveryReconciler {
  constructor(
    private readonly queueService: WaLifecycleQueueService,
    private readonly db: PrismaClient = prisma,
  ) {}

  async reconcile(): Promise<void> {
    const accounts = await this.db.waAccount.findMany({
      where: {
        status: WaAccountStatus.RESTRICTED,
        restrictedUntil: { not: null },
      },
      select: { instanceId: true, restrictedUntil: true },
      orderBy: [{ restrictedUntil: 'asc' }, { instanceId: 'asc' }],
    })

    for (const account of accounts) {
      if (account.restrictedUntil === null) continue
      await this.queueService.enqueueRestrictedRecovery(account.instanceId, account.restrictedUntil)
    }
  }
}
