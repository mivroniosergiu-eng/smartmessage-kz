import { describe, expect, it, vi } from 'vitest'

import { InMemoryWaAuthStateStore } from './auth-state'
import type { OwnerClaimResult, OwnerRegistry } from './owner-registry'
import { InMemoryWaQrBootstrapRepository } from './qr-bootstrap'
import { createBaileysSessionRuntime } from './session-runtime'
import { InMemoryWaAccountStatusRepository } from './status-repository'
import type { WaTransportCallbacks, WaTransportFactory } from './transport'

describe('createBaileysSessionRuntime', () => {
  it('is inert until the lifecycle receives an explicit start command', async () => {
    const transport = createEventTransport()
    const runtime = createHarness(transport)

    await expect(runtime.sessionManager.getState('instance-idle')).resolves.toMatchObject({
      status: 'idle',
      hasAuthState: false,
    })
    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.closeTransport).not.toHaveBeenCalled()
    expect(transport.logout).not.toHaveBeenCalled()
  })

  it('persists QR and connected events immediately through the owned lifecycle', async () => {
    const transport = createEventTransport()
    const statuses = new InMemoryWaAccountStatusRepository()
    const qr = new InMemoryWaQrBootstrapRepository()
    const runtime = createHarness(transport, { statuses, qr })

    await runtime.lifecycle.start('instance-connect')
    const expiresAt = new Date('2999-07-15T12:00:00.000Z')
    await transport.emitQr('instance-connect', 'qr-fixture', expiresAt)

    await expect(qr.getLatest('instance-connect')).resolves.toMatchObject({
      qrCode: 'qr-fixture',
      expiresAt,
    })
    await transport.emitConnected('instance-connect')
    await waitUntil(async () => (await qr.getLatest('instance-connect')) === null)
    expect(statuses.getLast('instance-connect')).toMatchObject({
      status: 'connected',
      workerId: 'worker-runtime',
    })
    await runtime.lifecycle.stop('instance-connect')
  })

  it('restores persisted auth and reconnects a transient disconnect without logout', async () => {
    const auth = new InMemoryWaAuthStateStore()
    await auth.write('instance-restored', { creds: { registered: true }, keys: {} })
    const transport = createEventTransport(true)
    const runtime = createHarness(transport, { auth })

    await expect(runtime.sessionManager.getState('instance-restored')).resolves.toMatchObject({
      status: 'disconnected',
      hasAuthState: true,
    })
    await runtime.lifecycle.start('instance-restored')
    await transport.emitDisconnected('instance-restored', 'transient')
    await waitUntil(() => transport.connect.mock.calls.length === 2)

    expect(transport.connect).toHaveBeenCalledTimes(2)
    expect(transport.logout).not.toHaveBeenCalled()
    await expect(auth.has('instance-restored')).resolves.toBe(true)
    await runtime.lifecycle.stop('instance-restored')
  })

  it('drains a disconnect published before the initial connect call resolves', async () => {
    const auth = new InMemoryWaAuthStateStore()
    await auth.write('instance-early-disconnect', {
      creds: { registered: true },
      keys: {},
    })
    const transport = createEventTransport(true)
    transport.connect.mockImplementationOnce(async (instanceId, callbacks) => {
      await callbacks?.onDisconnected?.({ instanceId, reason: 'transient' })
      return {
        instanceId,
        status: 'connecting',
        hasAuthState: true,
        logoutCount: 0,
      }
    })
    const runtime = createHarness(transport, { auth })

    await runtime.lifecycle.start('instance-early-disconnect')
    await waitUntil(() => transport.connect.mock.calls.length === 2)

    expect(transport.connect).toHaveBeenCalledTimes(2)
    expect(transport.logout).not.toHaveBeenCalled()
    await runtime.lifecycle.stop('instance-early-disconnect')
  })
})

