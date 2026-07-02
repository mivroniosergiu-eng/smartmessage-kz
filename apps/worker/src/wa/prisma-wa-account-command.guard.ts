import { Injectable } from '@nestjs/common'
import { prisma, type PrismaClient } from '@smartmessage/db'
import { START_WA_INSTANCE_JOB_NAME, parseWaLifecycleInstanceJobPayload } from '@smartmessage/queue'

export class WaAccountCommandTargetNotFoundError extends Error {
  constructor(readonly instanceId: string) {
    super(`WA account command target not found: instanceId ${instanceId} does not exist`)
    this.name = 'WaAccountCommandTargetNotFoundError'
  }
}

@Injectable()
export class PrismaWaAccountCommandGuard {
  constructor(private readonly db: PrismaClient = prisma) {}

  async assertCommandableInstance(instanceId: string): Promise<{ instanceId: string }> {
    const payload = parseWaLifecycleInstanceJobPayload({ instanceId }, START_WA_INSTANCE_JOB_NAME)
    const account = await this.db.waAccount.findUnique({
      where: { instanceId: payload.instanceId },
      select: { instanceId: true },
    })

    if (!account) {
      throw new WaAccountCommandTargetNotFoundError(payload.instanceId)
    }

    return { instanceId: account.instanceId }
  }
}
