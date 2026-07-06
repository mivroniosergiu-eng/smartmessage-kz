import type { WaQrPendingEvent } from './qr-bootstrap'
import type { WaTransportCallbacks } from './transport'

export interface WaQrLifecycleRecorder {
  recordQrPending(instanceId: string, qrCode: string, expiresAt: Date): Promise<WaQrPendingEvent>
}

export function createWaTransportLifecycleBridge(
  lifecycle: WaQrLifecycleRecorder,
): WaTransportCallbacks {
  return {
    onQr: async (event) => {
      await lifecycle.recordQrPending(event.instanceId, event.qrCode, event.expiresAt)
    },
  }
}
