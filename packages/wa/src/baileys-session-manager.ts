import type { WaAuthStateStore } from './auth-state'
import type {
  SessionManager,
  SessionState,
  WaConnectionStatus,
  WaDisconnectReason,
} from './session'
import { createWaRestrictedUntil } from './session'
import {
  WaTransportAlreadyConnectedError,
  WaTransportNotConnectedError,
  type WaTransportCallbacks,
  type WaTransportErrorEvent,
  type WaTransportFactory,
  type WaTransportQrEvent,
} from './transport'

type MaybePromise<T> = Promise<T> | T
type SessionOperation = 'connect' | 'close' | 'logout'

export interface WaSessionQrEvent extends WaTransportQrEvent {
  state: SessionState
}

export interface WaSessionConnectedEvent {
  instanceId: string
  state: SessionState
}

export interface WaSessionDisconnectedEvent {
  instanceId: string
  reason: WaDisconnectReason
  state: SessionState
}

export interface WaSessionLoggedOutEvent {
  instanceId: string
  state: SessionState
}

export interface WaSessionErrorEvent extends WaTransportErrorEvent {
  state: SessionState
}

export interface WaSessionEvents {
  onQr?: (event: WaSessionQrEvent) => MaybePromise<void>
  onConnected?: (event: WaSessionConnectedEvent) => MaybePromise<void>
  onDisconnected?: (event: WaSessionDisconnectedEvent) => MaybePromise<void>
  onLoggedOut?: (event: WaSessionLoggedOutEvent) => MaybePromise<void>
  onError?: (event: WaSessionErrorEvent) => MaybePromise<void>
}

export class WaSessionOperationInProgressError extends Error {
  constructor(
    readonly instanceId: string,
    readonly operation: SessionOperation,
  ) {
    super(`WA session ${instanceId} already has an operation in progress: ${operation}`)
    this.name = 'WaSessionOperationInProgressError'
  }
}

export class WaSessionAlreadyActiveError extends Error {
  constructor(
    readonly instanceId: string,
    readonly status: Extract<WaConnectionStatus, 'connecting' | 'connected'>,
  ) {
    super(`WA session ${instanceId} is already ${status}`)
    this.name = 'WaSessionAlreadyActiveError'
  }
}

export class WaSessionConnectForbiddenError extends Error {
  constructor(
    readonly instanceId: string,
    readonly status: Extract<WaConnectionStatus, 'banned'>,
  ) {
    super(`WA session ${instanceId} cannot connect while it is ${status}`)
    this.name = 'WaSessionConnectForbiddenError'
  }
}

interface RuntimeSession {
  state: SessionState
  generation: number
  allowRecoveryConnect: boolean
  requiresTerminalTransportClose: boolean
}

interface ActiveOperation {
  kind: SessionOperation
  generation: number
  token: symbol
}

export class BaileysSessionManager implements SessionManager {
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly initializations = new Map<string, Promise<RuntimeSession>>()
  private readonly operations = new Map<string, ActiveOperation>()

  constructor(
    private readonly transport: WaTransportFactory,
    private readonly authStateStore: WaAuthStateStore,
    private readonly events: WaSessionEvents = {},
  ) {}

  async getState(instanceId: string): Promise<SessionState> {
    const normalizedInstanceId = normalizeInstanceId(instanceId)
    return cloneState((await this.ensureRuntime(normalizedInstanceId)).state)
  }

