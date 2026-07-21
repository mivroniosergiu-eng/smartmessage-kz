import {
  ContactWaStatus as PrismaContactWaStatus,
  PrismaClient,
  WaAccountStatus,
  prisma as defaultPrisma,
} from '@smartmessage/db'

export interface PreparedPhoneValidation {
  contactId: string
  teamId: string
  phone: string
  validationRunId: string
  terminalStatus?: 'confirmed' | 'not_on_whatsapp'
}

export interface EligibleWaValidationAccount {
  instanceId: string
  ownerWorkerId: string
  ownershipEpoch: bigint
}

export interface OwnerPhoneValidationTarget {
  contactId: string
  teamId: string
  phone: string
  instanceId: string
  validationRunId: string
  expectedOwnerWorkerId: string
  expectedOwnerEpoch: string
}

export class WaPhoneValidationTargetNotFoundError extends Error {
  constructor(
    readonly contactId: string,
    readonly teamId: string,
  ) {
    super(`WA phone validation contact was not found: ${contactId}`)
    this.name = 'WaPhoneValidationTargetNotFoundError'
  }
}

export class WaPhoneValidationTargetStaleError extends Error {
  constructor(readonly contactId: string) {
    super(`WA phone validation target is stale: ${contactId}`)
    this.name = 'WaPhoneValidationTargetStaleError'
  }
}

export class PrismaWaPhoneValidationRepository {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  async getTeamId(contactId: string): Promise<string> {
    const contact = await this.prisma.contact.findUnique({
      where: { id: contactId },
      select: { teamId: true },
    })
    if (!contact) throw new WaPhoneValidationTargetNotFoundError(contactId, 'derived')
    return contact.teamId
  }

  async prepare(
    contactId: string,
    teamId: string,
    validationRunId: string,
  ): Promise<PreparedPhoneValidation> {
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, teamId },
      select: {
        id: true,
        teamId: true,
        phone: true,
        isValid: true,
        waValidationRunId: true,
      },
    })
    if (!contact) throw new WaPhoneValidationTargetNotFoundError(contactId, teamId)

    const terminalStatus = toTerminalStatus(contact.isValid)
    if (terminalStatus)
      return {
        contactId: contact.id,
        teamId: contact.teamId,
        phone: contact.phone,
        validationRunId,
        terminalStatus,
      }
    if (
      contact.isValid === PrismaContactWaStatus.IN_PROGRESS &&
      contact.waValidationRunId === validationRunId
    ) {
      return {
        contactId: contact.id,
        teamId: contact.teamId,
        phone: contact.phone,
        validationRunId,
      }
    }

    const claimed = await this.prisma.contact.updateMany({
      where: {
        id: contact.id,
        teamId: contact.teamId,
        isValid: contact.isValid,
        waValidationRunId: contact.waValidationRunId,
      },
      data: {
        isValid: PrismaContactWaStatus.IN_PROGRESS,
        waValidationRunId: validationRunId,
      },
    })
    if (claimed.count === 1) {
      return {
        contactId: contact.id,
        teamId: contact.teamId,
        phone: contact.phone,
        validationRunId,
      }
    }

    return this.prepare(contactId, teamId, validationRunId)
  }

  async listEligibleAccounts(teamId: string): Promise<EligibleWaValidationAccount[]> {
    const accounts = await this.prisma.waAccount.findMany({
      where: {
        teamId,
        status: WaAccountStatus.CONNECTED,
        ownerWorkerId: { not: null },
        ownershipEpoch: { gt: 0 },
      },
      orderBy: { instanceId: 'asc' },
      select: { instanceId: true, ownerWorkerId: true, ownershipEpoch: true },
    })

    return accounts.flatMap((account) =>
      account.ownerWorkerId
        ? [
            {
              instanceId: account.instanceId,
              ownerWorkerId: account.ownerWorkerId,
              ownershipEpoch: account.ownershipEpoch,
            },
          ]
        : [],
    )
  }

  async assertOwnerTarget(target: OwnerPhoneValidationTarget): Promise<void> {
    const expectedEpoch = BigInt(target.expectedOwnerEpoch)
    const [contact, account] = await Promise.all([
      this.prisma.contact.findFirst({
        where: {
          id: target.contactId,
          teamId: target.teamId,
          phone: target.phone,
          isValid: PrismaContactWaStatus.IN_PROGRESS,
          waValidationRunId: target.validationRunId,
        },
        select: { id: true },
      }),
      this.prisma.waAccount.findFirst({
        where: {
          instanceId: target.instanceId,
          teamId: target.teamId,
          status: WaAccountStatus.CONNECTED,
          ownerWorkerId: target.expectedOwnerWorkerId,
          ownershipEpoch: expectedEpoch,
        },
        select: { id: true },
      }),
    ])
    if (!contact || !account) throw new WaPhoneValidationTargetStaleError(target.contactId)
  }

  async complete(
    contactId: string,
    teamId: string,
    phone: string,
    validationRunId: string,
    status: 'confirmed' | 'not_on_whatsapp',
  ): Promise<void> {
    const prismaStatus = fromTerminalStatus(status)
    const updated = await this.prisma.contact.updateMany({
      where: {
        id: contactId,
        teamId,
        phone,
        isValid: PrismaContactWaStatus.IN_PROGRESS,
        waValidationRunId: validationRunId,
      },
      data: { isValid: prismaStatus },
    })
    if (updated.count === 1) return

    const current = await this.prisma.contact.findFirst({
      where: { id: contactId, teamId },
      select: { phone: true, isValid: true, waValidationRunId: true },
    })
    if (
      current?.phone !== phone ||
      current.isValid !== prismaStatus ||
      current.waValidationRunId !== validationRunId
    ) {
      throw new WaPhoneValidationTargetStaleError(contactId)
    }
  }

  async markError(
    contactId: string,
    teamId: string,
    phone: string,
    validationRunId: string,
  ): Promise<void> {
    await this.prisma.contact.updateMany({
      where: {
        id: contactId,
        teamId,
        phone,
        isValid: PrismaContactWaStatus.IN_PROGRESS,
        waValidationRunId: validationRunId,
      },
      data: { isValid: PrismaContactWaStatus.ERROR },
    })
  }

  async markRunError(contactId: string, teamId: string, validationRunId: string): Promise<void> {
    await this.prisma.contact.updateMany({
      where: {
        id: contactId,
        teamId,
        isValid: PrismaContactWaStatus.IN_PROGRESS,
        waValidationRunId: validationRunId,
      },
      data: { isValid: PrismaContactWaStatus.ERROR },
    })
  }
}

function toTerminalStatus(
  status: PrismaContactWaStatus | null,
): PreparedPhoneValidation['terminalStatus'] {
  if (status === PrismaContactWaStatus.CONFIRMED) return 'confirmed'
  if (status === PrismaContactWaStatus.NOT_ON_WHATSAPP) return 'not_on_whatsapp'
  return undefined
}

function fromTerminalStatus(status: 'confirmed' | 'not_on_whatsapp'): PrismaContactWaStatus {
  return status === 'confirmed'
    ? PrismaContactWaStatus.CONFIRMED
    : PrismaContactWaStatus.NOT_ON_WHATSAPP
}
