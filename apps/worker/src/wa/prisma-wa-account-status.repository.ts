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

// WaAccount has numeric pid but no string workerId column yet; workerId stays in the port for later audit/context.
export class PrismaWaAccountStatusRepository implements WaAccountStatusRepository {
  private readonly processId: number

  constructor(
    private readonly db: PrismaClient = prisma,
    options: PrismaWaAccountStatusRepositoryOptions = {},
  ) {
    this.processId = options.processId ?? process.pid
  }

  markConnecting(instanceId: string, _workerId: string): Promise<void> {
    return this.updateStatus(instanceId, {
      status: WaAccountStatus.CONNECTING,
      pid: this.processId,
      restrictedUntil: null,
    })
  }

  markConnected(instanceId: string, _workerId: string): Promise<void> {
    return this.updateStatus(instanceId, {
      status: WaAccountStatus.CONNECTED,
      pid: this.processId,
      restrictedUntil: null,
    })
  }

  markDisconnected(instanceId: string, _workerId: string, _reason?: string): Promise<void> {
    return this.updateStatus(instanceId, {
      status: WaAccountStatus.DISCONNECTED,
      pid: null,
      restrictedUntil: null,
    })
  }

  markLoggedOut(instanceId: string, _workerId: string): Promise<void> {
    return this.updateStatus(instanceId, {
      status: WaAccountStatus.LOGGED_OUT,
      pid: null,
      restrictedUntil: null,
    })
  }

  markRestricted(instanceId: string, _workerId: string, restrictedUntil: Date): Promise<void> {
    return this.updateStatus(instanceId, {
      status: WaAccountStatus.RESTRICTED,
      pid: null,
      restrictedUntil,
    })
  }

  markBanned(instanceId: string, _workerId: string, _reason?: string): Promise<void> {
    return this.updateStatus(instanceId, {
      status: WaAccountStatus.BANNED,
      pid: null,
      restrictedUntil: null,
    })
  }

  private async updateStatus(
    instanceId: string,
    data: {
      status: WaAccountStatus
      pid: number | null
      restrictedUntil: Date | null
    },
  ): Promise<void> {
    const result = await this.db.waAccount.updateMany({
      where: { instanceId },
      data,
    })

    if (result.count === 0) {
      throw new WaAccountStatusNotFoundError(instanceId)
    }
  }
}
