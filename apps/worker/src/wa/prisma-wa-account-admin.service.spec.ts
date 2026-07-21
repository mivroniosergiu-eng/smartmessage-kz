import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { Prisma, PrismaClient, WaAccountStatus } from '@smartmessage/db'

import {
  PrismaWaAccountAdminService,
  WaAccountAdminDuplicateInstanceError,
  WaAccountAdminInvalidInputError,
  WaAccountAdminLimitExceededError,
  WaAccountAdminTeamNotFoundError,
} from './prisma-wa-account-admin.service'

const prisma = new PrismaClient()
const teamId = 'wa-account-admin-team'
const otherTeamId = 'wa-account-admin-other-team'

describe('PrismaWaAccountAdminService', () => {
  const service = new PrismaWaAccountAdminService(prisma)

  beforeEach(async () => {
    await cleanup()
    await prisma.team.createMany({
      data: [
        { id: teamId, name: 'WA Account Admin Team' },
        { id: otherTeamId, name: 'WA Account Admin Other Team' },
      ],
    })
    await prisma.permissions.createMany({
      data: [
        { teamId, maxWhatsappAccounts: 10 },
        { teamId: otherTeamId, maxWhatsappAccounts: 10 },
      ],
    })
  })

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  it('creates a WaAccount for an existing team with normalized ids', async () => {
    await expect(
      service.createAccount({
        teamId: ` ${teamId} `,
        instanceId: ' admin-instance-main ',
      }),
    ).resolves.toMatchObject({
      teamId,
      instanceId: 'admin-instance-main',
      status: WaAccountStatus.DISCONNECTED,
      pid: null,
      restrictedUntil: null,
    })

    await expect(prisma.waAccount.findUniqueOrThrow({ where: { instanceId: 'admin-instance-main' } })).resolves.toMatchObject({
      teamId,
      instanceId: 'admin-instance-main',
    })
  })

  it('maps duplicate instanceId to an explicit domain error', async () => {
    await service.createAccount({ teamId, instanceId: 'admin-instance-duplicate' })

    await expect(
      service.createAccount({ teamId: otherTeamId, instanceId: 'admin-instance-duplicate' }),
    ).rejects.toBeInstanceOf(WaAccountAdminDuplicateInstanceError)
  })

  it('maps missing team to an explicit domain error without creating WaAccount', async () => {
    await expect(
      service.createAccount({ teamId: 'missing-wa-admin-team', instanceId: 'admin-instance-missing-team' }),
    ).rejects.toBeInstanceOf(WaAccountAdminTeamNotFoundError)

    await expect(prisma.waAccount.findMany({ where: { instanceId: 'admin-instance-missing-team' } })).resolves.toHaveLength(0)
  })

  it('blocks creation when the team reaches its plan limit', async () => {
    await prisma.permissions.update({ where: { teamId }, data: { maxWhatsappAccounts: 1 } })
    await service.createAccount({ teamId, instanceId: 'admin-instance-limit-existing' })

    await expect(
      service.createAccount({ teamId, instanceId: 'admin-instance-limit-next' }),
    ).rejects.toBeInstanceOf(WaAccountAdminLimitExceededError)
  })

  it('maps a Prisma P2002 race to the same explicit duplicate error', async () => {
    const db = {
      team: { findUnique: vi.fn(async () => ({ id: teamId })) },
      waAccount: {
        findUnique: vi.fn(async () => null),
        count: vi.fn(async () => 0),
        create: vi.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          })
        }),
      },
    }
    const isolatedService = new PrismaWaAccountAdminService(db as unknown as PrismaClient)

    await expect(
      isolatedService.createAccount({ teamId, instanceId: 'admin-instance-race-duplicate' }),
    ).rejects.toBeInstanceOf(WaAccountAdminDuplicateInstanceError)
  })

  it.each([
    ['blank teamId', { teamId: '   ', instanceId: 'admin-instance-invalid-team' }, 'teamId must be a non-empty string'],
    [
      'blank instanceId',
      { teamId, instanceId: '   ' },
      'instanceId must be a non-empty string',
    ],
  ])('rejects %s before querying Prisma', async (_caseName, input, message) => {
    const db = {
      team: { findUnique: vi.fn(async () => ({ id: teamId })) },
      waAccount: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({ teamId, instanceId: 'should-not-create' })),
      },
    }
    const isolatedService = new PrismaWaAccountAdminService(db as unknown as PrismaClient)

    await expect(isolatedService.createAccount(input)).rejects.toThrow(message)
    await expect(isolatedService.createAccount(input)).rejects.toBeInstanceOf(WaAccountAdminInvalidInputError)
    expect(db.team.findUnique).not.toHaveBeenCalled()
    expect(db.waAccount.findUnique).not.toHaveBeenCalled()
    expect(db.waAccount.create).not.toHaveBeenCalled()
  })

  it('returns an existing WaAccount and null for a missing account', async () => {
    await service.createAccount({ teamId, instanceId: 'admin-instance-get' })

    await expect(service.getAccount(' admin-instance-get ')).resolves.toMatchObject({
      teamId,
      instanceId: 'admin-instance-get',
    })
    await expect(service.getAccount('admin-instance-missing')).resolves.toBeNull()
  })

  it('lists only accounts owned by the requested teamId', async () => {
    await service.createAccount({ teamId, instanceId: 'admin-instance-list-a' })
    await service.createAccount({ teamId: otherTeamId, instanceId: 'admin-instance-list-other' })
    await service.createAccount({ teamId, instanceId: 'admin-instance-list-b' })

    await expect(service.listAccounts(` ${teamId} `)).resolves.toEqual([
      expect.objectContaining({ teamId, instanceId: 'admin-instance-list-a' }),
      expect.objectContaining({ teamId, instanceId: 'admin-instance-list-b' }),
    ])
  })

  it('does not manually override lifecycle status during create', async () => {
    const db = {
      team: { findUnique: vi.fn(async () => ({ id: teamId })) },
      waAccount: {
        findUnique: vi.fn(async () => null),
        count: vi.fn(async () => 0),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'created-account',
          ...data,
          status: WaAccountStatus.DISCONNECTED,
        })),
      },
    }
    const isolatedService = new PrismaWaAccountAdminService(db as unknown as PrismaClient)

    await isolatedService.createAccount({ teamId, instanceId: 'admin-instance-default-status' })

    expect(db.waAccount.create).toHaveBeenCalledWith({
      data: {
        teamId,
        instanceId: 'admin-instance-default-status',
      },
    })
  })
})

async function cleanup(): Promise<void> {
  await prisma.team.deleteMany({ where: { id: { in: [teamId, otherTeamId, 'missing-wa-admin-team'] } } })
}
