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
        OR: [{ ownershipEpoch: { lt: epoch } }, { ownershipEpoch: epoch, ownerWorkerId: workerId }],
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

  markRestricted(
    instanceId: string,
    workerId: string,
    restrictedUntil: Date,
    epoch: bigint,
  ): Promise<boolean> {
    return this.updateStatus(instanceId, workerId, epoch, {
      status: WaAccountStatus.RESTRICTED,
      pid: null,
      restrictedUntil,
    })
  }

  markBanned(
    instanceId: string,
    workerId: string,
    _reason: string | undefined,
    epoch: bigint,
  ): Promise<boolean> {
    return this.updateStatus(instanceId, workerId, epoch, {
      status: WaAccountStatus.BANNED,
      pid: null,
      restrictedUntil: null,
    })
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
      where: { instanceId, ownerWorkerId: workerId, ownershipEpoch: epoch },
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
