import { prisma, WaAccountStatus, type PrismaClient } from '@smartmessage/db'
import type { WaAccountStatusRepository } from '@smartmessage/wa'

export class WaAccountStatusNotFoundError extends Error {
  constructor(readonly instanceId: string) {
    super(`WA account status update failed: instanceId ${instanceId} was not found`)
    this.name = 'WaAccountStatusNotFoundError'
  }
}

export interface PrismaWaAccountStatusRepositoryOptions {
  processId?: number
}

export class PrismaWaAccountStatusRepository implements WaAccountStatusRepository {
  private readonly processId: number

  constructor(
    private readonly db: PrismaClient = prisma,
    options: PrismaWaAccountStatusRepositoryOptions = {},
  ) {
    this.processId = options.processId ?? process.pid
  }

  async getOwnershipEpoch(instanceId: string): Promise<bigint> {
    const account = await this.db.waAccount.findUnique({
      where: { instanceId },
      select: { ownershipEpoch: true },
    })
    if (!account) throw new WaAccountStatusNotFoundError(instanceId)
    return account.ownershipEpoch
  }

  async activateOwnership(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    const result = await this.db.waAccount.updateMany({
      where: {
        instanceId,
        AND: [
          {
            OR: [
              { ownershipEpoch: { lt: epoch } },
              { ownershipEpoch: epoch, ownerWorkerId: workerId },
            ],
          },
          {
            OR: [
              {
                status: {
                  notIn: [WaAccountStatus.BANNED, WaAccountStatus.RESTRICTED],
                },
              },
              {
                status: WaAccountStatus.RESTRICTED,
                restrictedUntil: { lte: new Date() },
              },
            ],
          },
        ],
      },
      data: { ownershipEpoch: epoch, ownerWorkerId: workerId },
    })
    if (result.count > 0) return true
    return this.resolveRejectedFence(instanceId)
  }

  markConnecting(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    return this.updateStatus(instanceId, workerId, epoch, {
      status: WaAccountStatus.CONNECTING,
      pid: this.processId,
      restrictedUntil: null,
    })
  }

  markConnected(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    return this.updateStatus(instanceId, workerId, epoch, {
      status: WaAccountStatus.CONNECTED,
      pid: this.processId,
      restrictedUntil: null,
    })
  }

  markDisconnected(
    instanceId: string,
    workerId: string,
    _reason: string | undefined,
    epoch: bigint,
  ): Promise<boolean> {
    return this.updateStatus(instanceId, workerId, epoch, {
      status: WaAccountStatus.DISCONNECTED,
      pid: null,
      restrictedUntil: null,
    })
  }

  markLoggedOut(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    return this.updateStatus(instanceId, workerId, epoch, {
      status: WaAccountStatus.LOGGED_OUT,
      pid: null,
      restrictedUntil: null,
    })
  }

  async markRestricted(
    instanceId: string,
    workerId: string,
    restrictedUntil: Date,
    epoch: bigint,
  ): Promise<boolean> {
    const result = await this.db.waAccount.updateMany({
      where: {
        instanceId,
        ownerWorkerId: workerId,
        ownershipEpoch: epoch,
        status: { not: WaAccountStatus.BANNED },
        OR: [
          { status: { not: WaAccountStatus.RESTRICTED } },
          { restrictedUntil: null },
          { restrictedUntil: { lt: restrictedUntil } },
        ],
      },
      data: {
        status: WaAccountStatus.RESTRICTED,
        pid: null,
        restrictedUntil,
      },
    })
    if (result.count > 0) return true

    const account = await this.db.waAccount.findUnique({
      where: { instanceId },
      select: {
        ownerWorkerId: true,
        ownershipEpoch: true,
        status: true,
        restrictedUntil: true,
      },
    })
    if (!account) throw new WaAccountStatusNotFoundError(instanceId)
    return (
      account.ownerWorkerId === workerId &&
      account.ownershipEpoch === epoch &&
      account.status === WaAccountStatus.RESTRICTED &&
      account.restrictedUntil !== null &&
      account.restrictedUntil >= restrictedUntil
    )
  }

  async markBanned(
    instanceId: string,
    workerId: string,
    _reason: string | undefined,
    epoch: bigint,
  ): Promise<boolean> {
    const updated = await this.db.$transaction(async (tx) => {
      const result = await tx.waAccount.updateMany({
        where: { instanceId, ownerWorkerId: workerId, ownershipEpoch: epoch },
        data: {
          status: WaAccountStatus.BANNED,
          pid: null,
          restrictedUntil: null,
        },
      })
      if (result.count === 0) return false

      const account = await tx.waAccount.findUniqueOrThrow({
        where: { instanceId },
        select: { id: true, instanceId: true, teamId: true },
      })
      await tx.auditLog.createMany({
        data: [
          {
            id: createBanAuditId(account.id),
            teamId: account.teamId,
            action: 'WA_ACCOUNT_BANNED',
            details: JSON.stringify({
              waAccountId: account.id,
              instanceId: account.instanceId,
              classification: 'banned',
            }),
          },
        ],
        skipDuplicates: true,
      })

      return true
    })

    if (updated) return true
    return this.resolveRejectedFence(instanceId)
  }

  private async updateStatus(
    instanceId: string,
    workerId: string,
    epoch: bigint,
    data: {
      status: WaAccountStatus
      pid: number | null
      restrictedUntil: Date | null
    },
  ): Promise<boolean> {
    const result = await this.db.waAccount.updateMany({
      where: {
        instanceId,
        ownerWorkerId: workerId,
        ownershipEpoch: epoch,
        status: { not: WaAccountStatus.BANNED },
      },
      data,
    })

    if (result.count > 0) return true
    return this.resolveRejectedFence(instanceId)
  }

  private async resolveRejectedFence(instanceId: string): Promise<false> {
    const account = await this.db.waAccount.findUnique({
      where: { instanceId },
      select: { id: true },
    })
    if (!account) throw new WaAccountStatusNotFoundError(instanceId)
    return false
  }
}

function createBanAuditId(waAccountId: string): string {
  return `wa-account-banned:${waAccountId}`
}
