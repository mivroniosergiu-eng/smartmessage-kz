import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common'
import { prisma } from '@smartmessage/db'
import {
  WA_LIFECYCLE_QUEUE_NAME,
  WA_PHONE_VALIDATION_QUEUE_NAME,
  WA_SINGLE_SEND_QUEUE_NAME,
  createWaLifecycleOwnerQueueName,
  createWaPhoneValidationOwnerQueueName,
  createWaSingleSendOwnerQueueName,
  createConnection,
  createQueue,
  createQueueEvents,
  createWorker,
} from '@smartmessage/queue'
import type {
  Queue,
  WaLifecycleInstanceJobPayload,
  WaPhoneValidationJobPayload,
  WaPhoneValidationOwnerJobPayload,
  WaSingleSendJobPayload,
  WaSingleSendOwnerJobPayload,
  Worker as QueueWorker,
} from '@smartmessage/queue'
import {
  MockSessionManager,
  RedisOwnerRegistry,
  UnavailableMessageSender,
  UnavailablePhoneValidator,
  WaSessionLifecycleService,
  createBaileysSessionRuntime,
  type OwnerRegistry,
  type PhoneValidator,
  type MessageSender,
  type WaAuthStateStore,
  type SessionManager,
  type WaAccountStatusRepository,
  type WaQrBootstrapRepository,
  type WaReceiver,
} from '@smartmessage/wa'

import { InternalWorkerApiGuard } from './internal-worker-api.guard'
import { PrismaWaAccountStatusRepository } from './prisma-wa-account-status.repository'
import { PrismaWaQrBootstrapRepository } from './prisma-wa-qr-bootstrap.repository'
import { PrismaWaAuthStateRepository } from './prisma-wa-auth-state.repository'
import { PrismaWaAccountCommandGuard } from './prisma-wa-account-command.guard'
import { PrismaWaAccountAdminService } from './prisma-wa-account-admin.service'
import { PrismaWaRestrictedRecoveryService } from './prisma-wa-restricted-recovery.service'
import { WaAccountController } from './wa-account.controller'
import { WaOperationsController } from './wa-operations.controller'
import { WaIncomingEventReceiver } from './wa-incoming-event.receiver'
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
import { WaLifecycleCommandService } from './wa-lifecycle-command.service'
import { WaLifecycleCommandQueueService } from './wa-lifecycle-command-queue.service'
import { WaLifecycleJobProcessor, type WaLifecycleJobResult } from './wa-lifecycle-job.processor'
import { WaLifecycleQueueService } from './wa-lifecycle-queue.service'
import { PrismaWaPhoneValidationRepository } from './prisma-wa-phone-validation.repository'
import { WaPhoneValidationAccountSelector } from './wa-phone-validation-account.selector'
import {
  WaPhoneValidationJobProcessor,
  type WaPhoneValidationJobResult,
} from './wa-phone-validation-job.processor'
import {
  WaPhoneValidationQueueService,
  type WaPhoneValidationQueueEventsFactory,
  type WaPhoneValidationQueueFactory,
} from './wa-phone-validation-queue.service'
import { WaRestrictedRecoveryReconciler } from './wa-restricted-recovery-reconciler'
import { PrismaWaSingleSendRepository } from './prisma-wa-single-send.repository'
import {
  WaSingleSendJobProcessor,
  type WaSingleSendJobResult,
} from './wa-single-send-job.processor'
import {
  WaSingleSendQueueService,
  type WaSingleSendQueueEventsFactory,
  type WaSingleSendQueueFactory,
} from './wa-single-send-queue.service'
import { WaTerminalFailureReconciler } from './wa-terminal-failure-reconciler'
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
const SHUTDOWN_PAUSE_TIMEOUT_MS = 1_000
const SHUTDOWN_LIFECYCLE_TIMEOUT_MS = 5_000
const SHUTDOWN_WORKER_CLOSE_TIMEOUT_MS = 1_000
export const WA_LIFECYCLE_WORKER = Symbol('WA_LIFECYCLE_WORKER')
export const WA_OWNER_LIFECYCLE_WORKER = Symbol('WA_OWNER_LIFECYCLE_WORKER')
export const WA_PHONE_VALIDATION_WORKER = Symbol('WA_PHONE_VALIDATION_WORKER')
export const WA_OWNER_PHONE_VALIDATION_WORKER = Symbol('WA_OWNER_PHONE_VALIDATION_WORKER')
export const WA_SINGLE_SEND_WORKER = Symbol('WA_SINGLE_SEND_WORKER')
export const WA_OWNER_SINGLE_SEND_WORKER = Symbol('WA_OWNER_SINGLE_SEND_WORKER')

