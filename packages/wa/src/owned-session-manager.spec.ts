import { describe, expect, it, vi } from 'vitest'

import type { OwnerClaimResult, OwnerRegistry } from './owner-registry'
import { OwnedSessionManager, WaOwnershipError } from './owned-session-manager'
import { MockSessionManager } from './session'

class FakeOwnerRegistry implements OwnerRegistry {
  private readonly owners = new Map<string, string>()

  async claim(instanceId: string, workerId: string): Promise<OwnerClaimResult> {
    const owner = this.owners.get(instanceId)
    if (owner && owner !== workerId) return { claimed: false, owner }

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

  setOwner(instanceId: string, workerId: string): void {
    this.owners.set(instanceId, workerId)
  }

  clearOwner(instanceId: string): void {
    this.owners.delete(instanceId)
  }
}

describe('OwnedSessionManager', () => {
  it('allows the owner worker to connect', async () => {
    const { manager, registry } = createHarness('worker-a')
    registry.setOwner('instance-1', 'worker-a')

    const state = await manager.connect('instance-1')

    expect(state.status).toBe('connected')
    expect(state.hasAuthState).toBe(true)
  })

  it('rejects connect from a non-owner worker before touching the inner manager', async () => {
    const { manager, registry, inner } = createHarness('worker-b')
    registry.setOwner('instance-2', 'worker-a')
    const connect = vi.spyOn(inner, 'connect')

    await expect(manager.connect('instance-2')).rejects.toBeInstanceOf(WaOwnershipError)
    await expect(manager.connect('instance-2')).rejects.toMatchObject({
      instanceId: 'instance-2',
      workerId: 'worker-b',
      owner: 'worker-a',
    })
    expect(connect).not.toHaveBeenCalled()
  })

  it('allows the owner worker to handle a transient disconnect without logging out', async () => {
    const { manager, registry } = createHarness('worker-a')
    registry.setOwner('instance-3', 'worker-a')
    await manager.connect('instance-3')

    const state = await manager.handleDisconnect('instance-3', 'transient')

    expect(state.status).toBe('disconnected')
    expect(state.hasAuthState).toBe(true)
    expect(state.logoutCount).toBe(0)
    expect(state.lastDisconnectReason).toBe('transient')
  })

  it('allows the owner worker to close runtime transport without logging out', async () => {
    const { manager, registry } = createHarness('worker-a')
    registry.setOwner('instance-transport', 'worker-a')
    await manager.connect('instance-transport')

    const state = await manager.closeTransport('instance-transport')

    expect(state.status).toBe('disconnected')
    expect(state.hasAuthState).toBe(true)
    expect(state.logoutCount).toBe(0)
    expect(state.lastDisconnectReason).toBe('connection_closed')
  })

  it('rejects closeTransport from a non-owner worker before touching the inner manager', async () => {
    const { manager, registry, inner } = createHarness('worker-b')
    registry.setOwner('instance-transport-foreign', 'worker-a')
    const closeTransport = vi.spyOn(inner, 'closeTransport')

    await expect(manager.closeTransport('instance-transport-foreign')).rejects.toBeInstanceOf(WaOwnershipError)
    expect(closeTransport).not.toHaveBeenCalled()
  })

  it('rejects logout from a non-owner worker before touching the inner manager', async () => {
    const { manager, registry, inner } = createHarness('worker-b')
    registry.setOwner('instance-4', 'worker-a')
    const logout = vi.spyOn(inner, 'logout')

    await expect(manager.logout('instance-4')).rejects.toBeInstanceOf(WaOwnershipError)
    expect(logout).not.toHaveBeenCalled()
  })

  it('rejects side effects when the owner lease is missing or expired', async () => {
    const { manager, registry, inner } = createHarness('worker-a')
    registry.setOwner('instance-5', 'worker-a')
    registry.clearOwner('instance-5')
    const connect = vi.spyOn(inner, 'connect')
    const closeTransport = vi.spyOn(inner, 'closeTransport')
    const disconnect = vi.spyOn(inner, 'handleDisconnect')
    const logout = vi.spyOn(inner, 'logout')

    await expect(manager.connect('instance-5')).rejects.toMatchObject({ owner: null })
    await expect(manager.closeTransport('instance-5')).rejects.toMatchObject({ owner: null })
    await expect(manager.handleDisconnect('instance-5', 'connection_closed')).rejects.toMatchObject({ owner: null })
    await expect(manager.logout('instance-5')).rejects.toMatchObject({ owner: null })
    expect(connect).not.toHaveBeenCalled()
    expect(closeTransport).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
    expect(logout).not.toHaveBeenCalled()
  })

  it('allows read-only getState without an owner lease', async () => {
    const { manager, inner } = createHarness('worker-a')
    await inner.connect('instance-6')

    const state = await manager.getState('instance-6')

    expect(state.status).toBe('connected')
    expect(state.hasAuthState).toBe(true)
  })
})

function createHarness(workerId: string): {
  inner: MockSessionManager
  registry: FakeOwnerRegistry
  manager: OwnedSessionManager
} {
  const inner = new MockSessionManager()
  const registry = new FakeOwnerRegistry()
  const manager = new OwnedSessionManager(inner, registry, workerId)

  return { inner, registry, manager }
}