  async connect(instanceId: string): Promise<SessionState> {
    const normalizedInstanceId = normalizeInstanceId(instanceId)
    const runtime = await this.ensureRuntime(normalizedInstanceId)
    const operation = this.reserveOperation(normalizedInstanceId, runtime, 'connect')
    const previousState = cloneState(runtime.state)
    const wasRecoveryConnect = runtime.allowRecoveryConnect
    const generation = runtime.generation + 1
    runtime.generation = generation
    operation.generation = generation
    runtime.state = {
      ...runtime.state,
      instanceId: normalizedInstanceId,
      status: 'connecting',
      lastDisconnectReason: undefined,
      restrictedUntil: undefined,
    }

    try {
      const result = await this.transport.connect(
        normalizedInstanceId,
        this.createTransportCallbacks(normalizedInstanceId, generation),
      )
      if (runtime.generation === generation && runtime.state.status === 'connecting') {
        runtime.state = mergeTransportState(normalizedInstanceId, runtime.state, result)
        runtime.allowRecoveryConnect = false
      }
      return cloneState(runtime.state)
    } catch (error: unknown) {
      if (runtime.generation === generation) {
        const activeRecoveryConfirmed =
          wasRecoveryConnect && error instanceof WaTransportAlreadyConnectedError
        runtime.generation = activeRecoveryConfirmed ? generation - 1 : generation + 1
        if (activeRecoveryConfirmed) runtime.allowRecoveryConnect = false
        runtime.state = previousState
      }
      throw error
    } finally {
      this.releaseOperation(normalizedInstanceId, operation.token)
    }
  }

  async closeTransport(instanceId: string): Promise<SessionState> {
    const normalizedInstanceId = normalizeInstanceId(instanceId)
    const runtime = await this.ensureRuntime(normalizedInstanceId)
    if (runtime.state.status === 'banned' || runtime.state.status === 'restricted') {
      return this.confirmTerminalTransportClosed(normalizedInstanceId, runtime)
    }
    if (runtime.state.status !== 'connecting' && runtime.state.status !== 'connected') {
      return cloneState(runtime.state)
    }
    return this.runTerminalCommand(normalizedInstanceId, runtime, 'close', (normalizedInstanceId) =>
      this.transport.closeTransport(normalizedInstanceId),
    )
  }

  async logout(instanceId: string): Promise<SessionState> {
    const normalizedInstanceId = normalizeInstanceId(instanceId)
    const runtime = await this.ensureRuntime(normalizedInstanceId)
    if (runtime.state.status === 'logged_out') return cloneState(runtime.state)
    if (runtime.state.status === 'banned') {
      await this.authStateStore.clear(normalizedInstanceId)
      runtime.state = { ...runtime.state, hasAuthState: false }
      return cloneState(runtime.state)
    }
    if (runtime.state.status !== 'connecting' && runtime.state.status !== 'connected') {
      return this.clearStoredAuthForLogout(normalizedInstanceId, runtime)
    }
    return this.runTerminalCommand(
      normalizedInstanceId,
      runtime,
      'logout',
      (normalizedInstanceId) => this.transport.logout(normalizedInstanceId),
    )
  }

  async handleDisconnect(
    instanceId: string,
    reason: WaDisconnectReason,
    restrictedUntil?: Date,
  ): Promise<SessionState> {
    const normalizedInstanceId = normalizeInstanceId(instanceId)
    const runtime = await this.ensureRuntime(normalizedInstanceId)
    const activeOperation = this.operations.get(normalizedInstanceId)
    if (activeOperation) {
      throw new WaSessionOperationInProgressError(normalizedInstanceId, activeOperation.kind)
    }
    if (runtime.state.status === 'banned' || runtime.state.status === 'logged_out') {
      return cloneState(runtime.state)
    }
    if (
      runtime.state.status === 'restricted' &&
      reason !== 'restricted' &&
      reason !== 'banned' &&
      reason !== 'logged_out'
    ) {
      return cloneState(runtime.state)
    }

    const generation = runtime.generation
    await this.recordDisconnect(
      normalizedInstanceId,
      runtime,
      generation,
      reason,
      reason === 'banned' || reason === 'restricted',
      restrictedUntil,
    )
    return cloneState(runtime.state)
  }

