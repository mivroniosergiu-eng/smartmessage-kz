import type { OwnerClaimResult, OwnerRegistry } from './owner-registry'
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
const FENCE_ACTIVATION_ATTEMPTS = 3
const SHUTDOWN_CLOSE_ATTEMPTS = 3
const SHUTDOWN_CLOSE_TIMEOUT_MS = 1_000
const SHUTDOWN_COMMAND_DRAIN_MS = 250
const timerRuntime = globalThis as unknown as TimerRuntime

interface TimerRuntime {
  setInterval(handler: () => void, timeoutMs: number): unknown
  clearInterval(handle: unknown): void
  setTimeout(handler: () => void, timeoutMs: number): unknown
  clearTimeout(handle: unknown): void
}

interface ActiveSupervision {
  instanceId: string
  epoch: bigint
  interval?: unknown
  heartbeatInFlight?: Promise<void>
  reconciliationInFlight?: Promise<void>
  reconciliationRequested: boolean
  forceReconnectRequested: boolean
  shutdownInFlight?: Promise<void>
  starting: boolean
  stopping: boolean
  stopped: boolean
  lastStatusKey?: string
}

export interface WaRestrictionRecoveryScheduler {
  scheduleRestrictedRecovery(instanceId: string, restrictedUntil: Date): Promise<void>
}

export class WaSessionLifecycleShuttingDownError extends Error {
  constructor() {
    super('WA session lifecycle is shutting down')
    this.name = 'WaSessionLifecycleShuttingDownError'
  }
}

class WaSessionTransportCloseTimeoutError extends Error {
  constructor(instanceId: string) {
    super(`WA transport close timed out during shutdown: ${instanceId}`)
    this.name = 'WaSessionTransportCloseTimeoutError'
  }
}

export class WaSessionLifecycleService {
  private readonly workerId: string
  private readonly ttlMs: number
  private readonly ownedSessions: SessionManager
  private readonly active = new Map<string, ActiveSupervision>()
  private readonly starts = new Map<string, Promise<SessionState>>()
  private readonly stops = new Map<string, Promise<boolean>>()
  private readonly logouts = new Map<string, Promise<boolean>>()
  private readonly transportShutdowns = new Set<Promise<void>>()
  private readonly transportShutdownsByInstance = new Map<string, Promise<void>>()
  private readonly shutdownController = new AbortController()
  private shuttingDown = false
  private shutdownInFlight?: Promise<void>

  constructor(
    workerId: string,
    private readonly ownerRegistry: OwnerRegistry,
    private readonly sessionManager: SessionManager,
    ttlMs: number,
    private readonly statusRepository?: WaAccountStatusRepository,
    private readonly qrBootstrapRepository?: WaQrBootstrapRepository,
    private readonly restrictionRecoveryScheduler?: WaRestrictionRecoveryScheduler,
  ) {
    this.workerId = normalizeWorkerId(workerId)
    this.ttlMs = normalizeTtl(ttlMs)
    this.ownedSessions = new OwnedSessionManager(sessionManager, ownerRegistry, this.workerId)
  }

  start(instanceId: string): Promise<SessionState> {
    if (this.shuttingDown) return Promise.reject(new WaSessionLifecycleShuttingDownError())
    const normalizedInstanceId = normalizeInstanceId(instanceId)
    const pending = this.starts.get(normalizedInstanceId)
    if (pending) return pending

    const terminalCommands = [
      this.stops.get(normalizedInstanceId),
      this.logouts.get(normalizedInstanceId),
    ].filter((command): command is Promise<boolean> => command !== undefined)
    const start =
      terminalCommands.length > 0
        ? Promise.all(terminalCommands).then(() => this.startOnce(normalizedInstanceId))
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
    const supervision = this.active.get(normalizeInstanceId(instanceId))
    if (!supervision) return Promise.resolve(false)
    return this.ownerRegistry.renew(
      supervision.instanceId,
      this.workerId,
      this.ttlMs,
      supervision.epoch,
    )
  }

