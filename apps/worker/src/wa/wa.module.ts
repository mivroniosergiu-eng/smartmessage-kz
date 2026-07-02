import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common'
import { createConnection } from '@smartmessage/queue'
import {
  MockSessionManager,
  RedisOwnerRegistry,
  WaSessionLifecycleService,
  type OwnerRegistry,
  type SessionManager,
  type WaAccountStatusRepository,
} from '@smartmessage/wa'

import { PrismaWaAccountStatusRepository } from './prisma-wa-account-status.repository'
import {
  WA_OWNER_REGISTRY,
  WA_OWNER_TTL_MS,
  WA_REDIS_CONNECTION,
  WA_SESSION_LIFECYCLE,
  WA_SESSION_MANAGER,
  WA_STATUS_REPOSITORY,
  WA_WORKER_ID,
} from './wa.tokens'

const DEFAULT_OWNER_TTL_MS = 30_000

type WaRedisConnection = ReturnType<typeof createConnection>

@Injectable()
class WaRedisConnectionShutdown implements OnApplicationShutdown {
  constructor(@Inject(WA_REDIS_CONNECTION) private readonly connection: WaRedisConnection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.quit()
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
  ],
  exports: [
    WA_WORKER_ID,
    WA_OWNER_TTL_MS,
    WA_REDIS_CONNECTION,
    WA_OWNER_REGISTRY,
    WA_SESSION_MANAGER,
    WA_STATUS_REPOSITORY,
    WA_SESSION_LIFECYCLE,
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
