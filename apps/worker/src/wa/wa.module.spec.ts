import 'reflect-metadata'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'

import { Test } from '@nestjs/testing'
import { prisma } from '@smartmessage/db'
import {
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  WA_LIFECYCLE_QUEUE_NAME,
  WA_PHONE_VALIDATION_QUEUE_NAME,
  WA_SINGLE_SEND_QUEUE_NAME,
  createWaLifecycleOwnerQueueName,
  createWaPhoneValidationOwnerQueueName,
  createWaSingleSendOwnerQueueName,
} from '@smartmessage/queue'
import {
  BaileysSessionManager,
  InMemoryWaAuthStateStore,
  MockSessionManager,
  UnavailableMessageSender,
  UnavailablePhoneValidator,
  WaSessionLifecycleService,
} from '@smartmessage/wa'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  WA_OWNER_REGISTRY,
  WA_OWNER_TTL_MS,
  WA_LIFECYCLE_QUEUE,
  WA_LIFECYCLE_QUEUE_EVENTS_FACTORY,
  WA_LIFECYCLE_QUEUE_FACTORY,
  WA_REDIS_CONNECTION,
  WA_SESSION_LIFECYCLE,
  WA_SESSION_MANAGER,
  WA_SESSION_RUNTIME,
  WA_STATUS_REPOSITORY,
  WA_QR_BOOTSTRAP_REPOSITORY,
  WA_AUTH_STATE_STORE,
  WA_WORKER_ID,
  WA_WORKER_IDENTITY_FATAL_HANDLER,
  WA_WORKER_IDENTITY_LEASE,
  WA_PHONE_VALIDATOR,
  WA_PHONE_VALIDATION_QUEUE,
  WA_PHONE_VALIDATION_QUEUE_EVENTS_FACTORY,
  WA_PHONE_VALIDATION_QUEUE_FACTORY,
  WA_MESSAGE_SENDER,
  WA_SINGLE_SEND_QUEUE,
  WA_SINGLE_SEND_QUEUE_EVENTS_FACTORY,
  WA_SINGLE_SEND_QUEUE_FACTORY,
} from './wa.tokens'
import {
  resolveWaWorkerId,
  resolveWaSessionRuntimeMode,
  WaModule,
  WA_LIFECYCLE_WORKER,
  WA_OWNER_LIFECYCLE_WORKER,
  WA_OWNER_PHONE_VALIDATION_WORKER,
  WA_PHONE_VALIDATION_WORKER,
  WA_SINGLE_SEND_WORKER,
  WA_OWNER_SINGLE_SEND_WORKER,
} from './wa.module'
import { InternalWorkerApiGuard } from './internal-worker-api.guard'
import { PrismaWaAccountCommandGuard } from './prisma-wa-account-command.guard'
import { PrismaWaAccountAdminService } from './prisma-wa-account-admin.service'
import { PrismaWaAccountStatusRepository } from './prisma-wa-account-status.repository'
import { PrismaWaRestrictedRecoveryService } from './prisma-wa-restricted-recovery.service'
import { PrismaWaQrBootstrapRepository } from './prisma-wa-qr-bootstrap.repository'
import { PrismaWaAuthStateRepository } from './prisma-wa-auth-state.repository'
import { WaAccountController } from './wa-account.controller'
import { WaLifecycleCommandService } from './wa-lifecycle-command.service'
import { WaLifecycleCommandQueueService } from './wa-lifecycle-command-queue.service'
import { WaLifecycleJobProcessor } from './wa-lifecycle-job.processor'
import { WaLifecycleQueueService } from './wa-lifecycle-queue.service'
import { PrismaWaPhoneValidationRepository } from './prisma-wa-phone-validation.repository'
import { WaPhoneValidationAccountSelector } from './wa-phone-validation-account.selector'
import { WaPhoneValidationJobProcessor } from './wa-phone-validation-job.processor'
import { WaPhoneValidationQueueService } from './wa-phone-validation-queue.service'
import { WaRestrictedRecoveryReconciler } from './wa-restricted-recovery-reconciler'
import { PrismaWaSingleSendRepository } from './prisma-wa-single-send.repository'
import { WaSingleSendJobProcessor } from './wa-single-send-job.processor'
import { WaSingleSendQueueService } from './wa-single-send-queue.service'
import { WaTerminalFailureReconciler } from './wa-terminal-failure-reconciler'
import { WaOperationsController } from './wa-operations.controller'
import { WaWorkerIdentityConflictError, WaWorkerIdentityLease } from './wa-worker-identity-lease'
import { WaWorkerIdentityLossGate } from './wa-worker-identity-supervisor'

