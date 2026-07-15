import { describe, expect, it, vi } from 'vitest'

import type { OwnerClaimResult, OwnerRegistry } from './owner-registry'
import { WaOwnershipError } from './owned-session-manager'
import { InMemoryWaQrBootstrapRepository, type WaQrPendingEvent } from './qr-bootstrap'
import { WaSessionLifecycleService } from './session-lifecycle'
import { MockSessionManager, type SessionState } from './session'
import { InMemoryWaAccountStatusRepository } from './status-repository'

const ttlMs = 1_000
const shortTtlMs = 10

class FakeOwnerRegistry implements OwnerRegistry {
  private readonly owners = new Map<string, string>()
  private readonly epochs = new Map<string, bigint>()

  readonly claims: Array<{ instanceId: string; workerId: string; ttlMs: number }> = []
  readonly renewals: Array<{ instanceId: string; workerId: string; ttlMs: number }> = []
  readonly releases: Array<{ instanceId: string; workerId: string }> = []
  readonly events: string[] = []

  async claim(
    instanceId: string,
    workerId: string,
    ttl: number,
    minimumEpoch: bigint = 0n,
  ): Promise<OwnerClaimResult> {
    this.claims.push({ instanceId, workerId, ttlMs: ttl })
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

  async renew(instanceId: string, workerId: string, ttl: number, epoch: bigint): Promise<boolean> {
    this.renewals.push({ instanceId, workerId, ttlMs: ttl })
    return this.owners.get(instanceId) === workerId && this.epochs.get(instanceId) === epoch
  }

  async release(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    this.releases.push({ instanceId, workerId })
    this.events.push('release')
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

  setOwner(instanceId: string, workerId: string): void {
    if (this.owners.get(instanceId) !== workerId) {
      this.epochs.set(instanceId, (this.epochs.get(instanceId) ?? 0n) + 1n)
    }
    this.owners.set(instanceId, workerId)
  }

  advanceEpoch(instanceId: string, workerId: string): bigint {
    const epoch = (this.epochs.get(instanceId) ?? 0n) + 1n
    this.epochs.set(instanceId, epoch)
    this.owners.set(instanceId, workerId)
    return epoch
  }

  expireOwner(instanceId: string): void {
    this.owners.delete(instanceId)
  }

  clearRenewals(): void {
    this.renewals.splice(0)
  }
}

class FailingRenewOwnerRegistry extends FakeOwnerRegistry {
  failRenewals = false

  async renew(instanceId: string, workerId: string, ttl: number, epoch: bigint): Promise<boolean> {
    if (this.failRenewals) throw new Error('redis unavailable')
    return super.renew(instanceId, workerId, ttl, epoch)
  }
}

class DeferredClaimOwnerRegistry extends FakeOwnerRegistry {
  readonly claimStarted = createDeferred<void>()
  readonly releaseClaim = createDeferred<void>()

  async claim(instanceId: string, workerId: string, ttl: number): Promise<OwnerClaimResult> {
    this.claimStarted.resolve(undefined)
    await this.releaseClaim.promise
    return super.claim(instanceId, workerId, ttl)
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

class DeferredConnectSessionManager extends MockSessionManager {
  readonly connectStarted = createDeferred<void>()
  readonly releaseConnect = createDeferred<void>()

  async connect(instanceId: string): Promise<SessionState> {
    this.connectStarted.resolve(undefined)
    await this.releaseConnect.promise
    return super.connect(instanceId)
  }
}

class DelayedGetStateSessionManager extends MockSessionManager {
  constructor(private readonly delayMs: number) {
    super()
  }

  async getState(instanceId: string): Promise<SessionState> {
    await delay(this.delayMs)
    return super.getState(instanceId)
  }
}

class DeferredGetStateSessionManager extends MockSessionManager {
  readonly readStarted = createDeferred<void>()
  readonly releaseRead = createDeferred<void>()

  async getState(instanceId: string): Promise<SessionState> {
    this.readStarted.resolve(undefined)
    await this.releaseRead.promise
    return super.getState(instanceId)
  }
}

class FailingCloseTransportSessionManager extends MockSessionManager {
  closeCalls = 0

  async closeTransport(_instanceId: string): Promise<SessionState> {
    this.closeCalls += 1
    throw new Error('close transport failed')
  }
}

class HangingCloseTransportSessionManager extends MockSessionManager {
  closeCalls = 0

  async closeTransport(_instanceId: string): Promise<SessionState> {
    this.closeCalls += 1
    return new Promise<SessionState>(() => undefined)
  }
}

class DelayedCloseTransportSessionManager extends MockSessionManager {
  readonly closeCalls: string[] = []

  constructor(private readonly delayMs: number) {
    super()
  }

  async closeTransport(instanceId: string): Promise<SessionState> {
    this.closeCalls.push(instanceId)
    await delay(this.delayMs)
    return super.closeTransport(instanceId)
  }
}

class DeferredCloseTransportSessionManager extends MockSessionManager {
  readonly closeStarted = createDeferred<void>()
  readonly releaseClose = createDeferred<void>()

  async closeTransport(instanceId: string): Promise<SessionState> {
    this.closeStarted.resolve(undefined)
    await this.releaseClose.promise
    return super.closeTransport(instanceId)
  }
}

class FlakyCloseTransportSessionManager extends MockSessionManager {
  readonly closeCalls: string[] = []

  constructor(private failuresRemaining: number) {
    super()
  }

  async closeTransport(instanceId: string): Promise<SessionState> {
    this.closeCalls.push(instanceId)
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error('transient close failed')
    }

    return super.closeTransport(instanceId)
  }
}

class CloseThenFailOnceSessionManager extends MockSessionManager {
  readonly firstCloseFailed = createDeferred<void>()
  readonly closeCalls: string[] = []

  async closeTransport(instanceId: string): Promise<SessionState> {
    this.closeCalls.push(instanceId)
    const state = await super.closeTransport(instanceId)
    if (this.closeCalls.length === 1) {
      this.firstCloseFailed.resolve(undefined)
      throw new Error('close confirmation failed after physical close')
    }
    return state
  }
}

class EventDrivenSessionManager extends MockSessionManager {
  readonly connectCalls: string[] = []

  async connect(instanceId: string): Promise<SessionState> {
    this.connectCalls.push(instanceId)
    const state: SessionState = {
      instanceId,
      status: 'connecting',
      hasAuthState: true,
      logoutCount: 0,
    }
    this.seed(state)
    return { ...state }
  }
}

class DelayedEventDrivenSessionManager extends EventDrivenSessionManager {
  maxConcurrentConnects = 0
  private concurrentConnects = 0

  constructor(private readonly delayMs: number) {
    super()
  }

  async connect(instanceId: string): Promise<SessionState> {
    this.concurrentConnects += 1
    this.maxConcurrentConnects = Math.max(this.maxConcurrentConnects, this.concurrentConnects)
    try {
      await delay(this.delayMs)
      return await super.connect(instanceId)
    } finally {
      this.concurrentConnects -= 1
    }
  }
}

class FailingConnectedStatusRepository extends InMemoryWaAccountStatusRepository {
  failConnected = false

  async markConnected(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    if (this.failConnected) throw new Error('status store unavailable')
    return super.markConnected(instanceId, workerId, epoch)
  }
}

class DeferredDisconnectedStatusRepository extends InMemoryWaAccountStatusRepository {
  readonly writeStarted = createDeferred<void>()
  readonly releaseWrite = createDeferred<void>()

  async markDisconnected(
    instanceId: string,
    workerId: string,
    reason: string | undefined,
    epoch: bigint,
  ): Promise<boolean> {
    this.writeStarted.resolve(undefined)
    await this.releaseWrite.promise
    return super.markDisconnected(instanceId, workerId, reason, epoch)
  }
}

class DeferredConnectedStatusRepository extends InMemoryWaAccountStatusRepository {
  readonly writeStarted = createDeferred<void>()
  readonly releaseWrite = createDeferred<void>()

  async markConnected(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    this.writeStarted.resolve(undefined)
    await this.releaseWrite.promise
    return super.markConnected(instanceId, workerId, epoch)
  }
}

class RacingOwnershipStatusRepository extends InMemoryWaAccountStatusRepository {
  private raced = false

  async activateOwnership(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    if (!this.raced) {
      this.raced = true
      await super.activateOwnership(instanceId, 'worker-racer', epoch + 1n)
      return false
    }
    return super.activateOwnership(instanceId, workerId, epoch)
  }
}

class AlwaysRacingOwnershipStatusRepository extends InMemoryWaAccountStatusRepository {
  async activateOwnership(instanceId: string, _workerId: string, epoch: bigint): Promise<boolean> {
    await super.activateOwnership(instanceId, 'worker-racer', epoch + 1n)
    return false
  }
}

class FailOnceDisconnectedStatusRepository extends InMemoryWaAccountStatusRepository {
  private fail = true

  async markDisconnected(
    instanceId: string,
    workerId: string,
    reason: string | undefined,
    epoch: bigint,
  ): Promise<boolean> {
    if (this.fail) {
      this.fail = false
      throw new Error('status stop failed')
    }
    return super.markDisconnected(instanceId, workerId, reason, epoch)
  }
}

class ThrowingClearQrRepository extends InMemoryWaQrBootstrapRepository {
  clearCalls = 0

  async clear(_instanceId: string, _workerId: string, _epoch: bigint): Promise<boolean> {
    this.clearCalls += 1
    throw new Error('qr clear failed')
  }
}

class DeferredQrStoreRepository extends InMemoryWaQrBootstrapRepository {
  readonly writeStarted = createDeferred<void>()
  readonly releaseWrite = createDeferred<void>()
  blockWorkerId?: string

  async store(event: WaQrPendingEvent, workerId: string, epoch: bigint): Promise<boolean> {
    if (workerId === this.blockWorkerId) {
      this.writeStarted.resolve(undefined)
      await this.releaseWrite.promise
    }
    return super.store(event, workerId, epoch)
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
    expect(statuses.getHistory('instance-1').map((entry) => entry.status)).toEqual([
      'connecting',
      'connected',
    ])
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

  it('serializes stop behind an in-progress start before closing the transport', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new DelayedConnectSessionManager(30)
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, shortTtlMs)
    const closeTransport = vi.spyOn(sessions, 'closeTransport')

    const start = lifecycle.start('instance-start-then-stop')
    await delay(1)
    const stop = lifecycle.stop('instance-start-then-stop')

    await expect(start).resolves.toMatchObject({ status: 'connected' })
    await expect(stop).resolves.toBe(true)
    expect(closeTransport).toHaveBeenCalledOnce()
    await expect(registry.getOwner('instance-start-then-stop')).resolves.toBeNull()
  })

  it('keeps renewing ownership after start returns until stop completes', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, shortTtlMs)

    await lifecycle.start('instance-long-lived-owner')
    registry.clearRenewals()
    await delay(20)

    expect(registry.renewals.length).toBeGreaterThan(0)
    await expect(lifecycle.stop('instance-long-lived-owner')).resolves.toBe(true)

    registry.clearRenewals()
    await delay(20)
    expect(registry.renewals).toEqual([])
  })