function createHarness(
  transport: EventTransport,
  overrides: {
    auth?: InMemoryWaAuthStateStore
    statuses?: InMemoryWaAccountStatusRepository
    qr?: InMemoryWaQrBootstrapRepository
  } = {},
) {
  return createBaileysSessionRuntime({
    workerId: 'worker-runtime',
    ownerRegistry: new MemoryOwnerRegistry(),
    authStateStore: overrides.auth ?? new InMemoryWaAuthStateStore(),
    ttlMs: 10_000,
    statusRepository: overrides.statuses ?? new InMemoryWaAccountStatusRepository(),
    qrBootstrapRepository: overrides.qr ?? new InMemoryWaQrBootstrapRepository(),
    transport,
  })
}

interface EventTransport extends WaTransportFactory {
  connect: ReturnType<typeof vi.fn<WaTransportFactory['connect']>>
  closeTransport: ReturnType<typeof vi.fn<WaTransportFactory['closeTransport']>>
  logout: ReturnType<typeof vi.fn<WaTransportFactory['logout']>>
  emitQr(instanceId: string, qrCode: string, expiresAt: Date): Promise<void>
  emitConnected(instanceId: string): Promise<void>
  emitDisconnected(instanceId: string, reason: 'transient'): Promise<void>
}

function createEventTransport(hasAuthState = false): EventTransport {
  const callbacks = new Map<string, WaTransportCallbacks>()
  const connect = vi.fn<WaTransportFactory['connect']>(async (instanceId, observers) => {
    callbacks.set(instanceId, observers ?? {})
    return {
      instanceId,
      status: 'connecting',
      hasAuthState,
      logoutCount: 0,
    }
  })
  const closeTransport = vi.fn<WaTransportFactory['closeTransport']>(async (instanceId) => ({
    instanceId,
    status: 'disconnected',
    hasAuthState,
    logoutCount: 0,
    lastDisconnectReason: 'connection_closed',
  }))
  const logout = vi.fn<WaTransportFactory['logout']>(async (instanceId) => ({
    instanceId,
    status: 'logged_out',
    hasAuthState: false,
    logoutCount: 1,
    lastDisconnectReason: 'logged_out',
  }))

  return {
    connect,
    closeTransport,
    logout,
    async emitQr(instanceId, qrCode, expiresAt) {
      await callbacks.get(instanceId)?.onQr?.({ instanceId, qrCode, expiresAt })
    },
    async emitConnected(instanceId) {
      await callbacks.get(instanceId)?.onConnected?.({
        instanceId,
        state: { instanceId, status: 'connected', hasAuthState: true, logoutCount: 0 },
      })
    },
    async emitDisconnected(instanceId, reason) {
      await callbacks.get(instanceId)?.onDisconnected?.({ instanceId, reason })
    },
  }
}

class MemoryOwnerRegistry implements OwnerRegistry {
  private readonly owners = new Map<string, string>()
  private readonly epochs = new Map<string, bigint>()

  async claim(
    instanceId: string,
    workerId: string,
    _ttlMs: number,
    minimumEpoch: bigint = 0n,
  ): Promise<OwnerClaimResult> {
    const owner = this.owners.get(instanceId)
    if (owner && owner !== workerId) {
      return { claimed: false, owner, epoch: this.epochs.get(instanceId) ?? 1n }
    }
    const currentEpoch = this.epochs.get(instanceId) ?? 0n
    const epoch =
      owner && currentEpoch > minimumEpoch
        ? currentEpoch
        : (currentEpoch > minimumEpoch ? currentEpoch : minimumEpoch) + 1n
    this.owners.set(instanceId, workerId)
    this.epochs.set(instanceId, epoch)
    return { claimed: true, owner: workerId, epoch }
  }

  async renew(
    instanceId: string,
    workerId: string,
    _ttlMs: number,
    epoch: bigint,
  ): Promise<boolean> {
    return this.owners.get(instanceId) === workerId && this.epochs.get(instanceId) === epoch
  }

  async release(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    if (this.owners.get(instanceId) !== workerId || this.epochs.get(instanceId) !== epoch)
      return false
    this.owners.delete(instanceId)
    return true
  }

  async getOwner(instanceId: string): Promise<string | null> {
    return this.owners.get(instanceId) ?? null
  }

  async getOwnership(instanceId: string) {
    const owner = this.owners.get(instanceId)
    return owner ? { owner, epoch: this.epochs.get(instanceId) ?? 1n } : null
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for runtime event')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
