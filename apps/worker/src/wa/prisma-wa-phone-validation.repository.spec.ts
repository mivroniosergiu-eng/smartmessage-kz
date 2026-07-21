import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { ContactWaStatus, PrismaClient, WaAccountStatus } from '@smartmessage/db'

import {
  PrismaWaPhoneValidationRepository,
  WaPhoneValidationTargetStaleError,
} from './prisma-wa-phone-validation.repository'

const prisma = new PrismaClient()
const teamId = 'wa-phone-validation-repository-team'

describe('PrismaWaPhoneValidationRepository', () => {
  const repository = new PrismaWaPhoneValidationRepository(prisma)

  beforeEach(async () => {
    await cleanup()
    await prisma.team.create({ data: { id: teamId, name: 'Phone validation team' } })
  })

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  it('claims null/error contacts and preserves terminal idempotency', async () => {
    await prisma.contact.create({
      data: { id: 'contact-null', teamId, phone: '+77001234567' },
    })
    await prisma.contact.create({
      data: {
        id: 'contact-error',
        teamId,
        phone: '+77001234568',
        isValid: ContactWaStatus.ERROR,
      },
    })
    await prisma.contact.create({
      data: {
        id: 'contact-terminal',
        teamId,
        phone: '+77001234569',
        isValid: ContactWaStatus.CONFIRMED,
      },
    })

    const claimedNull = await repository.prepare('contact-null', teamId, 'run-null')
    expect(claimedNull).toMatchObject({ phone: '+77001234567', validationRunId: 'run-null' })
    expect(claimedNull).not.toHaveProperty('terminalStatus')
    const claimedError = await repository.prepare('contact-error', teamId, 'run-error')
    expect(claimedError).toMatchObject({ phone: '+77001234568', validationRunId: 'run-error' })
    expect(claimedError).not.toHaveProperty('terminalStatus')
    await expect(
      repository.prepare('contact-terminal', teamId, 'run-terminal'),
    ).resolves.toMatchObject({
      terminalStatus: 'confirmed',
    })
    await expect(
      prisma.contact.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, isValid: true, waValidationRunId: true },
      }),
    ).resolves.toEqual([
      {
        id: 'contact-error',
        isValid: ContactWaStatus.IN_PROGRESS,
        waValidationRunId: 'run-error',
      },
      {
        id: 'contact-null',
        isValid: ContactWaStatus.IN_PROGRESS,
        waValidationRunId: 'run-null',
      },
      {
        id: 'contact-terminal',
        isValid: ContactWaStatus.CONFIRMED,
        waValidationRunId: null,
      },
    ])
  })

  it('selects only connected owned accounts and enforces the exact owner target', async () => {
    await prisma.contact.create({
      data: {
        id: 'contact-owner',
        teamId,
        phone: '+77001234567',
        isValid: ContactWaStatus.IN_PROGRESS,
        waValidationRunId: 'run-1',
      },
    })
    await createAccount('instance-connected', WaAccountStatus.CONNECTED, 'worker-1', 3n)
    await createAccount('instance-disconnected', WaAccountStatus.DISCONNECTED, 'worker-1', 4n)

    await expect(repository.listEligibleAccounts(teamId)).resolves.toEqual([
      { instanceId: 'instance-connected', ownerWorkerId: 'worker-1', ownershipEpoch: 3n },
    ])
    await expect(
      repository.assertOwnerTarget({
        contactId: 'contact-owner',
        teamId,
        validationRunId: 'run-1',
        phone: '+77001234567',
        instanceId: 'instance-connected',
        expectedOwnerWorkerId: 'worker-1',
        expectedOwnerEpoch: '3',
      }),
    ).resolves.toBeUndefined()
    await expect(
      repository.assertOwnerTarget({
        contactId: 'contact-owner',
        teamId,
        validationRunId: 'run-1',
        phone: '+77001234567',
        instanceId: 'instance-connected',
        expectedOwnerWorkerId: 'worker-1',
        expectedOwnerEpoch: '4',
      }),
    ).rejects.toBeInstanceOf(WaPhoneValidationTargetStaleError)
  })

  it('persists terminal results and only marks unfinished work as error', async () => {
    await prisma.contact.createMany({
      data: [
        {
          id: 'contact-complete',
          teamId,
          phone: '+77001234567',
          isValid: ContactWaStatus.IN_PROGRESS,
          waValidationRunId: 'run-complete',
        },
        {
          id: 'contact-failed',
          teamId,
          phone: '+77001234568',
          isValid: ContactWaStatus.IN_PROGRESS,
          waValidationRunId: 'run-failed',
        },
        {
          id: 'contact-terminal',
          teamId,
          phone: '+77001234569',
          isValid: ContactWaStatus.NOT_ON_WHATSAPP,
        },
      ],
    })

    await repository.complete(
      'contact-complete',
      teamId,
      '+77001234567',
      'run-complete',
      'confirmed',
    )
    await repository.markError('contact-failed', teamId, '+77001234568', 'run-failed')
    await repository.markError('contact-terminal', teamId, '+77001234569', 'old-run')

    await expect(
      prisma.contact.findMany({ orderBy: { id: 'asc' }, select: { id: true, isValid: true } }),
    ).resolves.toEqual([
      { id: 'contact-complete', isValid: ContactWaStatus.CONFIRMED },
      { id: 'contact-failed', isValid: ContactWaStatus.ERROR },
      { id: 'contact-terminal', isValid: ContactWaStatus.NOT_ON_WHATSAPP },
    ])
  })

  it('rejects a stale completion after the phone snapshot or validation run changes', async () => {
    await prisma.contact.create({
      data: {
        id: 'contact-snapshot',
        teamId,
        phone: '+77001234567',
        isValid: ContactWaStatus.IN_PROGRESS,
        waValidationRunId: 'run-old',
      },
    })
    await prisma.contact.update({
      where: { id: 'contact-snapshot' },
      data: { phone: '+77001234568', waValidationRunId: 'run-new' },
    })

    await expect(
      repository.complete('contact-snapshot', teamId, '+77001234567', 'run-old', 'confirmed'),
    ).rejects.toBeInstanceOf(WaPhoneValidationTargetStaleError)
    await repository.markError('contact-snapshot', teamId, '+77001234567', 'run-old')

    await expect(
      prisma.contact.findUniqueOrThrow({ where: { id: 'contact-snapshot' } }),
    ).resolves.toMatchObject({
      phone: '+77001234568',
      isValid: ContactWaStatus.IN_PROGRESS,
      waValidationRunId: 'run-new',
    })
  })
})

async function createAccount(
  instanceId: string,
  status: WaAccountStatus,
  ownerWorkerId: string,
  ownershipEpoch: bigint,
): Promise<void> {
  await prisma.waAccount.create({
    data: { instanceId, teamId, status, ownerWorkerId, ownershipEpoch },
  })
}

async function cleanup(): Promise<void> {
  await prisma.contact.deleteMany({ where: { teamId } })
  await prisma.waAccount.deleteMany({ where: { teamId } })
  await prisma.team.deleteMany({ where: { id: teamId } })
}
