import { Injectable } from '@nestjs/common'
import { Prisma, prisma, type PrismaClient, type WaAccount } from '@smartmessage/db'
import { START_WA_INSTANCE_JOB_NAME, parseWaLifecycleInstanceJobPayload } from '@smartmessage/queue'

export interface CreateWaAccountInput {
  teamId: string
  instanceId: string
}

export class WaAccountAdminInvalidInputError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'WaAccountAdminInvalidInputError'
  }
}

export class WaAccountAdminDuplicateInstanceError extends Error {
  constructor(readonly instanceId: string) {
    super(`WA account admin create failed: instanceId ${instanceId} already exists`)
    this.name = 'WaAccountAdminDuplicateInstanceError'
  }
}

export class WaAccountAdminTeamNotFoundError extends Error {
  constructor(readonly teamId: string) {
    super(`WA account admin create failed: teamId ${teamId} does not exist`)
    this.name = 'WaAccountAdminTeamNotFoundError'
  }
}

@Injectable()
export class PrismaWaAccountAdminService {
  constructor(private readonly db: PrismaClient = prisma) {}

  async createAccount(input: CreateWaAccountInput): Promise<WaAccount> {
    const teamId = normalizeTeamId(input.teamId)
    const instanceId = normalizeInstanceId(input.instanceId)

    const team = await this.db.team.findUnique({
      where: { id: teamId },
      select: { id: true },
    })
    if (!team) {
      throw new WaAccountAdminTeamNotFoundError(teamId)
    }

    const existingAccount = await this.db.waAccount.findUnique({
      where: { instanceId },
      select: { instanceId: true },
    })
    if (existingAccount) {
      throw new WaAccountAdminDuplicateInstanceError(instanceId)
    }

    try {
      return await this.db.waAccount.create({
        data: {
          teamId,
          instanceId,
        },
      })
    } catch (error) {
      if (isPrismaError(error, 'P2002')) {
        throw new WaAccountAdminDuplicateInstanceError(instanceId)
      }
      if (isPrismaError(error, 'P2003')) {
        throw new WaAccountAdminTeamNotFoundError(teamId)
      }

      throw error
    }
  }

  getAccount(instanceId: string): Promise<WaAccount | null> {
    const normalizedInstanceId = normalizeInstanceId(instanceId)

    return this.db.waAccount.findUnique({
      where: { instanceId: normalizedInstanceId },
    })
  }

  listAccounts(teamId: string): Promise<WaAccount[]> {
    const normalizedTeamId = normalizeTeamId(teamId)

    return this.db.waAccount.findMany({
      where: { teamId: normalizedTeamId },
      orderBy: { instanceId: 'asc' },
    })
  }
}

function normalizeTeamId(teamId: string): string {
  if (typeof teamId !== 'string') {
    throw new WaAccountAdminInvalidInputError('teamId must be a non-empty string')
  }

  const normalizedTeamId = teamId.trim()
  if (normalizedTeamId.length === 0) {
    throw new WaAccountAdminInvalidInputError('teamId must be a non-empty string')
  }

  return normalizedTeamId
}

function normalizeInstanceId(instanceId: string): string {
  return parseWaLifecycleInstanceJobPayload({ instanceId }, START_WA_INSTANCE_JOB_NAME).instanceId
}

function isPrismaError(error: unknown, code: string): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
}
