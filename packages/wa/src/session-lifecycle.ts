import type { OwnerRegistry } from './owner-registry'
import { OwnedSessionManager, WaOwnershipError } from './owned-session-manager'
import {
  createWaQrPendingEvent,
  type WaQrBootstrapRepository,
  type WaQrPendingEvent,
} from './qr-bootstrap'
import type { SessionManager, SessionState } from './session'
import type { WaAccountStatusRepository } from './status-repository'

const CONNECT_ATTEMPTS = 3
const CONNECT_BACKOFF_MS = 10
const CLOSE_BACKOFF_MS = 10
const timerRuntime = globalThis as unknown as TimerRuntime

interface TimerRuntime {
  setInterval(handler: () => void, timeoutMs: number): unknown
  clearInterval(handle: unknown): void
  setTimeout(handler: () => void, timeoutMs: number): unknown
}

interface ActiveSupervision {
  instanceId: string
  interval?: unknown
  heartbeatInFlight?: Promise<void>
  reconciliationInFlight?: Promise<void>
  shutdownInFlight?: Promise<void>
  starting: boolean
  stopping: boolean
  stopped: boolean
  lastStatusKey?: string
}

export class WaSessionLifecycleService {
  private readonly workerId: string
  private readonly ttlMs: number
  private readonly ownedSessions: SessionManager
  private readonly active = new Map<string, ActiveSupervision>()
  private readonly starts = new Map<string, Promise<SessionState>>()
  private readonly stops = new Map<string, Promise<boolean>>()

  constructor(
    workerId: string,
    private readonly ownerRegistry: OwnerRegistry,
    private readonly sessionManager: SessionManager,
    ttlMs: number,
    private readonly statusRepository?: WaAccountStatusRepository,
    private readonly qrBootstrapRepository?: WaQrBootstrapRepository,
  ) {
    this.workerId = normalizeWorkerId(workerId)
    this.ttlMs = normalizeTtl(ttlMs)
    this.ownedSessions = new OwnedSessionManager(sessionManager, ownerRegistry, this.workerId)
  }

  start(instanceId: string): Promise<SessionState> {
    const normalizedInstanceId = normalizeInstanceId(instanceId)
    const pending = this.starts.get(normalizedInstanceId)
    if (pending) return pending

    const stopping = this.stops.get(normalizedInstanceId)
    const start = stopping
      ? stopping.then(() => this.startOnce(normalizedInstanceId))
      : this.startOnce(normalizedInstanceId)
    return this.trackStart(normalizedInstanceId, start)
  }

  private trackStart(instanceId: string, start: Promise<SessionState>): Promise<SessionState> {
    const tracked = start.then(
      (state) => {
        if (this.starts.get(instanceId) === tracked) {
          this.starts.delete(instanceId)
        }
        return state
      },
      (error: unknown) => {
        if (this.starts.get(instanceId) === tracked) {
          this.starts.delete(instanceId)
        }
        throw error
      },
    )
    this.starts.set(instanceId, tracked)
    return tracked
  }

  renew(instanceId: string): Promise<boolean> {
    return this.ownerRegistry.renew(normalizeInstanceId(instanceId), this.workerId, this.ttlMs)
  }

  async recordQrPending(
    instanceId: string,
    qrCode: string,
    expiresAt: Date,
  ): Promise<WaQrPendingEvent> {
    const event = createWaQrPendingEvent({ instanceId, qrCode, expiresAt })

    await this.assertLeaseStillOwned(event.instanceId)
    await this.statusRepository?.markConnecting(event.instanceId, this.workerId)
    await this.qrBootstrapRepository?.store(event)

    return event
  }

  stop(instanceId: string): Promise<boolean> {
    const normalizedInstanceId = normalizeInstanceId(instanceId)
    const pending = this.stops.get(normalizedInstanceId)
    if (pending) return pending

    const pendingStart = this.starts.get(normalizedInstanceId)
    if (pendingStart && this.starts.get(normalizedInstanceId) === pendingStart) {
      this.starts.delete(normalizedInstanceId)
    }

    const stop = this.stopAfterStart(normalizedInstanceId, pendingStart)
    const tracked = stop.then(
      (stopped) => {
        if (this.stops.get(normalizedInstanceId) === tracked) {
          this.stops.delete(normalizedInstanceId)
        }
        return stopped
      },
      (error: unknown) => {
        if (this.stops.get(normalizedInstanceId) === tracked) {
          this.stops.delete(normalizedInstanceId)
        }
        throw error
      },
    )
    this.stops.set(normalizedInstanceId, tracked)
    return tracked
  }

