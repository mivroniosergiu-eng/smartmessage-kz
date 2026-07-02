import { describe, expect, it, vi } from 'vitest'

import type { OwnerClaimResult, OwnerRegistry } from './owner-registry'
import { WaOwnershipError } from './owned-session-manager'
import { WaSessionLifecycleService } from './session-lifecycle'
import { MockSessionManager, type SessionState } from './session'
import { InMemoryWaAccountStatusRepository } from './status-repository'

const ttlMs = 1_000
const shortTtlMs = 10

class FakeOwnerRegistry implements OwnerRegistry {
  private readonly owners = new Map<string, string>()

  readonly claims: Array<{ instanceId: string; workerId: string; ttlMs: number }> = []
  readonly renewals: Array<{ instanceId: string; workerId: string; ttlMs: number }> = []
  readonly releases: Array<{ instanceId: string; workerId: string }> = []
  readonly events: string[] = []

  async claim(instanceId: string, workerId: string, ttl: number): Promise<OwnerClaimResult> {
    this.claims.push({ instanceId, workerId, ttlMs: ttl })
    const owner = this.owners.get(instanceId)
    if (owner && owner !== workerId) return { claimed: false, owner }

    this.owners.set(instanceId, workerId)
    return { claimed: true, owner: workerId }
  }

  async renew(instanceId: string, workerId: string, ttl: number): Promise<boolean> {
    this.renewals.push({ instanceId, workerId, ttlMs: ttl })
    return this.owners.get(instanceId) === workerId
  }

  async release(instanceId: string, workerId: string): Promise<boolean> {
    this.releases.push({ instanceId, workerId })
    this.events.push('release')
    if (this.owners.get(instanceId) !== workerId) return false

    this.owners.delete(instanceId)
    return true
  }

  async getOwner(instanceId: string): Promise<string | null> {
    return this.owners.get(instanceId) ?? null
  }

  setOwner(instanceId: string, workerId: string): void {
    this.owners.set(instanceId, workerId)
  }

  clearRenewals(): void {
    this.renewals.splice(0)
  }
}

class FailingConnectSessionManager extends MockSessionManager {
  async connect(_instanceId: string): Promise<SessionState> {
    throw new Error('connect failed')
  }
}

class FlakyConnectSessionManager extends MockSessionManager {
  private failuresRemaining: number

  constructor(failures: number) {
    super()
    this.failuresRemaining = failures
  }

  async connect(instanceId: string): Promise<SessionState> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error('transient connect failed')
    }

    return super.connect(instanceId)
  }
}

class DelayedConnectSessionManager extends MockSessionManager {
  constructor(private readonly delayMs: number) {
    super()
  }

  async connect(instanceId: string): Promise<SessionState> {
    await delay(this.delayMs)

    return super.connect(instanceId)
  }
}

class FailingCloseTransportSessionManager extends MockSessionManager {
  async closeTransport(_instanceId: string): Promise<SessionState> {
    throw new Error('close transport failed')
  }
}

