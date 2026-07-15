import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { PrismaClient, WaAccountStatus } from '@smartmessage/db'
import {
  LOGOUT_WA_INSTANCE_JOB_NAME,
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  type WaLifecycleJobName,
} from '@smartmessage/queue'

import {
  WaAccountCommandBlockedError,
  PrismaWaAccountCommandGuard,
  WaAccountCommandTargetNotFoundError,
} from './prisma-wa-account-command.guard'

const prisma = new PrismaClient()
const teamId = 'wa-command-guard-team'

describe('PrismaWaAccountCommandGuard', () => {
  const guard = new PrismaWaAccountCommandGuard(prisma)

  beforeEach(async () => {
    await cleanup()
    await prisma.team.create({ data: { id: teamId, name: 'WA Command Guard Team' } })
  })

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  it('accepts an existing WaAccount.instanceId and returns the normalized target', async () => {
    await createWaAccount('command-guard-instance')

    await expect(
      guard.assertCommandableInstance(' command-guard-instance ', START_WA_INSTANCE_JOB_NAME),
    ).resolves.toEqual({
      instanceId: 'command-guard-instance',
    })
  })

  it('rejects a missing instanceId with an explicit error and does not create WaAccount', async () => {
    await expect(
      guard.assertCommandableInstance('missing-command-guard-instance', START_WA_INSTANCE_JOB_NAME),
    ).rejects.toBeInstanceOf(WaAccountCommandTargetNotFoundError)

    await expect(
      prisma.waAccount.findMany({ where: { instanceId: 'missing-command-guard-instance' } }),
    ).resolves.toHaveLength(0)
  })

  it('does not mutate WaAccount status while authorizing commands', async () => {
    await createWaAccount(
      'command-guard-status-instance',
      WaAccountStatus.RESTRICTED,
      new Date('2000-01-01T00:00:00.000Z'),
    )

    await guard.assertCommandableInstance(
      'command-guard-status-instance',
      START_WA_INSTANCE_JOB_NAME,
    )

    await expect(
      prisma.waAccount.findUniqueOrThrow({
        where: { instanceId: 'command-guard-status-instance' },
      }),
    ).resolves.toMatchObject({
      status: WaAccountStatus.RESTRICTED,
      pid: null,
    })
  })

  it('blocks start for a terminal banned account before any lifecycle side effect', async () => {
    await createWaAccount('command-guard-banned', WaAccountStatus.BANNED)

    await expect(
      guard.assertCommandableInstance('command-guard-banned', START_WA_INSTANCE_JOB_NAME),
    ).rejects.toMatchObject({
      name: 'WaAccountCommandBlockedError',
      instanceId: 'command-guard-banned',
      status: WaAccountStatus.BANNED,
      restrictedUntil: null,
    } satisfies Partial<WaAccountCommandBlockedError>)

    await expect(
      prisma.waAccount.findUniqueOrThrow({ where: { instanceId: 'command-guard-banned' } }),
    ).resolves.toMatchObject({
      status: WaAccountStatus.BANNED,
      ownerWorkerId: null,
      ownershipEpoch: 0n,
    })
  })

  it('blocks start while a restriction is still active', async () => {
    const restrictedUntil = new Date('2999-01-01T00:00:00.000Z')
    await createWaAccount(
      'command-guard-future-restricted',
      WaAccountStatus.RESTRICTED,
      restrictedUntil,
    )

    await expect(
      guard.assertCommandableInstance(
        'command-guard-future-restricted',
        START_WA_INSTANCE_JOB_NAME,
      ),
    ).rejects.toMatchObject({
      name: 'WaAccountCommandBlockedError',
      instanceId: 'command-guard-future-restricted',
      status: WaAccountStatus.RESTRICTED,
      restrictedUntil,
    } satisfies Partial<WaAccountCommandBlockedError>)
  })

  it('fails closed when a restricted account has no recovery deadline', async () => {
    await createWaAccount('command-guard-restricted-without-deadline', WaAccountStatus.RESTRICTED)

    await expect(
      guard.assertCommandableInstance(
        'command-guard-restricted-without-deadline',
        START_WA_INSTANCE_JOB_NAME,
      ),
    ).rejects.toBeInstanceOf(WaAccountCommandBlockedError)
  })

  it('allows start when restrictedUntil is due without mutating the stored status', async () => {
    const restrictedUntil = new Date('2000-01-01T00:00:00.000Z')
    await createWaAccount(
      'command-guard-due-restricted',
      WaAccountStatus.RESTRICTED,
      restrictedUntil,
    )

    await expect(
      guard.assertCommandableInstance('command-guard-due-restricted', START_WA_INSTANCE_JOB_NAME),
    ).resolves.toEqual({ instanceId: 'command-guard-due-restricted' })

    await expect(
      prisma.waAccount.findUniqueOrThrow({
        where: { instanceId: 'command-guard-due-restricted' },
      }),
    ).resolves.toMatchObject({ status: WaAccountStatus.RESTRICTED, restrictedUntil })
  })

  it.each([
    STOP_WA_INSTANCE_JOB_NAME,
    LOGOUT_WA_INSTANCE_JOB_NAME,
    RENEW_WA_INSTANCE_JOB_NAME,
  ] satisfies WaLifecycleJobName[])('keeps %s available for terminal cleanup', async (jobName) => {
    await createWaAccount('command-guard-terminal-cleanup', WaAccountStatus.BANNED)

    await expect(
      guard.assertCommandableInstance('command-guard-terminal-cleanup', jobName),
    ).resolves.toEqual({ instanceId: 'command-guard-terminal-cleanup' })
  })

  it.each([
    START_WA_INSTANCE_JOB_NAME,
    STOP_WA_INSTANCE_JOB_NAME,
    LOGOUT_WA_INSTANCE_JOB_NAME,
    RENEW_WA_INSTANCE_JOB_NAME,
  ] satisfies WaLifecycleJobName[])(
    'rejects invalid blank instanceId for %s before querying Prisma',
    async (jobName) => {
      const db = {
        waAccount: {
          findUnique: vi.fn(async () => ({ instanceId: 'should-not-query' })),
        },
      }
      const isolatedGuard = new PrismaWaAccountCommandGuard(db as unknown as PrismaClient)

      await expect(isolatedGuard.assertCommandableInstance('   ', jobName)).rejects.toThrow(
        `${jobName} payload.instanceId must be a non-empty string`,
      )
      expect(db.waAccount.findUnique).not.toHaveBeenCalled()
    },
  )
})

async function createWaAccount(
  instanceId: string,
  status = WaAccountStatus.DISCONNECTED,
  restrictedUntil: Date | null = null,
): Promise<void> {
  await prisma.waAccount.create({
    data: {
      teamId,
      instanceId,
      status,
      restrictedUntil,
    },
  })
}

async function cleanup(): Promise<void> {
  await prisma.team.deleteMany({ where: { id: teamId } })
}
