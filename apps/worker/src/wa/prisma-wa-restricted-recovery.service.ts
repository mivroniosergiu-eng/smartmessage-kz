import { Injectable } from '@nestjs/common'
import { prisma, WaAccountStatus, type PrismaClient } from '@smartmessage/db'
import {
  parseRecoverRestrictedWaInstanceJobPayload,
  type RecoverRestrictedWaInstanceJobPayload,
} from '@smartmessage/queue'

export type WaRestrictedRecoveryDecision =
  { kind: 'recover' } | { kind: 'reschedule'; restrictedUntil: Date } | { kind: 'stale' }

@Injectable()
export class PrismaWaRestrictedRecoveryService {
  constructor(private readonly db: PrismaClient = prisma) {}

  async resolve(
    payload: RecoverRestrictedWaInstanceJobPayload,
  ): Promise<WaRestrictedRecoveryDecision> {
    const parsed = parseRecoverRestrictedWaInstanceJobPayload(payload)
    const account = await this.db.waAccount.findUnique({
      where: { instanceId: parsed.instanceId },
      select: { status: true, restrictedUntil: true },
    })

    if (account?.status !== WaAccountStatus.RESTRICTED || account.restrictedUntil === null) {
      return { kind: 'stale' }
    }

    const currentRestrictedUntilMs = account.restrictedUntil.getTime()
    const expectedRestrictedUntilMs = Date.parse(parsed.restrictedUntil)
    if (currentRestrictedUntilMs !== expectedRestrictedUntilMs) {
      return currentRestrictedUntilMs > Date.now()
        ? { kind: 'reschedule', restrictedUntil: new Date(account.restrictedUntil) }
        : { kind: 'stale' }
    }

    return currentRestrictedUntilMs > Date.now()
      ? { kind: 'reschedule', restrictedUntil: new Date(account.restrictedUntil) }
      : { kind: 'recover' }
  }
}
