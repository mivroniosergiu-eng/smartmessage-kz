import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common'
import { prisma } from '@smartmessage/db'
import {
  WA_LIFECYCLE_QUEUE_NAME,
  createWaLifecycleOwnerQueueName,
  createConnection,
  createQueue,
  createQueueEvents,
  createWorker,
} from '@smartmessage/queue'
import type {
  Queue,
  WaLifecycleInstanceJobPayload,
  Worker as QueueWorker,
} from '@smartmessage/queue'
import {
  RedisOwnerRegistry,
  createBaileysSessionRuntime,
  type BaileysSessionRuntime,
  type OwnerRegistry,
  type WaAuthStateStore,
  type SessionManager,
  type WaSessionLifecycleService,
  type WaAccountStatusRepository,
  type WaQrBootstrapRepository,
} from '@smartmessage/wa'

import { InternalWorkerApiGuard } from './internal-worker-api.guard'
import { PrismaWaAccountStatusRepository } from './prisma-wa-account-status.repository'
import { PrismaWaQrBootstrapRepository } from './prisma-wa-qr-bootstrap.repository'
import { PrismaWaAuthStateRepository } from './prisma-wa-auth-state.repository'
import { PrismaWaAccountCommandGuard } from './prisma-wa-account-command.guard'
import { PrismaWaAccountAdminService } from './prisma-wa-account-admin.service'
import { WaAccountController } from './wa-account.controller'
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
} from './wa.tokens'
import { WaLifecycleCommandService } from './wa-lifecycle-command.service'
import { WaLifecycleCommandQueueService } from './wa-lifecycle-command-queue.service'
import { WaLifecycleJobProcessor, type WaLifecycleJobResult } from './wa-lifecycle-job.processor'
import { WaLifecycleQueueService } from './wa-lifecycle-queue.service'
import type {
  WaLifecycleQueueEventsFactory,
  WaLifecycleQueueFactory,
} from './wa-lifecycle-queue.service'
import { WaWorkerIdentityLease } from './wa-worker-identity-lease'
import {
  WaWorkerIdentityLossGate,
  WaWorkerIdentityLossSupervisor,
  type WaWorkerIdentityFatalHandler,
} from './wa-worker-identity-supervisor'

const DEFAULT_OWNER_TTL_MS = 30_000
const DEFAULT_WORKER_ID = `worker-${hostname()}-${process.pid}-${randomUUID()}`
export const WA_LIFECYCLE_WORKER = Symbol('WA_LIFECYCLE_WORKER')
export const WA_OWNER_LIFECYCLE_WORKER = Symbol('WA_OWNER_LIFECYCLE_WORKER')

type WaRedisConnection = ReturnType<typeof createConnection>
type WaLifecycleQueue = Queue<WaLifecycleInstanceJobPayload>
type WaLifecycleWorker = QueueWorker<unknown, WaLifecycleJobResult>

