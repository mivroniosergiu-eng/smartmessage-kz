import type { WaAuthStateStore } from './auth-state'
import { BaileysSocketTransportConnector } from './baileys-connector'
import { BaileysSessionManager } from './baileys-session-manager'
import { BaileysTransportAdapter } from './baileys-transport-adapter'
import type { OwnerRegistry } from './owner-registry'
import { UnavailablePhoneValidator, type PhoneValidator } from './phone-validator'
import type { WaQrBootstrapRepository } from './qr-bootstrap'
import type { WaReceiver } from './receiver'
import { WaSessionLifecycleService, type WaRestrictionRecoveryScheduler } from './session-lifecycle'
import type { WaAccountStatusRepository } from './status-repository'
import type { WaTransportFactory } from './transport'
import { UnavailableMessageSender, type MessageSender } from './sender'

export interface BaileysSessionRuntimeInput {
  workerId: string
  ownerRegistry: OwnerRegistry
  authStateStore: WaAuthStateStore
  ttlMs: number
  statusRepository?: WaAccountStatusRepository
  qrBootstrapRepository?: WaQrBootstrapRepository
  restrictionRecoveryScheduler?: WaRestrictionRecoveryScheduler
  receiver?: WaReceiver
  transport?: WaTransportFactory
  phoneValidator?: PhoneValidator
  messageSender?: MessageSender
}

export interface BaileysSessionRuntime {
  sessionManager: BaileysSessionManager
  lifecycle: WaSessionLifecycleService
  phoneValidator: PhoneValidator
  messageSender: MessageSender
}

export function createBaileysSessionRuntime(
  input: BaileysSessionRuntimeInput,
): BaileysSessionRuntime {
  const connector = input.transport
    ? undefined
    : new BaileysSocketTransportConnector(input.authStateStore)
  const transport = input.transport ?? new BaileysTransportAdapter(connector)
  const phoneValidator = input.phoneValidator ?? connector ?? new UnavailablePhoneValidator()
  const messageSender = input.messageSender ?? connector ?? new UnavailableMessageSender()
  const sessionManager: BaileysSessionManager = new BaileysSessionManager(
    transport,
    input.authStateStore,
    {
      onQr: async (event) => {
        await lifecycle.recordQrPending(event.instanceId, event.qrCode, event.expiresAt)
      },
      onConnected: (event): void => lifecycle.notifyState(event.instanceId),
      onDisconnected: (event): void => lifecycle.notifyState(event.instanceId),
      onLoggedOut: (event): void => lifecycle.notifyState(event.instanceId),
      onMessageUpsert: async (event) => input.receiver?.onMessageUpsert(event),
      onMessageUpdate: async (event) => input.receiver?.onMessageUpdate(event),
    },
  )
  const lifecycle: WaSessionLifecycleService = new WaSessionLifecycleService(
    input.workerId,
    input.ownerRegistry,
    sessionManager,
    input.ttlMs,
    input.statusRepository,
    input.qrBootstrapRepository,
    input.restrictionRecoveryScheduler,
  )

  return { sessionManager, lifecycle, phoneValidator, messageSender }
}