type WaRedisConnection = ReturnType<typeof createConnection>
type WaLifecycleQueue = Queue<WaLifecycleInstanceJobPayload>
type WaLifecycleWorker = QueueWorker<unknown, WaLifecycleJobResult>
type WaPhoneValidationQueue = Queue<WaPhoneValidationJobPayload>
type WaPhoneValidationWorker = QueueWorker<unknown, WaPhoneValidationJobResult>
type WaSingleSendQueue = Queue<WaSingleSendJobPayload>
type WaSingleSendWorker = QueueWorker<unknown, WaSingleSendJobResult>
type WaSessionRuntime = {
  sessionManager: SessionManager
  lifecycle: WaSessionLifecycleService
  phoneValidator: PhoneValidator
  messageSender: MessageSender
}

@Injectable()
class WaShutdownCoordinator implements OnApplicationShutdown {
  constructor(
    @Inject(WA_LIFECYCLE_WORKER)
    private readonly lifecycleWorker: WaLifecycleWorker,
    @Inject(WA_OWNER_LIFECYCLE_WORKER)
    private readonly ownerLifecycleWorker: WaLifecycleWorker,
    @Inject(WA_PHONE_VALIDATION_WORKER)
    private readonly phoneValidationWorker: WaPhoneValidationWorker,
    @Inject(WA_OWNER_PHONE_VALIDATION_WORKER)
    private readonly ownerPhoneValidationWorker: WaPhoneValidationWorker,
    @Inject(WA_SINGLE_SEND_WORKER)
    private readonly singleSendWorker: WaSingleSendWorker,
    @Inject(WA_OWNER_SINGLE_SEND_WORKER)
    private readonly ownerSingleSendWorker: WaSingleSendWorker,
    @Inject(WA_SESSION_LIFECYCLE)
    private readonly lifecycle: WaSessionLifecycleService,
    @Inject(WA_LIFECYCLE_QUEUE)
    private readonly lifecycleQueue: WaLifecycleQueue,
    @Inject(WA_PHONE_VALIDATION_QUEUE)
    private readonly phoneValidationQueue: WaPhoneValidationQueue,
    @Inject(WA_SINGLE_SEND_QUEUE)
    private readonly singleSendQueue: WaSingleSendQueue,
    @Inject(WA_REDIS_CONNECTION)
    private readonly connection: WaRedisConnection,
    @Inject(WA_WORKER_IDENTITY_LEASE)
    private readonly identityLease: WaWorkerIdentityLease,
    @Inject(WA_WORKER_IDENTITY_FATAL_HANDLER)
    private readonly terminate: WaWorkerIdentityFatalHandler,
    @Inject(WaTerminalFailureReconciler)
    private readonly terminalFailureReconciler: WaTerminalFailureReconciler,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.terminalFailureReconciler.stop()
    let firstError: unknown
    let hasError = false
    const attempt = async (
      step: string,
      operation: () => Promise<unknown>,
      timeoutMs?: number,
    ): Promise<boolean> => {
      try {
        const pending = operation()
        await (timeoutMs === undefined ? pending : completeWithin(pending, timeoutMs, step))
        return true
      } catch (error: unknown) {
        if (!hasError) {
          firstError = error
          hasError = true
        }
        return false
      }
    }

    await Promise.all([
      attempt(
        'pause shared lifecycle worker',
        async () => this.lifecycleWorker.pause?.(true),
        SHUTDOWN_PAUSE_TIMEOUT_MS,
      ),
      attempt(
        'pause owner lifecycle worker',
        async () => this.ownerLifecycleWorker.pause?.(true),
        SHUTDOWN_PAUSE_TIMEOUT_MS,
      ),
      attempt(
        'pause phone validation worker',
        async () => this.phoneValidationWorker.pause?.(true),
        SHUTDOWN_PAUSE_TIMEOUT_MS,
      ),
      attempt(
        'pause owner phone validation worker',
        async () => this.ownerPhoneValidationWorker.pause?.(true),
        SHUTDOWN_PAUSE_TIMEOUT_MS,
      ),
      attempt(
        'pause single-send worker',
        async () => this.singleSendWorker.pause?.(true),
        SHUTDOWN_PAUSE_TIMEOUT_MS,
      ),
      attempt(
        'pause owner single-send worker',
        async () => this.ownerSingleSendWorker.pause?.(true),
        SHUTDOWN_PAUSE_TIMEOUT_MS,
      ),
    ])
    const sessionsClosed = await attempt(
      'close WA sessions',
      () => this.lifecycle.shutdownAll(),
      SHUTDOWN_LIFECYCLE_TIMEOUT_MS,
    )
    const [
      lifecycleWorkerClosed,
      ownerLifecycleWorkerClosed,
      phoneValidationWorkerClosed,
      ownerPhoneValidationWorkerClosed,
      singleSendWorkerClosed,
      ownerSingleSendWorkerClosed,
    ] = await Promise.all([
      attempt(
        'close shared lifecycle worker',
        () => this.lifecycleWorker.close(true),
        SHUTDOWN_WORKER_CLOSE_TIMEOUT_MS,
      ),
      attempt(
        'close owner lifecycle worker',
        () => this.ownerLifecycleWorker.close(true),
        SHUTDOWN_WORKER_CLOSE_TIMEOUT_MS,
      ),
      attempt(
        'close phone validation worker',
        () => this.phoneValidationWorker.close(true),
        SHUTDOWN_WORKER_CLOSE_TIMEOUT_MS,
      ),
      attempt(
        'close owner phone validation worker',
        () => this.ownerPhoneValidationWorker.close(true),
        SHUTDOWN_WORKER_CLOSE_TIMEOUT_MS,
      ),
      attempt(
        'close single-send worker',
        () => this.singleSendWorker.close(true),
        SHUTDOWN_WORKER_CLOSE_TIMEOUT_MS,
      ),
      attempt(
        'close owner single-send worker',
        () => this.ownerSingleSendWorker.close(true),
        SHUTDOWN_WORKER_CLOSE_TIMEOUT_MS,
      ),
    ])
    const canReleaseIdentity =
      sessionsClosed &&
      lifecycleWorkerClosed &&
      ownerLifecycleWorkerClosed &&
      phoneValidationWorkerClosed &&
      ownerPhoneValidationWorkerClosed &&
      singleSendWorkerClosed &&
      ownerSingleSendWorkerClosed
    if (canReleaseIdentity) {
      await attempt('release worker identity', () => this.identityLease.release())
    } else {
      this.identityLease.stopRenewal()
      await settleWithin(
        Promise.resolve().then(() => this.terminate(toError(firstError))),
        IDENTITY_FATAL_HANDLER_GRACE_MS,
      )
    }
    await attempt('close lifecycle queue', () => this.lifecycleQueue.close())
    await attempt('close phone validation queue', () => this.phoneValidationQueue.close())
    await attempt('close single-send queue', () => this.singleSendQueue.close())
    await attempt('close Redis connection', () => this.connection.quit())
    await attempt('disconnect Prisma', () => prisma.$disconnect())

    if (hasError) throw firstError
  }
}