@Injectable()
class WaShutdownCoordinator implements OnApplicationShutdown {
  constructor(
    @Inject(WA_LIFECYCLE_WORKER)
    private readonly lifecycleWorker: WaLifecycleWorker,
    @Inject(WA_OWNER_LIFECYCLE_WORKER)
    private readonly ownerLifecycleWorker: WaLifecycleWorker,
    @Inject(WA_SESSION_LIFECYCLE)
    private readonly lifecycle: WaSessionLifecycleService,
    @Inject(WA_LIFECYCLE_QUEUE)
    private readonly lifecycleQueue: WaLifecycleQueue,
    @Inject(WA_REDIS_CONNECTION)
    private readonly connection: WaRedisConnection,
    @Inject(WA_WORKER_IDENTITY_LEASE)
    private readonly identityLease: WaWorkerIdentityLease,
    @Inject(WA_WORKER_IDENTITY_FATAL_HANDLER)
    private readonly terminate: WaWorkerIdentityFatalHandler,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    let firstError: unknown
    let hasError = false
    const attempt = async (operation: () => Promise<unknown>): Promise<boolean> => {
      try {
        await operation()
        return true
      } catch (error: unknown) {
        if (!hasError) {
          firstError = error
          hasError = true
        }
        return false
      }
    }

    await attempt(async () => {
      await this.lifecycleWorker.pause?.(true)
    })
    await attempt(async () => {
      await this.ownerLifecycleWorker.pause?.(true)
    })
    const sessionsClosed = await attempt(() => this.lifecycle.shutdownAll())
    const lifecycleWorkerClosed = await attempt(() => this.lifecycleWorker.close(true))
    const ownerLifecycleWorkerClosed = await attempt(() => this.ownerLifecycleWorker.close(true))
    const canReleaseIdentity = sessionsClosed && lifecycleWorkerClosed && ownerLifecycleWorkerClosed
    if (canReleaseIdentity) {
      await attempt(() => this.identityLease.release())
    } else {
      this.identityLease.stopRenewal()
      await settleWithin(
        Promise.resolve().then(() => this.terminate(toError(firstError))),
        IDENTITY_FATAL_HANDLER_GRACE_MS,
      )
    }
    await attempt(() => this.lifecycleQueue.close())
    await attempt(() => this.connection.quit())
    await attempt(() => prisma.$disconnect())

    if (hasError) throw firstError
  }
}

