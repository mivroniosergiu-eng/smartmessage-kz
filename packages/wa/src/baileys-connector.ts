import makeWASocket, {
  DisconnectReason,
  type AuthenticationState,
  type BaileysEventMap,
  type SignalDataSet,
  type SignalDataTypeMap,
  type UserFacingSocketConfig,
  type WASocket,
} from '@whiskeysockets/baileys'

import type { WaAuthStateJsonValue, WaAuthStateStore } from './auth-state'
import {
  readBaileysAuthState,
  writeBaileysAuthState,
  type BaileysAuthState,
} from './baileys-auth-state-mapper'
import type { BaileysTransportConnectInput, BaileysTransportConnector } from './baileys-transport-adapter'
import type { SessionState, WaDisconnectReason } from './session'
import {
  WaTransportAlreadyConnectedError,
  WaTransportNotConnectedError,
  WaTransportOperationInProgressError,
  type WaTransportCallbacks,
  type WaTransportSession,
} from './transport'

const DEFAULT_QR_TTL_MS = 60_000
const BINARY_JSON_MARKER = '__smartmessageWaBinary'

export interface BaileysSocketTransportConnectorOptions {
  now?: () => Date
  qrTtlMs?: number
  socketConfig?: Omit<Partial<UserFacingSocketConfig>, 'auth' | 'printQRInTerminal'>
}

interface ActiveBaileysTransport {
  socket: WASocket
  callbacks?: WaTransportCallbacks
  auth: StoreBackedAuthenticationState
  phase: 'active' | 'closing' | 'logging_out' | 'remote_closing' | 'terminal_failed'
  eventTail: Promise<void>
  transportClosed: Promise<void>
  resolveTransportClosed(): void
}

interface StoreBackedAuthenticationState extends AuthenticationState {
  mergeCreds(update: Partial<AuthenticationState['creds']>): Promise<void>
  deactivate(): void
  drain(): Promise<void>
}

export class BaileysSocketTransportConnector implements BaileysTransportConnector {
  private readonly activeTransports = new Map<string, ActiveBaileysTransport>()
  private readonly openingTransports = new Set<string>()
  private readonly terminalTransports = new Set<string>()
  private readonly pendingAuthClears = new Set<string>()
  private readonly now: () => Date
  private readonly qrTtlMs: number
  private readonly socketConfig: Omit<Partial<UserFacingSocketConfig>, 'auth' | 'printQRInTerminal'>

  constructor(
    private readonly authStateStore: WaAuthStateStore,
    options: BaileysSocketTransportConnectorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.qrTtlMs = normalizeQrTtlMs(options.qrTtlMs ?? DEFAULT_QR_TTL_MS)
    this.socketConfig = options.socketConfig ?? {}
  }

  async connect(input: BaileysTransportConnectInput): Promise<SessionState> {
    const instanceId = normalizeInstanceId(input.instanceId)
    if (
      this.activeTransports.has(instanceId) ||
      this.openingTransports.has(instanceId) ||
      this.terminalTransports.has(instanceId)
    ) {
      throw new WaTransportAlreadyConnectedError(instanceId)
    }
    this.openingTransports.add(instanceId)

    try {
      if (this.pendingAuthClears.has(instanceId)) {
        await this.authStateStore.clear(instanceId)
        this.pendingAuthClears.delete(instanceId)
      }
      const persistedState = await readBaileysAuthState(instanceId, this.authStateStore)
      const hasAuthState = await this.authStateStore.has(instanceId)
      const auth = createStoreBackedAuthState(instanceId, persistedState, this.authStateStore)
      const socket = makeWASocket({
        ...this.socketConfig,
        auth,
        printQRInTerminal: false,
      })
      let resolveTransportClosed!: () => void
      const transportClosed = new Promise<void>((resolve) => {
        resolveTransportClosed = resolve
      })

      const active: ActiveBaileysTransport = {
        socket,
        callbacks: input.callbacks,
        auth,
        phase: 'active',
        eventTail: Promise.resolve(),
        transportClosed,
        resolveTransportClosed,
      }
      socket.ev.on('creds.update', (update) => {
        this.enqueueCurrentTransportEvent(instanceId, active, () => auth.mergeCreds(update))
      })
      socket.ev.on('connection.update', (update) => {
        this.enqueueConnectionUpdate(instanceId, active, update)
      })
      this.activeTransports.set(instanceId, active)

      return {
        instanceId,
        status: 'connecting',
        hasAuthState,
        logoutCount: 0,
      }
    } finally {
      this.openingTransports.delete(instanceId)
    }
  }