  private async runTerminalCommand(
    normalizedInstanceId: string,
    runtime: RuntimeSession,
    kind: Exclude<SessionOperation, 'connect'>,
    command: (normalizedInstanceId: string) => Promise<SessionState>,
  ): Promise<SessionState> {
    const operation = this.reserveOperation(normalizedInstanceId, runtime, kind)
    const generation = runtime.generation

    try {
      const result = await command(normalizedInstanceId)
      if (runtime.generation === generation) {
        runtime.generation += 1
        runtime.state = mergeTerminalCommandState(normalizedInstanceId, runtime.state, result, kind)
        runtime.allowRecoveryConnect = false
      }
      return cloneState(runtime.state)
    } catch (error: unknown) {
      if (runtime.generation === generation && error instanceof WaTransportNotConnectedError) {
        return this.reconcileMissingTransport(normalizedInstanceId, runtime, generation, kind)
      }
      if (runtime.generation === generation) {
        runtime.allowRecoveryConnect = true
        await this.reconcileAuthState(normalizedInstanceId, runtime, generation)
      }
      throw error
    } finally {
      this.releaseOperation(normalizedInstanceId, operation.token)
    }
  }

  private async confirmTerminalTransportClosed(
    instanceId: string,
    runtime: RuntimeSession,
  ): Promise<SessionState> {
    if (!runtime.requiresTerminalTransportClose) return cloneState(runtime.state)

    const operation = this.reserveOperation(instanceId, runtime, 'close')
    try {
      await this.transport.closeTransport(instanceId)
    } catch (error: unknown) {
      if (!(error instanceof WaTransportNotConnectedError)) throw error
    } finally {
      this.releaseOperation(instanceId, operation.token)
    }

    runtime.requiresTerminalTransportClose = false
    return cloneState(runtime.state)
  }

  private reserveOperation(
    instanceId: string,
    runtime: RuntimeSession,
    kind: SessionOperation,
  ): ActiveOperation {
    const active = this.operations.get(instanceId)
    if (active) throw new WaSessionOperationInProgressError(instanceId, active.kind)
    if (kind === 'connect' && runtime.state.status === 'banned') {
      throw new WaSessionConnectForbiddenError(instanceId, runtime.state.status)
    }
    if (
      kind === 'connect' &&
      !runtime.allowRecoveryConnect &&
      (runtime.state.status === 'connecting' || runtime.state.status === 'connected')
    ) {
      throw new WaSessionAlreadyActiveError(instanceId, runtime.state.status)
    }

    const operation: ActiveOperation = {
      kind,
      generation: runtime.generation,
      token: Symbol(`${instanceId}:${kind}`),
    }
    this.operations.set(instanceId, operation)
    return operation
  }

  private releaseOperation(instanceId: string, token: symbol): void {
    if (this.operations.get(instanceId)?.token === token) {
      this.operations.delete(instanceId)
    }
  }

  private createTransportCallbacks(instanceId: string, generation: number): WaTransportCallbacks {
    let retiredState: SessionState | undefined
    const callbacks: WaTransportCallbacks = {
      onQr: async (event) => {
        const runtime = this.currentRuntime(instanceId, generation)
        if (!runtime) return
        await this.dispatchObserver(instanceId, runtime, this.events.onQr, {
          ...event,
          instanceId,
          state: cloneState(runtime.state),
        })
      },
      onConnected: async (event) => {
        const runtime = this.currentRuntime(instanceId, generation)
        if (!runtime) return
        if (runtime.state.status === 'connected') return
        runtime.state = {
          ...runtime.state,
          ...event.state,
          instanceId,
          status: 'connected',
          hasAuthState: event.state?.hasAuthState ?? true,
          logoutCount: runtime.state.logoutCount,
          lastDisconnectReason: undefined,
          restrictedUntil: undefined,
        }
        runtime.allowRecoveryConnect = false
        await this.dispatchObserver(instanceId, runtime, this.events.onConnected, {
          instanceId,
          state: cloneState(runtime.state),
        })
      },
      onDisconnected: async (event) => {
        const runtime = this.currentRuntime(instanceId, generation)
        if (!runtime) return
        retiredState = await this.recordDisconnect(
          instanceId,
          runtime,
          generation,
          event.reason,
          false,
          event.restrictedUntil,
        )
      },
      onLoggedOut: async () => {
        const runtime = this.currentRuntime(instanceId, generation)
        if (!runtime) return
        retiredState = await this.recordDisconnect(instanceId, runtime, generation, 'logged_out')
      },
    }
    if (this.events.onError) {
      callbacks.onError = async (event) => {
        const runtime = this.currentRuntime(instanceId, generation)
        const state = runtime?.state ?? retiredState
        if (!state) return
        await this.dispatchError(instanceId, state, event.error)
      }
    }
    return callbacks
  }