@Module({
  controllers: [WaAccountController],
  providers: [
    {
      provide: WA_WORKER_ID,
      useFactory: () => resolveWaWorkerId(process.env.WA_WORKER_ID),
    },
    {
      provide: WA_OWNER_TTL_MS,
      useFactory: () => resolveWaOwnerTtlMs(process.env.WA_OWNER_TTL_MS),
    },
    {
      provide: WA_REDIS_CONNECTION,
      useFactory: () => createConnection(),
    },
    {
      provide: WA_WORKER_IDENTITY_FATAL_HANDLER,
      useValue: terminateWaWorkerProcess,
    },
    WaWorkerIdentityLossGate,
    {
      provide: WA_WORKER_IDENTITY_LEASE,
      useFactory: async (
        redis: WaRedisConnection,
        workerId: string,
        ttlMs: number,
        lossGate: WaWorkerIdentityLossGate,
      ): Promise<WaWorkerIdentityLease> => {
        const lease = new WaWorkerIdentityLease({ workerId, redis, ttlMs })
        await lease.acquire()
        await lease.startRenewal((error) => lossGate.report(error))
        return lease
      },
      inject: [WA_REDIS_CONNECTION, WA_WORKER_ID, WA_OWNER_TTL_MS, WaWorkerIdentityLossGate],
    },
    {
      provide: WA_OWNER_REGISTRY,
      useFactory: (redis: WaRedisConnection): OwnerRegistry => new RedisOwnerRegistry(redis),
      inject: [WA_REDIS_CONNECTION],
    },
    {
      provide: WA_STATUS_REPOSITORY,
      useFactory: (): WaAccountStatusRepository => new PrismaWaAccountStatusRepository(),
    },
    {
      provide: WA_QR_BOOTSTRAP_REPOSITORY,
      useFactory: (): WaQrBootstrapRepository => new PrismaWaQrBootstrapRepository(),
    },
    {
      provide: WA_AUTH_STATE_STORE,
      useFactory: (): WaAuthStateStore => new PrismaWaAuthStateRepository(),
    },
    {
      provide: WA_SESSION_RUNTIME,
      useFactory: (
        workerId: string,
        ownerRegistry: OwnerRegistry,
        authStateStore: WaAuthStateStore,
        ttlMs: number,
        statusRepository: WaAccountStatusRepository,
        qrBootstrapRepository: WaQrBootstrapRepository,
        _identityLease: WaWorkerIdentityLease,
        identityGate: WaWorkerIdentityLossGate,
      ): BaileysSessionRuntime =>
        createHealthyBaileysSessionRuntime(identityGate, {
          workerId,
          ownerRegistry,
          authStateStore,
          ttlMs,
          statusRepository,
          qrBootstrapRepository,
        }),
      inject: [
        WA_WORKER_ID,
        WA_OWNER_REGISTRY,
        WA_AUTH_STATE_STORE,
        WA_OWNER_TTL_MS,
        WA_STATUS_REPOSITORY,
        WA_QR_BOOTSTRAP_REPOSITORY,
        WA_WORKER_IDENTITY_LEASE,
        WaWorkerIdentityLossGate,
      ],
    },
    {
      provide: WA_SESSION_MANAGER,
      useFactory: (runtime: BaileysSessionRuntime): SessionManager => runtime.sessionManager,
      inject: [WA_SESSION_RUNTIME],
    },
    {
      provide: WA_SESSION_LIFECYCLE,
      useFactory: (runtime: BaileysSessionRuntime): WaSessionLifecycleService => runtime.lifecycle,
      inject: [WA_SESSION_RUNTIME],
    },
    WaLifecycleCommandService,
    WaLifecycleJobProcessor,
    InternalWorkerApiGuard,
    {
      provide: PrismaWaAccountCommandGuard,
      useFactory: (): PrismaWaAccountCommandGuard => new PrismaWaAccountCommandGuard(),
    },
    {
      provide: PrismaWaAccountAdminService,
      useFactory: (): PrismaWaAccountAdminService => new PrismaWaAccountAdminService(),
    },
    {
      provide: WA_LIFECYCLE_QUEUE,
      useFactory: (redis: WaRedisConnection): WaLifecycleQueue =>
        createQueue<WaLifecycleInstanceJobPayload>(WA_LIFECYCLE_QUEUE_NAME, redis),
      inject: [WA_REDIS_CONNECTION],
    },
    {
      provide: WA_LIFECYCLE_QUEUE_FACTORY,
      useFactory:
        (redis: WaRedisConnection): WaLifecycleQueueFactory =>
        (queueName) =>
          createQueue<WaLifecycleInstanceJobPayload>(queueName, redis),
      inject: [WA_REDIS_CONNECTION],
    },
    {
      provide: WA_LIFECYCLE_QUEUE_EVENTS_FACTORY,
      useFactory:
        (redis: WaRedisConnection): WaLifecycleQueueEventsFactory =>
        (queueName) =>
          createQueueEvents(queueName, redis),
      inject: [WA_REDIS_CONNECTION],
    },
    WaLifecycleQueueService,
    WaLifecycleCommandQueueService,
    {
      provide: WA_LIFECYCLE_WORKER,
      useFactory: (
        redis: WaRedisConnection,
        processor: WaLifecycleJobProcessor,
        _identityLease: WaWorkerIdentityLease,
        identityGate: WaWorkerIdentityLossGate,
      ): WaLifecycleWorker => {
        identityGate.assertHealthy()
        return createWorker<unknown, WaLifecycleJobResult>(
          WA_LIFECYCLE_QUEUE_NAME,
          (job) => {
            identityGate.assertHealthy()
            return processor.process(job)
          },
          redis,
          { autorun: false },
        )
      },
      inject: [
        WA_REDIS_CONNECTION,
        WaLifecycleJobProcessor,
        WA_WORKER_IDENTITY_LEASE,
        WaWorkerIdentityLossGate,
      ],
    },
    {
      provide: WA_OWNER_LIFECYCLE_WORKER,
      useFactory: (
        redis: WaRedisConnection,
        processor: WaLifecycleJobProcessor,
        workerId: string,
        _identityLease: WaWorkerIdentityLease,
        identityGate: WaWorkerIdentityLossGate,
      ): WaLifecycleWorker => {
        identityGate.assertHealthy()
        return createWorker<unknown, WaLifecycleJobResult>(
          createWaLifecycleOwnerQueueName(workerId),
          (job) => {
            identityGate.assertHealthy()
            return processor.process(job)
          },
          redis,
          { autorun: false },
        )
      },
      inject: [
        WA_REDIS_CONNECTION,
        WaLifecycleJobProcessor,
        WA_WORKER_ID,
        WA_WORKER_IDENTITY_LEASE,
        WaWorkerIdentityLossGate,
      ],
    },
    {
      provide: WaWorkerIdentityLossSupervisor,
      useFactory: async (
        lifecycleWorker: WaLifecycleWorker,
        ownerLifecycleWorker: WaLifecycleWorker,
        lifecycle: WaSessionLifecycleService,
        lossGate: WaWorkerIdentityLossGate,
        terminate: WaWorkerIdentityFatalHandler,
      ): Promise<WaWorkerIdentityLossSupervisor> => {
        const supervisor = new WaWorkerIdentityLossSupervisor(
          lifecycleWorker,
          ownerLifecycleWorker,
          lifecycle,
          terminate,
        )
        await lossGate.bind((error) => supervisor.reportLoss(error))
        lossGate.assertHealthy()
        startWorker(lifecycleWorker, supervisor)
        startWorker(ownerLifecycleWorker, supervisor)
        return supervisor
      },
      inject: [
        WA_LIFECYCLE_WORKER,
        WA_OWNER_LIFECYCLE_WORKER,
        WA_SESSION_LIFECYCLE,
        WaWorkerIdentityLossGate,
        WA_WORKER_IDENTITY_FATAL_HANDLER,
      ],
    },
    WaShutdownCoordinator,
  ],
  exports: [
    WA_WORKER_ID,
    WA_WORKER_IDENTITY_LEASE,
    WA_OWNER_TTL_MS,
    WA_REDIS_CONNECTION,
    WA_OWNER_REGISTRY,
    WA_SESSION_MANAGER,
    WA_SESSION_RUNTIME,
    WA_STATUS_REPOSITORY,
    WA_QR_BOOTSTRAP_REPOSITORY,
    WA_AUTH_STATE_STORE,
    WA_SESSION_LIFECYCLE,
    WaLifecycleCommandService,
    WaLifecycleJobProcessor,
    InternalWorkerApiGuard,
    PrismaWaAccountCommandGuard,
    PrismaWaAccountAdminService,
    WA_LIFECYCLE_QUEUE,
    WA_LIFECYCLE_QUEUE_EVENTS_FACTORY,
    WA_LIFECYCLE_QUEUE_FACTORY,
    WaLifecycleQueueService,
    WaLifecycleCommandQueueService,
    WA_LIFECYCLE_WORKER,
    WA_OWNER_LIFECYCLE_WORKER,
  ],
})
export class WaModule {}

