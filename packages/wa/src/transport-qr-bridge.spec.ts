import { describe, expect, it, vi } from 'vitest'

import { WaOwnershipError } from './owned-session-manager'
import type { WaQrPendingEvent } from './qr-bootstrap'
import { createWaTransportLifecycleBridge } from './transport-qr-bridge'

describe('createWaTransportLifecycleBridge', () => {
  it('records QR pending through lifecycle with instanceId, QR, and expiry', async () => {
    const expiresAt = new Date('2999-07-06T10:00:00.000Z')
    const recorded: WaQrPendingEvent = {
      type: 'qr_pending',
      instanceId: 'instance-qr',
      qrCode: 'qr-payload',
      createdAt: new Date('2999-07-06T09:59:00.000Z'),
      expiresAt,
    }
    const lifecycle = {
      recordQrPending: vi.fn(async () => recorded),
    }
    const bridge = createWaTransportLifecycleBridge(lifecycle)

    await expect(
      bridge.onQr?.({ instanceId: 'instance-qr', qrCode: 'qr-payload', expiresAt }),
    ).resolves.toBeUndefined()

    expect(lifecycle.recordQrPending).toHaveBeenCalledOnce()
    expect(lifecycle.recordQrPending).toHaveBeenCalledWith(
      'instance-qr',
      'qr-payload',
      expiresAt,
    )
  })

  it('propagates ownership errors from lifecycle for foreign owners', async () => {
    const error = new WaOwnershipError('instance-foreign', 'worker-a', 'worker-b')
    const lifecycle = {
      recordQrPending: vi.fn(async () => {
        throw error
      }),
    }
    const bridge = createWaTransportLifecycleBridge(lifecycle)

    await expect(
      bridge.onQr?.({
        instanceId: 'instance-foreign',
        qrCode: 'qr-payload',
        expiresAt: new Date('2999-07-06T10:00:00.000Z'),
      }),
    ).rejects.toBe(error)
  })

  it('propagates ownership errors from lifecycle for missing owners', async () => {
    const error = new WaOwnershipError('instance-missing', 'worker-a', null)
    const lifecycle = {
      recordQrPending: vi.fn(async () => {
        throw error
      }),
    }
    const bridge = createWaTransportLifecycleBridge(lifecycle)

    await expect(
      bridge.onQr?.({
        instanceId: 'instance-missing',
        qrCode: 'qr-payload',
        expiresAt: new Date('2999-07-06T10:00:00.000Z'),
      }),
    ).rejects.toBe(error)
  })
})
