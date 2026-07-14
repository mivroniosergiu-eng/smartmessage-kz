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
}

export class BaileysSocketTransportConnector implements BaileysTransportConnector {
  private readonly activeTransports = new Map<string, ActiveBaileysTransport>()
  private readonly openingTransports = new Set<string>()
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
    if (this.activeTransports.has(instanceId) || this.openingTransports.has(instanceId)) {
      throw new WaTransportAlreadyConnectedError(instanceId)
    }
    this.openingTransports.add(instanceId)

    try {
      const persistedState = await readBaileysAuthState(instanceId, this.authStateStore)
      const hasAuthState = await this.authStateStore.has(instanceId)
      const auth = createStoreBackedAuthState(instanceId, persistedState, this.authStateStore)
      const socket = makeWASocket({
        ...this.socketConfig,
        auth,
        printQRInTerminal: false,
      })

      socket.ev.on('creds.update', (update) => {
        this.handleAsyncEvent(instanceId, input.callbacks, () => auth.mergeCreds(update))
      })
      socket.ev.on('connection.update', (update) => {
        this.handleAsyncEvent(instanceId, input.callbacks, () =>
          this.handleConnectionUpdate(instanceId, socket, update, input.callbacks),
        )
      })
      this.activeTransports.set(instanceId, { socket, callbacks: input.callbacks })

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
    const active = this.requireActiveTransport(normalizedInstanceId)

    try {
      await active.socket.end(undefined)
    } catch (error: unknown) {
      await this.reportError(normalizedInstanceId, active.callbacks, error)
      throw error
    } finally {
      this.removeActiveTransport(normalizedInstanceId, active.socket)
    }

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
    const active = this.requireActiveTransport(normalizedInstanceId)

    try {
      await active.socket.logout()
      await this.authStateStore.clear(normalizedInstanceId)
    } catch (error: unknown) {
      await this.reportError(normalizedInstanceId, active.callbacks, error)
      throw error
    } finally {
      this.removeActiveTransport(normalizedInstanceId, active.socket)
    }

    return {
      instanceId: normalizedInstanceId,
      status: 'logged_out',
      hasAuthState: false,
      logoutCount: 1,
      lastDisconnectReason: 'logged_out',
    }
  }

  private handleAsyncEvent(
    instanceId: string,
    callbacks: BaileysTransportConnectInput['callbacks'],
    handler: () => Promise<void>,
  ): void {
    void (async () => {
      try {
        await handler()
      } catch (error: unknown) {
        await this.reportError(instanceId, callbacks, error)
      }
    })()
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

  private removeActiveTransport(instanceId: string, socket: WASocket): void {
    if (this.activeTransports.get(instanceId)?.socket === socket) {
      this.activeTransports.delete(instanceId)
    }
  }

  private async handleConnectionUpdate(
    instanceId: string,
    socket: WASocket,
    update: BaileysEventMap['connection.update'],
    callbacks: BaileysTransportConnectInput['callbacks'],
  ): Promise<void> {
    if (update.qr) {
      await callbacks?.onQr?.({
        instanceId,
        qrCode: update.qr,
        expiresAt: new Date(this.now().getTime() + this.qrTtlMs),
      })
    }

    if (update.connection === 'open') {
      await callbacks?.onConnected?.({
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

    this.removeActiveTransport(instanceId, socket)

    const reason = disconnectReasonFromStatusCode(
      getDisconnectStatusCode(update.lastDisconnect?.error),
    )
    if (reason === 'logged_out') {
      await callbacks?.onLoggedOut?.({ instanceId })
      return
    }

    await callbacks?.onDisconnected?.({ instanceId, reason })
  }
}

function createStoreBackedAuthState(
  instanceId: string,
  state: BaileysAuthState,
  store: WaAuthStateStore,
): AuthenticationState & {
  mergeCreds(update: Partial<AuthenticationState['creds']>): Promise<void>
} {
  const liveCreds = decodeJsonObject(state.creds) as unknown as AuthenticationState['creds']
  const persist = async (): Promise<void> => {
    await writeBaileysAuthState(instanceId, state, store)
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
