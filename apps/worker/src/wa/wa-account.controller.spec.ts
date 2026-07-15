import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { WaAccountStatus, WaLoginType, type WaAccount } from '@smartmessage/db'
import {
  InMemoryWaQrBootstrapRepository,
  createWaQrPendingEvent,
  type WaQrBootstrapRepository,
} from '@smartmessage/wa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PrismaWaAccountAdminService,
  WaAccountAdminDuplicateInstanceError,
  WaAccountAdminInvalidInputError,
  WaAccountAdminTeamNotFoundError,
} from './prisma-wa-account-admin.service'
import {
  WaAccountCommandBlockedError,
  WaAccountCommandTargetNotFoundError,
} from './prisma-wa-account-command.guard'
import { WaAccountController } from './wa-account.controller'
import { WaLifecycleCommandQueueService } from './wa-lifecycle-command-queue.service'
import { InternalWorkerApiGuard } from './internal-worker-api.guard'
import { WA_QR_BOOTSTRAP_REPOSITORY } from './wa.tokens'

const originalToken = process.env.WORKER_INTERNAL_API_TOKEN

describe('WaAccountController', () => {
  let adminService: AdminServiceMock
  let commandQueue: CommandQueueMock
  let qrBootstrapRepository: WaQrBootstrapRepository
  let controller: WaAccountController

  beforeEach(() => {
    adminService = createAdminServiceMock()
    commandQueue = createCommandQueueMock()
    qrBootstrapRepository = new InMemoryWaQrBootstrapRepository()
    controller = new WaAccountController(
      adminService as unknown as PrismaWaAccountAdminService,
      commandQueue as unknown as WaLifecycleCommandQueueService,
      qrBootstrapRepository,
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
    adminService.createAccount.mockResolvedValueOnce(
      createWaAccount({ teamId: 'team-1', instanceId: 'instance-1' }),
    )

    await expect(
      controller.createAccount({ teamId: ' team-1 ', instanceId: ' instance-1 ' }),
    ).resolves.toMatchObject({
      teamId: 'team-1',
      instanceId: 'instance-1',
      loginType: WaLoginType.BAILEYS,
      status: WaAccountStatus.DISCONNECTED,
    })
    expect(adminService.createAccount).toHaveBeenCalledWith({
      teamId: 'team-1',
      instanceId: 'instance-1',
    })
  })

  it('maps duplicate instanceId to 409', async () => {
    adminService.createAccount.mockRejectedValueOnce(
      new WaAccountAdminDuplicateInstanceError('instance-1'),
    )

    await expect(
      controller.createAccount({ teamId: 'team-1', instanceId: 'instance-1' }),
    ).rejects.toMatchObject({
      status: 409,
    })
  })

  it('maps missing team to 404', async () => {
    adminService.createAccount.mockRejectedValueOnce(
      new WaAccountAdminTeamNotFoundError('missing-team'),
    )

    await expect(
      controller.createAccount({ teamId: 'missing-team', instanceId: 'instance-1' }),
    ).rejects.toMatchObject({
      status: 404,
    })
  })

  it('rejects invalid create body before calling the service', async () => {
    await expect(
      controller.createAccount({ teamId: 'team-1', instanceId: '   ' }),
    ).rejects.toMatchObject({
      status: 400,
    })
    expect(adminService.createAccount).not.toHaveBeenCalled()
  })

  it('maps admin invalid input to 400', async () => {
    adminService.createAccount.mockRejectedValueOnce(
      new WaAccountAdminInvalidInputError('instanceId must be a non-empty string'),
    )

    await expect(
      controller.createAccount({ teamId: 'team-1', instanceId: 'instance-1' }),
    ).rejects.toMatchObject({
      status: 400,
    })
  })

  it('returns an existing WaAccount and maps missing account to 404', async () => {
    adminService.getAccount.mockResolvedValueOnce(
      createWaAccount({ teamId: 'team-1', instanceId: 'instance-1' }),
    )
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
    ['logout', () => controller.logoutAccount(' instance-1 '), 'enqueueLogout'],
    ['renew', () => controller.renewAccount(' instance-1 '), 'enqueueRenew'],
  ] as const)('queues %s lifecycle command', async (command, call, methodName) => {
    await expect(call()).resolves.toEqual({ instanceId: 'instance-1', command, queued: true })
    expect(commandQueue[methodName]).toHaveBeenCalledWith('instance-1')
  })

  it('maps an operationally blocked start to conflict without exposing internals', async () => {
    commandQueue.enqueueStart.mockRejectedValueOnce(
      new WaAccountCommandBlockedError('instance-banned', WaAccountStatus.BANNED, null),
    )

    await expect(controller.startAccount('instance-banned')).rejects.toMatchObject({
      status: 409,
      message: 'WA account start is blocked by operational status BANNED: instance-banned',
    })
  })

  it('rejects invalid instanceId before calling command queue service', async () => {
    await expect(controller.startAccount('   ')).rejects.toMatchObject({ status: 400 })
    expect(commandQueue.enqueueStart).not.toHaveBeenCalled()
  })

  it('maps missing lifecycle command target to 404', async () => {
    commandQueue.enqueueStart.mockRejectedValueOnce(
      new WaAccountCommandTargetNotFoundError('missing-instance'),
    )

    await expect(controller.startAccount('missing-instance')).rejects.toMatchObject({ status: 404 })
  })

  it('maps missing QR bootstrap account to 404', async () => {
    adminService.getAccount.mockResolvedValueOnce(null)

    await expect(controller.getQrBootstrapState('missing-instance')).rejects.toMatchObject({
      status: 404,
    })
  })

  it('returns account status when QR bootstrap has no QR yet', async () => {
    adminService.getAccount.mockResolvedValueOnce(
      createWaAccount({
        teamId: 'team-1',
        instanceId: 'instance-no-qr',
        status: WaAccountStatus.CONNECTING,
      }),
    )

    await expect(controller.getQrBootstrapState(' instance-no-qr ')).resolves.toEqual({
      instanceId: 'instance-no-qr',
      status: 'connecting',
    })
  })

  it('returns QR pending bootstrap state with expiry', async () => {
    adminService.getAccount.mockResolvedValueOnce(
      createWaAccount({
        teamId: 'team-1',
        instanceId: 'instance-qr',
        status: WaAccountStatus.CONNECTING,
      }),
    )
    await qrBootstrapRepository.activateOwnership('instance-qr', 'worker-test', 1n)
    await qrBootstrapRepository.store(
      createWaQrPendingEvent({
        instanceId: 'instance-qr',
        qrCode: 'qr-payload',
        createdAt: new Date('2026-07-03T10:00:00.000Z'),
        expiresAt: new Date('2999-07-03T10:01:00.000Z'),
      }),
      'worker-test',
      1n,
    )

    await expect(controller.getQrBootstrapState('instance-qr')).resolves.toEqual({
      instanceId: 'instance-qr',
      status: 'qr_pending',
      qrCode: 'qr-payload',
      expiresAt: '2999-07-03T10:01:00.000Z',
    })
  })

  it('falls back to account status when the latest QR bootstrap event is expired', async () => {
    adminService.getAccount.mockResolvedValueOnce(
      createWaAccount({
        teamId: 'team-1',
        instanceId: 'instance-expired-qr',
        status: WaAccountStatus.CONNECTING,
      }),
    )
    await qrBootstrapRepository.activateOwnership('instance-expired-qr', 'worker-test', 1n)
    await qrBootstrapRepository.store(
      createWaQrPendingEvent({
        instanceId: 'instance-expired-qr',
        qrCode: 'expired-qr-payload',
        createdAt: new Date('2026-07-03T10:00:00.000Z'),
        expiresAt: new Date('2026-07-03T10:01:00.000Z'),
      }),
      'worker-test',
      1n,
    )

    await expect(controller.getQrBootstrapState('instance-expired-qr')).resolves.toEqual({
      instanceId: 'instance-expired-qr',
      status: 'connecting',
    })
  })

  it('rejects protected routes without token through Nest HTTP pipeline', async () => {
    process.env.WORKER_INTERNAL_API_TOKEN = 'worker-token'
    const app = await createHttpApp(adminService, commandQueue, qrBootstrapRepository)

    try {
      await app.listen(0)
      const response = await fetch(`${await app.getUrl()}/internal/wa/accounts/instance-qr/qr`)

      expect(response.status).toBe(401)
      expect(adminService.listAccounts).not.toHaveBeenCalled()
      expect(adminService.getAccount).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('serves QR bootstrap state through Nest HTTP pipeline with a valid token', async () => {
    process.env.WORKER_INTERNAL_API_TOKEN = 'worker-token'
    adminService.getAccount.mockResolvedValueOnce(
      createWaAccount({
        teamId: 'team-1',
        instanceId: 'instance-qr',
        status: WaAccountStatus.CONNECTING,
      }),
    )
    await qrBootstrapRepository.activateOwnership('instance-qr', 'worker-test', 1n)
    await qrBootstrapRepository.store(
      createWaQrPendingEvent({
        instanceId: 'instance-qr',
        qrCode: 'qr-payload',
        createdAt: new Date('2026-07-03T10:00:00.000Z'),
        expiresAt: new Date('2999-07-03T10:01:00.000Z'),
      }),
      'worker-test',
      1n,
    )
    const app = await createHttpApp(adminService, commandQueue, qrBootstrapRepository)

    try {
      await app.listen(0)
      const response = await fetch(`${await app.getUrl()}/internal/wa/accounts/instance-qr/qr`, {
        headers: { 'x-internal-worker-token': 'worker-token' },
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        instanceId: 'instance-qr',
        status: 'qr_pending',
        qrCode: 'qr-payload',
        expiresAt: '2999-07-03T10:01:00.000Z',
      })
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
    enqueueLogout: vi.fn(async () => ({ id: 'logout-job' })),
    enqueueRenew: vi.fn(async () => ({ id: 'renew-job' })),
  }
}

async function createHttpApp(
  adminService: AdminServiceMock,
  commandQueue: CommandQueueMock,
  qrBootstrapRepository: WaQrBootstrapRepository,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [WaAccountController],
    providers: [
      InternalWorkerApiGuard,
      { provide: PrismaWaAccountAdminService, useValue: adminService },
      { provide: WaLifecycleCommandQueueService, useValue: commandQueue },
      { provide: WA_QR_BOOTSTRAP_REPOSITORY, useValue: qrBootstrapRepository },
    ],
  }).compile()

  const app = moduleRef.createNestApplication()
  await app.init()
  return app
}

function createWaAccount(input: {
  teamId: string
  instanceId: string
  status?: WaAccountStatus
}): WaAccount {
  const now = new Date('2026-07-03T00:00:00.000Z')

  return {
    id: `${input.instanceId}-id`,
    teamId: input.teamId,
    instanceId: input.instanceId,
    loginType: WaLoginType.BAILEYS,
    status: input.status ?? WaAccountStatus.DISCONNECTED,
    pid: null,
    restrictedUntil: null,
    createdAt: now,
    updatedAt: now,
  }
}

interface AdminServiceMock {
  createAccount: ReturnType<
    typeof vi.fn<(input: { teamId: string; instanceId: string }) => Promise<WaAccount>>
  >
  getAccount: ReturnType<typeof vi.fn<(instanceId: string) => Promise<WaAccount | null>>>
  listAccounts: ReturnType<typeof vi.fn<(teamId: string) => Promise<WaAccount[]>>>
}

interface CommandQueueMock {
  enqueueStart: ReturnType<typeof vi.fn<(instanceId: string) => Promise<unknown>>>
  enqueueStop: ReturnType<typeof vi.fn<(instanceId: string) => Promise<unknown>>>
  enqueueLogout: ReturnType<typeof vi.fn<(instanceId: string) => Promise<unknown>>>
  enqueueRenew: ReturnType<typeof vi.fn<(instanceId: string) => Promise<unknown>>>
}