  private async recordDisconnect(
    instanceId: string,
    runtime: RuntimeSession,
    generation: number,
    reason: WaDisconnectReason,
    requiresTerminalTransportClose = false,
    restrictedUntil?: Date,
  ): Promise<SessionState | undefined> {
    if (runtime.generation !== generation) return undefined
    if (reason === 'logged_out' && runtime.state.status === 'logged_out') {
      return cloneState(runtime.state)
    }

    runtime.state = transitionDisconnect(runtime.state, reason, restrictedUntil)
    runtime.requiresTerminalTransportClose =
      (reason === 'banned' || reason === 'restricted') && requiresTerminalTransportClose
    const terminalState = cloneState(runtime.state)
    runtime.allowRecoveryConnect = false
    runtime.generation += 1
    const activeOperation = this.operations.get(instanceId)
    if (activeOperation?.generation === generation) {
      this.operations.delete(instanceId)
    }

    if (reason === 'logged_out') {
      await this.dispatchObserver(instanceId, runtime, this.events.onLoggedOut, {
        instanceId,
        state: cloneState(terminalState),
      })
      return terminalState
    }
    await this.dispatchObserver(instanceId, runtime, this.events.onDisconnected, {
      instanceId,
      reason,
      state: cloneState(terminalState),
    })
    return terminalState
  }

  private async dispatchObserver<T>(
    instanceId: string,
    runtime: RuntimeSession,
    observer: ((event: T) => MaybePromise<void>) | undefined,
    event: T,
  ): Promise<void> {
    if (!observer) return
    try {
      await observer(event)
    } catch (error: unknown) {
      if (!this.events.onError) throw error
      await this.dispatchError(instanceId, runtime.state, error)
    }
  }

  private async dispatchError(
    instanceId: string,
    state: SessionState,
    error: unknown,
  ): Promise<void> {
    try {
      await this.events.onError?.({ instanceId, error, state: cloneState(state) })
    } catch {
      // Error observers are terminal and must never create an unhandled rejection.
    }
  }

  private currentRuntime(instanceId: string, generation: number): RuntimeSession | undefined {
    const runtime = this.sessions.get(instanceId)
    return runtime?.generation === generation ? runtime : undefined
  }

  private async ensureRuntime(instanceId: string): Promise<RuntimeSession> {
    const existing = this.sessions.get(instanceId)
    if (existing) return existing

    const pending = this.initializations.get(instanceId)
    if (pending) return pending

    const initialization = (async () => {
      const hasAuthState = await this.authStateStore.has(instanceId)
      const current = this.sessions.get(instanceId)
      if (current) return current

      const runtime: RuntimeSession = {
        state: {
          instanceId,
          status: hasAuthState ? 'disconnected' : 'idle',
          hasAuthState,
          logoutCount: 0,
        },
        generation: 0,
        allowRecoveryConnect: false,
        requiresTerminalTransportClose: false,
      }
      this.sessions.set(instanceId, runtime)
      return runtime
    })()
    this.initializations.set(instanceId, initialization)
    try {
      return await initialization
    } finally {
      if (this.initializations.get(instanceId) === initialization) {
        this.initializations.delete(instanceId)
      }
    }
  }

  private async clearStoredAuthForLogout(
    instanceId: string,
    runtime: RuntimeSession,
  ): Promise<SessionState> {
    const operation = this.reserveOperation(instanceId, runtime, 'logout')
    const generation = runtime.generation
    try {
      await this.authStateStore.clear(instanceId)
      if (runtime.generation === generation) {
        runtime.generation += 1
        runtime.allowRecoveryConnect = false
        runtime.state = transitionDisconnect(runtime.state, 'logged_out')
      }
      return cloneState(runtime.state)
    } finally {
      this.releaseOperation(instanceId, operation.token)
    }
  }

