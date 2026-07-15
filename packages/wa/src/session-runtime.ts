import type { WaAuthStateStore } from './auth-state'
import { BaileysSocketTransportConnector } from './baileys-connector'
import { BaileysSessionManager } from './baileys-session-manager'
import { BaileysTransportAdapter } from './baileys-transport-adapter'
import type { OwnerRegistry } from './owner-registry'
import type { WaQrBootstrapRepository } from './qr-bootstrap'
import { WaSessionLifecycleService, type WaRestrictionRecoveryScheduler } from './session-lifecycle'
import type { WaAccountStatusRepository } from './status-repository'
import type { WaTransportFactory } from './transport'

export interface BaileysSessionRuntimeInput {
  workerId: string
  ownerRegistry: OwnerRegistry
  authStateStore: WaAuthStateStore
  ttlMs: number
  statusRepository?: WaAccountStatusRepository
  qrBootstrapRepository?: WaQrBootstrapRepository
  restrictionRecoveryScheduler?: WaRestrictionRecoveryScheduler
  transport?: WaTransportFactory
}

export interface BaileysSessionRuntime {
  sessionManager: BaileysSessionManager
  lifecycle: WaSessionLifecycleService
}

export function createBaileysSessionRuntime(
  input: BaileysSessionRuntimeInput,
): BaileysSessionRuntime {
  const transport =
    input.transport ??
    new BaileysTransportAdapter(new BaileysSocketTransportConnector(input.authStateStore))
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

  return { sessionManager, lifecycle }
}
