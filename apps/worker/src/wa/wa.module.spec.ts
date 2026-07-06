import 'reflect-metadata'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { Test } from '@nestjs/testing'
import { prisma } from '@smartmessage/db'
import {
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  WA_LIFECYCLE_QUEUE_NAME,
} from '@smartmessage/queue'
import { MockSessionManager, WaSessionLifecycleService } from '@smartmessage/wa'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  WA_OWNER_REGISTRY,
  WA_OWNER_TTL_MS,
  WA_LIFECYCLE_QUEUE,
  WA_REDIS_CONNECTION,
  WA_SESSION_LIFECYCLE,
  WA_SESSION_MANAGER,
  WA_STATUS_REPOSITORY,
  WA_QR_BOOTSTRAP_REPOSITORY,
  WA_AUTH_STATE_STORE,
  WA_WORKER_ID,
} from './wa.tokens'
import { WaModule } from './wa.module'
import { WA_LIFECYCLE_WORKER } from './wa.module'
import { InternalWorkerApiGuard } from './internal-worker-api.guard'
import { PrismaWaAccountCommandGuard } from './prisma-wa-account-command.guard'
import { PrismaWaAccountAdminService } from './prisma-wa-account-admin.service'
import { PrismaWaAccountStatusRepository } from './prisma-wa-account-status.repository'
import { PrismaWaQrBootstrapRepository } from './prisma-wa-qr-bootstrap.repository'
import { PrismaWaAuthStateRepository } from './prisma-wa-auth-state.repository'
import { WaAccountController } from './wa-account.controller'
import { WaLifecycleCommandService } from './wa-lifecycle-command.service'
import { WaLifecycleCommandQueueService } from './wa-lifecycle-command-queue.service'
import { WaLifecycleJobProcessor } from './wa-lifecycle-job.processor'
import { WaLifecycleQueueService } from './wa-lifecycle-queue.service'

const queueMock = vi.hoisted(() => {
  const queues: Array<{ close: ReturnType<typeof vi.fn>; add: ReturnType<typeof vi.fn> }> = []
  const workers: Array<{ close: ReturnType<typeof vi.fn> }> = []

  return {
    queues,
    workers,
    createQueue: vi.fn(() => {
      const queue = {
        add: vi.fn(async () => ({ id: 'job-1' })),
        close: vi.fn(async () => undefined),
      }
      queues.push(queue)
      return queue
    }),
    createWorker: vi.fn(() => {
      const worker = { close: vi.fn(async () => undefined) }
      workers.push(worker)
      return worker
    }),
  }
})

vi.mock('@smartmessage/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@smartmessage/queue')>()

  return {
    ...actual,
    createQueue: queueMock.createQueue,
    createWorker: queueMock.createWorker,
  }
})

const originalWaWorkerId = process.env.WA_WORKER_ID
const originalWaOwnerTtlMs = process.env.WA_OWNER_TTL_MS

