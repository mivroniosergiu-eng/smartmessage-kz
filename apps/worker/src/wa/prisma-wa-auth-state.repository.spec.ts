import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { PrismaClient } from '@smartmessage/db'
import type { WaAuthStatePayload } from '@smartmessage/wa'

import {
  PrismaWaAuthStateRepository,
  WaAuthStateAccountNotFoundError,
} from './prisma-wa-auth-state.repository'

const prisma = new PrismaClient()
const teamId = 'wa-auth-state-team'

describe('PrismaWaAuthStateRepository', () => {
  const repository = new PrismaWaAuthStateRepository(prisma)

  beforeEach(async () => {
    await cleanup()
    await prisma.team.create({
      data: { id: teamId, name: 'WA Auth State Team' },
    })
  })

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  it('reads missing auth-state as null and reports has=false', async () => {
    await createWaAccount('auth-state-missing')

    await expect(repository.read('auth-state-missing')).resolves.toBeNull()
    await expect(repository.has('auth-state-missing')).resolves.toBe(false)
  })

  it('writes and reads provider-neutral JSON auth-state for an existing WaAccount', async () => {
    await createWaAccount('auth-state-instance')
    const payload: WaAuthStatePayload = {
      provider: 'future-connector',
      version: 1,
      credentials: {
        opaque: true,
        keys: ['identity', 'pre-key'],
      },
    }

    await repository.write(' auth-state-instance ', payload)

    await expect(repository.has('auth-state-instance')).resolves.toBe(true)
    await expect(repository.read('auth-state-instance')).resolves.toEqual(payload)
  })

  it('updates the same instanceId without creating duplicate auth-state rows', async () => {
    await createWaAccount('auth-state-update')
    await repository.write('auth-state-update', { version: 1, token: 'first' })
    const latest: WaAuthStatePayload = { version: 2, token: 'second' }

    await repository.write('auth-state-update', latest)

    await expect(repository.read('auth-state-update')).resolves.toEqual(latest)
    await expect(
      prisma.waAuthState.findMany({ where: { instanceId: 'auth-state-update' } }),
    ).resolves.toHaveLength(1)
  })

  it('maps missing WaAccount on write to an explicit domain error and does not create an account', async () => {
    await expect(
      repository.write('auth-state-missing-account', { version: 1 }),
    ).rejects.toBeInstanceOf(WaAuthStateAccountNotFoundError)

    await expect(
      prisma.waAccount.findMany({ where: { instanceId: 'auth-state-missing-account' } }),
    ).resolves.toHaveLength(0)
    await expect(
      prisma.waAuthState.findMany({ where: { instanceId: 'auth-state-missing-account' } }),
    ).resolves.toHaveLength(0)
  })

  it('clears auth-state without deleting the WaAccount', async () => {
    await createWaAccount('auth-state-clear')
    await repository.write('auth-state-clear', { version: 1 })

    await repository.clear(' auth-state-clear ')

    await expect(repository.read('auth-state-clear')).resolves.toBeNull()
    await expect(repository.has('auth-state-clear')).resolves.toBe(false)
    await expect(
      prisma.waAccount.findUnique({ where: { instanceId: 'auth-state-clear' } }),
    ).resolves.toMatchObject({ instanceId: 'auth-state-clear' })
  })
})

async function createWaAccount(instanceId: string): Promise<void> {
  await prisma.waAccount.create({
    data: {
      teamId,
      instanceId,
    },
  })
}

async function cleanup(): Promise<void> {
  await prisma.team.deleteMany({ where: { id: teamId } })
}