  async recordQrPending(
    instanceId: string,
    qrCode: string,
    expiresAt: Date,
  ): Promise<WaQrPendingEvent> {
    const event = createWaQrPendingEvent({ instanceId, qrCode, expiresAt })
    const supervision = this.active.get(event.instanceId)
    const ownership = supervision?.epoch
      ? { owner: this.workerId, epoch: supervision.epoch }
      : await this.ownerRegistry.getOwnership(event.instanceId)
    if (
      !ownership ||
      ownership.owner !== this.workerId ||
      (supervision && !this.isActive(supervision))
    ) {
      throw new WaOwnershipError(
        event.instanceId,
        this.workerId,
        await this.ownerRegistry.getOwner(event.instanceId),
      )
    }

    await this.assertLeaseStillOwned(event.instanceId, ownership.epoch)
    const statusFenceActive =
      (await this.statusRepository?.activateOwnership(
        event.instanceId,
        this.workerId,
        ownership.epoch,
      )) ?? true
    const qrFenceActive = statusFenceActive
      ? ((await this.qrBootstrapRepository?.activateOwnership(
          event.instanceId,
          this.workerId,
          ownership.epoch,
        )) ?? true)
      : false
    if (!statusFenceActive || !qrFenceActive) {
      if (supervision) await this.handleOwnershipLoss(supervision)
      throw new WaOwnershipError(
        event.instanceId,
        this.workerId,
        await this.ownerRegistry.getOwner(event.instanceId),
      )
    }
    if (
      (await this.statusRepository?.markConnecting(
        event.instanceId,
        this.workerId,
        ownership.epoch,
      )) === false
    ) {
      if (supervision) await this.handleOwnershipLoss(supervision)
      throw new WaOwnershipError(
        event.instanceId,
        this.workerId,
        await this.ownerRegistry.getOwner(event.instanceId),
      )
    }
    if (
      (await this.qrBootstrapRepository?.store(event, this.workerId, ownership.epoch)) === false
    ) {
      if (supervision) await this.handleOwnershipLoss(supervision)
      throw new WaOwnershipError(
        event.instanceId,
        this.workerId,
        await this.ownerRegistry.getOwner(event.instanceId),
      )
    }

    return event
  }

  notifyState(instanceId: string): void {
    const normalizedInstanceId = normalizeInstanceId(instanceId)
    const supervision = this.active.get(normalizedInstanceId)
    if (!supervision || !this.isActive(supervision)) return

    this.requestReconciliation(supervision)
  }

  shutdownAll(): Promise<void> {
    if (this.shutdownInFlight) return this.shutdownInFlight

    this.shuttingDown = true
    this.shutdownController.abort()
    const shutdown = this.finishShutdown()
    this.shutdownInFlight = shutdown
    return shutdown
  }

  private async finishShutdown(): Promise<void> {
    const pendingCommands = [
      ...this.starts.values(),
      ...this.stops.values(),
      ...this.logouts.values(),
    ]
    if (pendingCommands.length > 0) {
      await Promise.race([
        Promise.allSettled(pendingCommands).then(() => undefined),
        delay(SHUTDOWN_COMMAND_DRAIN_MS),
      ])
    }

    const shutdowns = [...this.active.values()].map((supervision) =>
      this.handleApplicationShutdown(supervision),
    )
    const results = await Promise.allSettled([
      ...shutdowns,
      ...[...this.transportShutdowns].filter((shutdown) => !shutdowns.includes(shutdown)),
    ])
    let firstError: unknown
    for (const result of results) {
      if (result.status === 'rejected' && firstError === undefined) firstError = result.reason
    }

    for (const supervision of this.active.values()) {
      this.stopSupervision(supervision)
    }
    this.starts.clear()
    this.stops.clear()
    this.logouts.clear()

    if (firstError !== undefined) throw firstError
  }

  private requestReconciliation(
    supervision: ActiveSupervision,
    forceReconnect = false,
  ): Promise<void> {
    if (!this.isTracked(supervision)) return Promise.resolve()
    supervision.reconciliationRequested = true
    if (forceReconnect) supervision.forceReconnectRequested = true
    if (!this.isActive(supervision) || supervision.starting) return Promise.resolve()
    if (supervision.reconciliationInFlight) return supervision.reconciliationInFlight

    const reconciliation = this.drainReconciliation(supervision).finally(() => {
      if (supervision.reconciliationInFlight === reconciliation) {
        supervision.reconciliationInFlight = undefined
      }
      if (this.isActive(supervision) && supervision.reconciliationRequested) {
        this.requestReconciliation(supervision)
      }
    })
    supervision.reconciliationInFlight = reconciliation
    return reconciliation
  }

  private async drainReconciliation(supervision: ActiveSupervision): Promise<void> {
    while (this.isActive(supervision) && supervision.reconciliationRequested) {
      supervision.reconciliationRequested = false
      const forceReconnect = supervision.forceReconnectRequested
      supervision.forceReconnectRequested = false
      try {
        await this.runReconciliation(supervision, forceReconnect)
      } catch {
        // Runtime/status reads are retried by a newer event or on the next watchdog tick.
      }
    }
  }

