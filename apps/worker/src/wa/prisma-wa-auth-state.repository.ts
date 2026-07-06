import { Prisma, prisma, type PrismaClient } from '@smartmessage/db'
import {
  assertWaAuthStatePayload,
  cloneWaAuthStatePayload,
  normalizeWaAuthStateInstanceId,
  type WaAuthStatePayload,
  type WaAuthStateStore,
} from '@smartmessage/wa'

export class WaAuthStateAccountNotFoundError extends Error {
  constructor(readonly instanceId: string) {
    super(`WA auth-state write failed: instanceId ${instanceId} was not found`)
    this.name = 'WaAuthStateAccountNotFoundError'
  }
}

export class PrismaWaAuthStateRepository implements WaAuthStateStore {
  constructor(private readonly db: PrismaClient = prisma) {}

  async read(instanceId: string): Promise<WaAuthStatePayload | null> {
    const row = await this.db.waAuthState.findUnique({
      where: { instanceId: normalizeWaAuthStateInstanceId(instanceId) },
      select: { payload: true },
    })

    if (!row) return null

    assertWaAuthStatePayload(row.payload)
    return cloneWaAuthStatePayload(row.payload)
  }

  async write(instanceId: string, state: WaAuthStatePayload): Promise<void> {
    const normalizedInstanceId = normalizeWaAuthStateInstanceId(instanceId)
    const payload = cloneWaAuthStatePayload(state) as Prisma.InputJsonObject
    const account = await this.db.waAccount.findUnique({
      where: { instanceId: normalizedInstanceId },
      select: { id: true },
    })

    if (!account) {
      throw new WaAuthStateAccountNotFoundError(normalizedInstanceId)
    }

    try {
      await this.db.waAuthState.upsert({
        where: { instanceId: normalizedInstanceId },
        create: {
          instanceId: normalizedInstanceId,
          payload,
        },
        update: {
          payload,
        },
      })
    } catch (error) {
      if (isPrismaError(error, 'P2003')) {
        throw new WaAuthStateAccountNotFoundError(normalizedInstanceId)
      }

      throw error
    }
  }

  async clear(instanceId: string): Promise<void> {
    await this.db.waAuthState.deleteMany({
      where: { instanceId: normalizeWaAuthStateInstanceId(instanceId) },
    })
  }

  async has(instanceId: string): Promise<boolean> {
    const count = await this.db.waAuthState.count({
      where: { instanceId: normalizeWaAuthStateInstanceId(instanceId) },
    })

    return count > 0
  }
}

function isPrismaError(
  error: unknown,
  code: string,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
}
