import 'reflect-metadata'

import { Test } from '@nestjs/testing'
import { WaOwnershipError, type SessionState, type WaAccountStatusRepository, type OwnerRegistry } from '@smartmessage/wa'
import { describe, expect, it, vi } from 'vitest'

import { WaLifecycleCommandService } from './wa-lifecycle-command.service'
import { WaModule } from './wa.module'
import { WA_OWNER_REGISTRY, WA_REDIS_CONNECTION, WA_STATUS_REPOSITORY } from './wa.tokens'

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

    await expect(service.startInstance('   ')).rejects.toThrow('instanceId must be a non-empty string')
    expect(lifecycle.start).not.toHaveBeenCalled()
    expect(lifecycle.stop).not.toHaveBeenCalled()
    expect(lifecycle.renew).not.toHaveBeenCalled()
  })

  it('propagates ownership errors from lifecycle.start', async () => {
    const error = new WaOwnershipError('instance-2', 'worker-a', 'worker-b')
    const lifecycle = createLifecycleMock({ start: vi.fn(async () => Promise.reject(error)) })
    const service = new WaLifecycleCommandService(lifecycle)

    await expect(service.startInstance('instance-2')).rejects.toBe(error)
  })

  it('stopInstance and renewInstance call lifecycle', async () => {
    const lifecycle = createLifecycleMock({
      stop: vi.fn(async () => true),
      renew: vi.fn(async () => false),
    })
    const service = new WaLifecycleCommandService(lifecycle)

    await expect(service.stopInstance(' instance-3 ')).resolves.toBe(true)
    await expect(service.renewInstance(' instance-3 ')).resolves.toBe(false)
    expect(lifecycle.stop).toHaveBeenCalledWith('instance-3')
    expect(lifecycle.renew).toHaveBeenCalledWith('instance-3')
  })

  it('is available from the Nest WA module and starts through lifecycle wiring', async () => {
    const ownerRegistry = new FakeOwnerRegistry()
    const statusRepository = createStatusRepositoryMock()

    const moduleRef = await Test.createTestingModule({ imports: [WaModule] })
      .overrideProvider(WA_REDIS_CONNECTION)
      .useValue(createFakeRedisConnection())
      .overrideProvider(WA_OWNER_REGISTRY)
      .useValue(ownerRegistry)
      .overrideProvider(WA_STATUS_REPOSITORY)
      .useValue(statusRepository)
      .compile()

    try {
      const service = moduleRef.get(WaLifecycleCommandService)
      await expect(service.startInstance('instance-4')).resolves.toMatchObject({
        instanceId: 'instance-4',
        status: 'connected',
        hasAuthState: true,
      })
      expect(statusRepository.markConnecting).toHaveBeenCalledWith('instance-4', expect.stringMatching(/^worker-/))
      expect(statusRepository.markConnected).toHaveBeenCalledWith('instance-4', expect.stringMatching(/^worker-/))
    } finally {
      await moduleRef.close()
    }
  })
})

function createLifecycleMock(overrides: Partial<LifecycleMock> = {}): LifecycleMock {
  return {
    start: vi.fn(async () => createSessionState('default-instance')),
    stop: vi.fn(async () => false),
    renew: vi.fn(async () => false),
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

function createStatusRepositoryMock(): WaAccountStatusRepositoryMock {
  return {
    markConnecting: vi.fn(async () => undefined),
    markConnected: vi.fn(async () => undefined),
    markDisconnected: vi.fn(async () => undefined),
    markLoggedOut: vi.fn(async () => undefined),
    markRestricted: vi.fn(async () => undefined),
    markBanned: vi.fn(async () => undefined),
  }
}

function createFakeRedisConnection(): unknown {
  return {
    eval: async () => [1, 'worker-test'],
    get: async () => null,
    quit: async () => 'OK',
  }
}

interface LifecycleMock {
  start: ReturnType<typeof vi.fn<[string], Promise<SessionState>>>
  stop: ReturnType<typeof vi.fn<[string], Promise<boolean>>>
  renew: ReturnType<typeof vi.fn<[string], Promise<boolean>>>
}

type WaAccountStatusRepositoryMock = {
  [K in keyof WaAccountStatusRepository]: ReturnType<typeof vi.fn>
}

class FakeOwnerRegistry implements OwnerRegistry {
  private readonly owners = new Map<string, string>()

  async claim(instanceId: string, workerId: string): Promise<{ claimed: boolean; owner: string }> {
    const owner = this.owners.get(instanceId)
    if (owner && owner !== workerId) {
      return { claimed: false, owner }
    }

    this.owners.set(instanceId, workerId)
    return { claimed: true, owner: workerId }
  }

  async renew(instanceId: string, workerId: string): Promise<boolean> {
    return this.owners.get(instanceId) === workerId
  }

  async release(instanceId: string, workerId: string): Promise<boolean> {
    if (this.owners.get(instanceId) !== workerId) return false

    this.owners.delete(instanceId)
    return true
  }

  async getOwner(instanceId: string): Promise<string | null> {
    return this.owners.get(instanceId) ?? null
  }
}