  async closeTransport(instanceId: string): Promise<WaTransportSession> {
    const normalizedInstanceId = normalizeInstanceId(instanceId)
    const active = this.reserveTerminalTransport(normalizedInstanceId, 'closing')

    await active.eventTail
    active.auth.deactivate()
    let persistenceError: unknown
    let hasPersistenceError = false
    try {
      await active.auth.drain()
    } catch (error: unknown) {
      persistenceError = error
      hasPersistenceError = true
    }

    let closeError: unknown
    let hasCloseError = false
    try {
      await active.socket.end(undefined)
      await active.transportClosed
    } catch (error: unknown) {
      closeError = error
      hasCloseError = true
    }

    if (hasCloseError) {
      active.phase = 'terminal_failed'
    } else {
      this.removeActiveTransport(normalizedInstanceId, active.socket)
    }
    this.terminalTransports.delete(normalizedInstanceId)

    if (hasPersistenceError) {
      await this.reportError(normalizedInstanceId, active.callbacks, persistenceError)
    }
    if (hasCloseError) {
      await this.reportError(normalizedInstanceId, active.callbacks, closeError)
      throw closeError
    }
    if (hasPersistenceError) throw persistenceError

    return {
      instanceId: normalizedInstanceId,
      status: 'disconnected',
      hasAuthState: await this.authStateStore.has(normalizedInstanceId),
      logoutCount: 0,
      lastDisconnectReason: 'connection_closed',
    }
  }

  async logout(instanceId: string): Promise<WaTransportSession> {
    const normalizedInstanceId = normalizeInstanceId(instanceId)
    const active = this.reserveTerminalTransport(normalizedInstanceId, 'logging_out')

    await active.eventTail
    active.auth.deactivate()
    let persistenceError: unknown
    let hasPersistenceError = false
    try {
      await active.auth.drain()
    } catch (error: unknown) {
      persistenceError = error
      hasPersistenceError = true
    }

    let logoutError: unknown
    let hasLogoutError = false
    try {
      await active.socket.logout()
    } catch (error: unknown) {
      logoutError = error
      hasLogoutError = true
    }

    let closeError: unknown
    let hasCloseError = false
    try {
      if (hasLogoutError) {
        await active.socket.end(logoutError instanceof Error ? logoutError : undefined)
      }
      await active.transportClosed
    } catch (error: unknown) {
      closeError = error
      hasCloseError = true
    }

    let clearError: unknown
    let hasClearError = false
    try {
      await this.authStateStore.clear(normalizedInstanceId)
      this.pendingAuthClears.delete(normalizedInstanceId)
    } catch (error: unknown) {
      clearError = error
      hasClearError = true
      this.pendingAuthClears.add(normalizedInstanceId)
    }

    if (hasCloseError) {
      active.phase = 'terminal_failed'
    } else {
      this.removeActiveTransport(normalizedInstanceId, active.socket)
    }
    this.terminalTransports.delete(normalizedInstanceId)

    if (hasPersistenceError) {
      await this.reportError(normalizedInstanceId, active.callbacks, persistenceError)
    }
    if (hasClearError) {
      await this.reportError(normalizedInstanceId, active.callbacks, clearError)
    }
    if (hasLogoutError) {
      await this.reportError(normalizedInstanceId, active.callbacks, logoutError)
    }
    if (hasCloseError) {
      await this.reportError(normalizedInstanceId, active.callbacks, closeError)
      throw closeError
    }
    if (hasLogoutError) throw logoutError
    if (hasClearError) throw clearError

    return {
      instanceId: normalizedInstanceId,
      status: 'logged_out',
      hasAuthState: false,
      logoutCount: 1,
      lastDisconnectReason: 'logged_out',
    }
  }

  private enqueueCurrentTransportEvent(
    instanceId: string,
    active: ActiveBaileysTransport,
    handler: () => Promise<void>,
  ): void {
    if (!this.isCurrentTransport(instanceId, active) || active.phase !== 'active') return

    this.enqueueTransportEvent(instanceId, active, handler)
  }

  private enqueueConnectionUpdate(
    instanceId: string,
    active: ActiveBaileysTransport,
    update: BaileysEventMap['connection.update'],
  ): void {
    if (!this.isCurrentTransport(instanceId, active)) return

    if (update.connection === 'close') {
      active.resolveTransportClosed()
    }
    if (active.phase !== 'active') return

    if (update.connection === 'close') {
      active.phase = 'remote_closing'
      this.terminalTransports.add(instanceId)
    }

    this.enqueueTransportEvent(instanceId, active, () =>
      this.handleConnectionUpdate(instanceId, active, update),
    )
  }

