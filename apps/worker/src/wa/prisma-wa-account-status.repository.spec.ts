import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { PrismaClient, WaAccountStatus } from '@smartmessage/db'

import {
  PrismaWaAccountStatusRepository,
  WaAccountStatusNotFoundError,
} from './prisma-wa-account-status.repository'

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
  ] as const)(
    '%s updates the expected WaAccount status',
    async (method, expectedStatus, expectedPid) => {
      await createWaAccount('adapter-instance-main')
      await repository.activateOwnership('adapter-instance-main', 'worker-a', 1n)

      const updated =
        method === 'markDisconnected'
          ? await repository.markDisconnected(
              'adapter-instance-main',
              'worker-a',
              'connection_closed',
              1n,
            )
          : method === 'markBanned'
            ? await repository.markBanned('adapter-instance-main', 'worker-a', 'permanent_ban', 1n)
            : await repository[method]('adapter-instance-main', 'worker-a', 1n)

      expect(updated).toBe(true)

      await expect(
        prisma.waAccount.findUniqueOrThrow({ where: { instanceId: 'adapter-instance-main' } }),
      ).resolves.toMatchObject({
        status: expectedStatus,
        pid: expectedPid,
        restrictedUntil: null,
      })
    },
  )

  it('markRestricted writes RESTRICTED with restrictedUntil and clears active pid', async () => {
    const restrictedUntil = new Date('2026-07-02T12:00:00.000Z')
    await createWaAccount('adapter-instance-restricted')
    await repository.activateOwnership('adapter-instance-restricted', 'worker-a', 1n)

    await repository.markRestricted('adapter-instance-restricted', 'worker-a', restrictedUntil, 1n)

    await expect(
      prisma.waAccount.findUniqueOrThrow({ where: { instanceId: 'adapter-instance-restricted' } }),
    ).resolves.toMatchObject({
      status: WaAccountStatus.RESTRICTED,
      pid: null,
      restrictedUntil,
    })
  })

  it('throws an explicit error for a missing instanceId and does not create WaAccount silently', async () => {
    await expect(
      repository.markConnected('missing-adapter-instance', 'worker-a', 1n),
    ).rejects.toBeInstanceOf(WaAccountStatusNotFoundError)

    await expect(
      prisma.waAccount.findMany({ where: { instanceId: 'missing-adapter-instance' } }),
    ).resolves.toHaveLength(0)
  })

  it('updates only the WaAccount matched by unique instanceId', async () => {
    await createWaAccount('adapter-instance-target')
    await createWaAccount('adapter-instance-other', otherTeamId)
    await repository.activateOwnership('adapter-instance-target', 'worker-a', 1n)

    await repository.markConnected('adapter-instance-target', 'worker-a', 1n)

    await expect(
      prisma.waAccount.findUniqueOrThrow({ where: { instanceId: 'adapter-instance-target' } }),
    ).resolves.toMatchObject({
      teamId,
      status: WaAccountStatus.CONNECTED,
      pid: 42,
    })
    await expect(
      prisma.waAccount.findUniqueOrThrow({ where: { instanceId: 'adapter-instance-other' } }),
    ).resolves.toMatchObject({
      teamId: otherTeamId,
      status: WaAccountStatus.DISCONNECTED,
      pid: null,
    })
  })

  it('rejects stale epochs and a reset Redis counter without overwriting the newer owner', async () => {
    await createWaAccount('adapter-instance-fenced')
    await expect(
      repository.activateOwnership('adapter-instance-fenced', 'worker-new', 9n),
    ).resolves.toBe(true)
    await expect(repository.getOwnershipEpoch('adapter-instance-fenced')).resolves.toBe(9n)
    await repository.markConnecting('adapter-instance-fenced', 'worker-new', 9n)

    await expect(
      repository.activateOwnership('adapter-instance-fenced', 'worker-reset', 1n),
    ).resolves.toBe(false)
    await expect(
      repository.markConnected('adapter-instance-fenced', 'worker-reset', 1n),
    ).resolves.toBe(false)
    await expect(
      prisma.waAccount.findUniqueOrThrow({ where: { instanceId: 'adapter-instance-fenced' } }),
    ).resolves.toMatchObject({
      ownerWorkerId: 'worker-new',
      ownershipEpoch: 9n,
      status: WaAccountStatus.CONNECTING,
    })
  })

  it('blocks ownership activation for banned and future-restricted accounts before connect', async () => {
    const restrictedUntil = new Date('2999-01-01T00:00:00.000Z')
    await createWaAccount('adapter-instance-banned')
    await createWaAccount('adapter-instance-restricted-future')
    await prisma.waAccount.update({
      where: { instanceId: 'adapter-instance-banned' },
      data: { status: WaAccountStatus.BANNED },
    })
    await prisma.waAccount.update({
      where: { instanceId: 'adapter-instance-restricted-future' },
      data: { status: WaAccountStatus.RESTRICTED, restrictedUntil },
    })

    await expect(
      repository.activateOwnership('adapter-instance-banned', 'worker-a', 1n),
    ).resolves.toBe(false)
    await expect(
      repository.activateOwnership('adapter-instance-restricted-future', 'worker-a', 1n),
    ).resolves.toBe(false)

    await expect(
      prisma.waAccount.findUniqueOrThrow({ where: { instanceId: 'adapter-instance-banned' } }),
    ).resolves.toMatchObject({ ownerWorkerId: null, ownershipEpoch: 0n })
    await expect(
      prisma.waAccount.findUniqueOrThrow({
        where: { instanceId: 'adapter-instance-restricted-future' },
      }),
    ).resolves.toMatchObject({ ownerWorkerId: null, ownershipEpoch: 0n })
  })

  it('allows ownership activation once restrictedUntil is due', async () => {
    const restrictedUntil = new Date('2000-01-01T00:00:00.000Z')
    await createWaAccount('adapter-instance-restricted-due')
    await prisma.waAccount.update({
      where: { instanceId: 'adapter-instance-restricted-due' },
      data: { status: WaAccountStatus.RESTRICTED, restrictedUntil },
    })

    await expect(
      repository.activateOwnership('adapter-instance-restricted-due', 'worker-a', 1n),
    ).resolves.toBe(true)

    await expect(
      prisma.waAccount.findUniqueOrThrow({
        where: { instanceId: 'adapter-instance-restricted-due' },
      }),
    ).resolves.toMatchObject({
      status: WaAccountStatus.RESTRICTED,
      restrictedUntil,
      ownerWorkerId: 'worker-a',
      ownershipEpoch: 1n,
    })
  })

  it('never shortens a restrictedUntil deadline under out-of-order delivery', async () => {
    const later = new Date('2999-01-02T00:00:00.000Z')
    const earlier = new Date('2999-01-01T00:00:00.000Z')
    await createWaAccount('adapter-instance-restriction-max')
    await repository.activateOwnership('adapter-instance-restriction-max', 'worker-a', 1n)

    await expect(
      repository.markRestricted('adapter-instance-restriction-max', 'worker-a', later, 1n),
    ).resolves.toBe(true)
    await expect(
      repository.markRestricted('adapter-instance-restriction-max', 'worker-a', earlier, 1n),
    ).resolves.toBe(true)

    await expect(
      prisma.waAccount.findUniqueOrThrow({
        where: { instanceId: 'adapter-instance-restriction-max' },
      }),
    ).resolves.toMatchObject({
      status: WaAccountStatus.RESTRICTED,
      restrictedUntil: later,
    })
  })

  it('keeps BANNED monotonic against every non-ban status writer', async () => {
    await createWaAccount('adapter-instance-monotonic-ban')
    await repository.activateOwnership('adapter-instance-monotonic-ban', 'worker-a', 1n)
    await repository.markBanned('adapter-instance-monotonic-ban', 'worker-a', 'permanent_ban', 1n)

    await expect(
      repository.markConnecting('adapter-instance-monotonic-ban', 'worker-a', 1n),
    ).resolves.toBe(false)
    await expect(
      repository.markConnected('adapter-instance-monotonic-ban', 'worker-a', 1n),
    ).resolves.toBe(false)
    await expect(
      repository.markDisconnected(
        'adapter-instance-monotonic-ban',
        'worker-a',
        'connection_closed',
        1n,
      ),
    ).resolves.toBe(false)
    await expect(
      repository.markLoggedOut('adapter-instance-monotonic-ban', 'worker-a', 1n),
    ).resolves.toBe(false)
    await expect(
      repository.markRestricted(
        'adapter-instance-monotonic-ban',
        'worker-a',
        new Date('2999-01-01T00:00:00.000Z'),
        1n,
      ),
    ).resolves.toBe(false)
    await expect(
      repository.activateOwnership('adapter-instance-monotonic-ban', 'worker-new', 2n),
    ).resolves.toBe(false)

    await expect(
      prisma.waAccount.findUniqueOrThrow({
        where: { instanceId: 'adapter-instance-monotonic-ban' },
      }),
    ).resolves.toMatchObject({
      status: WaAccountStatus.BANNED,
      pid: null,
      restrictedUntil: null,
      ownerWorkerId: 'worker-a',
      ownershipEpoch: 1n,
    })
  })

  it('creates exactly one sanitized ban AuditLog under concurrent duplicate delivery', async () => {
    await createWaAccount('adapter-instance-ban-audit')
    await repository.activateOwnership('adapter-instance-ban-audit', 'worker-a', 1n)

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.markBanned(
          'adapter-instance-ban-audit',
          'worker-a',
          'Bearer should-not-be-persisted\nstack trace',
          1n,
        ),
      ),
    )

    expect(results).toEqual(Array.from({ length: 8 }, () => true))
    const audits = await prisma.auditLog.findMany({ where: { teamId } })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      action: 'WA_ACCOUNT_BANNED',
      userId: null,
    })
    expect(audits[0]?.details).toContain('adapter-instance-ban-audit')
    expect(audits[0]?.details).not.toContain('Bearer')
    expect(audits[0]?.details).not.toContain('stack trace')
  })

  it('does not audit or mutate a stale fenced ban command', async () => {
    await createWaAccount('adapter-instance-stale-ban')
    await repository.activateOwnership('adapter-instance-stale-ban', 'worker-new', 9n)

    await expect(
      repository.markBanned('adapter-instance-stale-ban', 'worker-old', 'permanent_ban', 8n),
    ).resolves.toBe(false)

    await expect(prisma.auditLog.findMany({ where: { teamId } })).resolves.toHaveLength(0)
    await expect(
      prisma.waAccount.findUniqueOrThrow({ where: { instanceId: 'adapter-instance-stale-ban' } }),
    ).resolves.toMatchObject({
      status: WaAccountStatus.DISCONNECTED,
      ownerWorkerId: 'worker-new',
      ownershipEpoch: 9n,
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
