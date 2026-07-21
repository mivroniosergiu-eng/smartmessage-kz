import type {
  AuthenticationState,
  BaileysEventMap,
  SignalDataSet,
  SignalDataTypeMap,
  UserFacingSocketConfig,
  WASocket,
} from '@whiskeysockets/baileys'
import { normalizePhone } from '@smartmessage/shared'
import { createHash } from 'node:crypto'

import type { WaAuthStateJsonValue, WaAuthStateStore } from './auth-state'
import {
  readBaileysAuthState,
  writeBaileysAuthState,
  type BaileysAuthState,
} from './baileys-auth-state-mapper'
import type {
  BaileysTransportConnectInput,
  BaileysTransportConnector,
} from './baileys-transport-adapter'
import { mapBaileysMessageUpdates, mapBaileysMessagesUpsert } from './receiver'
import type { PhoneValidator, ValidatePhonePayload, ValidatePhoneResult } from './phone-validator'
import type { MessageSender, SendMessagePayload, SendMessageResult } from './sender'
import { createWaRestrictedUntil, type SessionState, type WaDisconnectReason } from './session'
import {
  WaTransportAlreadyConnectedError,
  WaTransportCloseTimeoutError,
  WaTransportNotConnectedError,
  WaTransportOperationDrainTimeoutError,
  WaTransportOperationInProgressError,
  type WaTransportCallbacks,
  type WaTransportSession,
} from './transport'

const DEFAULT_QR_TTL_MS = 60_000
const DEFAULT_TRANSPORT_CLOSE_TIMEOUT_MS = 10_000
const BINARY_JSON_MARKER = '__smartmessageWaBinary'
const HTTP_TOO_MANY_REQUESTS = 429

type BaileysModule = typeof import('@whiskeysockets/baileys')
type BaileysDisconnectReasons = BaileysModule['DisconnectReason']

let baileysModulePromise: Promise<BaileysModule> | undefined

function loadBaileysModule(): Promise<BaileysModule> {
  baileysModulePromise ??= import('@whiskeysockets/baileys')
  return baileysModulePromise
}

export interface BaileysSocketTransportConnectorOptions {
  now?: () => Date
  qrTtlMs?: number
  transportCloseTimeoutMs?: number
  socketConfig?: Omit<Partial<UserFacingSocketConfig>, 'auth' | 'printQRInTerminal'>
}

