import { ContactWaStatus, MessageLogStatus, WaAccountStatus } from '@smartmessage/db'
import { describe, expect, it, vi } from 'vitest'

import {
  PrismaWaSingleSendRepository,
  WaSingleSendIdempotencyConflictError,
  WaSingleSendTargetNotFoundError,
  WaSingleSendTargetStaleError,
} from './prisma-wa-single-send.repository'

describe('PrismaWaSingleSendRepository', () => {
  it('derives tenant from account/contact and creates exactly one QUEUED log', async () => {
    const prisma = createPrisma()
    const repository = new PrismaWaSingleSendRepository(prisma as never)

    await expect(repository.prepare(request())).resolves.toMatchObject({
      messageLogId: 'log-1',
      teamId: 'team-1',
      phone: '+77001234567',
      ownerWorkerId: 'worker-1',
      ownershipEpoch: 2n,
    })
    expect(prisma.messageLog.create).toHaveBeenCalledWith({
      data: {
        instanceId: 'instance-1',
        teamId: 'team-1',
        phone: '+77001234567',
        type: 'text',
        message: 'hello',
        idempotencyKey: 'request-1',
      },
    })
  })

  it('returns terminal SENT for the same payload and rejects key reuse with different text', async () => {
    const prisma = createPrisma()
    prisma.messageLog.findUnique.mockResolvedValueOnce(
      log({ status: MessageLogStatus.SENT, providerMessageId: 'wa-1' }),
    )
    const repository = new PrismaWaSingleSendRepository(prisma as never)
    await expect(repository.prepare(request())).resolves.toMatchObject({
      terminalStatus: 'sent',
      providerMessageId: 'wa-1',
    })
    expect(prisma.messageLog.create).not.toHaveBeenCalled()

    prisma.messageLog.findUnique.mockResolvedValueOnce(log({ message: 'different' }))
    await expect(repository.prepare(request())).rejects.toBeInstanceOf(
      WaSingleSendIdempotencyConflictError,
    )
  })

  it('returns terminal SENT while the account is disconnected without a new side effect', async () => {
    const prisma = createPrisma()
    prisma.waAccount.findUnique.mockResolvedValueOnce({
      teamId: 'team-1',
      status: WaAccountStatus.DISCONNECTED,
      ownerWorkerId: null,
      ownershipEpoch: 2n,
    })
    prisma.messageLog.findUnique.mockResolvedValueOnce(
      log({ status: MessageLogStatus.SENT, providerMessageId: 'wa-1' }),
    )
    const repository = new PrismaWaSingleSendRepository(prisma as never)
    await expect(repository.prepare(request())).resolves.toMatchObject({ terminalStatus: 'sent' })
    expect(prisma.messageLog.create).not.toHaveBeenCalled()
  })

  it.each([MessageLogStatus.DELIVERED, MessageLogStatus.READ])(
    'treats post-send status %s as terminal sent without routing again',
    async (status) => {
      const prisma = createPrisma()
      prisma.waAccount.findUnique.mockResolvedValueOnce({
        teamId: 'team-1',
        status: WaAccountStatus.DISCONNECTED,
        ownerWorkerId: null,
        ownershipEpoch: 2n,
      })
      prisma.messageLog.findUnique.mockResolvedValueOnce(log({ status, providerMessageId: 'wa-1' }))
      const repository = new PrismaWaSingleSendRepository(prisma as never)

      await expect(repository.prepare(request())).resolves.toMatchObject({
        terminalStatus: 'sent',
        providerMessageId: 'wa-1',
      })
      expect(prisma.messageLog.create).not.toHaveBeenCalled()
    },
  )

  it('returns an honest ambiguous result after a durable dispatch fence without routing again', async () => {
    const prisma = createPrisma()
    prisma.waAccount.findUnique.mockResolvedValueOnce({
      teamId: 'team-1',
      status: WaAccountStatus.DISCONNECTED,
      ownerWorkerId: null,
      ownershipEpoch: 2n,
    })
    prisma.messageLog.findUnique.mockResolvedValueOnce(
      log({
        status: MessageLogStatus.DISPATCHING,
        dispatchAttemptedAt: new Date('2026-07-22T12:00:00.000Z'),
      }),
    )
    const repository = new PrismaWaSingleSendRepository(prisma as never)

    await expect(repository.prepare(request())).resolves.toMatchObject({
      deliveryAmbiguous: true,
    })
    expect(prisma.messageLog.create).not.toHaveBeenCalled()
  })

  it('rejects cross-tenant account/contact pairs before creating a log', async () => {
    const prisma = createPrisma()
    prisma.contact.findUnique.mockResolvedValueOnce({ teamId: 'team-other', phone: '+77001234567' })
    const repository = new PrismaWaSingleSendRepository(prisma as never)
    await expect(repository.prepare(request())).rejects.toBeInstanceOf(
      WaSingleSendTargetNotFoundError,
    )
    expect(prisma.messageLog.create).not.toHaveBeenCalled()
  })

  it.each([null, ContactWaStatus.ERROR, ContactWaStatus.NOT_ON_WHATSAPP])(
    'rejects a new send while contact validation is %s',
    async (isValid) => {
      const prisma = createPrisma()
      prisma.contact.findUnique.mockResolvedValue({
        teamId: 'team-1',
        phone: '+77001234567',
        isValid,
      })
      const repository = new PrismaWaSingleSendRepository(prisma as never)

      await expect(repository.assertRequestTarget(request())).rejects.toThrow(
        'WA single-send contact is not confirmed',
      )
      await expect(repository.prepare(request())).rejects.toThrow(
        'WA single-send contact is not confirmed',
      )
      expect(prisma.messageLog.create).not.toHaveBeenCalled()
    },
  )

  it('revalidates the confirmed contact at the exact owner boundary', async () => {
    const prisma = createPrisma()
    prisma.contact.findFirst.mockResolvedValueOnce(null)
    const repository = new PrismaWaSingleSendRepository(prisma as never)

    await expect(
      repository.assertOwnerTarget({
        messageLogId: 'log-1',
        teamId: 'team-1',
        instanceId: 'instance-1',
        contactId: 'contact-1',
        phone: '+77001234567',
        text: 'hello',
        idempotencyKey: 'request-1',
        expectedOwnerWorkerId: 'worker-1',
        expectedOwnerEpoch: '2',
      }),
    ).rejects.toBeInstanceOf(WaSingleSendTargetStaleError)
  })

  it('preflights an existing idempotency key without creating a log', async () => {
    const prisma = createPrisma()
    const repository = new PrismaWaSingleSendRepository(prisma as never)

    prisma.messageLog.findUnique.mockResolvedValueOnce(log())
    await expect(repository.assertRequestTarget(request())).resolves.toBeUndefined()

    prisma.messageLog.findUnique.mockResolvedValueOnce(log({ message: 'other' }))
    await expect(repository.assertRequestTarget(request())).rejects.toBeInstanceOf(
      WaSingleSendIdempotencyConflictError,
    )
    expect(prisma.messageLog.create).not.toHaveBeenCalled()
  })

  it('uses exact owner/log snapshot and CAS for SENT completion', async () => {
    const prisma = createPrisma()
    const repository = new PrismaWaSingleSendRepository(prisma as never)
    await expect(
      repository.assertOwnerTarget({
        messageLogId: 'log-1',
        teamId: 'team-1',
        instanceId: 'instance-1',
        contactId: 'contact-1',
        phone: '+77001234567',
        text: 'hello',
        idempotencyKey: 'request-1',
        expectedOwnerWorkerId: 'worker-1',
        expectedOwnerEpoch: '2',
      }),
    ).resolves.toBeUndefined()
    await expect(repository.claimDispatch('log-1')).resolves.toBe(true)
    expect(prisma.messageLog.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'log-1',
        status: MessageLogStatus.QUEUED,
        dispatchAttemptedAt: null,
      },
      data: {
        status: MessageLogStatus.DISPATCHING,
        dispatchAttemptedAt: expect.any(Date),
      },
    })
    await expect(repository.markSent('log-1', 'wa-1')).resolves.toBeUndefined()
    expect(prisma.messageLog.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'log-1', status: MessageLogStatus.DISPATCHING },
      data: { status: MessageLogStatus.SENT, providerMessageId: 'wa-1' },
    })

    prisma.waAccount.findFirst.mockResolvedValueOnce(null)
    await expect(
      repository.assertOwnerTarget({
        messageLogId: 'log-1',
        teamId: 'team-1',
        instanceId: 'instance-1',
        contactId: 'contact-1',
        phone: '+77001234567',
        text: 'hello',
        idempotencyKey: 'request-1',
        expectedOwnerWorkerId: 'worker-1',
        expectedOwnerEpoch: '2',
      }),
    ).rejects.toBeInstanceOf(WaSingleSendTargetStaleError)
  })

  it('reconciles only the exact queued request snapshot to FAILED', async () => {
    const prisma = createPrisma()
    const repository = new PrismaWaSingleSendRepository(prisma as never)
    await repository.markRequestFailed(request())
    expect(prisma.messageLog.updateMany).toHaveBeenCalledWith({
      where: {
        teamId: 'team-1',
        idempotencyKey: 'request-1',
        instanceId: 'instance-1',
        phone: '+77001234567',
        message: 'hello',
        type: 'text',
        status: MessageLogStatus.QUEUED,
        dispatchAttemptedAt: null,
      },
      data: { status: MessageLogStatus.FAILED, errorType: 'SEND_ERROR' },
    })
  })
})

