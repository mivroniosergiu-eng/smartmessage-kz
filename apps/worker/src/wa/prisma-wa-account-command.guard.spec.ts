import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { PrismaClient, WaAccountStatus } from '@smartmessage/db'

import {
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

    await expect(guard.assertCommandableInstance(' command-guard-instance ')).resolves.toEqual({
      instanceId: 'command-guard-instance',
    })
  })

  it('rejects a missing instanceId with an explicit error and does not create WaAccount', async () => {
    await expect(guard.assertCommandableInstance('missing-command-guard-instance')).rejects.toBeInstanceOf(
      WaAccountCommandTargetNotFoundError,
    )

    await expect(
      prisma.waAccount.findMany({ where: { instanceId: 'missing-command-guard-instance' } }),
    ).resolves.toHaveLength(0)
  })

  it('does not mutate WaAccount status while authorizing commands', async () => {
    await createWaAccount('command-guard-status-instance', WaAccountStatus.RESTRICTED)

    await guard.assertCommandableInstance('command-guard-status-instance')

    await expect(
      prisma.waAccount.findUniqueOrThrow({ where: { instanceId: 'command-guard-status-instance' } }),
    ).resolves.toMatchObject({
      status: WaAccountStatus.RESTRICTED,
      pid: null,
    })
  })

  it('rejects invalid blank instanceId before querying Prisma', async () => {
    const db = {
      waAccount: {
        findUnique: vi.fn(async () => ({ instanceId: 'should-not-query' })),
      },
    }
    const isolatedGuard = new PrismaWaAccountCommandGuard(db as unknown as PrismaClient)

    await expect(isolatedGuard.assertCommandableInstance('   ')).rejects.toThrow(
      'start-wa-instance payload.instanceId must be a non-empty string',
    )
    expect(db.waAccount.findUnique).not.toHaveBeenCalled()
  })
})

async function createWaAccount(instanceId: string, status = WaAccountStatus.DISCONNECTED): Promise<void> {
  await prisma.waAccount.create({
    data: {
      teamId,
      instanceId,
      status,
    },
  })
}

async function cleanup(): Promise<void> {
  await prisma.team.deleteMany({ where: { id: teamId } })
}
