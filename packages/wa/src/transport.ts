import type { SessionState, WaDisconnectReason } from './session'

export type WaTransportSession = SessionState

export type WaTransportErrorCode =
  | 'transport_unavailable'
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

export interface WaTransportRestrictedEvent {
  instanceId: string
  restrictedUntil: Date
  reason?: string
}

export interface WaTransportBannedEvent {
  instanceId: string
  reason?: string
}

export interface WaTransportCallbacks {
  onQr?: (event: WaTransportQrEvent) => Promise<void> | void
  onConnected?: (event: WaTransportConnectedEvent) => Promise<void> | void
  onDisconnected?: (event: WaTransportDisconnectedEvent) => Promise<void> | void
  onLoggedOut?: (event: WaTransportLoggedOutEvent) => Promise<void> | void
  onRestricted?: (event: WaTransportRestrictedEvent) => Promise<void> | void
  onBanned?: (event: WaTransportBannedEvent) => Promise<void> | void
}

export interface WaTransportFactory {
  connect(instanceId: string, callbacks?: WaTransportCallbacks): Promise<WaTransportSession>
}

export class WaTransportUnavailableError extends Error {
  readonly code = 'transport_unavailable' satisfies WaTransportErrorCode

  constructor(message = 'WA transport connector is not configured') {
    super(message)
    this.name = 'WaTransportUnavailableError'
  }
}
