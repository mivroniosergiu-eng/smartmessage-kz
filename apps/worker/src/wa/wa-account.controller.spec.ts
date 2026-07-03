import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { WaAccountStatus, WaLoginType, type WaAccount } from '@smartmessage/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PrismaWaAccountAdminService,
  WaAccountAdminDuplicateInstanceError,
  WaAccountAdminInvalidInputError,
  WaAccountAdminTeamNotFoundError,
} from './prisma-wa-account-admin.service'
import { WaAccountCommandTargetNotFoundError } from './prisma-wa-account-command.guard'
import { WaAccountController } from './wa-account.controller'
import { WaLifecycleCommandQueueService } from './wa-lifecycle-command-queue.service'
import { InternalWorkerApiGuard } from './internal-worker-api.guard'

const originalToken = process.env.WORKER_INTERNAL_API_TOKEN

describe('WaAccountController', () => {
  let adminService: AdminServiceMock
  let commandQueue: CommandQueueMock
  let controller: WaAccountController

  beforeEach(() => {
    adminService = createAdminServiceMock()
    commandQueue = createCommandQueueMock()
    controller = new WaAccountController(
      adminService as unknown as PrismaWaAccountAdminService,
      commandQueue as unknown as WaLifecycleCommandQueueService,
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalToken === undefined) {
      delete process.env.WORKER_INTERNAL_API_TOKEN
    } else {
      process.env.WORKER_INTERNAL_API_TOKEN = originalToken
    }
  })

  it('creates a WaAccount and returns a minimal DTO', async () => {
    adminService.createAccount.mockResolvedValueOnce(createWaAccount({ teamId: 'team-1', instanceId: 'instance-1' }))

    await expect(controller.createAccount({ teamId: ' team-1 ', instanceId: ' instance-1 ' })).resolves.toMatchObject({
      teamId: 'team-1',
      instanceId: 'instance-1',
      loginType: WaLoginType.BAILEYS,
      status: WaAccountStatus.DISCONNECTED,
    })
    expect(adminService.createAccount).toHaveBeenCalledWith({ teamId: 'team-1', instanceId: 'instance-1' })
  })

  it('maps duplicate instanceId to 409', async () => {
    adminService.createAccount.mockRejectedValueOnce(new WaAccountAdminDuplicateInstanceError('instance-1'))

    await expect(controller.createAccount({ teamId: 'team-1', instanceId: 'instance-1' })).rejects.toMatchObject({
      status: 409,
    })
  })

  it('maps missing team to 404', async () => {
    adminService.createAccount.mockRejectedValueOnce(new WaAccountAdminTeamNotFoundError('missing-team'))

    await expect(controller.createAccount({ teamId: 'missing-team', instanceId: 'instance-1' })).rejects.toMatchObject({
      status: 404,
    })
  })

  it('rejects invalid create body before calling the service', async () => {
    await expect(controller.createAccount({ teamId: 'team-1', instanceId: '   ' })).rejects.toMatchObject({
      status: 400,
    })
    expect(adminService.createAccount).not.toHaveBeenCalled()
  })

  it('maps admin invalid input to 400', async () => {
    adminService.createAccount.mockRejectedValueOnce(
      new WaAccountAdminInvalidInputError('instanceId must be a non-empty string'),
    )

    await expect(controller.createAccount({ teamId: 'team-1', instanceId: 'instance-1' })).rejects.toMatchObject({
      status: 400,
    })
  })

  it('returns an existing WaAccount and maps missing account to 404', async () => {
    adminService.getAccount.mockResolvedValueOnce(createWaAccount({ teamId: 'team-1', instanceId: 'instance-1' }))
    adminService.getAccount.mockResolvedValueOnce(null)

    await expect(controller.getAccount(' instance-1 ')).resolves.toMatchObject({
      teamId: 'team-1',
      instanceId: 'instance-1',
    })
    await expect(controller.getAccount('missing-instance')).rejects.toMatchObject({ status: 404 })
    expect(adminService.getAccount).toHaveBeenCalledWith('instance-1')
    expect(adminService.getAccount).toHaveBeenCalledWith('missing-instance')
  })

  it('lists accounts filtered by teamId', async () => {
    adminService.listAccounts.mockResolvedValueOnce([
      createWaAccount({ teamId: 'team-1', instanceId: 'instance-a' }),
      createWaAccount({ teamId: 'team-1', instanceId: 'instance-b' }),
    ])

    await expect(controller.listAccounts(' team-1 ')).resolves.toEqual([
      expect.objectContaining({ teamId: 'team-1', instanceId: 'instance-a' }),
      expect.objectContaining({ teamId: 'team-1', instanceId: 'instance-b' }),
    ])
    expect(adminService.listAccounts).toHaveBeenCalledWith('team-1')
  })

  it.each([
    ['start', () => controller.startAccount(' instance-1 '), 'enqueueStart'],
    ['stop', () => controller.stopAccount(' instance-1 '), 'enqueueStop'],
    ['renew', () => controller.renewAccount(' instance-1 '), 'enqueueRenew'],
  ] as const)('queues %s lifecycle command', async (command, call, methodName) => {
    await expect(call()).resolves.toEqual({ instanceId: 'instance-1', command, queued: true })
    expect(commandQueue[methodName]).toHaveBeenCalledWith('instance-1')
  })

  it('rejects invalid instanceId before calling command queue service', async () => {
    await expect(controller.startAccount('   ')).rejects.toMatchObject({ status: 400 })
    expect(commandQueue.enqueueStart).not.toHaveBeenCalled()
  })

  it('maps missing lifecycle command target to 404', async () => {
    commandQueue.enqueueStart.mockRejectedValueOnce(new WaAccountCommandTargetNotFoundError('missing-instance'))

    await expect(controller.startAccount('missing-instance')).rejects.toMatchObject({ status: 404 })
  })

  it('rejects protected routes without token through Nest HTTP pipeline', async () => {
    process.env.WORKER_INTERNAL_API_TOKEN = 'worker-token'
    const app = await createHttpApp(adminService, commandQueue)

    try {
      await app.listen(0)
      const response = await fetch(`${await app.getUrl()}/internal/wa/accounts?teamId=team-1`)

      expect(response.status).toBe(401)
      expect(adminService.listAccounts).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})

function createAdminServiceMock(): AdminServiceMock {
  return {
    createAccount: vi.fn(),
    getAccount: vi.fn(),
    listAccounts: vi.fn(),
  }
}

function createCommandQueueMock(): CommandQueueMock {
  return {
    enqueueStart: vi.fn(async () => ({ id: 'start-job' })),
    enqueueStop: vi.fn(async () => ({ id: 'stop-job' })),
    enqueueRenew: vi.fn(async () => ({ id: 'renew-job' })),
  }
}

async function createHttpApp(adminService: AdminServiceMock, commandQueue: CommandQueueMock): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [WaAccountController],
    providers: [
      InternalWorkerApiGuard,
      { provide: PrismaWaAccountAdminService, useValue: adminService },
      { provide: WaLifecycleCommandQueueService, useValue: commandQueue },
    ],
  }).compile()

  const app = moduleRef.createNestApplication()
  await app.init()
  return app
}

function createWaAccount(input: { teamId: string; instanceId: string }): WaAccount {
  const now = new Date('2026-07-03T00:00:00.000Z')

  return {
    id: `${input.instanceId}-id`,
    teamId: input.teamId,
    instanceId: input.instanceId,
    loginType: WaLoginType.BAILEYS,
    status: WaAccountStatus.DISCONNECTED,
    pid: null,
    restrictedUntil: null,
    createdAt: now,
    updatedAt: now,
  }
}

interface AdminServiceMock {
  createAccount: ReturnType<typeof vi.fn<(input: { teamId: string; instanceId: string }) => Promise<WaAccount>>>
  getAccount: ReturnType<typeof vi.fn<(instanceId: string) => Promise<WaAccount | null>>>
  listAccounts: ReturnType<typeof vi.fn<(teamId: string) => Promise<WaAccount[]>>>
}

interface CommandQueueMock {
  enqueueStart: ReturnType<typeof vi.fn<(instanceId: string) => Promise<unknown>>>
  enqueueStop: ReturnType<typeof vi.fn<(instanceId: string) => Promise<unknown>>>
  enqueueRenew: ReturnType<typeof vi.fn<(instanceId: string) => Promise<unknown>>>
}