export function resolveWaWorkerId(
  value: string | undefined,
  nodeEnv = process.env.NODE_ENV,
): string {
  const workerId = value?.trim()
  if (workerId && workerId.length > 0) return workerId
  if (nodeEnv === 'production') {
    throw new Error('WA_WORKER_ID is required in production')
  }
  return DEFAULT_WORKER_ID
}

export function resolveWaOwnerTtlMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_OWNER_TTL_MS

  const ttlMs = Number(value)
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError('WA_OWNER_TTL_MS must be a positive safe integer')
  }

  return ttlMs
}

function terminateWaWorkerProcess(error: Error): void {
  if (process.env.NODE_ENV === 'test') return
  process.exitCode = 1
  console.error('WA worker identity lease lost; terminating worker', error)
  process.kill(process.pid, 'SIGTERM')
}

function createHealthyBaileysSessionRuntime(
  identityGate: WaWorkerIdentityLossGate,
  options: Parameters<typeof createBaileysSessionRuntime>[0],
): BaileysSessionRuntime {
  identityGate.assertHealthy()
  return createBaileysSessionRuntime(options)
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error ?? 'WA shutdown failed'))
}

const IDENTITY_FATAL_HANDLER_GRACE_MS = 1_000

function startWorker(worker: WaLifecycleWorker, supervisor: WaWorkerIdentityLossSupervisor): void {
  try {
    void worker.run().catch((error: unknown) => supervisor.reportLoss(toError(error)))
  } catch (error: unknown) {
    void supervisor.reportLoss(toError(error))
    throw error
  }
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs)
    timeout.unref?.()
  })
  await Promise.race([operation.catch(() => undefined), deadline])
  if (timeout !== undefined) clearTimeout(timeout)
}
