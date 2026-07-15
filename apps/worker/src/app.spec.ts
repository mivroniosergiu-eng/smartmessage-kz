import 'reflect-metadata'
import { describe, it, expect } from 'vitest'
import { Test } from '@nestjs/testing'
import { WaSessionLifecycleService } from '@smartmessage/wa'
import { AppModule } from './app.module'
import { HealthController } from './health.controller'
import { ShutdownService } from './shutdown.service'
import { parsePort } from './main'
import { WA_REDIS_CONNECTION, WA_SESSION_LIFECYCLE } from './wa/wa.tokens'

describe('worker', () => {
  it('health returns ok', async () => {
    const moduleRef = await createAppTestingModule()
    try {
      const ctrl = moduleRef.get(HealthController)
      expect(ctrl.check()).toEqual({ status: 'ok' })
    } finally {
      await moduleRef.close()
    }
  })

  it('graceful shutdown calls onApplicationShutdown', async () => {
    const moduleRef = await createAppTestingModule()
    const app = moduleRef.createNestApplication()
    app.enableShutdownHooks()
    await app.init()
    const svc = app.get(ShutdownService)
    await app.close()
    expect(svc.shutdownSignal).toBe('manual')
  })

  it('exposes the WA lifecycle provider through AppModule', async () => {
    const moduleRef = await createAppTestingModule()
    try {
      expect(moduleRef.get(WA_SESSION_LIFECYCLE)).toBeInstanceOf(WaSessionLifecycleService)
    } finally {
      await moduleRef.close()
    }
  })

  it('parsePort rejects invalid worker ports', () => {
    expect(parsePort(undefined)).toBe(3001)
    expect(parsePort('3002')).toBe(3002)
    expect(() => parsePort('abc')).toThrow('Invalid PORT: abc')
    expect(() => parsePort('70000')).toThrow('Invalid PORT: 70000')
  })
})

function createAppTestingModule(): ReturnType<
  ReturnType<typeof Test.createTestingModule>['compile']
> {
  return Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WA_REDIS_CONNECTION)
    .useValue(createFakeRedisConnection())
    .compile()
}

function createFakeRedisConnection(): unknown {
  return {
    eval: async () => 1,
    get: async () => null,
    quit: async () => 'OK',
  }
}
