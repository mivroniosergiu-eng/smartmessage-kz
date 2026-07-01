import 'reflect-metadata'
import { describe, it, expect } from 'vitest'
import { Test } from '@nestjs/testing'
import { AppModule } from './app.module'
import { HealthController } from './health.controller'
import { ShutdownService } from './shutdown.service'
import { parsePort } from './main'

describe('worker', () => {
  it('health returns ok', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const ctrl = moduleRef.get(HealthController)
    expect(ctrl.check()).toEqual({ status: 'ok' })
  })

  it('graceful shutdown calls onApplicationShutdown', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const app = moduleRef.createNestApplication()
    app.enableShutdownHooks()
    await app.init()
    const svc = app.get(ShutdownService)
    await app.close()
    expect(svc.shutdownSignal).toBe('manual')
  })

  it('parsePort rejects invalid worker ports', () => {
    expect(parsePort(undefined)).toBe(3001)
    expect(parsePort('3002')).toBe(3002)
    expect(() => parsePort('abc')).toThrow('Invalid PORT: abc')
    expect(() => parsePort('70000')).toThrow('Invalid PORT: 70000')
  })
})