interface ActiveBaileysTransport {
  socket: WASocket
  disconnectReasons: BaileysDisconnectReasons
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

export class BaileysSocketTransportConnector
  implements BaileysTransportConnector, PhoneValidator, MessageSender
{
  private readonly activeTransports = new Map<string, ActiveBaileysTransport>()
  private readonly openingTransports = new Set<string>()
  private readonly terminalTransports = new Set<string>()
  private readonly pendingAuthClears = new Set<string>()
  private readonly now: () => Date
  private readonly qrTtlMs: number
  private readonly transportCloseTimeoutMs: number
  private readonly socketConfig: Omit<Partial<UserFacingSocketConfig>, 'auth' | 'printQRInTerminal'>

  constructor(
    private readonly authStateStore: WaAuthStateStore,
    options: BaileysSocketTransportConnectorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.qrTtlMs = normalizeQrTtlMs(options.qrTtlMs ?? DEFAULT_QR_TTL_MS)
    this.transportCloseTimeoutMs = normalizeTransportCloseTimeoutMs(
      options.transportCloseTimeoutMs ?? DEFAULT_TRANSPORT_CLOSE_TIMEOUT_MS,
    )
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
      const baileys = await loadBaileysModule()
      if (Object.keys(persistedState.creds).length === 0) {
        persistedState.creds = encodeJsonObject(baileys.initAuthCreds())
      }
      const auth = createStoreBackedAuthState(instanceId, persistedState, this.authStateStore)
      const makeWASocket = baileys.default
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
        disconnectReasons: baileys.DisconnectReason,
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
      socket.ev.on('messages.upsert', (update) => {
        this.enqueueCurrentTransportEvent(instanceId, active, async () => {
          const event = mapBaileysMessagesUpsert(instanceId, update)
          if (event) await active.callbacks?.onMessageUpsert?.(event)
        })
      })
      socket.ev.on('messages.update', (updates) => {
        this.enqueueCurrentTransportEvent(instanceId, active, async () => {
          const event = mapBaileysMessageUpdates(instanceId, updates)
          if (event) await active.callbacks?.onMessageUpdate?.(event)
        })
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

  async validate(payload: ValidatePhonePayload): Promise<ValidatePhoneResult> {
    const instanceId = normalizeInstanceId(payload.instanceId)
    const active = this.activeTransports.get(instanceId)
    if (!active || active.phase !== 'active') {
      throw new WaTransportNotConnectedError(instanceId)
    }

    const phone = normalizePhone(payload.phone)
    const jid = `${phone.slice(1)}@s.whatsapp.net`
    return this.runCurrentTransportOperation(instanceId, active, async () => {
      const matches = await active.socket.onWhatsApp(jid)
      const confirmed = matches?.some((match) => match.exists === true) ?? false

      return {
        instanceId,
        phone,
        status: confirmed ? 'confirmed' : 'not_on_whatsapp',
      }
    })
  }

  async send(payload: SendMessagePayload): Promise<SendMessageResult> {
    const instanceId = normalizeInstanceId(payload.instanceId)
    const active = this.activeTransports.get(instanceId)
    if (!active || active.phase !== 'active') {
      throw new WaTransportNotConnectedError(instanceId)
    }
    if (payload.kind !== 'text') throw new TypeError('Unsupported WA message kind')
    const text = payload.text.trim()
    const idempotencyKey = payload.idempotencyKey.trim()
    if (!text || !idempotencyKey) throw new TypeError('WA text and idempotencyKey are required')

    const phone = normalizePhone(payload.recipientPhone)
    const jid = `${phone.slice(1)}@s.whatsapp.net`
    const deterministicMessageId = createHash('sha256')
      .update(`${instanceId}\u0000${phone}\u0000${idempotencyKey}`)
      .digest('hex')
      .slice(0, 32)
      .toUpperCase()
    return this.runCurrentTransportOperation(instanceId, active, async () => {
      const sent = await active.socket.sendMessage(
        jid,
        { text },
        { messageId: deterministicMessageId },
      )

      return {
        messageId: sent?.key.id ?? deterministicMessageId,
        status: 'accepted',
      }
    })
  }

  async closeTransport(instanceId: string): Promise<WaTransportSession> {
    const normalizedInstanceId = normalizeInstanceId(instanceId)
    const active = this.reserveTerminalTransport(normalizedInstanceId, 'closing')

    await this.drainTransportOperations(normalizedInstanceId, active)
    active.auth.deactivate()
    let persistenceError: unknown
    let hasPersistenceError = false
    try {
      await this.completeTransportOperation(normalizedInstanceId, active.auth.drain())
    } catch (error: unknown) {
      persistenceError = error
      hasPersistenceError = true
    }

    let closeError: unknown
    let hasCloseError = false
    try {
      await this.waitForTransportClose(normalizedInstanceId, active, () =>
        active.socket.end(undefined),
      )
    } catch (error: unknown) {
      closeError = error
      hasCloseError = true
    }

    const persistenceTimedOut = isOperationDrainTimeout(persistenceError)
    if (hasCloseError || persistenceTimedOut) {
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

    await this.drainTransportOperations(normalizedInstanceId, active)
    active.auth.deactivate()
    let persistenceError: unknown
    let hasPersistenceError = false
    try {
      await this.completeTransportOperation(normalizedInstanceId, active.auth.drain())
    } catch (error: unknown) {
      persistenceError = error
      hasPersistenceError = true
    }

    let logoutError: unknown
    let hasLogoutError = false
    try {
      await this.completeTransportOperation(normalizedInstanceId, active.socket.logout())
    } catch (error: unknown) {
      logoutError = error
      hasLogoutError = true
    }

    let closeError: unknown
    let hasCloseError = false
    try {
      await this.waitForTransportClose(
        normalizedInstanceId,
        active,
        hasLogoutError
          ? () => active.socket.end(logoutError instanceof Error ? logoutError : undefined)
          : undefined,
      )
    } catch (error: unknown) {
      closeError = error
      hasCloseError = true
    }

    const persistenceTimedOut = isOperationDrainTimeout(persistenceError)
    let clearError: unknown
    let hasClearError = false
    if (persistenceTimedOut) {
      this.pendingAuthClears.add(normalizedInstanceId)
    } else {
      try {
        await this.authStateStore.clear(normalizedInstanceId)
        this.pendingAuthClears.delete(normalizedInstanceId)
      } catch (error: unknown) {
        clearError = error
        hasClearError = true
        this.pendingAuthClears.add(normalizedInstanceId)
      }
    }

    if (hasCloseError || persistenceTimedOut) {
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
    if (persistenceTimedOut) throw persistenceError
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
      const pendingOperations = active.eventTail
      const terminalUpdate = this.completeTransportOperation(instanceId, pendingOperations)
        .catch((error: unknown) => {
          void this.reportError(instanceId, active.callbacks, error)
        })
        .then(() => this.handleConnectionUpdate(instanceId, active, update))
      active.eventTail = terminalUpdate.catch((error: unknown) =>
        this.reportError(instanceId, active.callbacks, error),
      )
      return
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

  private runCurrentTransportOperation<T>(
    instanceId: string,
    active: ActiveBaileysTransport,
    handler: () => Promise<T>,
  ): Promise<T> {
    if (!this.isCurrentTransport(instanceId, active) || active.phase !== 'active') {
      throw new WaTransportNotConnectedError(instanceId)
    }

    const operation = active.eventTail.then(handler)
    active.eventTail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
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

  private async drainTransportOperations(
    instanceId: string,
    active: ActiveBaileysTransport,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      await Promise.race([
        active.eventTail,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true
            resolve()
          }, this.transportCloseTimeoutMs)
          timeout.unref?.()
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }

    if (timedOut) {
      void this.reportError(
        instanceId,
        active.callbacks,
        new WaTransportOperationDrainTimeoutError(instanceId, this.transportCloseTimeoutMs),
      )
    }
  }

  private async waitForTransportClose(
    instanceId: string,
    active: ActiveBaileysTransport,
    close?: () => Promise<void>,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const closeOperation = (async () => {
      await close?.()
      await active.transportClosed
    })()
    const timeoutOperation = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new WaTransportCloseTimeoutError(instanceId, this.transportCloseTimeoutMs))
      }, this.transportCloseTimeoutMs)
    })

    try {
      await Promise.race([closeOperation, timeoutOperation])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private async completeTransportOperation<T>(
    instanceId: string,
    operation: Promise<T>,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new WaTransportOperationDrainTimeoutError(instanceId, this.transportCloseTimeoutMs))
      }, this.transportCloseTimeoutMs)
      timeout.unref?.()
    })