@Module({
  controllers: [WaAccountController, WaOperationsController],
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
    WaIncomingEventReceiver,
    {
      provide: WA_SESSION_RUNTIME,
      useFactory: (
        workerId: string,
        ownerRegistry: OwnerRegistry,
        authStateStore: WaAuthStateStore,
        ttlMs: number,
        statusRepository: WaAccountStatusRepository,
        qrBootstrapRepository: WaQrBootstrapRepository,
        receiver: WaReceiver,
        lifecycleQueue: WaLifecycleQueueService,
        _identityLease: WaWorkerIdentityLease,
        identityGate: WaWorkerIdentityLossGate,
      ): WaSessionRuntime =>
        createHealthySessionRuntime(
          identityGate,
          resolveWaSessionRuntimeMode(process.env.WA_SESSION_RUNTIME),
          {
            workerId,
            ownerRegistry,
            authStateStore,
            ttlMs,
            statusRepository,
            qrBootstrapRepository,
            receiver,
            restrictionRecoveryScheduler: {
              scheduleRestrictedRecovery: async (instanceId, restrictedUntil): Promise<void> => {
                await lifecycleQueue.enqueueRestrictedRecovery(instanceId, restrictedUntil)
              },
            },
          },
        ),
      inject: [
        WA_WORKER_ID,
        WA_OWNER_REGISTRY,
        WA_AUTH_STATE_STORE,
        WA_OWNER_TTL_MS,
        WA_STATUS_REPOSITORY,
        WA_QR_BOOTSTRAP_REPOSITORY,
        WaIncomingEventReceiver,
        WaLifecycleQueueService,
        WA_WORKER_IDENTITY_LEASE,
        WaWorkerIdentityLossGate,
      ],
    },
    {
      provide: WA_SESSION_MANAGER,
      useFactory: (runtime: WaSessionRuntime): SessionManager => runtime.sessionManager,
      inject: [WA_SESSION_RUNTIME],
    },
    {
      provide: WA_SESSION_LIFECYCLE,
      useFactory: (runtime: WaSessionRuntime): WaSessionLifecycleService => runtime.lifecycle,
      inject: [WA_SESSION_RUNTIME],
    },
    {
      provide: WA_PHONE_VALIDATOR,
      useFactory: (runtime: WaSessionRuntime): PhoneValidator => runtime.phoneValidator,
      inject: [WA_SESSION_RUNTIME],
    },
    {
      provide: WA_MESSAGE_SENDER,
      useFactory: (runtime: WaSessionRuntime): MessageSender => runtime.messageSender,
      inject: [WA_SESSION_RUNTIME],
    },
    {
      provide: PrismaWaPhoneValidationRepository,
      useFactory: (): PrismaWaPhoneValidationRepository => new PrismaWaPhoneValidationRepository(),
    },
    WaPhoneValidationAccountSelector,
    WaPhoneValidationQueueService,
    WaPhoneValidationJobProcessor,
    {
      provide: PrismaWaSingleSendRepository,
      useFactory: (): PrismaWaSingleSendRepository => new PrismaWaSingleSendRepository(),
    },
    WaSingleSendQueueService,
    WaSingleSendJobProcessor,
    WaTerminalFailureReconciler,
    WaLifecycleCommandService,
    WaLifecycleJobProcessor,
    InternalWorkerApiGuard,
    {
      provide: PrismaWaAccountCommandGuard,
      useFactory: (): PrismaWaAccountCommandGuard => new PrismaWaAccountCommandGuard(),
    },
    {
      provide: PrismaWaRestrictedRecoveryService,
      useFactory: (): PrismaWaRestrictedRecoveryService => new PrismaWaRestrictedRecoveryService(),
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
      provide: WA_PHONE_VALIDATION_QUEUE,
      useFactory: (redis: WaRedisConnection): WaPhoneValidationQueue =>
        createQueue<WaPhoneValidationJobPayload>(WA_PHONE_VALIDATION_QUEUE_NAME, redis),
      inject: [WA_REDIS_CONNECTION],
    },
    {
      provide: WA_SINGLE_SEND_QUEUE,
      useFactory: (redis: WaRedisConnection): WaSingleSendQueue =>
        createQueue<WaSingleSendJobPayload>(WA_SINGLE_SEND_QUEUE_NAME, redis),
      inject: [WA_REDIS_CONNECTION],
    },
    {
      provide: WA_SINGLE_SEND_QUEUE_FACTORY,
      useFactory:
        (redis: WaRedisConnection): WaSingleSendQueueFactory =>
        (queueName) =>
          createQueue<WaSingleSendOwnerJobPayload>(queueName, redis),
      inject: [WA_REDIS_CONNECTION],
    },
    {
      provide: WA_SINGLE_SEND_QUEUE_EVENTS_FACTORY,
      useFactory:
        (redis: WaRedisConnection): WaSingleSendQueueEventsFactory =>
        (queueName) =>
          createQueueEvents(queueName, redis),
      inject: [WA_REDIS_CONNECTION],
    },
    {
      provide: WA_PHONE_VALIDATION_QUEUE_FACTORY,
      useFactory:
        (redis: WaRedisConnection): WaPhoneValidationQueueFactory =>
        (queueName) =>
          createQueue<WaPhoneValidationOwnerJobPayload>(queueName, redis),
      inject: [WA_REDIS_CONNECTION],
    },
    {
      provide: WA_PHONE_VALIDATION_QUEUE_EVENTS_FACTORY,
      useFactory:
        (redis: WaRedisConnection): WaPhoneValidationQueueEventsFactory =>
        (queueName) =>
          createQueueEvents(queueName, redis),
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
    {
      provide: WaRestrictedRecoveryReconciler,
      useFactory: (queueService: WaLifecycleQueueService): WaRestrictedRecoveryReconciler =>
        new WaRestrictedRecoveryReconciler(queueService),
      inject: [WaLifecycleQueueService],
    },
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
      provide: WA_PHONE_VALIDATION_WORKER,
      useFactory: (
        redis: WaRedisConnection,
        processor: WaPhoneValidationJobProcessor,
        _identityLease: WaWorkerIdentityLease,
        identityGate: WaWorkerIdentityLossGate,
      ): WaPhoneValidationWorker => {
        identityGate.assertHealthy()
        const worker = createWorker<unknown, WaPhoneValidationJobResult>(
          WA_PHONE_VALIDATION_QUEUE_NAME,
          (job) => {
            identityGate.assertHealthy()
            return processor.process(job)
          },
          redis,
          { autorun: false },
        )
        worker.on('failed', (job, error) => {
          if (!job) return
          void processor.handleFailed(job, error).catch(() => {
            console.error('WA phone validation failure reconciliation failed')
          })
        })
        return worker
      },
      inject: [
        WA_REDIS_CONNECTION,
        WaPhoneValidationJobProcessor,
        WA_WORKER_IDENTITY_LEASE,
        WaWorkerIdentityLossGate,
      ],
    },
    {
      provide: WA_OWNER_PHONE_VALIDATION_WORKER,
      useFactory: (
        redis: WaRedisConnection,
        processor: WaPhoneValidationJobProcessor,
        workerId: string,
        _identityLease: WaWorkerIdentityLease,
        identityGate: WaWorkerIdentityLossGate,
      ): WaPhoneValidationWorker => {
        identityGate.assertHealthy()
        return createWorker<unknown, WaPhoneValidationJobResult>(
          createWaPhoneValidationOwnerQueueName(workerId),
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
        WaPhoneValidationJobProcessor,
        WA_WORKER_ID,
        WA_WORKER_IDENTITY_LEASE,
        WaWorkerIdentityLossGate,
      ],
    },
    {
      provide: WA_SINGLE_SEND_WORKER,
      useFactory: (
        redis: WaRedisConnection,
        processor: WaSingleSendJobProcessor,
        _identityLease: WaWorkerIdentityLease,
        identityGate: WaWorkerIdentityLossGate,
      ): WaSingleSendWorker => {
        identityGate.assertHealthy()
        const worker = createWorker<unknown, WaSingleSendJobResult>(
          WA_SINGLE_SEND_QUEUE_NAME,
          (job) => {
            identityGate.assertHealthy()
            return processor.process(job)
          },
          redis,
          { autorun: false },
        )
        worker.on('failed', (job, error) => {
          if (!job) return
          void processor.handleFailed(job, error).catch(() => {
            console.error('WA single-send failure reconciliation failed')
          })
        })
        return worker
      },
      inject: [
        WA_REDIS_CONNECTION,
        WaSingleSendJobProcessor,
        WA_WORKER_IDENTITY_LEASE,
        WaWorkerIdentityLossGate,
      ],
    },
    {
      provide: WA_OWNER_SINGLE_SEND_WORKER,
      useFactory: (
        redis: WaRedisConnection,
        processor: WaSingleSendJobProcessor,
        workerId: string,
        _identityLease: WaWorkerIdentityLease,
        identityGate: WaWorkerIdentityLossGate,
      ): WaSingleSendWorker => {
        identityGate.assertHealthy()
        return createWorker<unknown, WaSingleSendJobResult>(
          createWaSingleSendOwnerQueueName(workerId),
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
        WaSingleSendJobProcessor,
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
        phoneValidationWorker: WaPhoneValidationWorker,
        ownerPhoneValidationWorker: WaPhoneValidationWorker,
        singleSendWorker: WaSingleSendWorker,
        ownerSingleSendWorker: WaSingleSendWorker,
        lifecycle: WaSessionLifecycleService,
        lossGate: WaWorkerIdentityLossGate,
        terminate: WaWorkerIdentityFatalHandler,
        restrictedRecoveryReconciler: WaRestrictedRecoveryReconciler,
        terminalFailureReconciler: WaTerminalFailureReconciler,
      ): Promise<WaWorkerIdentityLossSupervisor> => {
        if (process.env.NODE_ENV !== 'test') {
          await restrictedRecoveryReconciler.reconcile()
          await terminalFailureReconciler.reconcile()
        }
        const supervisor = new WaWorkerIdentityLossSupervisor(
          lifecycleWorker,
          ownerLifecycleWorker,
          lifecycle,
          terminate,
        ).addIntakeWorkers(
          phoneValidationWorker,
          ownerPhoneValidationWorker,
          singleSendWorker,
          ownerSingleSendWorker,
        )
        await lossGate.bind((error) => supervisor.reportLoss(error))
        lossGate.assertHealthy()
        startWorker(lifecycleWorker, supervisor)
        startWorker(ownerLifecycleWorker, supervisor)
        startWorker(phoneValidationWorker, supervisor)
        startWorker(ownerPhoneValidationWorker, supervisor)
        startWorker(singleSendWorker, supervisor)
        startWorker(ownerSingleSendWorker, supervisor)
        if (process.env.NODE_ENV !== 'test') terminalFailureReconciler.start()
        return supervisor
      },
      inject: [
        WA_LIFECYCLE_WORKER,
        WA_OWNER_LIFECYCLE_WORKER,
        WA_PHONE_VALIDATION_WORKER,
        WA_OWNER_PHONE_VALIDATION_WORKER,
        WA_SINGLE_SEND_WORKER,
        WA_OWNER_SINGLE_SEND_WORKER,
        WA_SESSION_LIFECYCLE,
        WaWorkerIdentityLossGate,
        WA_WORKER_IDENTITY_FATAL_HANDLER,
        WaRestrictedRecoveryReconciler,
        WaTerminalFailureReconciler,
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
    WA_PHONE_VALIDATOR,
    WA_MESSAGE_SENDER,
    PrismaWaPhoneValidationRepository,
    WaPhoneValidationAccountSelector,
    WaPhoneValidationQueueService,
    WaPhoneValidationJobProcessor,
    PrismaWaSingleSendRepository,
    WaSingleSendQueueService,
    WaSingleSendJobProcessor,
    WaTerminalFailureReconciler,
    WaLifecycleCommandService,
    WaLifecycleJobProcessor,
    InternalWorkerApiGuard,
    PrismaWaAccountCommandGuard,
    PrismaWaRestrictedRecoveryService,
    PrismaWaAccountAdminService,
    WA_LIFECYCLE_QUEUE,
    WA_LIFECYCLE_QUEUE_EVENTS_FACTORY,
    WA_LIFECYCLE_QUEUE_FACTORY,
    WA_PHONE_VALIDATION_QUEUE,
    WA_PHONE_VALIDATION_QUEUE_EVENTS_FACTORY,
    WA_PHONE_VALIDATION_QUEUE_FACTORY,
    WA_SINGLE_SEND_QUEUE,
    WA_SINGLE_SEND_QUEUE_EVENTS_FACTORY,
    WA_SINGLE_SEND_QUEUE_FACTORY,
    WaLifecycleQueueService,
    WaRestrictedRecoveryReconciler,
    WaLifecycleCommandQueueService,
    WA_LIFECYCLE_WORKER,
    WA_OWNER_LIFECYCLE_WORKER,
    WA_PHONE_VALIDATION_WORKER,
    WA_OWNER_PHONE_VALIDATION_WORKER,
    WA_SINGLE_SEND_WORKER,
    WA_OWNER_SINGLE_SEND_WORKER,
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

export type WaSessionRuntimeMode = 'mock' | 'baileys'

export function resolveWaSessionRuntimeMode(value: string | undefined): WaSessionRuntimeMode {
  if (value === undefined || value === '' || value === 'mock') return 'mock'
  if (value === 'baileys') return 'baileys'
  throw new Error('WA_SESSION_RUNTIME must be either mock or baileys')
}

function terminateWaWorkerProcess(error: Error): void {
  if (process.env.NODE_ENV === 'test') return
  process.exitCode = 1
  console.error('WA worker identity lease lost; terminating worker', error)
  process.kill(process.pid, 'SIGTERM')
}

function createHealthySessionRuntime(
  identityGate: WaWorkerIdentityLossGate,
  mode: WaSessionRuntimeMode,
  options: Parameters<typeof createBaileysSessionRuntime>[0],
): WaSessionRuntime {
  identityGate.assertHealthy()
  if (mode === 'baileys') return createBaileysSessionRuntime(options)

  const sessionManager = new MockSessionManager()
  const lifecycle = new WaSessionLifecycleService(
    options.workerId,
    options.ownerRegistry,
    sessionManager,
    options.ttlMs,
    options.statusRepository,
    options.qrBootstrapRepository,
    options.restrictionRecoveryScheduler,
  )
  return {
    sessionManager,
    lifecycle,
    phoneValidator: new UnavailablePhoneValidator(),
    messageSender: new UnavailableMessageSender(),
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error ?? 'WA shutdown failed'))
}

const IDENTITY_FATAL_HANDLER_GRACE_MS = 1_000

class WaShutdownStepTimeoutError extends Error {
  constructor(readonly step: string) {
    super(`WA shutdown step timed out: ${step}`)
    this.name = 'WaShutdownStepTimeoutError'
  }
}

function startWorker(
  worker: WaLifecycleWorker | WaPhoneValidationWorker | WaSingleSendWorker,
  supervisor: WaWorkerIdentityLossSupervisor,
): void {
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

async function completeWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
  step: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new WaShutdownStepTimeoutError(step)), timeoutMs)
    timeout.unref?.()
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
