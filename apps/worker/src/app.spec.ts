import 'reflect-metadata'
import { describe, it, expect } from 'vitest'
import { Test } from '@nestjs/testing'
import { AppModule } from './app.module'
import { HealthController } from './health.controller'
import { ShutdownService } from './shutdown.service'

describe('worker', () => {
  it('health возвращает ok', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const ctrl = moduleRef.get(HealthController)
    expect(ctrl.check()).toEqual({ status: 'ok' })
  })

  it('graceful shutdown вызывает onApplicationShutdown', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const app = moduleRef.createNestApplication()
    app.enableShutdownHooks()
    await app.init()
    const svc = app.get(ShutdownService)
    await app.close()
    expect(svc.shutdownSignal).toBe('manual')
  })
})