  private enqueueTransportEvent(
    instanceId: string,
    active: ActiveBaileysTransport,
    handler: () => Promise<void>,
  ): void {
    active.eventTail = active.eventTail
      .then(handler)
      .catch((error: unknown) => this.reportError(instanceId, active.callbacks, error))
  }

  private async reportError(
    instanceId: string,
    callbacks: BaileysTransportConnectInput['callbacks'],
    error: unknown,
  ): Promise<void> {
    try {
      if (callbacks?.onError) {
        await callbacks.onError({ instanceId, error })
        return
      }

      console.error(`[wa:${instanceId}] unhandled transport error`, error)
    } catch {
      // Error reporting must not create an unhandled rejection.
    }
  }

  private requireActiveTransport(instanceId: string): ActiveBaileysTransport {
    const active = this.activeTransports.get(instanceId)
    if (!active) throw new WaTransportNotConnectedError(instanceId)

    return active
  }

  private reserveTerminalTransport(
    instanceId: string,
    phase: 'closing' | 'logging_out',
  ): ActiveBaileysTransport {
    if (this.openingTransports.has(instanceId) || this.terminalTransports.has(instanceId)) {
      throw new WaTransportOperationInProgressError(instanceId)
    }

    const active = this.requireActiveTransport(instanceId)
    if (active.phase !== 'active' && active.phase !== 'terminal_failed') {
      throw new WaTransportOperationInProgressError(instanceId)
    }

    active.phase = phase
    this.terminalTransports.add(instanceId)
    return active
  }

  private isCurrentTransport(instanceId: string, active: ActiveBaileysTransport): boolean {
    return this.activeTransports.get(instanceId) === active
  }

  private removeActiveTransport(instanceId: string, socket: WASocket): void {
    if (this.activeTransports.get(instanceId)?.socket === socket) {
      this.activeTransports.delete(instanceId)
    }
  }

  private async handleConnectionUpdate(
    instanceId: string,
    active: ActiveBaileysTransport,
    update: BaileysEventMap['connection.update'],
  ): Promise<void> {
    if (update.qr) {
      await active.callbacks?.onQr?.({
        instanceId,
        qrCode: update.qr,
        expiresAt: new Date(this.now().getTime() + this.qrTtlMs),
      })
    }

    if (update.connection === 'open') {
      await active.callbacks?.onConnected?.({
        instanceId,
        state: {
          instanceId,
          status: 'connected',
          hasAuthState: true,
          logoutCount: 0,
        },
      })
      return
    }

    if (update.connection !== 'close') return

    const reason = disconnectReasonFromStatusCode(
      getDisconnectStatusCode(update.lastDisconnect?.error),
    )
    let clearError: unknown
    let hasClearError = false
    let persistenceError: unknown
    let hasPersistenceError = false
    try {
      active.auth.deactivate()
      try {
        await active.auth.drain()
      } catch (error: unknown) {
        persistenceError = error
        hasPersistenceError = true
      }
      if (reason === 'logged_out') {
        try {
          await this.authStateStore.clear(instanceId)
          this.pendingAuthClears.delete(instanceId)
        } catch (error: unknown) {
          clearError = error
          hasClearError = true
          this.pendingAuthClears.add(instanceId)
        }
      }
    } finally {
      this.removeActiveTransport(instanceId, active.socket)
      this.terminalTransports.delete(instanceId)
    }

    if (reason === 'logged_out') {
      try {
        await active.callbacks?.onLoggedOut?.({ instanceId })
      } finally {
        if (hasPersistenceError) {
          await this.reportError(instanceId, active.callbacks, persistenceError)
        }
        if (hasClearError) {
          await this.reportError(instanceId, active.callbacks, clearError)
        }
      }
      return
    }

    try {
      await active.callbacks?.onDisconnected?.({ instanceId, reason })
    } finally {
      if (hasPersistenceError) {
        await this.reportError(instanceId, active.callbacks, persistenceError)
      }
    }
  }
}

