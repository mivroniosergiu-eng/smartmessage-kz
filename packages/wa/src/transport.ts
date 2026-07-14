import type { SessionState, WaDisconnectReason } from './session'

export type WaTransportSession = SessionState

export type WaTransportErrorCode =
  | 'transport_unavailable'
  | 'already_connected'
  | 'not_connected'
  | 'connect_failed'
  | 'disconnected'
  | 'logged_out'
  | 'restricted'
  | 'banned'

export interface WaTransportError {
  code: WaTransportErrorCode
  message: string
  cause?: unknown
}

export type WaTransportResult<T> =
  | {
      ok: true
      value: T
    }
  | {
      ok: false
      error: WaTransportError
    }

export interface WaTransportQrEvent {
  instanceId: string
  qrCode: string
  expiresAt: Date
}

export interface WaTransportConnectedEvent {
  instanceId: string
  state?: WaTransportSession
}

export interface WaTransportDisconnectedEvent {
  instanceId: string
  reason: WaDisconnectReason
}

export interface WaTransportLoggedOutEvent {
  instanceId: string
}

export interface WaTransportErrorEvent {
  instanceId: string
  error: unknown
}

export interface WaTransportCallbacks {
  onQr?: (event: WaTransportQrEvent) => Promise<void> | void
  onConnected?: (event: WaTransportConnectedEvent) => Promise<void> | void
  onDisconnected?: (event: WaTransportDisconnectedEvent) => Promise<void> | void
  onLoggedOut?: (event: WaTransportLoggedOutEvent) => Promise<void> | void
  onError?: (event: WaTransportErrorEvent) => Promise<void> | void
}

export interface WaTransportFactory {
  connect(instanceId: string, callbacks?: WaTransportCallbacks): Promise<WaTransportSession>
  closeTransport(instanceId: string): Promise<WaTransportSession>
  logout(instanceId: string): Promise<WaTransportSession>
}

export class WaTransportUnavailableError extends Error {
  readonly code = 'transport_unavailable' satisfies WaTransportErrorCode

  constructor(message = 'WA transport connector is not configured') {
    super(message)
    this.name = 'WaTransportUnavailableError'
  }
}

export class WaTransportAlreadyConnectedError extends Error {
  readonly code = 'already_connected' satisfies WaTransportErrorCode

  constructor(readonly instanceId: string) {
    super(`WA transport already has an active socket for instance ${instanceId}`)
    this.name = 'WaTransportAlreadyConnectedError'
  }
}

export class WaTransportNotConnectedError extends Error {
  readonly code = 'not_connected' satisfies WaTransportErrorCode

  constructor(readonly instanceId: string) {
    super(`WA transport has no active socket for instance ${instanceId}`)
    this.name = 'WaTransportNotConnectedError'
  }
}
