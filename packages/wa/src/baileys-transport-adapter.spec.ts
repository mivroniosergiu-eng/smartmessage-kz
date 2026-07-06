import { describe, expect, it, vi } from 'vitest'

import { BaileysTransportAdapter, type BaileysTransportConnector } from './baileys-transport-adapter'
import { WaTransportUnavailableError, type WaTransportCallbacks } from './transport'

describe('BaileysTransportAdapter', () => {
  it('throws an explicit unavailable error without a connector', async () => {
    const adapter = new BaileysTransportAdapter()

    await expect(adapter.connect('instance-1')).rejects.toMatchObject({
      name: 'WaTransportUnavailableError',
      code: 'transport_unavailable',
      message: expect.stringContaining('connector is not configured'),
    })
    await expect(adapter.connect('instance-1')).rejects.toBeInstanceOf(WaTransportUnavailableError)
  })

  it('delegates connect to the injected connector and returns a session-like state', async () => {
    const callbacks: WaTransportCallbacks = {
      onQr: vi.fn(),
    }
    const state = {
      instanceId: 'instance-2',
      status: 'connected' as const,
      hasAuthState: true,
      logoutCount: 0,
    }
    const connector: BaileysTransportConnector = {
      connect: vi.fn(async () => state),
    }
    const adapter = new BaileysTransportAdapter(connector)

    await expect(adapter.connect(' instance-2 ', callbacks)).resolves.toEqual(state)
    expect(connector.connect).toHaveBeenCalledOnce()
    expect(connector.connect).toHaveBeenCalledWith({ instanceId: 'instance-2', callbacks })
  })
})