  private async reconcileAuthState(
    instanceId: string,
    runtime: RuntimeSession,
    generation: number,
  ): Promise<void> {
    try {
      const hasAuthState = await this.authStateStore.has(instanceId)
      if (runtime.generation !== generation) return
      runtime.state = {
        ...runtime.state,
        hasAuthState,
      }
    } catch {
      // Preserve the original command error and the last known auth snapshot.
    }
  }

  private async reconcileMissingTransport(
    instanceId: string,
    runtime: RuntimeSession,
    generation: number,
    kind: Exclude<SessionOperation, 'connect'>,
  ): Promise<SessionState> {
    if (kind === 'logout') {
      await this.authStateStore.clear(instanceId)
      if (runtime.generation === generation) {
        runtime.generation += 1
        runtime.allowRecoveryConnect = false
        runtime.state = transitionDisconnect(runtime.state, 'logged_out')
      }
      return cloneState(runtime.state)
    }

    const hasAuthState = await this.authStateStore.has(instanceId)
    if (runtime.generation === generation) {
      runtime.generation += 1
      runtime.allowRecoveryConnect = false
      runtime.state = {
        ...runtime.state,
        status: 'disconnected',
        hasAuthState,
        lastDisconnectReason: 'connection_closed',
      }
    }
    return cloneState(runtime.state)
  }
}

function mergeTransportState(
  instanceId: string,
  current: SessionState,
  result: SessionState,
): SessionState {
  return {
    ...result,
    instanceId,
    logoutCount: current.logoutCount,
  }
}

function mergeTerminalCommandState(
  instanceId: string,
  current: SessionState,
  result: SessionState,
  kind: Exclude<SessionOperation, 'connect'>,
): SessionState {
  return {
    ...result,
    instanceId,
    logoutCount: kind === 'logout' ? current.logoutCount + 1 : current.logoutCount,
  }
}

function transitionDisconnect(
  state: SessionState,
  reason: WaDisconnectReason,
  restrictedUntil?: Date,
): SessionState {
  if (reason === 'logged_out') {
    if (state.status === 'banned') {
      return {
        ...state,
        hasAuthState: false,
        logoutCount: state.logoutCount + 1,
        restrictedUntil: undefined,
      }
    }
    return {
      ...state,
      status: 'logged_out',
      hasAuthState: false,
      logoutCount: state.logoutCount + 1,
      lastDisconnectReason: 'logged_out',
      restrictedUntil: undefined,
    }
  }
  if (reason === 'restricted') {
    const candidate = restrictedUntil
      ? normalizeRestrictedUntil(restrictedUntil)
      : createWaRestrictedUntil(new Date())
    const current = state.restrictedUntil?.getTime() ?? 0
    return {
      ...state,
      status: 'restricted',
      lastDisconnectReason: 'restricted',
      restrictedUntil: new Date(Math.max(current, candidate.getTime())),
    }
  }
  return {
    ...state,
    status: statusFromDisconnect(reason),
    lastDisconnectReason: reason,
    restrictedUntil: undefined,
  }
}

function statusFromDisconnect(
  reason: Exclude<WaDisconnectReason, 'logged_out'>,
): WaConnectionStatus {
  if (reason === 'restricted') return 'restricted'
  if (reason === 'banned') return 'banned'
  return 'disconnected'
}

function normalizeInstanceId(instanceId: string): string {
  const normalized = instanceId.trim()
  if (normalized.length === 0) throw new TypeError('instanceId must be a non-empty string')
  return normalized
}

function cloneState(state: SessionState): SessionState {
  return {
    ...state,
    restrictedUntil: state.restrictedUntil ? new Date(state.restrictedUntil) : undefined,
  }
}

function normalizeRestrictedUntil(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('restrictedUntil must be a valid Date')
  }
  return new Date(value)
}
