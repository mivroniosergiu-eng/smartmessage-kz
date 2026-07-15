import 'reflect-metadata'

import { Test } from '@nestjs/testing'
import { WaOwnershipError, type SessionState } from '@smartmessage/wa'
import { describe, expect, it, vi } from 'vitest'

import { WaLifecycleCommandService } from './wa-lifecycle-command.service'
import { WA_LIFECYCLE_WORKER, WA_OWNER_LIFECYCLE_WORKER, WaModule } from './wa.module'
import { WA_LIFECYCLE_QUEUE, WA_REDIS_CONNECTION, WA_SESSION_LIFECYCLE } from './wa.tokens'

describe('WaLifecycleCommandService', () => {
  it('startInstance calls lifecycle.start and returns the session state', async () => {
    const state = createSessionState('instance-1')
    const lifecycle = createLifecycleMock({ start: vi.fn(async () => state) })
    const service = new WaLifecycleCommandService(lifecycle)

    await expect(service.startInstance(' instance-1 ')).resolves.toEqual(state)
    expect(lifecycle.start).toHaveBeenCalledWith('instance-1')
  })

  it('rejects invalid instanceId before lifecycle call', async () => {
    const lifecycle = createLifecycleMock()
    const service = new WaLifecycleCommandService(lifecycle)

    await expect(service.startInstance('   ')).rejects.toThrow(
      'instanceId must be a non-empty string',
    )
    expect(lifecycle.start).not.toHaveBeenCalled()
    expect(lifecycle.stop).not.toHaveBeenCalled()
    expect(lifecycle.logout).not.toHaveBeenCalled()
    expect(lifecycle.renew).not.toHaveBeenCalled()
  })

  it('propagates ownership errors from lifecycle.start', async () => {
    const error = new WaOwnershipError('instance-2', 'worker-a', 'worker-b')
    const lifecycle = createLifecycleMock({ start: vi.fn(async () => Promise.reject(error)) })
    const service = new WaLifecycleCommandService(lifecycle)

    await expect(service.startInstance('instance-2')).rejects.toBe(error)
  })

  it('stopInstance, logoutInstance and renewInstance call lifecycle', async () => {
    const lifecycle = createLifecycleMock({
      stop: vi.fn(async () => true),
      logout: vi.fn(async () => true),
      renew: vi.fn(async () => false),
    })
    const service = new WaLifecycleCommandService(lifecycle)

    await expect(service.stopInstance(' instance-3 ')).resolves.toBe(true)
    await expect(service.logoutInstance(' instance-3 ', 7n)).resolves.toBe(true)
    await expect(service.renewInstance(' instance-3 ')).resolves.toBe(false)
    expect(lifecycle.stop).toHaveBeenCalledWith('instance-3')
    expect(lifecycle.logout).toHaveBeenCalledWith('instance-3', 7n)
    expect(lifecycle.renew).toHaveBeenCalledWith('instance-3')
  })

  it('is available from the Nest WA module without opening a real transport in tests', async () => {
    const lifecycle = createLifecycleMock({
      start: vi.fn(async (instanceId) => createSessionState(instanceId)),
    })

    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(createFakeRedisConnection())
      .overrideProvider(WA_SESSION_LIFECYCLE)
      .useValue(lifecycle)
      .overrideProvider(WA_LIFECYCLE_QUEUE)
      .useValue({ add: vi.fn(), close: vi.fn(async () => undefined) })
      .overrideProvider(WA_LIFECYCLE_WORKER)
      .useValue({ close: vi.fn(async () => undefined), run: vi.fn(async () => undefined) })
      .overrideProvider(WA_OWNER_LIFECYCLE_WORKER)
      .useValue({ close: vi.fn(async () => undefined), run: vi.fn(async () => undefined) })
      .compile()

    try {
      const service = moduleRef.get(WaLifecycleCommandService)
      await expect(service.startInstance('instance-4')).resolves.toMatchObject({
        instanceId: 'instance-4',
        status: 'connected',
        hasAuthState: true,
      })
      expect(lifecycle.start).toHaveBeenCalledWith('instance-4')
    } finally {
      await moduleRef.close()
    }
  })
})

function createLifecycleMock(overrides: Partial<LifecycleMock> = {}): LifecycleMock {
  return {
    start: vi.fn(async () => createSessionState('default-instance')),
    stop: vi.fn(async () => false),
    logout: vi.fn(async () => false),
    renew: vi.fn(async () => false),
    shutdownAll: vi.fn(async () => undefined),
    ...overrides,
  }
}

function createSessionState(instanceId: string): SessionState {
  return {
    instanceId,
    status: 'connected',
    hasAuthState: true,
    logoutCount: 0,
  }
}

function createFakeRedisConnection(): unknown {
  return {
    eval: async () => 1,
    get: async () => null,
    quit: async () => 'OK',
  }
}

interface LifecycleMock {
  start: ReturnType<typeof vi.fn<(instanceId: string) => Promise<SessionState>>>
  stop: ReturnType<typeof vi.fn<(instanceId: string) => Promise<boolean>>>
  logout: ReturnType<typeof vi.fn<(instanceId: string, expectedEpoch?: bigint) => Promise<boolean>>>
  renew: ReturnType<typeof vi.fn<(instanceId: string) => Promise<boolean>>>
  shutdownAll: ReturnType<typeof vi.fn<() => Promise<void>>>
}