  it('keeps renewing ownership while a slow transport close is in progress', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new DelayedCloseTransportSessionManager(30)
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, shortTtlMs)
    await lifecycle.start('instance-slow-stop')
    registry.clearRenewals()

    const stop = lifecycle.stop('instance-slow-stop')
    await delay(20)

    expect(registry.renewals.length).toBeGreaterThan(0)
    await expect(stop).resolves.toBe(true)
  })

  it('keeps renewing ownership through status persistence until release', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const statuses = new DeferredDisconnectedStatusRepository()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      shortTtlMs,
      statuses,
    )
    await lifecycle.start('instance-slow-stop-status')

    const stop = lifecycle.stop('instance-slow-stop-status')
    await statuses.writeStarted.promise
    registry.clearRenewals()
    await delay(20)

    expect(registry.renewals.length).toBeGreaterThan(0)
    statuses.releaseWrite.resolve(undefined)
    await expect(stop).resolves.toBe(true)
  })

  it('keeps lease heartbeat independent from slow state reconciliation', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new DelayedGetStateSessionManager(40)
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, shortTtlMs)
    await lifecycle.start('instance-slow-reconciliation')
    registry.clearRenewals()

    await delay(30)

    expect(registry.renewals.length).toBeGreaterThanOrEqual(2)
    await lifecycle.stop('instance-slow-reconciliation')
  })

  it('keeps lease heartbeat alive while rolling back a started transport', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new DeferredCloseTransportSessionManager()
    const statuses = new FailingConnectedStatusRepository()
    statuses.failConnected = true
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      shortTtlMs,
      statuses,
    )

    const start = lifecycle.start('instance-start-rollback')
    await sessions.closeStarted.promise
    registry.clearRenewals()
    await delay(20)

    expect(registry.renewals.length).toBeGreaterThan(0)
    sessions.releaseClose.resolve(undefined)
    await expect(start).rejects.toThrow('status store unavailable')
    await expect(registry.getOwner('instance-start-rollback')).resolves.toBeNull()
  })

  it('does not finish failed start until rollback transport close is confirmed', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new FlakyCloseTransportSessionManager(2)
    const statuses = new FailingConnectedStatusRepository()
    statuses.failConnected = true
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      shortTtlMs,
      statuses,
    )

    await expect(lifecycle.start('instance-start-rollback-retry')).rejects.toThrow(
      'status store unavailable',
    )

    expect(sessions.closeCalls).toEqual([
      'instance-start-rollback-retry',
      'instance-start-rollback-retry',
      'instance-start-rollback-retry',
    ])
    await expect(registry.getOwner('instance-start-rollback-retry')).resolves.toBeNull()
  })

  it('always removes failed-start supervision and releases its fence when QR cleanup throws', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const statuses = new FailingConnectedStatusRepository()
    const qrBootstrap = new ThrowingClearQrRepository()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      ttlMs,
      statuses,
      qrBootstrap,
    )

    await expect(lifecycle.start('instance-rollback-qr-failure')).rejects.toThrow('qr clear failed')

    expect(qrBootstrap.clearCalls).toBe(2)
    expect(registry.releases).toContainEqual({
      instanceId: 'instance-rollback-qr-failure',
      workerId: 'worker-a',
    })
    await expect(registry.getOwner('instance-rollback-qr-failure')).resolves.toBeNull()
    await expect(lifecycle.stop('instance-rollback-qr-failure')).resolves.toBe(false)
  })

  it('rejects a connect that crosses an ABA ownership epoch and closes the opened transport', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new DeferredConnectSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs, statuses)
    const close = vi.spyOn(sessions, 'closeTransport')

    const start = lifecycle.start('instance-connect-aba')
    await sessions.connectStarted.promise
    expect(registry.advanceEpoch('instance-connect-aba', 'worker-a')).toBe(2n)
    sessions.releaseConnect.resolve(undefined)

    await expect(start).rejects.toBeInstanceOf(WaOwnershipError)
    expect(close).toHaveBeenCalled()
    await expect(registry.getOwnership('instance-connect-aba')).resolves.toEqual({
      owner: 'worker-a',
      epoch: 2n,
    })
    expect(statuses.getLast('instance-connect-aba')).toMatchObject({
      status: 'connecting',
      epoch: 1n,
    })
  })

  it('queues a new start behind an in-progress stop and opens one fresh transport', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new DelayedCloseTransportSessionManager(30)
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, shortTtlMs)
    const connect = vi.spyOn(sessions, 'connect')
    await lifecycle.start('instance-stop-then-start')

    const stop = lifecycle.stop('instance-stop-then-start')
    await delay(1)
    const restart = lifecycle.start('instance-stop-then-start')

    await expect(stop).resolves.toBe(true)
    await expect(restart).resolves.toMatchObject({ status: 'connected' })
    expect(connect).toHaveBeenCalledTimes(2)
    await expect(registry.getOwner('instance-stop-then-start')).resolves.toBe('worker-a')
    await lifecycle.stop('instance-stop-then-start')
  })

  it('does not mark a Baileys-style connecting result as connected before an open state', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new EventDrivenSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      shortTtlMs,
      statuses,
    )

    await expect(lifecycle.start('instance-await-open')).resolves.toMatchObject({
      status: 'connecting',
    })
    expect(statuses.getHistory('instance-await-open').map((entry) => entry.status)).toEqual([
      'connecting',
    ])

    sessions.seed({
      instanceId: 'instance-await-open',
      status: 'connected',
      hasAuthState: true,
      logoutCount: 0,
    })
    await delay(20)

    expect(statuses.getLast('instance-await-open')).toMatchObject({ status: 'connected' })
    await lifecycle.stop('instance-await-open')
  })

  it('persists an observed connected state immediately without waiting for the watchdog', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new EventDrivenSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs, statuses)
    await lifecycle.start('instance-observed-open')
    statuses.clear()
    const state: SessionState = {
      instanceId: 'instance-observed-open',
      status: 'connected',
      hasAuthState: true,
      logoutCount: 0,
    }
    sessions.seed(state)

    lifecycle.notifyState(state.instanceId)
    await waitUntil(() => statuses.getLast('instance-observed-open')?.status === 'connected')

    expect(statuses.getHistory('instance-observed-open')).toEqual([
      expect.objectContaining({ status: 'connected', workerId: 'worker-a' }),
    ])
    await lifecycle.stop('instance-observed-open')
  })

  it('clears a pending QR when an observed connection opens', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new EventDrivenSessionManager()
    const qr = new InMemoryWaQrBootstrapRepository()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      ttlMs,
      undefined,
      qr,
    )
    await lifecycle.start('instance-observed-qr-clear')
    await lifecycle.recordQrPending(
      'instance-observed-qr-clear',
      'qr-payload',
      new Date('2999-07-15T12:00:00.000Z'),
    )
    const state: SessionState = {
      instanceId: 'instance-observed-qr-clear',
      status: 'connected',
      hasAuthState: true,
      logoutCount: 0,
    }
    sessions.seed(state)

    lifecycle.notifyState(state.instanceId)
    await waitUntil(async () => (await qr.getLatest('instance-observed-qr-clear')) === null)

    await expect(qr.getLatest('instance-observed-qr-clear')).resolves.toBeNull()
    await lifecycle.stop('instance-observed-qr-clear')
  })

  it('serializes an observed status write before stop closes and marks disconnected', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new EventDrivenSessionManager()
    const statuses = new DeferredConnectedStatusRepository()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs, statuses)
    await lifecycle.start('instance-observe-stop-race')
    const state: SessionState = {
      instanceId: 'instance-observe-stop-race',
      status: 'connected',
      hasAuthState: true,
      logoutCount: 0,
    }
    sessions.seed(state)
    lifecycle.notifyState(state.instanceId)
    await statuses.writeStarted.promise
    const close = vi.spyOn(sessions, 'closeTransport')

    const stop = lifecycle.stop('instance-observe-stop-race')
    await delay(5)
    expect(close).not.toHaveBeenCalled()
    statuses.releaseWrite.resolve(undefined)
    await expect(stop).resolves.toBe(true)

    expect(statuses.getLast('instance-observe-stop-race')).toMatchObject({
      status: 'disconnected',
    })
  })

  it('starts one serialized reconnect immediately for an observed transient disconnect', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new DelayedEventDrivenSessionManager(20)
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs)
    await lifecycle.start('instance-observed-transient')
    const state: SessionState = {
      instanceId: 'instance-observed-transient',
      status: 'disconnected',
      hasAuthState: true,
      logoutCount: 0,
      lastDisconnectReason: 'transient',
    }
    sessions.seed(state)
    const logout = vi.spyOn(sessions, 'logout')

    lifecycle.notifyState(state.instanceId)
    lifecycle.notifyState(state.instanceId)
    await waitUntil(() => sessions.connectCalls.length === 2)

    expect(sessions.connectCalls).toEqual([
      'instance-observed-transient',
      'instance-observed-transient',
    ])
    expect(sessions.maxConcurrentConnects).toBe(1)
    expect(logout).not.toHaveBeenCalled()
    await lifecycle.stop('instance-observed-transient')
  })

  it('ignores an observed state after ownership moved to another worker', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new EventDrivenSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs, statuses)
    await lifecycle.start('instance-observed-stale')
    statuses.clear()
    registry.clearRenewals()
    registry.setOwner('instance-observed-stale', 'worker-b')

    lifecycle.notifyState('instance-observed-stale')
    await waitUntil(() => registry.renewals.length > 0)

    expect(statuses.getHistory('instance-observed-stale')).toEqual([])
    await expect(registry.getOwner('instance-observed-stale')).resolves.toBe('worker-b')
  })

  it('persists an observed logged_out state and releases ownership immediately', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new EventDrivenSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs, statuses)
    await lifecycle.start('instance-observed-logout')
    const state: SessionState = {
      instanceId: 'instance-observed-logout',
      status: 'logged_out',
      hasAuthState: false,
      logoutCount: 1,
      lastDisconnectReason: 'logged_out',
    }
    sessions.seed(state)

    lifecycle.notifyState(state.instanceId)
    await waitUntil(() => statuses.getLast('instance-observed-logout')?.status === 'logged_out')

    expect(statuses.getLast('instance-observed-logout')).toMatchObject({ status: 'logged_out' })
    await expect(registry.getOwner('instance-observed-logout')).resolves.toBeNull()
  })

  it('reconnects a transiently disconnected owned session from one serialized watchdog', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new EventDrivenSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      shortTtlMs,
      statuses,
    )
    await lifecycle.start('instance-watchdog-reconnect')
    sessions.seed({
      instanceId: 'instance-watchdog-reconnect',
      status: 'disconnected',
      hasAuthState: true,
      logoutCount: 0,
      lastDisconnectReason: 'transient',
    })

    await delay(20)

    expect(sessions.connectCalls).toEqual([
      'instance-watchdog-reconnect',
      'instance-watchdog-reconnect',
    ])
    expect(
      statuses.getHistory('instance-watchdog-reconnect').map((entry) => entry.status),
    ).toContain('disconnected')
    await lifecycle.stop('instance-watchdog-reconnect')
  })

  it('never overlaps reconnect attempts while watchdog ticks continue', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new DelayedEventDrivenSessionManager(20)
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, shortTtlMs)
    await lifecycle.start('instance-serialized-reconnect')
    sessions.seed({
      instanceId: 'instance-serialized-reconnect',
      status: 'disconnected',
      hasAuthState: true,
      logoutCount: 0,
      lastDisconnectReason: 'transient',
    })

    await delay(100)

    expect(sessions.connectCalls).toEqual([
      'instance-serialized-reconnect',
      'instance-serialized-reconnect',
    ])
    expect(sessions.maxConcurrentConnects).toBe(1)
    await lifecycle.stop('instance-serialized-reconnect')
  })

  it('closes the local transport and stops supervision when ownership is lost', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, shortTtlMs)
    const closeTransport = vi.spyOn(sessions, 'closeTransport')
    await lifecycle.start('instance-owner-lost')
    registry.setOwner('instance-owner-lost', 'worker-b')

    await delay(20)
    const renewalCountAfterLoss = registry.renewals.length
    await delay(20)

    expect(closeTransport).toHaveBeenCalledOnce()
    expect(registry.renewals).toHaveLength(renewalCountAfterLoss)
    expect(registry.releases).toEqual([])
    await expect(registry.getOwner('instance-owner-lost')).resolves.toBe('worker-b')
  })

  it('does not let a stale owner overwrite shared status after ownership loss', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      shortTtlMs,
      statuses,
    )
    await lifecycle.start('instance-stale-status')
    statuses.clear()
    registry.setOwner('instance-stale-status', 'worker-b')

    await delay(20)

    expect(statuses.getHistory('instance-stale-status')).toEqual([])
  })

  it('rechecks ownership after a slow state read before shared persistence', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new DeferredGetStateSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const qr = new InMemoryWaQrBootstrapRepository()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      ttlMs,
      statuses,
      qr,
    )
    await lifecycle.start('instance-slow-stale')
    statuses.clear()
    await lifecycle.recordQrPending(
      'instance-slow-stale',
      'qr-payload',
      new Date('2999-07-15T12:00:00.000Z'),
    )
    statuses.clear()
    const close = vi.spyOn(sessions, 'closeTransport')

    lifecycle.notifyState('instance-slow-stale')
    await sessions.readStarted.promise
    registry.setOwner('instance-slow-stale', 'worker-b')
    sessions.releaseRead.resolve(undefined)
    await waitUntil(() => close.mock.calls.length === 1)

    expect(statuses.getHistory('instance-slow-stale')).toEqual([])
    await expect(qr.getLatest('instance-slow-stale')).resolves.toMatchObject({
      qrCode: 'qr-payload',
    })
  })

  it('rejects an old status commit that resumes after a newer ownership fence wins', async () => {
    const registry = new FakeOwnerRegistry()
    const statuses = new DeferredDisconnectedStatusRepository()
    const oldSessions = new MockSessionManager()
    const newSessions = new MockSessionManager()
    const oldClose = vi.spyOn(oldSessions, 'closeTransport')
    const oldLifecycle = new WaSessionLifecycleService(
      'worker-old',
      registry,
      oldSessions,
      ttlMs,
      statuses,
    )
    const newLifecycle = new WaSessionLifecycleService(
      'worker-new',
      registry,
      newSessions,
      ttlMs,
      statuses,
    )
    await oldLifecycle.start('instance-status-commit-race')
    await oldSessions.handleDisconnect('instance-status-commit-race', 'transient')
    oldLifecycle.notifyState('instance-status-commit-race')
    await statuses.writeStarted.promise

    registry.setOwner('instance-status-commit-race', 'worker-new')
    await newLifecycle.start('instance-status-commit-race')
    statuses.releaseWrite.resolve(undefined)
    await waitUntil(
      () => statuses.getLast('instance-status-commit-race')?.workerId === 'worker-new',
    )
    await waitUntil(() => oldClose.mock.calls.length === 1)

    expect(statuses.getLast('instance-status-commit-race')).toMatchObject({
      workerId: 'worker-new',
      epoch: 2n,
      status: 'connected',
    })
    await newLifecycle.stop('instance-status-commit-race')
  })

  it('rejects an old QR commit that resumes after a newer ownership fence wins', async () => {
    const registry = new FakeOwnerRegistry()
    const qr = new DeferredQrStoreRepository()
    const oldLifecycle = new WaSessionLifecycleService(
      'worker-old',
      registry,
      new MockSessionManager(),
      ttlMs,
      new InMemoryWaAccountStatusRepository(),
      qr,
    )
    const newLifecycle = new WaSessionLifecycleService(
      'worker-new',
      registry,
      new MockSessionManager(),
      ttlMs,
      new InMemoryWaAccountStatusRepository(),
      qr,
    )
    await oldLifecycle.start('instance-qr-commit-race')
    qr.blockWorkerId = 'worker-old'
    const oldWrite = oldLifecycle.recordQrPending(
      'instance-qr-commit-race',
      'stale-qr',
      new Date('2999-07-15T12:00:00.000Z'),
    )
    await qr.writeStarted.promise

    registry.setOwner('instance-qr-commit-race', 'worker-new')
    await newLifecycle.start('instance-qr-commit-race')
    await newLifecycle.recordQrPending(
      'instance-qr-commit-race',
      'fresh-qr',
      new Date('2999-07-15T12:00:00.000Z'),
    )
    qr.releaseWrite.resolve(undefined)

    await expect(oldWrite).rejects.toBeInstanceOf(WaOwnershipError)
    await expect(qr.getLatest('instance-qr-commit-race')).resolves.toMatchObject({
      qrCode: 'fresh-qr',
    })
    await newLifecycle.stop('instance-qr-commit-race')
  })

  it('rejects a repeated start when ownership changes during its state read', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new DeferredGetStateSessionManager()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs)
    await lifecycle.start('instance-repeat-stale')
    const close = vi.spyOn(sessions, 'closeTransport')

    const repeatedStart = lifecycle.start('instance-repeat-stale')
    await sessions.readStarted.promise
    registry.setOwner('instance-repeat-stale', 'worker-b')
    sessions.releaseRead.resolve(undefined)

    await expect(repeatedStart).rejects.toMatchObject({
      instanceId: 'instance-repeat-stale',
      workerId: 'worker-a',
      owner: 'worker-b',
    })
    await waitUntil(() => close.mock.calls.length === 1)
    await expect(registry.getOwner('instance-repeat-stale')).resolves.toBe('worker-b')
  })

  it('closes fail-closed when lease renewal throws instead of keeping an uncertain socket', async () => {
    const registry = new FailingRenewOwnerRegistry()
    const sessions = new MockSessionManager()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, shortTtlMs)
    const closeTransport = vi.spyOn(sessions, 'closeTransport')
    await lifecycle.start('instance-renew-error')
    registry.failRenewals = true

    await delay(20)

    expect(closeTransport).toHaveBeenCalledOnce()
  })

  it('retries fail-closed transport shutdown after ownership is lost', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new FlakyCloseTransportSessionManager(4)
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, shortTtlMs)
    await lifecycle.start('instance-owner-lost-close-retry')
    registry.setOwner('instance-owner-lost-close-retry', 'worker-b')

    await waitUntil(() => sessions.closeCalls.length === 5)

    expect(sessions.closeCalls).toEqual([
      'instance-owner-lost-close-retry',
      'instance-owner-lost-close-retry',
      'instance-owner-lost-close-retry',
      'instance-owner-lost-close-retry',
      'instance-owner-lost-close-retry',
    ])
    await expect(registry.getOwner('instance-owner-lost-close-retry')).resolves.toBe('worker-b')
  })

  it('waits for the old ownership-loss shutdown before reclaiming and connecting a new epoch', async () => {
    vi.useFakeTimers()
    try {
      const registry = new FakeOwnerRegistry()
      const sessions = new CloseThenFailOnceSessionManager()
      const statuses = new InMemoryWaAccountStatusRepository()
      const lifecycle = new WaSessionLifecycleService(
        'worker-a',
        registry,
        sessions,
        shortTtlMs,
        statuses,
      )
      const connect = vi.spyOn(sessions, 'connect')
      await lifecycle.start('instance-same-process-reclaim')
      registry.setOwner('instance-same-process-reclaim', 'worker-b')

      await vi.advanceTimersByTimeAsync(5)
      await sessions.firstCloseFailed.promise
      registry.expireOwner('instance-same-process-reclaim')
      const restart = lifecycle.start('instance-same-process-reclaim')
      await Promise.resolve()

      expect(registry.claims).toHaveLength(1)
      expect(connect).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(10)
      await expect(restart).resolves.toMatchObject({ status: 'connected' })
      expect(registry.claims).toHaveLength(2)
      expect(connect).toHaveBeenCalledTimes(2)
      expect(statuses.getLast('instance-same-process-reclaim')).toMatchObject({
        workerId: 'worker-a',
        epoch: 3n,
        status: 'connected',
      })
      await lifecycle.stop('instance-same-process-reclaim')
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists terminal logged_out and releases supervision ownership', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new EventDrivenSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      shortTtlMs,
      statuses,
    )
    await lifecycle.start('instance-terminal-logout')
    sessions.seed({
      instanceId: 'instance-terminal-logout',
      status: 'logged_out',
      hasAuthState: false,
      logoutCount: 1,
      lastDisconnectReason: 'logged_out',
    })

    await delay(20)

    expect(statuses.getLast('instance-terminal-logout')).toMatchObject({ status: 'logged_out' })
    await expect(registry.getOwner('instance-terminal-logout')).resolves.toBeNull()
  })

  it('persists terminal banned and releases supervision ownership', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new EventDrivenSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      shortTtlMs,
      statuses,
    )
    const closeTransport = vi.spyOn(sessions, 'closeTransport').mockImplementation(async (id) => {
      registry.events.push('closeTransport')
      return MockSessionManager.prototype.closeTransport.call(sessions, id)
    })
    await lifecycle.start('instance-terminal-ban')
    sessions.seed({
      instanceId: 'instance-terminal-ban',
      status: 'banned',
      hasAuthState: false,
      logoutCount: 0,
      lastDisconnectReason: 'banned',
    })

    await delay(20)

    expect(statuses.getLast('instance-terminal-ban')).toMatchObject({ status: 'banned' })
    expect(closeTransport).toHaveBeenCalledOnce()
    expect(registry.events).toEqual(['closeTransport', 'release'])
    await expect(registry.getOwner('instance-terminal-ban')).resolves.toBeNull()
  })

  it('does not turn status persistence failure into a false transport disconnect', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new EventDrivenSessionManager()
    const statuses = new FailingConnectedStatusRepository()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      shortTtlMs,
      statuses,
    )
    await lifecycle.start('instance-status-failure')
    statuses.clear()
    statuses.failConnected = true
    sessions.seed({
      instanceId: 'instance-status-failure',
      status: 'connected',
      hasAuthState: true,
      logoutCount: 0,
    })

    await delay(20)

    expect(statuses.getHistory('instance-status-failure')).toEqual([])
    statuses.failConnected = false
    await lifecycle.stop('instance-status-failure')
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
    expect(statuses.getHistory('instance-3').map((entry) => entry.status)).toEqual([
      'connecting',
      'disconnected',
    ])
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

    expect(registry.renewals).toEqual([{ instanceId: 'instance-4', workerId: 'worker-a', ttlMs }])
    await expect(registry.getOwner('instance-4')).resolves.toBe('worker-a')
  })

  it('records QR pending without opening a session socket', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const qrBootstrap = new InMemoryWaQrBootstrapRepository()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      ttlMs,
      statuses,
      qrBootstrap,
    )
    const connect = vi.spyOn(sessions, 'connect')
    const expiresAt = new Date('2999-07-03T10:01:00.000Z')
    registry.setOwner('instance-qr', 'worker-a')

    const event = await lifecycle.recordQrPending(' instance-qr ', ' qr-payload ', expiresAt)

    expect(event).toMatchObject({
      type: 'qr_pending',
      instanceId: 'instance-qr',
      qrCode: 'qr-payload',
      expiresAt,
    })
    expect(connect).not.toHaveBeenCalled()
    expect(statuses.getLast('instance-qr')).toMatchObject({
      instanceId: 'instance-qr',
      workerId: 'worker-a',
      status: 'connecting',
    })
    await expect(qrBootstrap.getLatest('instance-qr')).resolves.toMatchObject({
      instanceId: 'instance-qr',
      qrCode: 'qr-payload',
      expiresAt,
    })
  })

  it('allows the active owner to record QR pending under the renewed lease', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const qrBootstrap = new InMemoryWaQrBootstrapRepository()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      ttlMs,
      statuses,
      qrBootstrap,
    )
    const expiresAt = new Date('2999-07-03T10:01:00.000Z')
    registry.setOwner('instance-active-qr', 'worker-a')

    await expect(
      lifecycle.recordQrPending('instance-active-qr', 'qr-payload', expiresAt),
    ).resolves.toMatchObject({
      type: 'qr_pending',
      instanceId: 'instance-active-qr',
      qrCode: 'qr-payload',
      expiresAt,
    })

    expect(registry.renewals).toEqual([
      { instanceId: 'instance-active-qr', workerId: 'worker-a', ttlMs },
    ])
    expect(statuses.getLast('instance-active-qr')).toMatchObject({
      instanceId: 'instance-active-qr',
      workerId: 'worker-a',
      status: 'connecting',
    })
    await expect(qrBootstrap.getLatest('instance-active-qr')).resolves.toMatchObject({
      instanceId: 'instance-active-qr',
      qrCode: 'qr-payload',
      expiresAt,
    })
  })

  it('rejects QR pending for a missing owner without status or QR writes', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const qrBootstrap = new InMemoryWaQrBootstrapRepository()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      ttlMs,
      statuses,
      qrBootstrap,
    )
    const expiresAt = new Date('2999-07-03T10:01:00.000Z')

    const error = await lifecycle
      .recordQrPending(' instance-missing-qr ', 'qr-payload', expiresAt)
      .catch((caught) => caught)

    expect(error).toBeInstanceOf(WaOwnershipError)
    expect(error).toMatchObject({
      instanceId: 'instance-missing-qr',
      workerId: 'worker-a',
      owner: null,
    })
    expect(statuses.getHistory('instance-missing-qr')).toEqual([])
    await expect(qrBootstrap.getLatest('instance-missing-qr')).resolves.toBeNull()
  })

  it('rejects QR pending for a foreign owner without status or QR writes', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const qrBootstrap = new InMemoryWaQrBootstrapRepository()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      ttlMs,
      statuses,
      qrBootstrap,
    )
    const expiresAt = new Date('2999-07-03T10:01:00.000Z')
    registry.setOwner('instance-foreign-qr', 'worker-b')

    const error = await lifecycle
      .recordQrPending('instance-foreign-qr', 'qr-payload', expiresAt)
      .catch((caught) => caught)

    expect(error).toBeInstanceOf(WaOwnershipError)
    expect(error).toMatchObject({
      instanceId: 'instance-foreign-qr',
      workerId: 'worker-a',
      owner: 'worker-b',
    })
    expect(statuses.getHistory('instance-foreign-qr')).toEqual([])
    await expect(qrBootstrap.getLatest('instance-foreign-qr')).resolves.toBeNull()
  })

  it('stops only the active owner', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const ownerLifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      ttlMs,
      statuses,
    )
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

  it('does not persist or release a close that crosses an ABA ownership epoch', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new DeferredCloseTransportSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs, statuses)
    await lifecycle.start('instance-close-aba')

    const stop = lifecycle.stop('instance-close-aba')
    await sessions.closeStarted.promise
    expect(registry.advanceEpoch('instance-close-aba', 'worker-a')).toBe(2n)
    sessions.releaseClose.resolve(undefined)

    await expect(stop).resolves.toBe(false)
    await expect(registry.getOwnership('instance-close-aba')).resolves.toEqual({
      owner: 'worker-a',
      epoch: 2n,
    })
    expect(statuses.getLast('instance-close-aba')).toMatchObject({ status: 'connected', epoch: 1n })
  })

  it('re-arms supervision when stop persistence fails so a later stop can finish', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const statuses = new FailOnceDisconnectedStatusRepository()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs, statuses)
    await lifecycle.start('instance-stop-persistence-retry')

    await expect(lifecycle.stop('instance-stop-persistence-retry')).rejects.toThrow(
      'status stop failed',
    )
    await expect(registry.getOwner('instance-stop-persistence-retry')).resolves.toBe('worker-a')

    await expect(lifecycle.stop('instance-stop-persistence-retry')).resolves.toBe(true)
    await expect(registry.getOwner('instance-stop-persistence-retry')).resolves.toBeNull()
  })

  it('shuts down every active transport and rejects new starts', async () => {
    const { lifecycle, registry, sessions } = createHarness('worker-a')
    const close = vi.spyOn(sessions, 'closeTransport')
    await lifecycle.start('instance-shutdown-a')
    await lifecycle.start('instance-shutdown-b')

    await lifecycle.shutdownAll()

    expect(close.mock.calls.map(([instanceId]) => instanceId).sort()).toEqual([
      'instance-shutdown-a',
      'instance-shutdown-b',
    ])
    await expect(registry.getOwner('instance-shutdown-a')).resolves.toBeNull()
    await expect(registry.getOwner('instance-shutdown-b')).resolves.toBeNull()
    await expect(lifecycle.start('instance-after-shutdown')).rejects.toThrow(
      'WA session lifecycle is shutting down',
    )
  })

  it('waits for a pending start already chained into stop before shutdown resolves', async () => {
    const registry = new DeferredClaimOwnerRegistry()
    const sessions = new MockSessionManager()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs)
    const connect = vi.spyOn(sessions, 'connect')

    const start = lifecycle.start('instance-pending-shutdown')
    await registry.claimStarted.promise
    const stop = lifecycle.stop('instance-pending-shutdown')
    let shutdownResolved = false
    const shutdown = lifecycle.shutdownAll().then(() => {
      shutdownResolved = true
    })
    await delay(5)

    expect(shutdownResolved).toBe(false)
    registry.releaseClaim.resolve(undefined)

    await expect(start).rejects.toThrow('WA session lifecycle is shutting down')
    await expect(stop).resolves.toBe(false)
    await expect(shutdown).resolves.toBeUndefined()
    expect(connect).not.toHaveBeenCalled()
    await expect(registry.getOwner('instance-pending-shutdown')).resolves.toBeNull()
  })

  it('waits for ownership-loss physical close before shutdown resolves', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new DeferredCloseTransportSessionManager()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, shortTtlMs)
    await lifecycle.start('instance-loss-during-shutdown')
    registry.setOwner('instance-loss-during-shutdown', 'worker-b')
    await sessions.closeStarted.promise
    let shutdownResolved = false

    const shutdown = lifecycle.shutdownAll().then(() => {
      shutdownResolved = true
    })
    await delay(10)
    expect(shutdownResolved).toBe(false)
    sessions.releaseClose.resolve(undefined)
    await shutdown

    expect(shutdownResolved).toBe(true)
  })

  it('bounds application shutdown close retries and keeps the lease when close never succeeds', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new FailingCloseTransportSessionManager()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs)
    await lifecycle.start('instance-bounded-shutdown')

    await expect(lifecycle.shutdownAll()).rejects.toThrow('close transport failed')

    expect(sessions.closeCalls).toBe(3)
    await expect(registry.getOwner('instance-bounded-shutdown')).resolves.toBe('worker-a')
    await expect(lifecycle.start('instance-after-failed-shutdown')).rejects.toThrow(
      'WA session lifecycle is shutting down',
    )
  })

  it('terminates application shutdown when transport close never settles', async () => {
    vi.useFakeTimers()
    try {
      const registry = new FakeOwnerRegistry()
      const sessions = new HangingCloseTransportSessionManager()
      const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs)
      await lifecycle.start('instance-hanging-shutdown')

      const shutdown = lifecycle.shutdownAll()
      const rejected = expect(shutdown).rejects.toThrow(
        'WA transport close timed out during shutdown',
      )
      await vi.advanceTimersByTimeAsync(4_000)

      await rejected
      expect(sessions.closeCalls).toBe(3)
      await expect(registry.getOwner('instance-hanging-shutdown')).resolves.toBe('worker-a')
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues shutdown cleanup and releases ownership after status persistence fails', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const statuses = new FailOnceDisconnectedStatusRepository()
    const qrBootstrap = new InMemoryWaQrBootstrapRepository()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      ttlMs,
      statuses,
      qrBootstrap,
    )
    await lifecycle.start('instance-shutdown-status-failure')

    await expect(lifecycle.shutdownAll()).rejects.toThrow('status stop failed')

    await expect(registry.getOwner('instance-shutdown-status-failure')).resolves.toBeNull()
    expect(registry.releases).toContainEqual({
      instanceId: 'instance-shutdown-status-failure',
      workerId: 'worker-a',
    })
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

  it('treats repeated start by the same worker as idempotent without a second connect', async () => {
    const { lifecycle, registry, sessions } = createHarness('worker-a')
    const connect = vi.spyOn(sessions, 'connect')

    await lifecycle.start('instance-6')
    const state = await lifecycle.start('instance-6')

    expect(registry.claims).toEqual([{ instanceId: 'instance-6', workerId: 'worker-a', ttlMs }])
    expect(connect).toHaveBeenCalledOnce()
    expect(state.status).toBe('connected')
    await expect(registry.getOwner('instance-6')).resolves.toBe('worker-a')
  })

  it('closes an expired active epoch before the same worker claims a fresh epoch', async () => {
    const { lifecycle, registry, sessions, statuses } = createHarness('worker-a')
    const close = vi.spyOn(sessions, 'closeTransport')
    const connect = vi.spyOn(sessions, 'connect')
    await lifecycle.start('instance-reclaim')
    registry.expireOwner('instance-reclaim')

    await lifecycle.start('instance-reclaim')

    expect(close).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledTimes(2)
    expect(statuses.getLast('instance-reclaim')).toMatchObject({ epoch: 2n, workerId: 'worker-a' })
    await lifecycle.stop('instance-reclaim')
  })

  it('closes fail-closed when repeated start cannot verify the active epoch', async () => {
    const registry = new FailingRenewOwnerRegistry()
    const sessions = new MockSessionManager()
    const lifecycle = new WaSessionLifecycleService(
      'worker-a',
      registry,
      sessions,
      ttlMs,
      new InMemoryWaAccountStatusRepository(),
    )
    const close = vi.spyOn(sessions, 'closeTransport')
    await lifecycle.start('instance-reclaim-renew-error')
    registry.failRenewals = true

    await expect(lifecycle.start('instance-reclaim-renew-error')).rejects.toThrow(
      'redis unavailable',
    )

    expect(close).toHaveBeenCalledOnce()
  })

  it('claims above the persistence fence after Redis ownership state is reset', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const statuses = new InMemoryWaAccountStatusRepository()
    await statuses.activateOwnership('instance-reset-counter', 'worker-previous', 9n)
    const lifecycle = new WaSessionLifecycleService(
      'worker-new',
      registry,
      sessions,
      ttlMs,
      statuses,
    )
    const connect = vi.spyOn(sessions, 'connect')

    await expect(lifecycle.start('instance-reset-counter')).resolves.toMatchObject({
      status: 'connected',
    })

    expect(connect).toHaveBeenCalledOnce()
    await expect(registry.getOwnership('instance-reset-counter')).resolves.toEqual({
      owner: 'worker-new',
      epoch: 10n,
    })
    expect(statuses.getLast('instance-reset-counter')).toMatchObject({
      workerId: 'worker-new',
      epoch: 10n,
      status: 'connected',
    })
    await lifecycle.stop('instance-reset-counter')
  })

  it('reclaims with a bounded retry when persistence advances during fence activation', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const statuses = new RacingOwnershipStatusRepository()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs, statuses)
    const connect = vi.spyOn(sessions, 'connect')

    await expect(lifecycle.start('instance-fence-activation-race')).resolves.toMatchObject({
      status: 'connected',
    })

    expect(registry.claims).toHaveLength(2)
    expect(connect).toHaveBeenCalledOnce()
    await expect(registry.getOwnership('instance-fence-activation-race')).resolves.toEqual({
      owner: 'worker-a',
      epoch: 3n,
    })
    expect(statuses.getLast('instance-fence-activation-race')).toMatchObject({ epoch: 3n })
    await lifecycle.stop('instance-fence-activation-race')
  })

  it('fails closed after the bounded activation retries are exhausted', async () => {
    const registry = new FakeOwnerRegistry()
    const sessions = new MockSessionManager()
    const statuses = new AlwaysRacingOwnershipStatusRepository()
    const lifecycle = new WaSessionLifecycleService('worker-a', registry, sessions, ttlMs, statuses)
    const connect = vi.spyOn(sessions, 'connect')

    await expect(lifecycle.start('instance-fence-always-racing')).rejects.toBeInstanceOf(
      WaOwnershipError,
    )

    expect(registry.claims).toHaveLength(3)
    expect(connect).not.toHaveBeenCalled()
    await expect(registry.getOwner('instance-fence-always-racing')).resolves.toBeNull()
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

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition')
    await delay(5)
  }
}
