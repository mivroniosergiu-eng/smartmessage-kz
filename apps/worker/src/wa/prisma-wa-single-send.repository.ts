import {
  ContactWaStatus,
  MessageErrorType,
  MessageLogStatus,
  Prisma,
  PrismaClient,
  WaAccountStatus,
  prisma as defaultPrisma,
} from '@smartmessage/db'

export interface PreparedWaSingleSend {
  messageLogId: string
  teamId: string
  instanceId: string
  contactId: string
  phone: string
  text: string
  idempotencyKey: string
  ownerWorkerId?: string
  ownershipEpoch?: bigint
  terminalStatus?: 'sent' | 'failed'
  providerMessageId?: string
  deliveryAmbiguous?: true
}

export class WaSingleSendTargetNotFoundError extends Error {
  constructor() {
    super('WA single-send account or contact was not found')
    this.name = 'WaSingleSendTargetNotFoundError'
  }
}

export class WaSingleSendTargetUnavailableError extends Error {
  constructor(readonly instanceId: string) {
    super(`WA single-send account is not connected and owned: ${instanceId}`)
    this.name = 'WaSingleSendTargetUnavailableError'
  }
}

export class WaSingleSendContactNotConfirmedError extends Error {
  constructor(readonly contactId: string) {
    super(`WA single-send contact is not confirmed: ${contactId}`)
    this.name = 'WaSingleSendContactNotConfirmedError'
  }
}

export class WaSingleSendIdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`WA single-send idempotency key conflicts with another payload: ${idempotencyKey}`)
    this.name = 'WaSingleSendIdempotencyConflictError'
  }
}

export class WaSingleSendTargetStaleError extends Error {
  constructor(readonly messageLogId: string) {
    super(`WA single-send target is stale: ${messageLogId}`)
    this.name = 'WaSingleSendTargetStaleError'
  }
}

