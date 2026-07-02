import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { PrismaClient, WaAccountStatus } from '@smartmessage/db'

import { PrismaWaAccountStatusRepository, WaAccountStatusNotFoundError } from './prisma-wa-account-status.repository'

const prisma = new PrismaClient()
const teamId = 'wa-status-adapter-team'
const otherTeamId = 'wa-status-adapter-other-team'

describe('PrismaWaAccountStatusRepository', () => {
  const repository = new PrismaWaAccountStatusRepository(prisma, { processId: 42 })

  beforeEach(async () => {
    await cleanup()
    await prisma.team.createMany({
      data: [
        { id: teamId, name: 'WA Status Adapter Team' },
        { id: otherTeamId, name: 'WA Status Adapter Other Team' },
      ],
    })
  })

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  it.each([
    ['markConnecting', WaAccountStatus.CONNECTING, 42],
    ['markConnected', WaAccountStatus.CONNECTED, 42],
    ['markDisconnected', WaAccountStatus.DISCONNECTED, null],
    ['markLoggedOut', WaAccountStatus.LOGGED_OUT, null],
    ['markBanned', WaAccountStatus.BANNED, null],
  ] as const)('%s updates the expected WaAccount status', async (method, expectedStatus, expectedPid) => {
    await createWaAccount('adapter-instance-main')

    if (method === 'markDisconnected') {
      await repository.markDisconnected('adapter-instance-main', 'worker-a', 'connection_closed')
    } else if (method === 'markBanned') {
      await repository.markBanned('adapter-instance-main', 'worker-a', 'permanent_ban')
    } else {
      await repository[method]('adapter-instance-main', 'worker-a')
    }

    await expect(prisma.waAccount.findUniqueOrThrow({ where: { instanceId: 'adapter-instance-main' } })).resolves.toMatchObject({
      status: expectedStatus,
      pid: expectedPid,
      restrictedUntil: null,
    })
  })

  it('markRestricted writes RESTRICTED with restrictedUntil and clears active pid', async () => {
    const restrictedUntil = new Date('2026-07-02T12:00:00.000Z')
    await createWaAccount('adapter-instance-restricted')

    await repository.markRestricted('adapter-instance-restricted', 'worker-a', restrictedUntil)

    await expect(
      prisma.waAccount.findUniqueOrThrow({ where: { instanceId: 'adapter-instance-restricted' } }),
    ).resolves.toMatchObject({
      status: WaAccountStatus.RESTRICTED,
      pid: null,
      restrictedUntil,
    })
  })

  it('throws an explicit error for a missing instanceId and does not create WaAccount silently', async () => {
    await expect(repository.markConnected('missing-adapter-instance', 'worker-a')).rejects.toBeInstanceOf(
      WaAccountStatusNotFoundError,
    )

    await expect(prisma.waAccount.findMany({ where: { instanceId: 'missing-adapter-instance' } })).resolves.toHaveLength(0)
  })

  it('updates only the WaAccount matched by unique instanceId', async () => {
    await createWaAccount('adapter-instance-target')
    await createWaAccount('adapter-instance-other', otherTeamId)

    await repository.markConnected('adapter-instance-target', 'worker-a')

    await expect(prisma.waAccount.findUniqueOrThrow({ where: { instanceId: 'adapter-instance-target' } })).resolves.toMatchObject({
      teamId,
      status: WaAccountStatus.CONNECTED,
      pid: 42,
    })
    await expect(prisma.waAccount.findUniqueOrThrow({ where: { instanceId: 'adapter-instance-other' } })).resolves.toMatchObject({
      teamId: otherTeamId,
      status: WaAccountStatus.DISCONNECTED,
      pid: null,
    })
  })
})

async function createWaAccount(instanceId: string, ownerTeamId = teamId): Promise<void> {
  await prisma.waAccount.create({
    data: {
      teamId: ownerTeamId,
      instanceId,
    },
  })
}

async function cleanup(): Promise<void> {
  await prisma.team.deleteMany({ where: { id: { in: [teamId, otherTeamId] } } })
}