  private async stopAfterStart(
    instanceId: string,
    pendingStart: Promise<SessionState> | undefined,
  ): Promise<boolean> {
    if (pendingStart) {
      try {
        await pendingStart
      } catch {
        // A failed start performs its own fail-closed cleanup before stop re-checks ownership.
      }
    }

    return this.stopOnce(instanceId)
  }

  private async stopOnce(normalizedInstanceId: string): Promise<boolean> {
    const owner = await this.ownerRegistry.getOwner(normalizedInstanceId)
    if (owner !== this.workerId) return false

    const supervision = this.active.get(normalizedInstanceId)
    if (supervision) {
      supervision.stopping = true
      await supervision.reconciliationInFlight

      const ownerAfterWatchdog = await this.ownerRegistry.getOwner(normalizedInstanceId)
      if (ownerAfterWatchdog !== this.workerId) {
        await this.handleOwnershipLoss(supervision)
        return false
      }
    }

    let state: SessionState
    try {
      state = await this.ownedSessions.closeTransport(normalizedInstanceId)
    } catch (error: unknown) {
      if (supervision && this.active.get(normalizedInstanceId) === supervision) {
        supervision.stopping = false
        this.armSupervision(supervision)
      }
      throw error
    }

    const ownerAfterClose = await this.ownerRegistry.getOwner(normalizedInstanceId)
    if (ownerAfterClose !== this.workerId) {
      this.stopSupervision(supervision)
      await supervision?.heartbeatInFlight
      return false
    }

    await this.statusRepository?.markDisconnected(
      normalizedInstanceId,
      this.workerId,
      state.lastDisconnectReason,
    )

    const released = await this.ownerRegistry.release(normalizedInstanceId, this.workerId)
    this.stopSupervision(supervision)
    await supervision?.heartbeatInFlight
    return released
  }

  private async startOnce(instanceId: string): Promise<SessionState> {
    const claim = await this.ownerRegistry.claim(instanceId, this.workerId, this.ttlMs)
    if (!claim.claimed) {
      throw new WaOwnershipError(instanceId, this.workerId, claim.owner)
    }

    const existing = this.active.get(instanceId)
    if (existing && !existing.stopped) {
      const state = await this.sessionManager.getState(instanceId)
      await this.persistState(existing, state)
      return state
    }

    const supervision: ActiveSupervision = {
      instanceId,
      starting: true,
      stopping: false,
      stopped: false,
    }
    this.active.set(instanceId, supervision)
    this.armSupervision(supervision)

    let connectError: unknown
    let transportMayExist = false
    try {
      await this.markConnecting(supervision)
      transportMayExist = true
      const state = await this.connectWithRetry(instanceId).catch((error: unknown) => {
        connectError = error
        throw error
      })
      await this.assertLeaseStillOwned(instanceId)
      supervision.starting = false
      await this.persistState(supervision, state)
      if (isTerminalState(state)) {
        await this.finishTerminal(supervision)
      }
      return state
    } catch (error: unknown) {
      supervision.starting = false
      if (!this.isTracked(supervision)) {
        await supervision.shutdownInFlight
        throw error
      }

      supervision.stopping = true
      if (transportMayExist) {
        await this.closeTransportUntilClosed(instanceId)
      }

      const owner = await this.ownerRegistry.getOwner(instanceId)
      if (owner !== this.workerId) {
        this.stopSupervision(supervision)
        await supervision.heartbeatInFlight
        throw error
      }

      let statusError: unknown
      if (connectError && !(connectError instanceof WaOwnershipError)) {
        try {
          await this.statusRepository?.markDisconnected(
            instanceId,
            this.workerId,
            reasonFromError(connectError),
          )
        } catch (caught: unknown) {
          statusError = caught
        }
      }
      await this.ownerRegistry.release(instanceId, this.workerId)
      this.stopSupervision(supervision)
      await supervision.heartbeatInFlight
      if (statusError) throw statusError
      throw error
    }
  }