function request() {
  return {
    instanceId: 'instance-1',
    contactId: 'contact-1',
    text: 'hello',
    idempotencyKey: 'request-1',
  }
}
function log(overrides: Record<string, unknown> = {}) {
  return {
    id: 'log-1',
    instanceId: 'instance-1',
    teamId: 'team-1',
    phone: '+77001234567',
    type: 'text',
    message: 'hello',
    idempotencyKey: 'request-1',
    providerMessageId: null,
    dispatchAttemptedAt: null,
    status: MessageLogStatus.QUEUED,
    errorType: null,
    timePost: new Date(),
    ...overrides,
  }
}
function createPrisma() {
  const prisma = {
    waAccount: {
      findUnique: vi.fn(async () => ({
        teamId: 'team-1',
        status: WaAccountStatus.CONNECTED,
        ownerWorkerId: 'worker-1',
        ownershipEpoch: 2n,
      })),
      findFirst: vi.fn(async () => ({ id: 'account-1' })),
    },
    contact: {
      findUnique: vi.fn(async () => ({
        teamId: 'team-1',
        phone: '+77001234567',
        isValid: ContactWaStatus.CONFIRMED,
      })),
      findFirst: vi.fn(async () => ({ id: 'contact-1' })),
    },
    messageLog: {
      findUnique: vi.fn(async () => null as ReturnType<typeof log> | null),
      findFirst: vi.fn(async () => ({ id: 'log-1' })),
      create: vi.fn(async () => log()),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
  }
  return prisma
}
