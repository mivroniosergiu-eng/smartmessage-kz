import { Prisma, prisma, type PrismaClient } from '@smartmessage/db'
import type { WaQrBootstrapRepository, WaQrPendingEvent } from '@smartmessage/wa'

export class WaQrBootstrapAccountNotFoundError extends Error {
  constructor(readonly instanceId: string) {
    super(`WA QR bootstrap store failed: instanceId ${instanceId} was not found`)
    this.name = 'WaQrBootstrapAccountNotFoundError'
  }
}

export class PrismaWaQrBootstrapRepository implements WaQrBootstrapRepository {
  constructor(private readonly db: PrismaClient = prisma) {}

  async activateOwnership(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    const normalized = normalizeNonEmptyString(instanceId, 'instanceId')
    return this.db.$transaction(async (tx) => {
      const result = await tx.waAccount.updateMany({
        where: {
          instanceId: normalized,
          OR: [
            { ownershipEpoch: { lt: epoch } },
            { ownershipEpoch: epoch, ownerWorkerId: workerId },
          ],
        },
        data: { ownershipEpoch: epoch, ownerWorkerId: workerId },
      })
      if (result.count === 0) return this.resolveRejectedFence(tx, normalized)
      await tx.waQrBootstrapEvent.deleteMany({
        where: { instanceId: normalized, ownershipEpoch: { not: epoch } },
      })
      return true
    })
  }

  async store(event: WaQrPendingEvent, workerId: string, epoch: bigint): Promise<boolean> {
    const instanceId = normalizeNonEmptyString(event.instanceId, 'instanceId')

    try {
      return await this.db.$transaction(async (tx) => {
        const fence = await this.lockFence(tx, instanceId, workerId, epoch)
        if (!fence) return false
        await tx.waQrBootstrapEvent.upsert({
          where: { instanceId },
          create: {
            instanceId,
            qrCode: event.qrCode,
            ownershipEpoch: epoch,
            createdAt: cloneDate(event.createdAt),
            expiresAt: cloneDate(event.expiresAt),
          },
          update: {
            qrCode: event.qrCode,
            ownershipEpoch: epoch,
            createdAt: cloneDate(event.createdAt),
            expiresAt: cloneDate(event.expiresAt),
          },
        })
        return true
      })
    } catch (error) {
      if (isPrismaError(error, 'P2003')) {
        throw new WaQrBootstrapAccountNotFoundError(instanceId)
      }

      throw error
    }
  }

  async getLatest(instanceId: string): Promise<WaQrPendingEvent | null> {
    const normalizedInstanceId = normalizeNonEmptyString(instanceId, 'instanceId')
    const event = await this.db.waQrBootstrapEvent.findUnique({
      where: { instanceId: normalizedInstanceId },
      include: { waAccount: { select: { ownershipEpoch: true } } },
    })

    if (!event || event.ownershipEpoch !== event.waAccount.ownershipEpoch) return null

    return {
      type: 'qr_pending',
      instanceId: event.instanceId,
      qrCode: event.qrCode,
      createdAt: cloneDate(event.createdAt),
      expiresAt: cloneDate(event.expiresAt),
    }
  }

  async clear(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    const normalized = normalizeNonEmptyString(instanceId, 'instanceId')
    return this.db.$transaction(async (tx) => {
      const fence = await this.lockFence(tx, normalized, workerId, epoch)
      if (!fence) return false
      await tx.waQrBootstrapEvent.deleteMany({ where: { instanceId: normalized } })
      return true
    })
  }

  private async lockFence(
    tx: Prisma.TransactionClient,
    instanceId: string,
    workerId: string,
    epoch: bigint,
  ): Promise<boolean> {
    const result = await tx.waAccount.updateMany({
      where: { instanceId, ownerWorkerId: workerId, ownershipEpoch: epoch },
      data: { ownershipEpoch: epoch },
    })
    if (result.count > 0) return true
    return this.resolveRejectedFence(tx, instanceId)
  }

  private async resolveRejectedFence(
    tx: Prisma.TransactionClient,
    instanceId: string,
  ): Promise<false> {
    const account = await tx.waAccount.findUnique({ where: { instanceId }, select: { id: true } })
    if (!account) throw new WaQrBootstrapAccountNotFoundError(instanceId)
    return false
  }
}

function normalizeNonEmptyString(value: string, fieldName: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`)
  }

  return normalized
}

function cloneDate(value: Date): Date {
  return new Date(value)
}

function isPrismaError(
  error: unknown,
  code: string,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
}