  private armSupervision(supervision: ActiveSupervision): void {
    if (supervision.stopped || supervision.stopping || supervision.interval !== undefined) return

    const intervalMs = Math.max(1, Math.floor(this.ttlMs / 2))
    supervision.interval = timerRuntime.setInterval(() => {
      this.scheduleHeartbeat(supervision)
      this.scheduleReconciliation(supervision)
    }, intervalMs)
    unrefTimer(supervision.interval)
  }

  private disarmSupervision(supervision: ActiveSupervision): void {
    if (supervision.interval === undefined) return
    timerRuntime.clearInterval(supervision.interval)
    supervision.interval = undefined
  }

  private stopSupervision(supervision: ActiveSupervision | undefined): void {
    if (!supervision) return
    supervision.stopped = true
    supervision.stopping = false
    this.disarmSupervision(supervision)
    if (this.active.get(supervision.instanceId) === supervision) {
      this.active.delete(supervision.instanceId)
    }
  }

  private scheduleHeartbeat(supervision: ActiveSupervision): void {
    if (!this.isTracked(supervision) || supervision.heartbeatInFlight) return

    const heartbeat = this.runHeartbeat(supervision).finally(() => {
      if (supervision.heartbeatInFlight === heartbeat) {
        supervision.heartbeatInFlight = undefined
      }
    })
    supervision.heartbeatInFlight = heartbeat
  }

  private async runHeartbeat(supervision: ActiveSupervision): Promise<void> {
    let renewed = false
    try {
      renewed = await this.ownerRegistry.renew(supervision.instanceId, this.workerId, this.ttlMs)
    } catch {
      await this.handleOwnershipLoss(supervision)
      return
    }

    if (this.isTracked(supervision) && !renewed) {
      await this.handleOwnershipLoss(supervision)
    }
  }

  private scheduleReconciliation(supervision: ActiveSupervision): void {
    if (!this.isActive(supervision) || supervision.starting || supervision.reconciliationInFlight) {
      return
    }

    const reconciliation = this.runReconciliation(supervision)
      .catch(() => {
        // Runtime/status reads are retried on the next tick without inventing a disconnect.
      })
      .finally(() => {
        if (supervision.reconciliationInFlight === reconciliation) {
          supervision.reconciliationInFlight = undefined
        }
      })
    supervision.reconciliationInFlight = reconciliation
  }

  private async runReconciliation(supervision: ActiveSupervision): Promise<void> {
    const state = await this.sessionManager.getState(supervision.instanceId)
    if (!this.isActive(supervision)) return
    await this.persistState(supervision, state)

    if (isTerminalState(state)) {
      if (state.status === 'banned') {
        await this.sessionManager.closeTransport(supervision.instanceId)
        if (!this.isActive(supervision)) return
      }
      await this.finishTerminal(supervision)
      return
    }
    if (!shouldReconnect(state)) return

    try {
      await this.markConnecting(supervision)
    } catch {
      // Status visibility is retried independently; it must not block transport recovery.
    }
    try {
      const reconnecting = await this.connectWithRetry(supervision.instanceId)
      if (!this.isActive(supervision)) return
      if (!(await this.leaseIsStillOwned(supervision.instanceId))) {
        await this.handleOwnershipLoss(supervision)
        return
      }
      await this.persistState(supervision, reconnecting)
    } catch (error: unknown) {
      if (!this.isActive(supervision)) return
      if (error instanceof WaOwnershipError) {
        await this.handleOwnershipLoss(supervision)
        return
      }
      await this.statusRepository?.markDisconnected(
        supervision.instanceId,
        this.workerId,
        reasonFromError(error),
      )
      supervision.lastStatusKey = undefined
    }
  }

  private handleOwnershipLoss(supervision: ActiveSupervision): Promise<void> {
    if (supervision.shutdownInFlight) return supervision.shutdownInFlight

    const shutdown = this.shutdownAfterOwnershipLoss(supervision)
    supervision.shutdownInFlight = shutdown
    return shutdown
  }

  private async shutdownAfterOwnershipLoss(supervision: ActiveSupervision): Promise<void> {
    this.stopSupervision(supervision)
    await this.closeTransportUntilClosed(supervision.instanceId)
  }

  private async finishTerminal(supervision: ActiveSupervision): Promise<void> {
    this.stopSupervision(supervision)
    await supervision.heartbeatInFlight
    const owner = await this.ownerRegistry.getOwner(supervision.instanceId)
    if (owner === this.workerId) {
      await this.ownerRegistry.release(supervision.instanceId, this.workerId)
    }
  }

