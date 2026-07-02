import 'reflect-metadata'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { Test } from '@nestjs/testing'
import { MockSessionManager, WaSessionLifecycleService } from '@smartmessage/wa'
import { afterEach, describe, expect, it } from 'vitest'

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
import { PrismaWaAccountStatusRepository } from './prisma-wa-account-status.repository'
import { WaLifecycleCommandService } from './wa-lifecycle-command.service'

const originalWaWorkerId = process.env.WA_WORKER_ID
const originalWaOwnerTtlMs = process.env.WA_OWNER_TTL_MS

describe('WaModule', () => {
  afterEach(() => {
    restoreEnv()
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
