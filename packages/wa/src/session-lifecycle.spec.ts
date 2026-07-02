import { describe, expect, it, vi } from 'vitest'

import type { OwnerClaimResult, OwnerRegistry } from './owner-registry'
import { WaOwnershipError } from './owned-session-manager'
import { WaSessionLifecycleService } from './session-lifecycle'
import { MockSessionManager, type SessionState } from './session'

const ttlMs = 1_000

class FakeOwnerRegistry implements OwnerRegistry {
  private readonly owners = new Map<string, string>()

  readonly claims: Array<{ instanceId: string; workerId: string; ttlMs: number }> = []
  readonly renewals: Array<{ instanceId: string; workerId: string; ttlMs: number }> = []
  readonly releases: Array<{ instanceId: string; workerId: string }> = []

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
}

class FailingConnectSessionManager extends MockSessionManager {
  async connect(): Promise<SessionState> {
    throw new Error('connect failed')
  }
}

describe('WaSessionLifecycleService', () => {
  it('claims ownership then connects on start', async () => {
    const { lifecycle, registry, sessions } = createHarness('worker-a')
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
  })

  it('rejects start if another worker owns the lease', async () => {
    const { lifecycle, registry, sessions } = createHarness('worker-b')
    registry.setOwner('instance-2', 'worker-a')
    const connect = vi.spyOn(sessions, 'connect')

    await expect(lifecycle.start('instance-2')).rejects.toBeInstanceOf(WaOwnershipError)
    await expect(lifecycle.start('instance-2')).rejects.toMatchObject({
      instanceId: 'instance-2',
      workerId: 'worker-b',
      owner: 'worker-a',
    })
    expect(connect).not.toHaveBeenCalled()
    await expect(registry.getOwner('instance-2')).resolves.toBe('worker-a')
  })

  it('releases ownership for the active worker when connect fails', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new FailingConnectSessionManager()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs)

    await expect(lifecycle.start('instance-3')).rejects.toThrow('connect failed')

    expect(registry.releases).toEqual([{ instanceId: 'instance-3', workerId: 'worker-a' }])
    await expect(registry.getOwner('instance-3')).resolves.toBeNull()
  })

  it('renews only for the active owner', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const ownerLifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs)
    const foreignLifecycle = new WaSessionLifecycleService('worker-b', registry, sessions, ttlMs)
    await ownerLifecycle.start('instance-4')

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
    const ownerLifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs)
    const foreignLifecycle = new WaSessionLifecycleService('worker-b', registry, sessions, ttlMs)
    await ownerLifecycle.start('instance-5')

    await expect(foreignLifecycle.stop('instance-5')).resolves.toBe(false)
    await expect(registry.getOwner('instance-5')).resolves.toBe('worker-a')
    await expect(ownerLifecycle.stop('instance-5')).resolves.toBe(true)
    await expect(registry.getOwner('instance-5')).resolves.toBeNull()
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
  lifecycle: WaSessionLifecycleService
} {
  const registry = new FakeOwnerRegistry()
  const sessions = new MockSessionManager()
  const lifecycle = new WaSessionLifecycleService(workerId, registry, sessions, ttlMs)

  return { registry, sessions, lifecycle }
}
