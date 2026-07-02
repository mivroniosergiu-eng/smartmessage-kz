import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common'
import { WA_LIFECYCLE_QUEUE_NAME, createConnection, createQueue, createWorker } from '@smartmessage/queue'
import type { Queue, WaLifecycleInstanceJobPayload, Worker as QueueWorker } from '@smartmessage/queue'
import {
  MockSessionManager,
  RedisOwnerRegistry,
  WaSessionLifecycleService,
  type OwnerRegistry,
  type SessionManager,
  type WaAccountStatusRepository,
} from '@smartmessage/wa'

import { PrismaWaAccountStatusRepository } from './prisma-wa-account-status.repository'
import { PrismaWaAccountCommandGuard } from './prisma-wa-account-command.guard'
import { PrismaWaAccountAdminService } from './prisma-wa-account-admin.service'
import {
  WA_OWNER_REGISTRY,
  WA_OWNER_TTL_MS,
  WA_LIFECYCLE_QUEUE,
  WA_REDIS_CONNECTION,
  WA_SESSION_LIFECYCLE,
  WA_SESSION_MANAGER,
  WA_STATUS_REPOSITORY,
  WA_WORKER_ID,
} from './wa.tokens'
import { WaLifecycleCommandService } from './wa-lifecycle-command.service'
import { WaLifecycleCommandQueueService } from './wa-lifecycle-command-queue.service'
import { WaLifecycleJobProcessor, type WaLifecycleJobResult } from './wa-lifecycle-job.processor'
import { WaLifecycleQueueService } from './wa-lifecycle-queue.service'

const DEFAULT_OWNER_TTL_MS = 30_000
export const WA_LIFECYCLE_WORKER = Symbol('WA_LIFECYCLE_WORKER')

type WaRedisConnection = ReturnType<typeof createConnection>
type WaLifecycleQueue = Queue<WaLifecycleInstanceJobPayload>
type WaLifecycleWorker = QueueWorker<unknown, WaLifecycleJobResult>

@Injectable()
class WaRedisConnectionShutdown implements OnApplicationShutdown {
  constructor(@Inject(WA_REDIS_CONNECTION) private readonly connection: WaRedisConnection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.quit()
  }
}

@Injectable()
class WaLifecycleWorkerShutdown implements OnApplicationShutdown {
  constructor(@Inject(WA_LIFECYCLE_WORKER) private readonly worker: WaLifecycleWorker) {}

  async onApplicationShutdown(): Promise<void> {
    await this.worker.close()
  }
}

@Injectable()
class WaLifecycleQueueShutdown implements OnApplicationShutdown {
  constructor(@Inject(WA_LIFECYCLE_QUEUE) private readonly queue: WaLifecycleQueue) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close()
  }
}

@Module({
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
    WaRedisConnectionShutdown,
    {
      provide: WA_OWNER_REGISTRY,
      useFactory: (redis: WaRedisConnection): OwnerRegistry => new RedisOwnerRegistry(redis),
      inject: [WA_REDIS_CONNECTION],
    },
    {
      provide: WA_SESSION_MANAGER,
      useFactory: (): SessionManager => new MockSessionManager(),
    },
    {
      provide: WA_STATUS_REPOSITORY,
      useFactory: (): WaAccountStatusRepository => new PrismaWaAccountStatusRepository(),
    },
    {
      provide: WA_SESSION_LIFECYCLE,
      useFactory: (
        workerId: string,
        ownerRegistry: OwnerRegistry,
        sessionManager: SessionManager,
        ttlMs: number,
        statusRepository: WaAccountStatusRepository,
      ): WaSessionLifecycleService =>
        new WaSessionLifecycleService(workerId, ownerRegistry, sessionManager, ttlMs, statusRepository),
      inject: [WA_WORKER_ID, WA_OWNER_REGISTRY, WA_SESSION_MANAGER, WA_OWNER_TTL_MS, WA_STATUS_REPOSITORY],
    },
    WaLifecycleCommandService,
    WaLifecycleJobProcessor,
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
    WaLifecycleQueueService,
    WaLifecycleCommandQueueService,
    WaLifecycleQueueShutdown,
    {
      provide: WA_LIFECYCLE_WORKER,
      useFactory: (redis: WaRedisConnection, processor: WaLifecycleJobProcessor): WaLifecycleWorker =>
        createWorker<unknown, WaLifecycleJobResult>(
          WA_LIFECYCLE_QUEUE_NAME,
          (job) => processor.process(job),
          redis,
        ),
      inject: [WA_REDIS_CONNECTION, WaLifecycleJobProcessor],
    },
    WaLifecycleWorkerShutdown,
  ],
  exports: [
    WA_WORKER_ID,
    WA_OWNER_TTL_MS,
    WA_REDIS_CONNECTION,
    WA_OWNER_REGISTRY,
    WA_SESSION_MANAGER,
    WA_STATUS_REPOSITORY,
    WA_SESSION_LIFECYCLE,
    WaLifecycleCommandService,
    WaLifecycleJobProcessor,
    PrismaWaAccountCommandGuard,
    PrismaWaAccountAdminService,
    WA_LIFECYCLE_QUEUE,
    WaLifecycleQueueService,
    WaLifecycleCommandQueueService,
    WA_LIFECYCLE_WORKER,
  ],
})
export class WaModule {}

export function resolveWaWorkerId(value: string | undefined): string {
  const workerId = value?.trim()
  return workerId && workerId.length > 0 ? workerId : `worker-${process.pid}`
}

export function resolveWaOwnerTtlMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_OWNER_TTL_MS

  const ttlMs = Number(value)
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError('WA_OWNER_TTL_MS must be a positive safe integer')
  }

  return ttlMs
}
