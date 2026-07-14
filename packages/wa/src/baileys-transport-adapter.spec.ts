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

  it('rejects close and logout with an explicit unavailable error without a connector', async () => {
    const adapter = new BaileysTransportAdapter()

    await expect(adapter.closeTransport('instance-1')).rejects.toBeInstanceOf(
      WaTransportUnavailableError,
    )
    await expect(adapter.logout('instance-1')).rejects.toBeInstanceOf(WaTransportUnavailableError)
  })

  it('delegates connect, close, and logout to the injected connector', async () => {
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
      closeTransport: vi.fn(async () => ({
        ...state,
        status: 'disconnected',
        lastDisconnectReason: 'connection_closed',
      })),
      logout: vi.fn(async () => ({
        ...state,
        status: 'logged_out',
        hasAuthState: false,
        logoutCount: 1,
        lastDisconnectReason: 'logged_out',
      })),
    }
    const adapter = new BaileysTransportAdapter(connector)

    await expect(adapter.connect(' instance-2 ', callbacks)).resolves.toEqual(state)
    await expect(adapter.closeTransport(' instance-2 ')).resolves.toMatchObject({
      instanceId: 'instance-2',
      status: 'disconnected',
    })
    await expect(adapter.logout(' instance-2 ')).resolves.toMatchObject({
      instanceId: 'instance-2',
      status: 'logged_out',
    })
    expect(connector.connect).toHaveBeenCalledOnce()
    expect(connector.connect).toHaveBeenCalledWith({ instanceId: 'instance-2', callbacks })
    expect(connector.closeTransport).toHaveBeenCalledWith('instance-2')
    expect(connector.logout).toHaveBeenCalledWith('instance-2')
  })
})
