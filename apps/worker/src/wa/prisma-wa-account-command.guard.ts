import { Injectable } from '@nestjs/common'
import { prisma, WaAccountStatus, type PrismaClient } from '@smartmessage/db'
import {
  START_WA_INSTANCE_JOB_NAME,
  parseWaLifecycleInstanceJobPayload,
  type WaLifecycleJobName,
} from '@smartmessage/queue'

export class WaAccountCommandTargetNotFoundError extends Error {
  constructor(readonly instanceId: string) {
    super(`WA account command target not found: instanceId ${instanceId} does not exist`)
    this.name = 'WaAccountCommandTargetNotFoundError'
  }
}

export class WaAccountCommandBlockedError extends Error {
  constructor(
    readonly instanceId: string,
    readonly status: WaAccountStatus,
    readonly restrictedUntil: Date | null,
  ) {
    super(`WA account start is blocked by operational status ${status}: ${instanceId}`)
    this.name = 'WaAccountCommandBlockedError'
  }
}

@Injectable()
export class PrismaWaAccountCommandGuard {
  constructor(private readonly db: PrismaClient = prisma) {}

  async assertCommandableInstance(
    instanceId: string,
    jobName: WaLifecycleJobName,
  ): Promise<{ instanceId: string }> {
    const payload = parseWaLifecycleInstanceJobPayload({ instanceId }, jobName)
    const account = await this.db.waAccount.findUnique({
      where: { instanceId: payload.instanceId },
      select: { instanceId: true, status: true, restrictedUntil: true },
    })

    if (!account) {
      throw new WaAccountCommandTargetNotFoundError(payload.instanceId)
    }

    if (
      jobName === START_WA_INSTANCE_JOB_NAME &&
      (account.status === WaAccountStatus.BANNED ||
        (account.status === WaAccountStatus.RESTRICTED &&
          (account.restrictedUntil === null || account.restrictedUntil.getTime() > Date.now())))
    ) {
      throw new WaAccountCommandBlockedError(
        account.instanceId,
        account.status,
        account.restrictedUntil,
      )
    }

    return { instanceId: account.instanceId }
  }
}