export class PrismaWaSingleSendRepository {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  async assertRequestTarget(input: {
    instanceId: string
    contactId: string
    text: string
    idempotencyKey: string
  }): Promise<void> {
    const [account, contact] = await Promise.all([
      this.prisma.waAccount.findUnique({
        where: { instanceId: input.instanceId },
        select: { teamId: true },
      }),
      this.prisma.contact.findUnique({
        where: { id: input.contactId },
        select: { teamId: true, phone: true, isValid: true },
      }),
    ])
    if (!account || !contact || account.teamId !== contact.teamId) {
      throw new WaSingleSendTargetNotFoundError()
    }

    const existing = await this.prisma.messageLog.findUnique({
      where: {
        teamId_idempotencyKey: {
          teamId: account.teamId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    })
    if (
      existing &&
      (existing.instanceId !== input.instanceId ||
        existing.phone !== contact.phone ||
        existing.type !== 'text' ||
        existing.message !== input.text)
    ) {
      throw new WaSingleSendIdempotencyConflictError(input.idempotencyKey)
    }
    if (
      contact.isValid !== ContactWaStatus.CONFIRMED &&
      (!existing || !isTerminalOrAmbiguousStatus(existing.status))
    ) {
      throw new WaSingleSendContactNotConfirmedError(input.contactId)
    }
  }

  async prepare(input: {
    instanceId: string
    contactId: string
    text: string
    idempotencyKey: string
  }): Promise<PreparedWaSingleSend> {
    return this.prisma.$transaction(
      async (tx) => {
        const [account, contact] = await Promise.all([
          tx.waAccount.findUnique({
            where: { instanceId: input.instanceId },
            select: {
              teamId: true,
              status: true,
              ownerWorkerId: true,
              ownershipEpoch: true,
            },
          }),
          tx.contact.findUnique({
            where: { id: input.contactId },
            select: { teamId: true, phone: true, isValid: true },
          }),
        ])
        if (!account || !contact || account.teamId !== contact.teamId) {
          throw new WaSingleSendTargetNotFoundError()
        }
        const existing = await tx.messageLog.findUnique({
          where: {
            teamId_idempotencyKey: {
              teamId: account.teamId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        })
        if (
          existing &&
          (existing.instanceId !== input.instanceId ||
            existing.phone !== contact.phone ||
            existing.type !== 'text' ||
            existing.message !== input.text)
        ) {
          throw new WaSingleSendIdempotencyConflictError(input.idempotencyKey)
        }
        if (
          existing &&
          (isSentTerminalStatus(existing.status) || existing.status === MessageLogStatus.FAILED)
        ) {
          const sentTerminal = isSentTerminalStatus(existing.status)
          return {
            messageLogId: existing.id,
            teamId: account.teamId,
            instanceId: input.instanceId,
            contactId: input.contactId,
            phone: contact.phone,
            text: input.text,
            idempotencyKey: input.idempotencyKey,
            terminalStatus: sentTerminal ? 'sent' : 'failed',
            ...(existing.providerMessageId
              ? { providerMessageId: existing.providerMessageId }
              : {}),
          }
        }
        if (existing?.status === MessageLogStatus.DISPATCHING) {
          return {
            messageLogId: existing.id,
            teamId: account.teamId,
            instanceId: input.instanceId,
            contactId: input.contactId,
            phone: contact.phone,
            text: input.text,
            idempotencyKey: input.idempotencyKey,
            deliveryAmbiguous: true,
            ...(existing.providerMessageId
              ? { providerMessageId: existing.providerMessageId }
              : {}),
          }
        }
        if (contact.isValid !== ContactWaStatus.CONFIRMED) {
          throw new WaSingleSendContactNotConfirmedError(input.contactId)
        }
        if (
          account.status !== WaAccountStatus.CONNECTED ||
          !account.ownerWorkerId ||
          account.ownershipEpoch <= 0n
        ) {
          throw new WaSingleSendTargetUnavailableError(input.instanceId)
        }

        const log =
          existing ??
          (await tx.messageLog.create({
            data: {
              instanceId: input.instanceId,
              teamId: account.teamId,
              phone: contact.phone,
              type: 'text',
              message: input.text,
              idempotencyKey: input.idempotencyKey,
            },
          }))

        return {
          messageLogId: log.id,
          teamId: account.teamId,
          instanceId: input.instanceId,
          contactId: input.contactId,
          phone: contact.phone,
          text: input.text,
          idempotencyKey: input.idempotencyKey,
          ownerWorkerId: account.ownerWorkerId,
          ownershipEpoch: account.ownershipEpoch,
          ...(log.status === MessageLogStatus.SENT ? { terminalStatus: 'sent' as const } : {}),
          ...(log.status === MessageLogStatus.FAILED ? { terminalStatus: 'failed' as const } : {}),
          ...(log.providerMessageId ? { providerMessageId: log.providerMessageId } : {}),
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
  }

  async assertOwnerTarget(input: {
    messageLogId: string
    teamId: string
    instanceId: string
    contactId: string
    phone: string
    text: string
    idempotencyKey: string
    expectedOwnerWorkerId: string
    expectedOwnerEpoch: string
  }): Promise<void> {
    const [account, contact, log] = await Promise.all([
      this.prisma.waAccount.findFirst({
        where: {
          instanceId: input.instanceId,
          teamId: input.teamId,
          status: WaAccountStatus.CONNECTED,
          ownerWorkerId: input.expectedOwnerWorkerId,
          ownershipEpoch: BigInt(input.expectedOwnerEpoch),
        },
        select: { id: true },
      }),
      this.prisma.contact.findFirst({
        where: {
          id: input.contactId,
          teamId: input.teamId,
          phone: input.phone,
          isValid: ContactWaStatus.CONFIRMED,
        },
        select: { id: true },
      }),
      this.prisma.messageLog.findFirst({
        where: {
          id: input.messageLogId,
          teamId: input.teamId,
          instanceId: input.instanceId,
          phone: input.phone,
          message: input.text,
          type: 'text',
          idempotencyKey: input.idempotencyKey,
          status: MessageLogStatus.QUEUED,
        },
        select: { id: true },
      }),
    ])
    if (!account || !contact || !log) throw new WaSingleSendTargetStaleError(input.messageLogId)
  }

  async markSent(messageLogId: string, providerMessageId: string): Promise<void> {
    const updated = await this.prisma.messageLog.updateMany({
      where: { id: messageLogId, status: MessageLogStatus.DISPATCHING },
      data: { status: MessageLogStatus.SENT, providerMessageId },
    })
    if (updated.count === 1) return

    const current = await this.prisma.messageLog.findUnique({
      where: { id: messageLogId },
      select: { status: true, providerMessageId: true },
    })
    if (
      current?.status !== MessageLogStatus.SENT ||
      current.providerMessageId !== providerMessageId
    ) {
      throw new WaSingleSendTargetStaleError(messageLogId)
    }
  }

  async claimDispatch(messageLogId: string): Promise<boolean> {
    const claimed = await this.prisma.messageLog.updateMany({
      where: {
        id: messageLogId,
        status: MessageLogStatus.QUEUED,
        dispatchAttemptedAt: null,
      },
      data: {
        status: MessageLogStatus.DISPATCHING,
        dispatchAttemptedAt: new Date(),
      },
    })
    if (claimed.count === 1) return true

    const current = await this.prisma.messageLog.findUnique({
      where: { id: messageLogId },
      select: { status: true, dispatchAttemptedAt: true },
    })
    if (current?.status === MessageLogStatus.DISPATCHING) return false
    throw new WaSingleSendTargetStaleError(messageLogId)
  }

  async markFailed(messageLogId: string): Promise<void> {
    await this.prisma.messageLog.updateMany({
      where: {
        id: messageLogId,
        status: MessageLogStatus.QUEUED,
        dispatchAttemptedAt: null,
      },
      data: { status: MessageLogStatus.FAILED, errorType: MessageErrorType.SEND_ERROR },
    })
  }

  async markRequestFailed(input: {
    instanceId: string
    contactId: string
    text: string
    idempotencyKey: string
  }): Promise<void> {
    const [account, contact] = await Promise.all([
      this.prisma.waAccount.findUnique({
        where: { instanceId: input.instanceId },
        select: { teamId: true },
      }),
      this.prisma.contact.findUnique({
        where: { id: input.contactId },
        select: { teamId: true, phone: true },
      }),
    ])
    if (!account || !contact || account.teamId !== contact.teamId) return
    await this.prisma.messageLog.updateMany({
      where: {
        teamId: account.teamId,
        idempotencyKey: input.idempotencyKey,
        instanceId: input.instanceId,
        phone: contact.phone,
        message: input.text,
        type: 'text',
        status: MessageLogStatus.QUEUED,
        dispatchAttemptedAt: null,
      },
      data: { status: MessageLogStatus.FAILED, errorType: MessageErrorType.SEND_ERROR },
    })
  }
}

function isSentTerminalStatus(status: MessageLogStatus): boolean {
  return (
    status === MessageLogStatus.SENT ||
    status === MessageLogStatus.DELIVERED ||
    status === MessageLogStatus.READ
  )
}

function isTerminalOrAmbiguousStatus(status: MessageLogStatus): boolean {
  return (
    isSentTerminalStatus(status) ||
    status === MessageLogStatus.FAILED ||
    status === MessageLogStatus.DISPATCHING
  )
}