describe('WaModule', () => {
  const prismaDisconnectSpy = vi.spyOn(prisma, '$disconnect').mockResolvedValue(undefined)

  afterEach(() => {
    restoreEnv()
    prismaDisconnectSpy.mockClear()
    queueMock.createQueue.mockClear()
    queueMock.createWorker.mockClear()
    queueMock.queues.length = 0
    queueMock.workers.length = 0
  })

  it('assembles the WA lifecycle providers through Nest DI', async () => {
    delete process.env.WA_WORKER_ID
    delete process.env.WA_OWNER_TTL_MS

    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(createFakeRedisConnection())
      .compile()

    try {
      expect(moduleRef.get(WA_OWNER_REGISTRY)).toBeDefined()
      expect(moduleRef.get(WA_STATUS_REPOSITORY)).toBeInstanceOf(PrismaWaAccountStatusRepository)
      expect(moduleRef.get(WA_QR_BOOTSTRAP_REPOSITORY)).toBeInstanceOf(
        PrismaWaQrBootstrapRepository,
      )
      expect(moduleRef.get(WA_AUTH_STATE_STORE)).toBeInstanceOf(PrismaWaAuthStateRepository)
      expect(moduleRef.get(WA_SESSION_MANAGER)).toBeInstanceOf(MockSessionManager)
      expect(moduleRef.get(WA_SESSION_LIFECYCLE)).toBeInstanceOf(WaSessionLifecycleService)
      expect(moduleRef.get(WaLifecycleCommandService)).toBeInstanceOf(WaLifecycleCommandService)
      expect(moduleRef.get(WaLifecycleJobProcessor)).toBeInstanceOf(WaLifecycleJobProcessor)
      expect(moduleRef.get(InternalWorkerApiGuard)).toBeInstanceOf(InternalWorkerApiGuard)
      expect(moduleRef.get(PrismaWaAccountCommandGuard)).toBeInstanceOf(PrismaWaAccountCommandGuard)
      expect(moduleRef.get(PrismaWaAccountAdminService)).toBeInstanceOf(PrismaWaAccountAdminService)
      expect(moduleRef.get(WaAccountController)).toBeInstanceOf(WaAccountController)
      expect(moduleRef.get(WaLifecycleQueueService)).toBeInstanceOf(WaLifecycleQueueService)
      expect(moduleRef.get(WaLifecycleCommandQueueService)).toBeInstanceOf(
        WaLifecycleCommandQueueService,
      )
      expect(moduleRef.get(WA_LIFECYCLE_QUEUE)).toBe(queueMock.queues.at(-1))
      expect(moduleRef.get(WA_LIFECYCLE_WORKER)).toBe(queueMock.workers.at(-1))
      expect(moduleRef.get(WA_OWNER_TTL_MS)).toBe(30_000)
    } finally {
      await moduleRef.close()
    }
  })

  it('uses a deterministic process worker id fallback', async () => {
    delete process.env.WA_WORKER_ID

    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(createFakeRedisConnection())
      .compile()

    try {
      expect(moduleRef.get(WA_WORKER_ID)).toBe(`worker-${process.pid}`)
    } finally {
      await moduleRef.close()
    }
  })

  it('fails fast for invalid WA_OWNER_TTL_MS', async () => {
    process.env.WA_OWNER_TTL_MS = '0'

    await expect(
      Test.createTestingModule({ imports: [WaModule] })
        .overrideProvider(WA_REDIS_CONNECTION)
        .useValue(createFakeRedisConnection())
        .compile(),
    ).rejects.toThrow('WA_OWNER_TTL_MS must be a positive safe integer')
  })

  it('starts a BullMQ consumer for WA lifecycle jobs through the job processor', async () => {
    const fakeRedisConnection = createFakeRedisConnection()
    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(fakeRedisConnection)
      .compile()
    const worker = queueMock.workers.at(-1)

    try {
      expect(queueMock.createWorker).toHaveBeenCalledWith(
        WA_LIFECYCLE_QUEUE_NAME,
        expect.any(Function),
        fakeRedisConnection,
      )
      expect(queueMock.createWorker).toHaveBeenCalledTimes(1)

      const workerProcessor = queueMock.createWorker.mock.calls.at(-1)?.[1] as
        ((job: { name: string; data: unknown }) => Promise<unknown>) | undefined
      const jobProcessor = moduleRef.get(WaLifecycleJobProcessor)
      const processSpy = vi
        .spyOn(jobProcessor, 'process')
        .mockResolvedValueOnce({ instanceId: 'instance-1', status: 'connected' })
        .mockResolvedValueOnce({ instanceId: 'instance-1', stopped: true })

      await expect(
        workerProcessor?.({
          name: START_WA_INSTANCE_JOB_NAME,
          data: { instanceId: 'instance-1' },
        }),
      ).resolves.toEqual({ instanceId: 'instance-1', status: 'connected' })
      expect(processSpy).toHaveBeenCalledWith({
        name: START_WA_INSTANCE_JOB_NAME,
        data: { instanceId: 'instance-1' },
      })

      await expect(
        workerProcessor?.({
          name: STOP_WA_INSTANCE_JOB_NAME,
          data: { instanceId: 'instance-1' },
        }),
      ).resolves.toEqual({ instanceId: 'instance-1', stopped: true })
      expect(processSpy).toHaveBeenCalledWith({
        name: STOP_WA_INSTANCE_JOB_NAME,
        data: { instanceId: 'instance-1' },
      })
    } finally {
      await moduleRef.close()
    }

    expect(worker?.close).toHaveBeenCalledTimes(1)
  })

  it('creates one WA lifecycle queue provider and exposes the enqueue service', async () => {
    const fakeRedisConnection = createFakeRedisConnection()
    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(fakeRedisConnection)
      .compile()

    try {
      expect(queueMock.createQueue).toHaveBeenCalledWith(
        WA_LIFECYCLE_QUEUE_NAME,
        fakeRedisConnection,
      )
      expect(queueMock.createQueue).toHaveBeenCalledTimes(1)
      expect(queueMock.createWorker).toHaveBeenCalledTimes(1)

      const service = moduleRef.get(WaLifecycleQueueService)
      await service.enqueueStart(' instance-1 ')

      expect(queueMock.queues.at(-1)?.add).toHaveBeenCalledWith(
        START_WA_INSTANCE_JOB_NAME,
        { instanceId: 'instance-1' },
        expect.objectContaining({ jobId: 'wa-lifecycle.start-wa-instance.instance-1' }),
      )
    } finally {
      await moduleRef.close()
    }
  })

  it('closes the WA lifecycle queue on application shutdown', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(createFakeRedisConnection())
      .compile()
    const queue = queueMock.queues.at(-1)

    await moduleRef.close()

    expect(queue?.close).toHaveBeenCalledTimes(1)
  })

  it('disconnects the shared Prisma client on application shutdown', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(createFakeRedisConnection())
      .compile()

    await moduleRef.close()

    expect(prismaDisconnectSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps the worker wiring on the mock session manager without Baileys or real sockets', async () => {
    const workerPackageJson = JSON.parse(
      await readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as PackageJson
    const moduleSource = await readFile(path.join(process.cwd(), 'src/wa/wa.module.ts'), 'utf8')
    const commandGuardSource = await readFile(
      path.join(process.cwd(), 'src/wa/prisma-wa-account-command.guard.ts'),
      'utf8',
    )
    const commandQueueSource = await readFile(
      path.join(process.cwd(), 'src/wa/wa-lifecycle-command-queue.service.ts'),
      'utf8',
    )
    const adminServiceSource = await readFile(
      path.join(process.cwd(), 'src/wa/prisma-wa-account-admin.service.ts'),
      'utf8',
    )
    const qrRepositorySource = await readFile(
      path.join(process.cwd(), 'src/wa/prisma-wa-qr-bootstrap.repository.ts'),
      'utf8',
    )
    const authStateRepositorySource = await readFile(
      path.join(process.cwd(), 'src/wa/prisma-wa-auth-state.repository.ts'),
      'utf8',
    )
    const accountControllerSource = await readFile(
      path.join(process.cwd(), 'src/wa/wa-account.controller.ts'),
      'utf8',
    )
    const internalGuardSource = await readFile(
      path.join(process.cwd(), 'src/wa/internal-worker-api.guard.ts'),
      'utf8',
    )
    const waSources = [
      moduleSource,
      commandGuardSource,
      commandQueueSource,
      adminServiceSource,
      qrRepositorySource,
      authStateRepositorySource,
      accountControllerSource,
      internalGuardSource,
    ]

    expect(workerPackageJson.dependencies).not.toHaveProperty('@whiskeysockets/baileys')
    for (const source of waSources) {
      expect(source).not.toContain('@whiskeysockets/baileys')
      expect(source).not.toContain('makeWASocket')
      expect(source).not.toContain('useMultiFileAuthState')
      expect(source).not.toContain('auth_info')
      expect(source).not.toContain('wa-sessions')
      expect(source).not.toContain('.session')
    }

    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(createFakeRedisConnection())
      .compile()

    try {
      expect(moduleRef.get(WA_SESSION_MANAGER)).toBeInstanceOf(MockSessionManager)
    } finally {
      await moduleRef.close()
    }
  })
})

function restoreEnv(): void {
  if (originalWaWorkerId === undefined) {
    delete process.env.WA_WORKER_ID
  } else {
    process.env.WA_WORKER_ID = originalWaWorkerId
  }

  if (originalWaOwnerTtlMs === undefined) {
    delete process.env.WA_OWNER_TTL_MS
  } else {
    process.env.WA_OWNER_TTL_MS = originalWaOwnerTtlMs
  }
}

function createFakeRedisConnection(): unknown {
  return {
    eval: async () => [1, 'worker-test'],
    get: async () => null,
    quit: async () => 'OK',
  }
}

interface PackageJson {
  dependencies?: Record<string, string>
}
