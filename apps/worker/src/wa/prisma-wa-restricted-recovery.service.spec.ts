import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { PrismaClient, WaAccountStatus } from '@smartmessage/db'

import { PrismaWaRestrictedRecoveryService } from './prisma-wa-restricted-recovery.service'

const prisma = new PrismaClient()
const teamId = 'wa-restricted-recovery-team'
const due = '2000-01-01T00:00:00.000Z'
const future = '2999-01-01T00:00:00.000Z'

describe('PrismaWaRestrictedRecoveryService', () => {
  const service = new PrismaWaRestrictedRecoveryService(prisma)

  beforeEach(async () => {
    await cleanup()
    await prisma.team.create({ data: { id: teamId, name: 'WA Restricted Recovery Team' } })
  })

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  it.each([
    ['missing account', undefined, null],
    ['banned account', WaAccountStatus.BANNED, new Date(future)],
    ['non-restricted account', WaAccountStatus.DISCONNECTED, new Date(future)],
    ['restricted account without a deadline', WaAccountStatus.RESTRICTED, null],
  ] as const)('returns stale for %s', async (label, status, restrictedUntil) => {
    if (status !== undefined) {
      await createWaAccount(`recovery-${label.replaceAll(' ', '-')}`, status, restrictedUntil)
    }
    const instanceId =
      status === undefined ? 'recovery-missing-account' : `recovery-${label.replaceAll(' ', '-')}`

    await expect(service.resolve({ instanceId, restrictedUntil: future })).resolves.toEqual({
      kind: 'stale',
    })
  })

  it('reschedules the current exact future deadline when the queued timestamp is stale', async () => {
    await createWaAccount('recovery-extended', WaAccountStatus.RESTRICTED, new Date(future))

    await expect(
      service.resolve({ instanceId: 'recovery-extended', restrictedUntil: due }),
    ).resolves.toEqual({ kind: 'reschedule', restrictedUntil: new Date(future) })
  })

  it('does not recover from a stale timestamp when the current deadline is already due', async () => {
    await createWaAccount(
      'recovery-stale-due',
      WaAccountStatus.RESTRICTED,
      new Date('2001-01-01T00:00:00.000Z'),
    )

    await expect(
      service.resolve({ instanceId: 'recovery-stale-due', restrictedUntil: due }),
    ).resolves.toEqual({ kind: 'stale' })
  })

  it('reschedules an exact recovery job that fires before its deadline', async () => {
    await createWaAccount('recovery-early', WaAccountStatus.RESTRICTED, new Date(future))

    await expect(
      service.resolve({ instanceId: 'recovery-early', restrictedUntil: future }),
    ).resolves.toEqual({ kind: 'reschedule', restrictedUntil: new Date(future) })
  })

  it('authorizes recovery only for the exact due persisted deadline', async () => {
    await createWaAccount('recovery-due', WaAccountStatus.RESTRICTED, new Date(due))

    await expect(
      service.resolve({ instanceId: 'recovery-due', restrictedUntil: due }),
    ).resolves.toEqual({ kind: 'recover' })
  })
})

async function createWaAccount(
  instanceId: string,
  status: WaAccountStatus,
  restrictedUntil: Date | null,
): Promise<void> {
  await prisma.waAccount.create({ data: { teamId, instanceId, status, restrictedUntil } })
}

async function cleanup(): Promise<void> {
  await prisma.team.deleteMany({ where: { id: teamId } })
}
