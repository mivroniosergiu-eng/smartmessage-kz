import type {
  WaTransportCallbacks,
  WaTransportFactory,
  WaTransportSession,
} from './transport'
import { WaTransportUnavailableError } from './transport'

export interface BaileysTransportConnectInput {
  instanceId: string
  callbacks?: WaTransportCallbacks
}

export interface BaileysTransportConnector {
  connect(input: BaileysTransportConnectInput): Promise<WaTransportSession>
}

export class BaileysTransportAdapter implements WaTransportFactory {
  constructor(private readonly connector?: BaileysTransportConnector) {}

  async connect(
    instanceId: string,
    callbacks?: WaTransportCallbacks,
  ): Promise<WaTransportSession> {
    const normalizedInstanceId = normalizeNonEmptyString(instanceId, 'instanceId')
    if (!this.connector) {
      throw new WaTransportUnavailableError(
        'Baileys transport connector is not configured; skeleton cannot open a real connection',
      )
    }

    return this.connector.connect({ instanceId: normalizedInstanceId, callbacks })
  }
}

function normalizeNonEmptyString(value: string, fieldName: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`)
  }

  return normalized
}