function createStoreBackedAuthState(
  instanceId: string,
  state: BaileysAuthState,
  store: WaAuthStateStore,
): StoreBackedAuthenticationState {
  const liveCreds = decodeJsonObject(state.creds) as unknown as AuthenticationState['creds']
  let acceptsWrites = true
  let persistenceTail = Promise.resolve()
  let persistenceError: unknown
  let hasPersistenceError = false
  const persist = async (): Promise<void> => {
    if (!acceptsWrites) return

    const operation = persistenceTail.then(async () => {
      try {
        await writeBaileysAuthState(instanceId, state, store)
        persistenceError = undefined
        hasPersistenceError = false
      } catch (error: unknown) {
        persistenceError = error
        hasPersistenceError = true
        throw error
      }
    })
    persistenceTail = operation.catch(() => undefined)
    await operation
  }

  return {
    creds: liveCreds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
        const bucket = state.keys[type] ?? {}
        const found: Record<string, SignalDataTypeMap[T]> = {}
        for (const id of ids) {
          if (Object.prototype.hasOwnProperty.call(bucket, id)) {
            const value = bucket[id]
            if (value !== undefined) {
              found[id] = decodeJsonValue(value) as unknown as SignalDataTypeMap[T]
            }
          }
        }

        return found
      },
      set: async (data: SignalDataSet): Promise<void> => {
        for (const [type, values] of Object.entries(data)) {
          if (!values) continue

          const bucket = (state.keys[type] ??= {})
          for (const [id, value] of Object.entries(values)) {
            if (value === null) {
              delete bucket[id]
              continue
            }

            bucket[id] = encodeJsonValue(value)
          }
        }

        await persist()
      },
    },
    mergeCreds: async (update: Partial<AuthenticationState['creds']>): Promise<void> => {
      Object.assign(liveCreds, update)
      state.creds = {
        ...state.creds,
        ...encodeJsonObject(update),
      }
      await persist()
    },
    deactivate: () => {
      acceptsWrites = false
    },
    drain: async () => {
      await persistenceTail
      if (hasPersistenceError) throw persistenceError
    },
  }
}

function normalizeInstanceId(instanceId: string): string {
  const normalized = instanceId.trim()
  if (normalized.length === 0) {
    throw new TypeError('instanceId must be a non-empty string')
  }

  return normalized
}

function normalizeQrTtlMs(qrTtlMs: number): number {
  if (!Number.isSafeInteger(qrTtlMs) || qrTtlMs <= 0) {
    throw new RangeError('qrTtlMs must be a positive safe integer')
  }

  return qrTtlMs
}

function disconnectReasonFromStatusCode(statusCode: number | undefined): WaDisconnectReason {
  if (statusCode === DisconnectReason.loggedOut) return 'logged_out'
  if (statusCode === DisconnectReason.restartRequired) return 'restart_required'
  if (statusCode === DisconnectReason.connectionClosed) return 'connection_closed'

  return 'transient'
}

function getDisconnectStatusCode(error: unknown): number | undefined {
  if (!isObject(error)) return undefined

  const output = error.output
  if (isObject(output) && typeof output.statusCode === 'number') {
    return output.statusCode
  }

  if (typeof error.statusCode === 'number') {
    return error.statusCode
  }

  return undefined
}

function encodeJsonObject(value: unknown): Record<string, WaAuthStateJsonValue> {
  const encoded = encodeJsonValue(value)
  if (!isObject(encoded) || Array.isArray(encoded)) return {}

  return encoded as Record<string, WaAuthStateJsonValue>
}

function encodeJsonValue(value: unknown): WaAuthStateJsonValue {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (value instanceof Uint8Array) {
    return {
      [BINARY_JSON_MARKER]: 'uint8array',
      data: Array.from(value),
    }
  }

  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => encodeJsonValue(item))
  }

  if (isObject(value)) {
    const encoded: Record<string, WaAuthStateJsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) encoded[key] = encodeJsonValue(item)
    }

    return encoded
  }

  throw new TypeError('Baileys auth-state value must be JSON-serializable')
}

function decodeJsonObject(value: Record<string, WaAuthStateJsonValue>): Record<string, unknown> {
  const decoded = decodeJsonValue(value)
  if (!isObject(decoded) || Array.isArray(decoded) || decoded instanceof Uint8Array) return {}

  return decoded
}

function decodeJsonValue(value: WaAuthStateJsonValue): unknown {
  if (Array.isArray(value)) return value.map((item) => decodeJsonValue(item))

  if (isObject(value)) {
    if (value[BINARY_JSON_MARKER] === 'uint8array' && Array.isArray(value.data)) {
      return new Uint8Array(value.data as number[])
    }

    const decoded: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      decoded[key] = decodeJsonValue(item)
    }

    return decoded
  }

  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