    try {
      return await Promise.race([operation, deadline])
    } finally {
      if (timeout) clearTimeout(timeout)
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

    const disconnectError = update.lastDisconnect?.error
    const reason = disconnectReasonFromStatusCode(
      getDisconnectStatusCode(disconnectError),
      active.disconnectReasons,
    )
    const restrictedUntil =
      reason === 'restricted'
        ? createWaRestrictedUntil(this.now(), getRetryAfterMs(disconnectError, this.now()))
        : undefined
    let clearError: unknown
    let hasClearError = false
    let persistenceError: unknown
    let hasPersistenceError = false
    try {
      active.auth.deactivate()
      try {
        await this.completeTransportOperation(instanceId, active.auth.drain())
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
      if (isOperationDrainTimeout(persistenceError)) {
        active.phase = 'terminal_failed'
      } else {
        this.removeActiveTransport(instanceId, active.socket)
      }
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
      await active.callbacks?.onDisconnected?.({
        instanceId,
        reason,
        ...(restrictedUntil ? { restrictedUntil } : {}),
      })
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

function isOperationDrainTimeout(error: unknown): error is WaTransportOperationDrainTimeoutError {
  return error instanceof WaTransportOperationDrainTimeoutError
}

function normalizeQrTtlMs(qrTtlMs: number): number {
  if (!Number.isSafeInteger(qrTtlMs) || qrTtlMs <= 0) {
    throw new RangeError('qrTtlMs must be a positive safe integer')
  }

  return qrTtlMs
}

function normalizeTransportCloseTimeoutMs(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('transportCloseTimeoutMs must be a positive safe integer')
  }

  return timeoutMs
}

function disconnectReasonFromStatusCode(
  statusCode: number | undefined,
  disconnectReasons: BaileysDisconnectReasons,
): WaDisconnectReason {
  if (statusCode === disconnectReasons.loggedOut) return 'logged_out'
  if (statusCode === disconnectReasons.forbidden) return 'banned'
  if (statusCode === HTTP_TOO_MANY_REQUESTS) return 'restricted'
  if (statusCode === disconnectReasons.restartRequired) return 'restart_required'
  if (statusCode === disconnectReasons.connectionClosed) return 'connection_closed'

  return 'transient'
}

function getRetryAfterMs(error: unknown, now: Date): number | undefined {
  if (!isObject(error)) return undefined

  const output = isObject(error.output) ? error.output : undefined
  const headers =
    (output && isObject(output.headers) ? output.headers : undefined) ??
    (isObject(error.headers) ? error.headers : undefined)
  if (!headers) return undefined

  const header = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1]
  if (typeof header !== 'string' && typeof header !== 'number') return undefined

  const value = String(header).trim()
  if (value.length === 0) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000

  const retryAt = Date.parse(value)
  const retryAfterMs = retryAt - now.getTime()
  return Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : undefined
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

  if (Buffer.isBuffer(value)) {
    return {
      [BINARY_JSON_MARKER]: 'buffer',
      data: Array.from(value),
    }
  }

  if (value instanceof Uint8Array) {
    return {
      [BINARY_JSON_MARKER]: 'uint8array',
      data: Array.from(value),
    }
  }

  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined).map((item) => encodeJsonValue(item))
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
    if (value[BINARY_JSON_MARKER] === 'buffer' && Array.isArray(value.data)) {
      return Buffer.from(value.data as number[])
    }

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