describe('WaSessionLifecycleService', () => {
  it('claims ownership then connects on start', async () => {
    const { lifecycle, registry, sessions, statuses } = createHarness('worker-a')
    const connect = vi.spyOn(sessions, 'connect')

    const state = await lifecycle.start('instance-1')

    expect(registry.claims).toEqual([{ instanceId: 'instance-1', workerId: 'worker-a', ttlMs }])
    expect(connect).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledWith('instance-1')
    expect(state).toMatchObject({
      instanceId: 'instance-1',
      status: 'connected',
      hasAuthState: true,
    })
    await expect(registry.getOwner('instance-1')).resolves.toBe('worker-a')
    expect(statuses.getHistory('instance-1').map((entry) => entry.status)).toEqual(['connecting', 'connected'])
    expect(statuses.getLast('instance-1')).toMatchObject({
      instanceId: 'instance-1',
      workerId: 'worker-a',
      status: 'connected',
    })
  })

  it('rejects start if another worker owns the lease', async () => {
    const { lifecycle, registry, sessions, statuses } = createHarness('worker-b')
    registry.setOwner('instance-2', 'worker-a')
    const connect = vi.spyOn(sessions, 'connect')

    const error = await lifecycle.start('instance-2').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(WaOwnershipError)
    expect(error).toMatchObject({
      instanceId: 'instance-2',
      workerId: 'worker-b',
      owner: 'worker-a',
    })
    expect(connect).not.toHaveBeenCalled()
    expect(statuses.getHistory('instance-2')).toEqual([])
    await expect(registry.getOwner('instance-2')).resolves.toBe('worker-a')
  })

  it('renews ownership while a long-running connect is in progress', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new DelayedConnectSessionManager(30)
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, shortTtlMs)

    const state = await lifecycle.start('instance-long-connect')

    expect(state.status).toBe('connected')
    expect(registry.renewals.length).toBeGreaterThanOrEqual(2)
    expect(registry.renewals.every((renewal) => renewal.workerId === 'worker-a')).toBe(true)
    await expect(registry.getOwner('instance-long-connect')).resolves.toBe('worker-a')
  })

  it('retries transient connect failure and keeps ownership when a later attempt succeeds', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new FlakyConnectSessionManager(1)
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs)
    const connect = vi.spyOn(sessions, 'connect')

    const state = await lifecycle.start('instance-retry-success')

    expect(connect).toHaveBeenCalledTimes(2)
    expect(state.status).toBe('connected')
    expect(registry.releases).toEqual([])
    await expect(registry.getOwner('instance-retry-success')).resolves.toBe('worker-a')
  })

  it('releases ownership for the active worker after all connect attempts fail', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new FailingConnectSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs, statuses)
    const connect = vi.spyOn(sessions, 'connect')

    await expect(lifecycle.start('instance-3')).rejects.toThrow('connect failed')

    expect(connect).toHaveBeenCalledTimes(3)
    expect(statuses.getHistory('instance-3').map((entry) => entry.status)).toEqual(['connecting', 'disconnected'])
    expect(statuses.getLast('instance-3')).toMatchObject({
      instanceId: 'instance-3',
      workerId: 'worker-a',
      status: 'disconnected',
      reason: 'connect failed',
    })
    expect(registry.releases).toEqual([{ instanceId: 'instance-3', workerId: 'worker-a' }])
    await expect(registry.getOwner('instance-3')).resolves.toBeNull()
  })

  it('renews only for the active owner', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const ownerLifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs)
    const foreignLifecycle = new WaSessionLifecycleService('worker-b', registry, sessions, ttlMs)
    await ownerLifecycle.start('instance-4')
    registry.clearRenewals()

    await expect(ownerLifecycle.renew('instance-4')).resolves.toBe(true)
    await expect(foreignLifecycle.renew('instance-4')).resolves.toBe(false)

    expect(registry.renewals).toEqual([
      { instanceId: 'instance-4', workerId: 'worker-a', ttlMs },
      { instanceId: 'instance-4', workerId: 'worker-b', ttlMs },
    ])
    await expect(registry.getOwner('instance-4')).resolves.toBe('worker-a')
  })

  it('stops only the active owner', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const ownerLifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs, statuses)
    const foreignLifecycle = new WaSessionLifecycleService('worker-b', registry, sessions, ttlMs)
    await ownerLifecycle.start('instance-5')
    const closeTransport = vi.spyOn(sessions, 'closeTransport')
    const markDisconnected = vi.spyOn(statuses, 'markDisconnected')
    markDisconnected.mockImplementation(async (...args) => {
      registry.events.push('markDisconnected')
      return InMemoryWaAccountStatusRepository.prototype.markDisconnected.apply(statuses, args)
    })

    await expect(foreignLifecycle.stop('instance-5')).resolves.toBe(false)
    expect(closeTransport).not.toHaveBeenCalled()
    expect(markDisconnected).not.toHaveBeenCalled()
    expect(registry.releases).toEqual([])
    await expect(registry.getOwner('instance-5')).resolves.toBe('worker-a')
    await expect(ownerLifecycle.stop('instance-5')).resolves.toBe(true)
    expect(closeTransport).toHaveBeenCalledOnce()
    expect(closeTransport).toHaveBeenCalledWith('instance-5')
    await expect(sessions.getState('instance-5')).resolves.toMatchObject({
      status: 'disconnected',
      hasAuthState: true,
      logoutCount: 0,
    })
    expect(statuses.getLast('instance-5')).toMatchObject({
      instanceId: 'instance-5',
      workerId: 'worker-a',
      status: 'disconnected',
      reason: 'connection_closed',
    })
    expect(registry.events).toEqual(['markDisconnected', 'release'])
    await expect(registry.getOwner('instance-5')).resolves.toBeNull()
  })

  it('keeps ownership when stop cannot close transport', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new FailingCloseTransportSessionManager()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs)
    await lifecycle.start('instance-close-fail')
    registry.releases.splice(0)

    await expect(lifecycle.stop('instance-close-fail')).rejects.toThrow('close transport failed')

    expect(registry.releases).toEqual([])
    await expect(registry.getOwner('instance-close-fail')).resolves.toBe('worker-a')
  })

  it('allows repeated start by the same worker and repeats connect under the renewed lease', async () => {
    const { lifecycle, registry, sessions } = createHarness('worker-a')
    const connect = vi.spyOn(sessions, 'connect')

    await lifecycle.start('instance-6')
    const state = await lifecycle.start('instance-6')

    expect(registry.claims).toEqual([
      { instanceId: 'instance-6', workerId: 'worker-a', ttlMs },
      { instanceId: 'instance-6', workerId: 'worker-a', ttlMs },
    ])
    expect(connect).toHaveBeenCalledTimes(2)
    expect(state.status).toBe('connected')
    await expect(registry.getOwner('instance-6')).resolves.toBe('worker-a')
  })
})

function createHarness(workerId: string): {
  registry: FakeOwnerRegistry
  sessions: MockSessionManager
  statuses: InMemoryWaAccountStatusRepository
  lifecycle: WaSessionLifecycleService
} {
  const registry = new FakeOwnerRegistry()
  const sessions = new MockSessionManager()
  const statuses = new InMemoryWaAccountStatusRepository()
  const lifecycle = new WaSessionLifecycleService(workerId, registry, sessions, ttlMs, statuses)

  return { registry, sessions, statuses, lifecycle }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