  private async observeOwnership(supervision: ActiveSupervision): Promise<boolean> {
    const instanceId = supervision.instanceId
    if (!this.isActive(supervision)) return false
    if (!(await this.leaseIsStillOwned(instanceId))) {
      await this.handleOwnershipLoss(supervision)
      return false
    }
    return this.isActive(supervision)
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

  logout(instanceId: string, expectedEpoch?: bigint): Promise<boolean> {
    const normalizedInstanceId = normalizeInstanceId(instanceId)
    if (expectedEpoch !== undefined && expectedEpoch <= 0n) {
      return Promise.reject(new RangeError('expectedEpoch must be positive'))
    }
    const pending = this.logouts.get(normalizedInstanceId)
    if (pending) return pending

    const pendingStart = this.starts.get(normalizedInstanceId)
    if (pendingStart && this.starts.get(normalizedInstanceId) === pendingStart) {
      this.starts.delete(normalizedInstanceId)
    }
    const pendingStop = this.stops.get(normalizedInstanceId)
    const logout = this.logoutAfterCommands(
      normalizedInstanceId,
      pendingStart,
      pendingStop,
      expectedEpoch,
    )
    const tracked = logout.then(
      (loggedOut) => {
        if (this.logouts.get(normalizedInstanceId) === tracked) {
          this.logouts.delete(normalizedInstanceId)
        }
        return loggedOut
      },
      (error: unknown) => {
        if (this.logouts.get(normalizedInstanceId) === tracked) {
          this.logouts.delete(normalizedInstanceId)
        }
        throw error
      },
    )
    this.logouts.set(normalizedInstanceId, tracked)
    return tracked
  }

  private async logoutAfterCommands(
    instanceId: string,
    pendingStart: Promise<SessionState> | undefined,
    pendingStop: Promise<boolean> | undefined,
    expectedEpoch: bigint | undefined,
  ): Promise<boolean> {
    if (pendingStart) {
      try {
        await pendingStart
      } catch {
        // Failed start already performed fail-closed cleanup; logout claims a fresh fence below.
      }
    }
    if (pendingStop) {
      try {
        await pendingStop
      } catch {
        // Logout is the stronger terminal command and may recover after a failed transport close.
      }
    }

    return this.logoutOnce(instanceId, expectedEpoch)
  }

  private async logoutOnce(
    instanceId: string,
    expectedEpoch: bigint | undefined,
  ): Promise<boolean> {
    let supervision = this.active.get(instanceId)
    const ownership = await this.ownerRegistry.getOwnership(instanceId)
    if (
      ownership &&
      (ownership.owner !== this.workerId ||
        (expectedEpoch !== undefined && ownership.epoch !== expectedEpoch))
    ) {
      if (supervision) await this.handleOwnershipLoss(supervision)
      return false
    }
    if (!ownership && expectedEpoch !== undefined) {
      if (supervision) await this.handleOwnershipLoss(supervision)
      return false
    }
    if (
      supervision &&
      (!ownership ||
        ownership.epoch !== supervision.epoch ||
        ownership.owner !== this.workerId ||
        (expectedEpoch !== undefined && supervision.epoch !== expectedEpoch))
    ) {
      await this.handleOwnershipLoss(supervision)
      return false
    }

    if (!supervision) {
      const claim = ownership ?? (await this.claimAndActivateFence(instanceId))
      if (ownership && !(await this.activateExistingFence(instanceId, ownership.epoch))) {
        await this.bestEffortRelease(instanceId, ownership.epoch)
        return false
      }
      supervision = {
        instanceId,
        epoch: claim.epoch,
        starting: false,
        stopping: false,
        stopped: false,
        reconciliationRequested: false,
        forceReconnectRequested: false,
      }
      this.active.set(instanceId, supervision)
      this.armSupervision(supervision)
    }

    supervision.stopping = true
    await supervision.reconciliationInFlight
    if (!(await this.leaseIsStillOwned(instanceId, supervision.epoch))) {
      await this.handleOwnershipLoss(supervision)
      return false
    }

    try {
      await this.assertLeaseStillOwned(instanceId, supervision.epoch)
      const state = await this.ownedSessions.logout(instanceId)
      await this.assertLeaseStillOwned(instanceId, supervision.epoch)
      if ((state.status !== 'logged_out' && state.status !== 'banned') || state.hasAuthState) {
        throw new TypeError(`WA explicit logout returned an invalid terminal state: ${instanceId}`)
      }
      if (!(await this.persistOwnedState(supervision, state))) {
        await this.handleOwnershipLoss(supervision)
        return false
      }
      if (
        (await this.qrBootstrapRepository?.clear(instanceId, this.workerId, supervision.epoch)) ===
        false
      ) {
        await this.handleOwnershipLoss(supervision)
        return false
      }

      const released = await this.ownerRegistry.release(
        instanceId,
        this.workerId,
        supervision.epoch,
      )
      this.stopSupervision(supervision)
      await supervision.heartbeatInFlight
      return released
    } catch (error: unknown) {
      if (this.isTracked(supervision)) {
        supervision.stopping = false
        this.armSupervision(supervision)
      }
      throw error
    }
  }

  private async activateExistingFence(instanceId: string, epoch: bigint): Promise<boolean> {
    const statusFenceActive =
      (await this.statusRepository?.activateOwnership(instanceId, this.workerId, epoch)) ?? true
    if (!statusFenceActive) return false
    return (
      (await this.qrBootstrapRepository?.activateOwnership(instanceId, this.workerId, epoch)) ??
      true
    )
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
    const supervision = this.active.get(normalizedInstanceId)
    const owner = await this.ownerRegistry.getOwner(normalizedInstanceId)
    if (owner !== this.workerId) {
      if (supervision) await this.handleOwnershipLoss(supervision)
      return false
    }
    if (!supervision) return false
    if (supervision) {
      supervision.stopping = true
      await supervision.reconciliationInFlight

      const ownerAfterWatchdog = await this.ownerRegistry.getOwner(normalizedInstanceId)
      if (ownerAfterWatchdog !== this.workerId) {
        await this.handleOwnershipLoss(supervision)
        return false
      }
    }

    if (!(await this.leaseIsStillOwned(normalizedInstanceId, supervision.epoch))) {
      await this.handleOwnershipLoss(supervision)
      return false
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

    if (!(await this.leaseIsStillOwned(normalizedInstanceId, supervision.epoch))) {
      this.stopSupervision(supervision)
      await supervision.heartbeatInFlight
      return false
    }

    try {
      if (!(await this.persistOwnedState(supervision, state))) {
        await this.handleOwnershipLoss(supervision)
        return false
      }
      await this.scheduleRestrictedRecovery(state)
      if (
        (await this.qrBootstrapRepository?.clear(
          normalizedInstanceId,
          this.workerId,
          supervision.epoch,
        )) === false
      ) {
        await this.handleOwnershipLoss(supervision)
        return false
      }

      const released = await this.ownerRegistry.release(
        normalizedInstanceId,
        this.workerId,
        supervision.epoch,
      )
      this.stopSupervision(supervision)
      await supervision.heartbeatInFlight
      return released
    } catch (error: unknown) {
      if (this.isTracked(supervision)) {
        supervision.stopping = false
        this.armSupervision(supervision)
      }
      throw error
    }
  }

  private async startOnce(instanceId: string): Promise<SessionState> {
    const pendingTransportShutdown = this.transportShutdownsByInstance.get(instanceId)
    if (pendingTransportShutdown) await pendingTransportShutdown
    if (this.shuttingDown) throw new WaSessionLifecycleShuttingDownError()
    const existing = this.active.get(instanceId)
    if (existing && !existing.stopped) {
      let renewed = false
      try {
        renewed = await this.ownerRegistry.renew(
          instanceId,
          this.workerId,
          this.ttlMs,
          existing.epoch,
        )
      } catch (error: unknown) {
        await this.handleOwnershipLoss(existing)
        throw error
      }
      if (renewed) {
        let state = await this.sessionManager.getState(instanceId)
        if (!(await this.persistState(existing, state))) {
          throw new WaOwnershipError(
            instanceId,
            this.workerId,
            await this.ownerRegistry.getOwner(instanceId),
          )
        }
        if (state.status === 'disconnected') {
          await existing.reconciliationInFlight
          state = await this.sessionManager.getState(instanceId)
          if (state.status === 'disconnected') {
            await this.requestReconciliation(existing, true)
            state = await this.sessionManager.getState(instanceId)
          }
        }
        return state
      }
      await this.handleOwnershipLoss(existing)
    }

    const claim = await this.claimAndActivateFence(instanceId)

    const supervision: ActiveSupervision = {
      instanceId,
      epoch: claim.epoch,
      starting: true,
      stopping: false,
      stopped: false,
      reconciliationRequested: false,
      forceReconnectRequested: false,
    }
    this.active.set(instanceId, supervision)
    this.armSupervision(supervision)

    let connectError: unknown
    let transportMayExist = false
    try {
      await this.markConnecting(supervision)
      if (this.shuttingDown) throw new WaSessionLifecycleShuttingDownError()
      transportMayExist = true
      const state = await this.connectWithRetry(supervision).catch((error: unknown) => {
        connectError = error
        throw error
      })
      await this.assertLeaseStillOwned(instanceId, supervision.epoch)
      supervision.starting = false
      if (!(await this.persistState(supervision, state))) {
        throw new WaOwnershipError(
          instanceId,
          this.workerId,
          await this.ownerRegistry.getOwner(instanceId),
        )
      }
      if (isTerminalState(state)) {
        await this.finishTerminal(supervision)
      } else if (supervision.reconciliationRequested || shouldReconnect(state)) {
        await this.requestReconciliation(supervision)
      }
      return state
    } catch (error: unknown) {
      connectError ??= error
      supervision.starting = false
      if (!this.isTracked(supervision)) {
        await supervision.shutdownInFlight
        throw error
      }

      await this.rollbackFailedStart(supervision, transportMayExist, connectError)
      throw error
    }
  }

  private async rollbackFailedStart(
    supervision: ActiveSupervision,
    transportMayExist: boolean,
    connectError: unknown,
  ): Promise<void> {
    supervision.stopping = true
    let cleanupError: unknown
    let transportClosed = !transportMayExist
    try {
      if (transportMayExist) {
        try {
          await this.closeTransportUntilClosed(supervision.instanceId)
          transportClosed = true
        } catch (error: unknown) {
          cleanupError ??= error
        }
      }

      let ownsExactEpoch = false
      if (transportClosed) {
        try {
          const ownership = await this.ownerRegistry.getOwnership(supervision.instanceId)
          ownsExactEpoch =
            ownership?.owner === this.workerId && ownership.epoch === supervision.epoch
        } catch (error: unknown) {
          cleanupError ??= error
        }
      }

      if (ownsExactEpoch) {
        if (connectError && !(connectError instanceof WaOwnershipError)) {
          try {
            await this.statusRepository?.markDisconnected(
              supervision.instanceId,
              this.workerId,
              reasonFromError(connectError),
              supervision.epoch,
            )
          } catch (error: unknown) {
            cleanupError ??= error
          }
        }
        try {
          await this.qrBootstrapRepository?.clear(
            supervision.instanceId,
            this.workerId,
            supervision.epoch,
          )
        } catch (error: unknown) {
          cleanupError ??= error
        }
        try {
          await this.ownerRegistry.release(supervision.instanceId, this.workerId, supervision.epoch)
        } catch (error: unknown) {
          cleanupError ??= error
        }
      }
    } finally {
      this.stopSupervision(supervision)
      try {
        await supervision.heartbeatInFlight
      } catch (error: unknown) {
        cleanupError ??= error
      }
    }

    if (cleanupError !== undefined) throw cleanupError
  }

  private armSupervision(supervision: ActiveSupervision): void {
    if (supervision.stopped || supervision.stopping || supervision.interval !== undefined) return

    const intervalMs = Math.max(1, Math.floor(this.ttlMs / 2))
    supervision.interval = timerRuntime.setInterval(() => {
      this.scheduleHeartbeat(supervision)
      this.requestReconciliation(supervision)
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
      renewed = await this.ownerRegistry.renew(
        supervision.instanceId,
        this.workerId,
        this.ttlMs,
        supervision.epoch,
      )
    } catch {
      await this.handleOwnershipLoss(supervision)
      return
    }

    if (this.isTracked(supervision) && !renewed) {
      await this.handleOwnershipLoss(supervision)
    }
  }

  private async runReconciliation(
    supervision: ActiveSupervision,
    forceReconnect = false,
  ): Promise<void> {
    if (!(await this.observeOwnership(supervision))) return
    const state = await this.sessionManager.getState(supervision.instanceId)
    if (!this.isActive(supervision)) return
    if (!(await this.observeOwnership(supervision))) return
    if (!(await this.persistState(supervision, state))) return

    if (isTerminalState(state)) {
      if (state.status === 'banned') {
        await this.sessionManager.closeTransport(supervision.instanceId)
        if (!this.isActive(supervision)) return
      }
      await this.finishTerminal(supervision)
      return
    }
    if (state.status === 'restricted') {
      await this.sessionManager.closeTransport(supervision.instanceId)
      if (!this.isActive(supervision)) return
      if (!state.restrictedUntil) {
        throw new TypeError('restricted session state requires restrictedUntil')
      }
      if (!this.restrictionRecoveryScheduler) {
        throw new Error('WA restriction recovery scheduler is not configured')
      }
      await this.restrictionRecoveryScheduler.scheduleRestrictedRecovery(
        supervision.instanceId,
        state.restrictedUntil,
      )
      await this.finishTerminal(supervision)
      return
    }
    if (!forceReconnect && !shouldReconnect(state)) return
    if (state.status !== 'disconnected') return

    try {
      await this.markConnecting(supervision)
    } catch (error: unknown) {
      if (error instanceof WaOwnershipError) {
        await this.handleOwnershipLoss(supervision)
        return
      }
      // Status visibility is retried independently; it must not block transport recovery.
    }
    try {
      const reconnecting = await this.connectWithRetry(supervision)
      if (!this.isActive(supervision)) return
      if (!(await this.leaseIsStillOwned(supervision.instanceId))) {
        await this.handleOwnershipLoss(supervision)
        return
      }
      if (!(await this.persistState(supervision, reconnecting))) return
    } catch (error: unknown) {
      if (!this.isActive(supervision)) return
      if (error instanceof WaOwnershipError) {
        await this.handleOwnershipLoss(supervision)
        return
      }
      const persisted = await this.statusRepository?.markDisconnected(
        supervision.instanceId,
        this.workerId,
        reasonFromError(error),
        supervision.epoch,
      )
      if (persisted === false) {
        await this.handleOwnershipLoss(supervision)
        return
      }
      supervision.lastStatusKey = undefined
    }
  }

  private handleOwnershipLoss(supervision: ActiveSupervision): Promise<void> {
    if (supervision.shutdownInFlight) return supervision.shutdownInFlight

    return this.trackTransportShutdown(supervision, this.shutdownAfterOwnershipLoss(supervision))
  }

  private handleApplicationShutdown(supervision: ActiveSupervision): Promise<void> {
    if (supervision.shutdownInFlight) return supervision.shutdownInFlight

    return this.trackTransportShutdown(supervision, this.shutdownForApplication(supervision))
  }

  private trackTransportShutdown(
    supervision: ActiveSupervision,
    shutdown: Promise<void>,
  ): Promise<void> {
    const tracked = shutdown.finally(() => {
      this.transportShutdowns.delete(tracked)
      if (this.transportShutdownsByInstance.get(supervision.instanceId) === tracked) {
        this.transportShutdownsByInstance.delete(supervision.instanceId)
      }
    })
    supervision.shutdownInFlight = tracked
    this.transportShutdowns.add(tracked)
    this.transportShutdownsByInstance.set(supervision.instanceId, tracked)
    return tracked
  }

  private async shutdownForApplication(supervision: ActiveSupervision): Promise<void> {
    supervision.stopping = true
    this.disarmSupervision(supervision)
    let firstError: unknown
    let state: SessionState | undefined
    try {
      try {
        state = await this.closeTransportUntilClosed(supervision.instanceId)
      } catch (error: unknown) {
        firstError ??= error
      }

      if (state) {
        let ownsExactEpoch = false
        try {
          const ownership = await this.ownerRegistry.getOwnership(supervision.instanceId)
          ownsExactEpoch =
            ownership?.owner === this.workerId && ownership.epoch === supervision.epoch
        } catch (error: unknown) {
          firstError ??= error
        }

        if (ownsExactEpoch) {
          try {
            const persisted = await this.persistOwnedState(supervision, state)
            if (persisted) await this.scheduleRestrictedRecovery(state)
          } catch (error: unknown) {
            firstError ??= error
          }
        }
        if (ownsExactEpoch) {
          try {
            await this.qrBootstrapRepository?.clear(
              supervision.instanceId,
              this.workerId,
              supervision.epoch,
            )
          } catch (error: unknown) {
            firstError ??= error
          }
          try {
            await this.ownerRegistry.release(
              supervision.instanceId,
              this.workerId,
              supervision.epoch,
            )
          } catch (error: unknown) {
            firstError ??= error
          }
        }
      }
    } finally {
      this.stopSupervision(supervision)
    }

    if (firstError !== undefined) throw firstError
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
      await this.ownerRegistry.release(supervision.instanceId, this.workerId, supervision.epoch)
    }
  }

  private async markConnecting(supervision: ActiveSupervision): Promise<void> {
    if (supervision.lastStatusKey === 'connecting::') return
    const persisted = await this.statusRepository?.markConnecting(
      supervision.instanceId,
      this.workerId,
      supervision.epoch,
    )
    if (persisted === false) throw new WaOwnershipError(supervision.instanceId, this.workerId, null)
    supervision.lastStatusKey = 'connecting::'
  }

  private async persistState(
    supervision: ActiveSupervision,
    state: SessionState,
  ): Promise<boolean> {
    if (!(await this.observeOwnership(supervision))) return false
    if (state.status !== 'connecting' && state.status !== 'idle') {
      if (
        (await this.qrBootstrapRepository?.clear(
          state.instanceId,
          this.workerId,
          supervision.epoch,
        )) === false
      ) {
        await this.handleOwnershipLoss(supervision)
        return false
      }
      if (!(await this.observeOwnership(supervision))) return false
    }
    const statusKey = `${state.status}:${state.lastDisconnectReason ?? ''}:${state.restrictedUntil?.toISOString() ?? ''}`
    if (supervision.lastStatusKey === statusKey) return true

    if (state.status === 'connecting') {
      if (
        (await this.statusRepository?.markConnecting(
          state.instanceId,
          this.workerId,
          supervision.epoch,
        )) === false
      ) {
        await this.handleOwnershipLoss(supervision)
        return false
      }
    } else if (state.status === 'connected') {
      if (
        (await this.statusRepository?.markConnected(
          state.instanceId,
          this.workerId,
          supervision.epoch,
        )) === false
      ) {
        await this.handleOwnershipLoss(supervision)
        return false
      }
    } else if (state.status === 'logged_out') {
      if (
        (await this.statusRepository?.markLoggedOut(
          state.instanceId,
          this.workerId,
          supervision.epoch,
        )) === false
      ) {
        await this.handleOwnershipLoss(supervision)
        return false
      }
    } else if (state.status === 'banned') {
      if (
        (await this.statusRepository?.markBanned(
          state.instanceId,
          this.workerId,
          state.lastDisconnectReason,
          supervision.epoch,
        )) === false
      ) {
        await this.handleOwnershipLoss(supervision)
        return false
      }
    } else if (state.status === 'restricted') {
      if (!state.restrictedUntil) {
        throw new TypeError('restricted session state requires restrictedUntil')
      }
      if (
        (await this.statusRepository?.markRestricted(
          state.instanceId,
          this.workerId,
          state.restrictedUntil,
          supervision.epoch,
        )) === false
      ) {
        await this.handleOwnershipLoss(supervision)
        return false
      }
    } else {
      if (
        (await this.statusRepository?.markDisconnected(
          state.instanceId,
          this.workerId,
          state.lastDisconnectReason ?? state.status,
          supervision.epoch,
        )) === false
      ) {
        await this.handleOwnershipLoss(supervision)
        return false
      }
    }
    supervision.lastStatusKey = statusKey
    return true
  }

  private async persistOwnedState(
    supervision: ActiveSupervision,
    state: SessionState,
  ): Promise<boolean> {
    if (state.status === 'banned') {
      return (
        (await this.statusRepository?.markBanned(
          state.instanceId,
          this.workerId,
          state.lastDisconnectReason,
          supervision.epoch,
        )) ?? true
      )
    }
    if (state.status === 'restricted') {
      if (!state.restrictedUntil) {
        throw new TypeError('restricted session state requires restrictedUntil')
      }
      return (
        (await this.statusRepository?.markRestricted(
          state.instanceId,
          this.workerId,
          state.restrictedUntil,
          supervision.epoch,
        )) ?? true
      )
    }
    if (state.status === 'logged_out') {
      return (
        (await this.statusRepository?.markLoggedOut(
          state.instanceId,
          this.workerId,
          supervision.epoch,
        )) ?? true
      )
    }
    return (
      (await this.statusRepository?.markDisconnected(
        state.instanceId,
        this.workerId,
        state.lastDisconnectReason,
        supervision.epoch,
      )) ?? true
    )
  }

  private async scheduleRestrictedRecovery(state: SessionState): Promise<void> {
    if (state.status !== 'restricted') return
    if (!state.restrictedUntil) {
      throw new TypeError('restricted session state requires restrictedUntil')
    }
    if (!this.restrictionRecoveryScheduler) {
      throw new Error('WA restriction recovery scheduler is not configured')
    }
    await this.restrictionRecoveryScheduler.scheduleRestrictedRecovery(
      state.instanceId,
      state.restrictedUntil,
    )
  }

  private isActive(supervision: ActiveSupervision): boolean {
    return this.isTracked(supervision) && !supervision.stopping && !supervision.stopped
  }

  private isTracked(supervision: ActiveSupervision): boolean {
    return !supervision.stopped && this.active.get(supervision.instanceId) === supervision
  }

  private async connectWithRetry(supervision: ActiveSupervision): Promise<SessionState> {
    let lastError: unknown
    const instanceId = supervision.instanceId

    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
      try {
        await this.assertLeaseStillOwned(instanceId, supervision.epoch)
        const state = await this.ownedSessions.connect(instanceId)
        try {
          await this.assertLeaseStillOwned(instanceId, supervision.epoch)
        } catch (error: unknown) {
          await this.closeTransportUntilClosed(instanceId)
          throw error
        }
        return state
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

  private async claimAndActivateFence(instanceId: string): Promise<OwnerClaimResult> {
    let minimumEpoch = (await this.statusRepository?.getOwnershipEpoch(instanceId)) ?? 0n
    let lastOwner: string | null = null

    for (let attempt = 1; attempt <= FENCE_ACTIVATION_ATTEMPTS; attempt += 1) {
      const claim = await this.ownerRegistry.claim(
        instanceId,
        this.workerId,
        this.ttlMs,
        minimumEpoch,
      )
      lastOwner = claim.owner
      if (!claim.claimed) throw new WaOwnershipError(instanceId, this.workerId, claim.owner)
      if (this.shuttingDown) {
        await this.ownerRegistry.release(instanceId, this.workerId, claim.epoch)
        throw new WaSessionLifecycleShuttingDownError()
      }

      let statusFenceActive = false
      let qrFenceActive = false
      try {
        statusFenceActive =
          (await this.statusRepository?.activateOwnership(
            instanceId,
            this.workerId,
            claim.epoch,
          )) ?? true
        qrFenceActive = statusFenceActive
          ? ((await this.qrBootstrapRepository?.activateOwnership(
              instanceId,
              this.workerId,
              claim.epoch,
            )) ?? true)
          : false
      } catch (error: unknown) {
        await this.bestEffortRelease(instanceId, claim.epoch)
        throw error
      }
      if (statusFenceActive && qrFenceActive) return claim

      await this.bestEffortRelease(instanceId, claim.epoch)
      const persistedEpoch = (await this.statusRepository?.getOwnershipEpoch(instanceId)) ?? 0n
      minimumEpoch = persistedEpoch > claim.epoch ? persistedEpoch : claim.epoch
    }

    throw new WaOwnershipError(instanceId, this.workerId, lastOwner)
  }

  private async bestEffortRelease(instanceId: string, epoch: bigint): Promise<void> {
    try {
      await this.ownerRegistry.release(instanceId, this.workerId, epoch)
    } catch {
      // The caller still fails closed; the lease expires if Redis cannot confirm release.
    }
  }

  private async closeTransportUntilClosed(instanceId: string): Promise<SessionState> {
    let failedAttempts = 0

    for (;;) {
      try {
        return await this.closeTransportAttempt(instanceId)
      } catch (error: unknown) {
        failedAttempts += 1
        if (this.shuttingDown && failedAttempts >= SHUTDOWN_CLOSE_ATTEMPTS) throw error
        const backoffMs = Math.min(CLOSE_BACKOFF_MS * 2 ** Math.min(failedAttempts - 1, 7), 1_000)
        await delay(backoffMs)
      }
    }
  }

  private closeTransportAttempt(instanceId: string): Promise<SessionState> {
    const close = this.sessionManager.closeTransport(instanceId)
    const signal = this.shutdownController.signal

    return new Promise<SessionState>((resolve, reject) => {
      let settled = false
      let timeoutStarted = false
      let timeoutHandle: unknown
      const finish = (): boolean => {
        if (settled) return false
        settled = true
        signal.removeEventListener('abort', startShutdownTimeout)
        if (timeoutHandle !== undefined) {
          timerRuntime.clearTimeout(timeoutHandle)
          timeoutHandle = undefined
        }
        return true
      }
      const startShutdownTimeout = (): void => {
        if (timeoutStarted) return
        timeoutStarted = true
        timeoutHandle = timerRuntime.setTimeout(() => {
          if (finish()) reject(new WaSessionTransportCloseTimeoutError(instanceId))
        }, SHUTDOWN_CLOSE_TIMEOUT_MS)
        unrefTimer(timeoutHandle)
      }

      signal.addEventListener('abort', startShutdownTimeout, { once: true })
      if (signal.aborted) startShutdownTimeout()
      close.then(
        (state) => {
          if (finish()) resolve(state)
        },
        (error: unknown) => {
          if (finish()) reject(error)
        },
      )
    })
  }

  private async leaseIsStillOwned(instanceId: string, epoch?: bigint): Promise<boolean> {
    const activeEpoch = epoch ?? this.active.get(instanceId)?.epoch
    if (activeEpoch === undefined) return false
    try {
      return await this.ownerRegistry.renew(instanceId, this.workerId, this.ttlMs, activeEpoch)
    } catch {
      return false
    }
  }

  private async assertLeaseStillOwned(instanceId: string, epoch: bigint): Promise<void> {
    const renewed = await this.ownerRegistry.renew(instanceId, this.workerId, this.ttlMs, epoch)
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
