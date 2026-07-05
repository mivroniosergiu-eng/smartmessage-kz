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

  async store(event: WaQrPendingEvent): Promise<void> {
    const instanceId = normalizeNonEmptyString(event.instanceId, 'instanceId')
    const account = await this.db.waAccount.findUnique({
      where: { instanceId },
      select: { id: true },
    })

    if (!account) {
      throw new WaQrBootstrapAccountNotFoundError(instanceId)
    }

    try {
      await this.db.waQrBootstrapEvent.upsert({
        where: { instanceId },
        create: {
          instanceId,
          qrCode: event.qrCode,
          createdAt: cloneDate(event.createdAt),
          expiresAt: cloneDate(event.expiresAt),
        },
        update: {
          qrCode: event.qrCode,
          createdAt: cloneDate(event.createdAt),
          expiresAt: cloneDate(event.expiresAt),
        },
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
    })

    if (!event) return null

    return {
      type: 'qr_pending',
      instanceId: event.instanceId,
      qrCode: event.qrCode,
      createdAt: cloneDate(event.createdAt),
      expiresAt: cloneDate(event.expiresAt),
    }
  }

  async clear(instanceId: string): Promise<void> {
    await this.db.waQrBootstrapEvent.deleteMany({
      where: { instanceId: normalizeNonEmptyString(instanceId, 'instanceId') },
    })
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