  private async markConnecting(supervision: ActiveSupervision): Promise<void> {
    if (supervision.lastStatusKey === 'connecting:') return
    await this.statusRepository?.markConnecting(supervision.instanceId, this.workerId)
    supervision.lastStatusKey = 'connecting:'
  }

  private async persistState(supervision: ActiveSupervision, state: SessionState): Promise<void> {
    const statusKey = `${state.status}:${state.lastDisconnectReason ?? ''}`
    if (supervision.lastStatusKey === statusKey) return

    if (state.status === 'connecting') {
      await this.statusRepository?.markConnecting(state.instanceId, this.workerId)
    } else if (state.status === 'connected') {
      await this.statusRepository?.markConnected(state.instanceId, this.workerId)
    } else if (state.status === 'logged_out') {
      await this.statusRepository?.markLoggedOut(state.instanceId, this.workerId)
    } else if (state.status === 'banned') {
      await this.statusRepository?.markBanned(
        state.instanceId,
        this.workerId,
        state.lastDisconnectReason,
      )
    } else {
      await this.statusRepository?.markDisconnected(
        state.instanceId,
        this.workerId,
        state.lastDisconnectReason ?? state.status,
      )
    }
    supervision.lastStatusKey = statusKey
  }

  private isActive(supervision: ActiveSupervision): boolean {
    return this.isTracked(supervision) && !supervision.stopping && !supervision.stopped
  }

  private isTracked(supervision: ActiveSupervision): boolean {
    return !supervision.stopped && this.active.get(supervision.instanceId) === supervision
  }

  private async connectWithRetry(instanceId: string): Promise<SessionState> {
    let lastError: unknown

    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
      try {
        return await this.ownedSessions.connect(instanceId)
      } catch (error: unknown) {
        lastError = error
        if (error instanceof WaOwnershipError || attempt === CONNECT_ATTEMPTS) {
          throw error
        }

        await delay(CONNECT_BACKOFF_MS)
      }
    }

    throw lastError
  }

  private async closeTransportUntilClosed(instanceId: string): Promise<SessionState> {
    let failedAttempts = 0

    for (;;) {
      try {
        return await this.sessionManager.closeTransport(instanceId)
      } catch {
        failedAttempts += 1
        const backoffMs = Math.min(CLOSE_BACKOFF_MS * 2 ** Math.min(failedAttempts - 1, 7), 1_000)
        await delay(backoffMs)
      }
    }
  }

  private async leaseIsStillOwned(instanceId: string): Promise<boolean> {
    try {
      return await this.ownerRegistry.renew(instanceId, this.workerId, this.ttlMs)
    } catch {
      return false
    }
  }

  private async assertLeaseStillOwned(instanceId: string): Promise<void> {
    const renewed = await this.ownerRegistry.renew(instanceId, this.workerId, this.ttlMs)
    if (renewed) return

    const owner = await this.ownerRegistry.getOwner(instanceId)
    throw new WaOwnershipError(instanceId, this.workerId, owner)
  }
}

function normalizeWorkerId(workerId: string): string {
  const normalizedWorkerId = workerId.trim()
  if (normalizedWorkerId.length === 0) {
    throw new TypeError('workerId must be a non-empty string')
  }

  return normalizedWorkerId
}

function normalizeInstanceId(instanceId: string): string {
  const normalizedInstanceId = instanceId.trim()
  if (normalizedInstanceId.length === 0) {
    throw new TypeError('instanceId must be a non-empty string')
  }

  return normalizedInstanceId
}

function normalizeTtl(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError('ttlMs must be a positive safe integer')
  }

  return ttlMs
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    timerRuntime.setTimeout(resolve, ms)
  })
}

function reasonFromError(error: unknown): string | undefined {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error

  return undefined
}

function shouldReconnect(state: SessionState): boolean {
  return (
    state.status === 'disconnected' &&
    state.hasAuthState &&
    (state.lastDisconnectReason === 'transient' ||
      state.lastDisconnectReason === 'restart_required' ||
      state.lastDisconnectReason === 'connection_closed')
  )
}

function isTerminalState(state: SessionState): boolean {
  return state.status === 'logged_out' || state.status === 'banned'
}

function unrefTimer(handle: unknown): void {
  if (
    typeof handle === 'object' &&
    handle !== null &&
    'unref' in handle &&
    typeof handle.unref === 'function'
  ) {
    handle.unref()
  }
}
