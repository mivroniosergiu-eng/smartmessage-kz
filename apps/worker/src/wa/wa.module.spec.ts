import 'reflect-metadata'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { Test } from '@nestjs/testing'
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
  WA_REDIS_CONNECTION,
  WA_SESSION_LIFECYCLE,
  WA_SESSION_MANAGER,
  WA_STATUS_REPOSITORY,
  WA_WORKER_ID,
} from './wa.tokens'
import { WaModule } from './wa.module'
import { WA_LIFECYCLE_WORKER } from './wa.module'
import { PrismaWaAccountStatusRepository } from './prisma-wa-account-status.repository'
import { WaLifecycleCommandService } from './wa-lifecycle-command.service'
import { WaLifecycleJobProcessor } from './wa-lifecycle-job.processor'

const queueMock = vi.hoisted(() => {
  const workers: Array<{ close: ReturnType<typeof vi.fn> }> = []

  return {
    workers,
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
    createWorker: queueMock.createWorker,
  }
})

const originalWaWorkerId = process.env.WA_WORKER_ID
const originalWaOwnerTtlMs = process.env.WA_OWNER_TTL_MS

describe('WaModule', () => {
  afterEach(() => {
    restoreEnv()
    queueMock.createWorker.mockClear()
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
      expect(moduleRef.get(WA_SESSION_MANAGER)).toBeInstanceOf(MockSessionManager)
      expect(moduleRef.get(WA_SESSION_LIFECYCLE)).toBeInstanceOf(WaSessionLifecycleService)
      expect(moduleRef.get(WaLifecycleCommandService)).toBeInstanceOf(WaLifecycleCommandService)
      expect(moduleRef.get(WaLifecycleJobProcessor)).toBeInstanceOf(WaLifecycleJobProcessor)
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
        | ((job: { name: string; data: unknown }) => Promise<unknown>)
        | undefined
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

  it('keeps the worker wiring on the mock session manager without Baileys or real sockets', async () => {
    const workerPackageJson = JSON.parse(
      await readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as PackageJson
    const moduleSource = await readFile(path.join(process.cwd(), 'src/wa/wa.module.ts'), 'utf8')

    expect(workerPackageJson.dependencies).not.toHaveProperty('@whiskeysockets/baileys')
    expect(moduleSource).not.toContain('@whiskeysockets/baileys')
    expect(moduleSource).not.toContain('makeWASocket')
    expect(moduleSource).not.toContain('useMultiFileAuthState')

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