const queueMock = vi.hoisted(() => {
  const queues: Array<{ close: ReturnType<typeof vi.fn>; add: ReturnType<typeof vi.fn> }> = []
  const workers: Array<{
    name: string
    pause: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    run: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
  }> = []

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
    createWorker: vi.fn((name: string) => {
      const worker: (typeof workers)[number] = {
        name,
        pause: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        run: vi.fn(async () => undefined),
        on: vi.fn(),
      }
      worker.on.mockReturnValue(worker)
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
const originalWaSessionRuntime = process.env.WA_SESSION_RUNTIME

describe('WaModule', () => {
  const prismaDisconnectSpy = vi.spyOn(prisma, '$disconnect').mockResolvedValue(undefined)

  afterEach(() => {
    restoreEnv()
    prismaDisconnectSpy.mockReset().mockResolvedValue(undefined)
    queueMock.createQueue.mockClear()
    queueMock.createWorker.mockClear()
    queueMock.queues.length = 0
    queueMock.workers.length = 0
  })

  it('assembles the WA lifecycle providers through Nest DI', async () => {
    delete process.env.WA_WORKER_ID
    delete process.env.WA_OWNER_TTL_MS
    delete process.env.WA_SESSION_RUNTIME

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
      expect(moduleRef.get(WA_SESSION_RUNTIME)).toBeDefined()
      expect(moduleRef.get(WA_SESSION_MANAGER)).toBeInstanceOf(MockSessionManager)
      expect(moduleRef.get(WA_SESSION_LIFECYCLE)).toBeInstanceOf(WaSessionLifecycleService)
      expect(moduleRef.get(WA_SESSION_RUNTIME).sessionManager).toBe(
        moduleRef.get(WA_SESSION_MANAGER),
      )
      expect(moduleRef.get(WA_SESSION_RUNTIME).lifecycle).toBe(moduleRef.get(WA_SESSION_LIFECYCLE))
      expect(moduleRef.get(WA_PHONE_VALIDATOR)).toBe(
        moduleRef.get(WA_SESSION_RUNTIME).phoneValidator,
      )
      expect(moduleRef.get(WA_MESSAGE_SENDER)).toBe(moduleRef.get(WA_SESSION_RUNTIME).messageSender)
      expect(moduleRef.get(WA_PHONE_VALIDATOR)).toBeInstanceOf(UnavailablePhoneValidator)
      expect(moduleRef.get(WA_MESSAGE_SENDER)).toBeInstanceOf(UnavailableMessageSender)
      expect(moduleRef.get(PrismaWaPhoneValidationRepository)).toBeInstanceOf(
        PrismaWaPhoneValidationRepository,
      )
      expect(moduleRef.get(WaPhoneValidationAccountSelector)).toBeInstanceOf(
        WaPhoneValidationAccountSelector,
      )
      expect(moduleRef.get(WaPhoneValidationQueueService)).toBeInstanceOf(
        WaPhoneValidationQueueService,
      )
      expect(moduleRef.get(WaPhoneValidationJobProcessor)).toBeInstanceOf(
        WaPhoneValidationJobProcessor,
      )
      expect(moduleRef.get(PrismaWaSingleSendRepository)).toBeInstanceOf(
        PrismaWaSingleSendRepository,
      )
      expect(moduleRef.get(WaSingleSendQueueService)).toBeInstanceOf(WaSingleSendQueueService)
      expect(moduleRef.get(WaSingleSendJobProcessor)).toBeInstanceOf(WaSingleSendJobProcessor)
      expect(moduleRef.get(WaOperationsController)).toBeInstanceOf(WaOperationsController)
      expect(moduleRef.get(WaLifecycleCommandService)).toBeInstanceOf(WaLifecycleCommandService)
      expect(moduleRef.get(WaLifecycleJobProcessor)).toBeInstanceOf(WaLifecycleJobProcessor)
      expect(moduleRef.get(InternalWorkerApiGuard)).toBeInstanceOf(InternalWorkerApiGuard)
      expect(moduleRef.get(PrismaWaAccountCommandGuard)).toBeInstanceOf(PrismaWaAccountCommandGuard)
      expect(moduleRef.get(PrismaWaAccountAdminService)).toBeInstanceOf(PrismaWaAccountAdminService)
      expect(moduleRef.get(WaAccountController)).toBeInstanceOf(WaAccountController)
      const accountController = moduleRef.get(WaAccountController) as unknown as {
        adminService: unknown
        commandQueue: unknown
      }
      expect(accountController.adminService).toBe(moduleRef.get(PrismaWaAccountAdminService))
      expect(accountController.commandQueue).toBe(moduleRef.get(WaLifecycleCommandQueueService))
      expect(moduleRef.get(WaLifecycleQueueService)).toBeInstanceOf(WaLifecycleQueueService)
      expect(moduleRef.get(PrismaWaRestrictedRecoveryService)).toBeInstanceOf(
        PrismaWaRestrictedRecoveryService,
      )
      expect(moduleRef.get(WaRestrictedRecoveryReconciler)).toBeInstanceOf(
        WaRestrictedRecoveryReconciler,
      )
      expect(moduleRef.get(WaLifecycleCommandQueueService)).toBeInstanceOf(
        WaLifecycleCommandQueueService,
      )
      expect(moduleRef.get(WA_LIFECYCLE_QUEUE)).toBe(queueMock.queues[0])
      expect(moduleRef.get(WA_PHONE_VALIDATION_QUEUE)).toBe(queueMock.queues[1])
      expect(moduleRef.get(WA_SINGLE_SEND_QUEUE)).toBe(queueMock.queues[2])
      expect(moduleRef.get(WA_LIFECYCLE_WORKER)).toBe(workerForQueue(WA_LIFECYCLE_QUEUE_NAME))
      expect(moduleRef.get(WA_OWNER_LIFECYCLE_WORKER)).toBe(
        workerForQueue(createWaLifecycleOwnerQueueName(moduleRef.get(WA_WORKER_ID))),
      )
      expect(moduleRef.get(WA_PHONE_VALIDATION_WORKER)).toBe(
        workerForQueue(WA_PHONE_VALIDATION_QUEUE_NAME),
      )
      expect(moduleRef.get(WA_OWNER_PHONE_VALIDATION_WORKER)).toBe(
        workerForQueue(createWaPhoneValidationOwnerQueueName(moduleRef.get(WA_WORKER_ID))),
      )
      expect(moduleRef.get(WA_SINGLE_SEND_WORKER)).toBe(workerForQueue(WA_SINGLE_SEND_QUEUE_NAME))
      expect(moduleRef.get(WA_OWNER_SINGLE_SEND_WORKER)).toBe(
        workerForQueue(createWaSingleSendOwnerQueueName(moduleRef.get(WA_WORKER_ID))),
      )
      expect(moduleRef.get(WA_LIFECYCLE_QUEUE_FACTORY)).toBeTypeOf('function')
      expect(moduleRef.get(WA_LIFECYCLE_QUEUE_EVENTS_FACTORY)).toBeTypeOf('function')
      expect(moduleRef.get(WA_PHONE_VALIDATION_QUEUE_FACTORY)).toBeTypeOf('function')
      expect(moduleRef.get(WA_PHONE_VALIDATION_QUEUE_EVENTS_FACTORY)).toBeTypeOf('function')
      expect(moduleRef.get(WA_SINGLE_SEND_QUEUE_FACTORY)).toBeTypeOf('function')
      expect(moduleRef.get(WA_SINGLE_SEND_QUEUE_EVENTS_FACTORY)).toBeTypeOf('function')
      expect(moduleRef.get(WA_OWNER_TTL_MS)).toBe(30_000)
    } finally {
      await moduleRef.close()
    }
  })

  it('reconciles durable restricted recovery before starting lifecycle consumers', async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL
    const originalNodeEnv = process.env.NODE_ENV
    const originalWorkerId = process.env.WA_WORKER_ID
    process.env.DATABASE_URL = 'postgresql://startup-recovery-test.invalid/db'
    process.env.NODE_ENV = 'production'
    process.env.WA_WORKER_ID = 'worker-startup-recovery-test'
    const reconcile = vi.fn(async () => undefined)
    const reconcileTerminalFailures = vi.fn(async () => undefined)
    const startTerminalFailureReconciliation = vi.fn()
    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(createFakeRedisConnection())
      .overrideProvider(WaRestrictedRecoveryReconciler)
      .useValue({ reconcile })
      .overrideProvider(WaTerminalFailureReconciler)
      .useValue({
        reconcile: reconcileTerminalFailures,
        start: startTerminalFailureReconciliation,
        stop: vi.fn(),
      })
      .compile()

    try {
      expect(reconcile).toHaveBeenCalledOnce()
      expect(reconcileTerminalFailures).toHaveBeenCalledOnce()
      expect(startTerminalFailureReconciliation).toHaveBeenCalledOnce()
      expect(queueMock.workers).toHaveLength(6)
      for (const worker of queueMock.workers) {
        expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(
          worker.run.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        )
      }
    } finally {
      await moduleRef.close()
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = originalDatabaseUrl
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = originalNodeEnv
      if (originalWorkerId === undefined) delete process.env.WA_WORKER_ID
      else process.env.WA_WORKER_ID = originalWorkerId
    }
  })

  it('uses one process-stable and globally unique worker id fallback', async () => {
    delete process.env.WA_WORKER_ID
    const fallbackWorkerId = resolveWaWorkerId(undefined)

    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(createFakeRedisConnection())
      .compile()

    try {
      expect(moduleRef.get(WA_WORKER_ID)).toBe(fallbackWorkerId)
      expect(resolveWaWorkerId(undefined)).toBe(fallbackWorkerId)
      expect(fallbackWorkerId).toContain(hostname())
      expect(fallbackWorkerId).toContain(`-${process.pid}-`)
      expect(fallbackWorkerId).toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
      expect(resolveWaWorkerId(' worker-explicit ')).toBe('worker-explicit')
    } finally {
      await moduleRef.close()
    }
  })

  it('fails closed in production when WA_WORKER_ID is missing', () => {
    expect(() => resolveWaWorkerId(undefined, 'production')).toThrow(
      'WA_WORKER_ID is required in production',
    )
    expect(resolveWaWorkerId(' worker-production ', 'production')).toBe('worker-production')
  })

  it('acquires the stable worker identity before creating either BullMQ consumer', async () => {
    const redis = createTrackedRedisConnection()
    const acquire = createDeferred<number>()
    redis.eval.mockImplementation(async (script: string) => {
      if (script.includes('"NX"')) return acquire.promise
      return 1
    })

    const compilation = Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(redis)
      .compile()
    await delay(10)
    expect(queueMock.createWorker).not.toHaveBeenCalled()

    acquire.resolve(1)
    const moduleRef = await compilation
    try {
      expect(moduleRef.get(WA_WORKER_IDENTITY_LEASE)).toBeInstanceOf(WaWorkerIdentityLease)
      expect(queueMock.createWorker).toHaveBeenCalledTimes(6)
    } finally {
      await moduleRef.close()
    }
  })

  it('confirms the first identity renewal before creating either BullMQ consumer', async () => {
    const redis = createTrackedRedisConnection()
    const renew = createDeferred<number>()
    redis.eval.mockImplementation(async (script: string) => {
      if (script.includes('"NX"')) return 1
      if (script.includes('PEXPIRE')) return renew.promise
      return 1
    })

    const compilation = Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(redis)
      .compile()
    await delay(10)
    expect(queueMock.createWorker).not.toHaveBeenCalled()

    renew.resolve(1)
    const moduleRef = await compilation
    try {
      expect(queueMock.createWorker).toHaveBeenCalledTimes(6)
    } finally {
      await moduleRef.close()
    }
  })

  it('rejects a duplicate live WA_WORKER_ID before creating consumers', async () => {
    const redis = createTrackedRedisConnection()
    redis.eval.mockImplementation(async (script: string) => (script.includes('"NX"') ? 0 : 1))

    await expect(
      Test.createTestingModule({ imports: [WaModule] })
        .overrideProvider(WA_REDIS_CONNECTION)
        .useValue(redis)
        .compile(),
    ).rejects.toBeInstanceOf(WaWorkerIdentityConflictError)
    expect(queueMock.createWorker).not.toHaveBeenCalled()
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
    const workers = [...queueMock.workers]

    try {
      expect(queueMock.createWorker).toHaveBeenCalledWith(
        WA_LIFECYCLE_QUEUE_NAME,
        expect.any(Function),
        fakeRedisConnection,
        { autorun: false },
      )
      expect(queueMock.createWorker).toHaveBeenCalledWith(
        createWaLifecycleOwnerQueueName(moduleRef.get(WA_WORKER_ID)),
        expect.any(Function),
        fakeRedisConnection,
        { autorun: false },
      )
      expect(queueMock.createWorker).toHaveBeenCalledTimes(6)
      expect(workers[0]?.run).toHaveBeenCalledOnce()
      expect(workers[1]?.run).toHaveBeenCalledOnce()

      const lifecycleCall = queueMock.createWorker.mock.calls.find(
        ([queueName]) => queueName === WA_LIFECYCLE_QUEUE_NAME,
      )
      const workerProcessor = lifecycleCall?.[1] as
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

    expect(workers).toHaveLength(6)
    for (const worker of workers) expect(worker.close).toHaveBeenCalledTimes(1)
  })

  it('fences every lifecycle job after a worker identity loss', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(createFakeRedisConnection())
      .overrideProvider(WA_WORKER_IDENTITY_FATAL_HANDLER)
      .useValue(vi.fn(async () => undefined))
      .compile()
    const processor = queueMock.createWorker.mock.calls[0]?.[1] as
      ((job: { name: string; data: unknown }) => Promise<unknown>) | undefined
    const loss = new Error('identity lost before job dispatch')

    try {
      await moduleRef.get(WaWorkerIdentityLossGate).report(loss)

      await expect(
        Promise.resolve().then(() =>
          processor?.({
            name: START_WA_INSTANCE_JOB_NAME,
            data: { instanceId: 'instance-fenced' },
          }),
        ),
      ).rejects.toBe(loss)
    } finally {
      await moduleRef.close().catch(() => undefined)
    }
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
      expect(queueMock.createQueue).toHaveBeenCalledWith(
        WA_PHONE_VALIDATION_QUEUE_NAME,
        fakeRedisConnection,
      )
      expect(queueMock.createQueue).toHaveBeenCalledWith(
        WA_SINGLE_SEND_QUEUE_NAME,
        fakeRedisConnection,
      )
      expect(queueMock.createQueue).toHaveBeenCalledTimes(3)
      expect(queueMock.createWorker).toHaveBeenCalledTimes(6)

      const service = moduleRef.get(WaLifecycleQueueService)
      await service.enqueueStart(' instance-1 ')

      expect(queueMock.queues[0]?.add).toHaveBeenCalledWith(
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
    const lifecycleQueue = queueMock.queues[0]
    const phoneValidationQueue = queueMock.queues[1]

    await moduleRef.close()

    expect(lifecycleQueue?.close).toHaveBeenCalledTimes(1)
    expect(phoneValidationQueue?.close).toHaveBeenCalledTimes(1)
  })

  it('disconnects the shared Prisma client on application shutdown', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(createFakeRedisConnection())
      .compile()

    await moduleRef.close()

    expect(prismaDisconnectSpy).toHaveBeenCalledTimes(1)
  })

  it('shuts down intake, sessions, queue, Redis, and Prisma in strict order', async () => {
    const events: string[] = []
    const redis = createTrackedRedisConnection()
    redis.quit.mockImplementation(async () => {
      events.push('redis')
      return 'OK'
    })
    prismaDisconnectSpy.mockImplementationOnce(async () => {
      events.push('prisma')
    })
    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(redis)
      .compile()
    const workers = [...queueMock.workers]
    const queue = queueMock.queues[0]
    const lifecycle = moduleRef.get<WaSessionLifecycleService>(WA_SESSION_LIFECYCLE)
    const identityLease = moduleRef.get<WaWorkerIdentityLease>(WA_WORKER_IDENTITY_LEASE)
    workers[0]?.pause.mockImplementation(async () => {
      events.push('pause-shared-worker')
    })
    workers[1]?.pause.mockImplementation(async () => {
      events.push('pause-owner-worker')
    })
    workers[0]?.close.mockImplementation(async () => {
      events.push('shared-worker')
    })
    workers[1]?.close.mockImplementation(async () => {
      events.push('owner-worker')
    })
    vi.spyOn(lifecycle, 'shutdownAll').mockImplementation(async () => {
      events.push('sessions')
    })
    queue?.close.mockImplementation(async () => {
      events.push('queue')
    })
    vi.spyOn(identityLease, 'release').mockImplementation(async () => {
      events.push('identity-release')
      return true
    })

    await moduleRef.close()

    expect(events).toEqual([
      'pause-shared-worker',
      'pause-owner-worker',
      'sessions',
      'shared-worker',
      'owner-worker',
      'identity-release',
      'queue',
      'redis',
      'prisma',
    ])
  })

  it('activates bounded session shutdown before draining a never-settling active worker job', async () => {
    const events: string[] = []
    let releaseBlockingClose!: () => void
    const blockingClose = new Promise<void>((resolve) => {
      releaseBlockingClose = resolve
    })
    const lifecycleStarted = createDeferred<void>()
    const redis = createTrackedRedisConnection()
    redis.quit.mockImplementation(async () => {
      events.push('redis')
      return 'OK'
    })
    prismaDisconnectSpy.mockImplementationOnce(async () => {
      events.push('prisma')
    })
    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(redis)
      .compile()
    const workers = [...queueMock.workers]
    const queue = queueMock.queues[0]
    const lifecycle = moduleRef.get<WaSessionLifecycleService>(WA_SESSION_LIFECYCLE)
    for (const worker of workers) {
      worker.pause.mockImplementation(async (doNotWaitActive?: boolean) => {
        events.push(`pause-${worker.name}-${String(doNotWaitActive)}`)
      })
      worker.close.mockImplementation(async (force?: boolean) => {
        events.push(`close-${worker.name}-${String(force)}`)
        if (force !== true) await blockingClose
      })
    }
    vi.spyOn(lifecycle, 'shutdownAll').mockImplementation(async () => {
      events.push('sessions')
      lifecycleStarted.resolve()
    })
    queue?.close.mockImplementation(async () => {
      events.push('queue')
    })

    const shutdown = moduleRef.close()
    const firstStep = await Promise.race([
      lifecycleStarted.promise.then(() => 'sessions' as const),
      delay(25).then(() => 'blocked' as const),
    ])

    try {
      expect(firstStep).toBe('sessions')
      await expect(shutdown).resolves.toBeUndefined()
      const ownerLifecycleQueue = createWaLifecycleOwnerQueueName(moduleRef.get(WA_WORKER_ID))
      const ownerValidationQueue = createWaPhoneValidationOwnerQueueName(
        moduleRef.get(WA_WORKER_ID),
      )
      const ownerSingleSendQueue = createWaSingleSendOwnerQueueName(moduleRef.get(WA_WORKER_ID))
      expect(events).toEqual([
        `pause-${WA_LIFECYCLE_QUEUE_NAME}-true`,
        `pause-${ownerLifecycleQueue}-true`,
        `pause-${WA_PHONE_VALIDATION_QUEUE_NAME}-true`,
        `pause-${ownerValidationQueue}-true`,
        `pause-${WA_SINGLE_SEND_QUEUE_NAME}-true`,
        `pause-${ownerSingleSendQueue}-true`,
        'sessions',
        `close-${WA_LIFECYCLE_QUEUE_NAME}-true`,
        `close-${ownerLifecycleQueue}-true`,
        `close-${WA_PHONE_VALIDATION_QUEUE_NAME}-true`,
        `close-${ownerValidationQueue}-true`,
        `close-${WA_SINGLE_SEND_QUEUE_NAME}-true`,
        `close-${ownerSingleSendQueue}-true`,
        'queue',
        'redis',
        'prisma',
      ])
    } finally {
      releaseBlockingClose()
      await shutdown.catch(() => undefined)
    }
  })

  it('reaches fatal termination before the identity TTL when critical shutdown steps hang', async () => {
    vi.useFakeTimers()
    try {
      const never = new Promise<void>(() => undefined)
      const fatalStarted = vi.fn(async () => undefined)
      const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
        .overrideProvider(WA_REDIS_CONNECTION)
        .useValue(createFakeRedisConnection())
        .overrideProvider(WA_WORKER_IDENTITY_FATAL_HANDLER)
        .useValue(fatalStarted)
        .compile()
      const lifecycle = moduleRef.get<WaSessionLifecycleService>(WA_SESSION_LIFECYCLE)
      const identityLease = moduleRef.get<WaWorkerIdentityLease>(WA_WORKER_IDENTITY_LEASE)
      const release = vi.spyOn(identityLease, 'release')
      const stopRenewal = vi.spyOn(identityLease, 'stopRenewal')
      vi.spyOn(lifecycle, 'shutdownAll').mockImplementation(() => never)
      for (const worker of queueMock.workers) {
        worker.pause.mockImplementation(() => never)
        worker.close.mockImplementation(() => never)
      }

      const shutdown = moduleRef.close()
      const rejected = expect(shutdown).rejects.toThrow('WA shutdown step timed out')
      await vi.advanceTimersByTimeAsync(10_000)

      await rejected
      expect(fatalStarted).toHaveBeenCalledOnce()
      expect(stopRenewal).toHaveBeenCalled()
      expect(release).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues every shutdown step and rethrows the first failure', async () => {
    const events: string[] = []
    const firstError = new Error('shared worker close failed')
    const redis = createTrackedRedisConnection()
    redis.quit.mockImplementation(async () => {
      events.push('redis')
      throw new Error('redis quit failed')
    })
    prismaDisconnectSpy.mockImplementationOnce(async () => {
      events.push('prisma')
      throw new Error('prisma disconnect failed')
    })
    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(redis)
      .compile()
    const workers = [...queueMock.workers]
    const queue = queueMock.queues[0]
    const lifecycle = moduleRef.get<WaSessionLifecycleService>(WA_SESSION_LIFECYCLE)
    workers[0]?.pause.mockImplementation(async () => {
      events.push('pause-shared-worker')
      throw firstError
    })
    workers[1]?.pause.mockImplementation(async () => {
      events.push('pause-owner-worker')
      throw new Error('owner worker pause failed')
    })
    workers[0]?.close.mockImplementation(async () => {
      events.push('shared-worker')
      throw new Error('shared worker close failed')
    })
    workers[1]?.close.mockImplementation(async () => {
      events.push('owner-worker')
      throw new Error('owner worker close failed')
    })
    vi.spyOn(lifecycle, 'shutdownAll').mockImplementation(async () => {
      events.push('sessions')
      throw new Error('session shutdown failed')
    })
    queue?.close.mockImplementation(async () => {
      events.push('queue')
      throw new Error('queue close failed')
    })

    await expect(moduleRef.close()).rejects.toBe(firstError)
    expect(events).toEqual([
      'pause-shared-worker',
      'pause-owner-worker',
      'sessions',
      'shared-worker',
      'owner-worker',
      'queue',
      'redis',
      'prisma',
    ])
  })

  it('retains the identity lease until TTL and terminates when sessions do not close', async () => {
    const redis = createTrackedRedisConnection()
    const fatalStarted = createDeferred<void>()
    const cleanupRelease = createDeferred<void>()
    const terminate = vi.fn(async () => {
      fatalStarted.resolve()
    })
    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(redis)
      .overrideProvider(WA_WORKER_IDENTITY_FATAL_HANDLER)
      .useValue(terminate)
      .compile()
    const lifecycle = moduleRef.get<WaSessionLifecycleService>(WA_SESSION_LIFECYCLE)
    const identityLease = moduleRef.get<WaWorkerIdentityLease>(WA_WORKER_IDENTITY_LEASE)
    const queue = queueMock.queues[0]
    const sessionError = new Error('physical session shutdown failed')
    vi.spyOn(lifecycle, 'shutdownAll').mockRejectedValue(sessionError)
    const release = vi.spyOn(identityLease, 'release')
    const stopRenewal = vi.spyOn(identityLease, 'stopRenewal')
    queue?.close.mockImplementation(() => cleanupRelease.promise)

    const shutdown = moduleRef.close()
    await expect(
      Promise.race([fatalStarted.promise.then(() => 'fatal'), delay(25).then(() => 'timeout')]),
    ).resolves.toBe('fatal')

    expect(stopRenewal).toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(terminate).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledWith(sessionError)
    expect(redis.quit).not.toHaveBeenCalled()

    cleanupRelease.resolve()
    await expect(shutdown).rejects.toBe(sessionError)
    expect(redis.quit).toHaveBeenCalledOnce()
    expect(prismaDisconnectSpy).toHaveBeenCalledOnce()
  })

  it('uses a strict mock-by-default runtime gate', () => {
    expect(resolveWaSessionRuntimeMode(undefined)).toBe('mock')
    expect(resolveWaSessionRuntimeMode('')).toBe('mock')
    expect(resolveWaSessionRuntimeMode('mock')).toBe('mock')
    expect(resolveWaSessionRuntimeMode('baileys')).toBe('baileys')
    expect(() => resolveWaSessionRuntimeMode('true')).toThrow(
      'WA_SESSION_RUNTIME must be either mock or baileys',
    )
  })

  it('wires the real session manager only with explicit opt-in and without socket autostart', async () => {
    process.env.WA_SESSION_RUNTIME = 'baileys'
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
      expect(source).not.toMatch(/['"`][^'"`\r\n]*\.session['"`]/)
    }

    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(createFakeRedisConnection())
      .overrideProvider(WA_AUTH_STATE_STORE)
      .useValue(new InMemoryWaAuthStateStore())
      .compile()

    try {
      const manager = moduleRef.get<BaileysSessionManager>(WA_SESSION_MANAGER)
      expect(manager).toBeInstanceOf(BaileysSessionManager)
      await expect(manager.getState('instance-inert')).resolves.toMatchObject({
        status: 'idle',
        hasAuthState: false,
      })
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

  if (originalWaSessionRuntime === undefined) {
    delete process.env.WA_SESSION_RUNTIME
  } else {
    process.env.WA_SESSION_RUNTIME = originalWaSessionRuntime
  }
}

function createFakeRedisConnection(): unknown {
  return {
    eval: async () => 1,
    get: async () => null,
    quit: async () => 'OK',
  }
}

function createTrackedRedisConnection() {
  return {
    eval: vi.fn(async (_script: string) => 1),
    get: vi.fn(async () => null),
    quit: vi.fn(async () => 'OK'),
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

function workerForQueue(queueName: string) {
  return queueMock.workers.find((worker) => worker.name === queueName)
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs))
}

interface PackageJson {
  dependencies?: Record<string, string>
}
