import { beforeEach, describe, expect, it, vi } from 'vitest'

import { InMemoryWaAuthStateStore } from './auth-state'
import { BaileysAuthStateMapperError } from './baileys-auth-state-mapper'
import { BaileysSocketTransportConnector } from './baileys-connector'
import type { WaTransportCallbacks } from './transport'

const baileysMock = vi.hoisted(() => {
  const makeWASocket = vi.fn()

  return {
    DisconnectReason: {
      connectionClosed: 428,
      connectionLost: 408,
      connectionReplaced: 440,
      loggedOut: 401,
      badSession: 500,
      restartRequired: 515,
      timedOut: 408,
      multideviceMismatch: 411,
      forbidden: 403,
      unavailableService: 503,
    },
    makeWASocket,
  }
})

vi.mock('@whiskeysockets/baileys', () => ({
  DisconnectReason: baileysMock.DisconnectReason,
  default: baileysMock.makeWASocket,
  makeWASocket: baileysMock.makeWASocket,
}))

describe('BaileysSocketTransportConnector', () => {
  beforeEach(() => {
    baileysMock.makeWASocket.mockReset()
  })

  it('does not create a Baileys socket when the connector module is imported or constructed', () => {
    new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    expect(baileysMock.makeWASocket).not.toHaveBeenCalled()
  })

  it('creates the Baileys socket only on explicit connect and returns a connecting state', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const store = new InMemoryWaAuthStateStore()
    const connector = new BaileysSocketTransportConnector(store)

    await expect(connector.connect({ instanceId: ' instance-1 ' })).resolves.toEqual({
      instanceId: 'instance-1',
      status: 'connecting',
      hasAuthState: false,
      logoutCount: 0,
    })

    expect(baileysMock.makeWASocket).toHaveBeenCalledOnce()
    expect(baileysMock.makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({
          creds: {},
          keys: expect.objectContaining({
            get: expect.any(Function),
            set: expect.any(Function),
          }),
        }),
        printQRInTerminal: false,
      }),
    )
  })

  it('emits QR events with instance id, QR payload, and deterministic expiry', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const callbacks: WaTransportCallbacks = {
      onQr: vi.fn(),
    }
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore(), {
      now: () => new Date('2026-07-15T00:00:00.000Z'),
      qrTtlMs: 45_000,
    })

    await connector.connect({ instanceId: 'instance-qr', callbacks })
    await socket.emit('connection.update', { qr: 'qr-fixture' })

    expect(callbacks.onQr).toHaveBeenCalledWith({
      instanceId: 'instance-qr',
      qrCode: 'qr-fixture',
      expiresAt: new Date('2026-07-15T00:00:45.000Z'),
    })
  })

  it('routes rejected QR callbacks to onError', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const error = new Error('QR callback failed')
    const callbacks: WaTransportCallbacks = {
      onQr: vi.fn().mockRejectedValue(error),
      onError: vi.fn(),
    }
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    await connector.connect({ instanceId: 'instance-qr-error', callbacks })
    await socket.emit('connection.update', { qr: 'qr-fixture' })
    await flushAsyncEvents()

    expect(callbacks.onError).toHaveBeenCalledWith({
      instanceId: 'instance-qr-error',
      error,
    })
  })

  it('routes rejected non-QR callbacks to onError', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const error = new Error('connected callback failed')
    const callbacks: WaTransportCallbacks = {
      onConnected: vi.fn().mockRejectedValue(error),
      onError: vi.fn(),
    }
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    await connector.connect({ instanceId: 'instance-connected-error', callbacks })
    await socket.emit('connection.update', { connection: 'open' })
    await flushAsyncEvents()

    expect(callbacks.onError).toHaveBeenCalledWith({
      instanceId: 'instance-connected-error',
      error,
    })
  })

  it('maps connected, disconnected, and logged_out updates to transport callbacks', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const callbacks: WaTransportCallbacks = {
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onLoggedOut: vi.fn(),
    }
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    await connector.connect({ instanceId: 'instance-events', callbacks })
    await socket.emit('connection.update', { connection: 'open' })
    await socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(428), date: new Date() },
    })
    await socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(401), date: new Date() },
    })

    expect(callbacks.onConnected).toHaveBeenCalledWith({
      instanceId: 'instance-events',
      state: {
        instanceId: 'instance-events',
        status: 'connected',
        hasAuthState: true,
        logoutCount: 0,
      },
    })
    expect(callbacks.onDisconnected).toHaveBeenCalledWith({
      instanceId: 'instance-events',
      reason: 'connection_closed',
    })
    expect(callbacks.onLoggedOut).toHaveBeenCalledWith({ instanceId: 'instance-events' })
  })

  it('maps unclassified Baileys session failures to transient disconnects', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const callbacks: WaTransportCallbacks = {
      onDisconnected: vi.fn(),
    }
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    await connector.connect({ instanceId: 'instance-session-failures', callbacks })
    await socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: createBaileysCloseError(baileysMock.DisconnectReason.badSession),
        date: new Date(),
      },
    })
    await socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: createBaileysCloseError(baileysMock.DisconnectReason.connectionReplaced),
        date: new Date(),
      },
    })

    expect(callbacks.onDisconnected).toHaveBeenNthCalledWith(1, {
      instanceId: 'instance-session-failures',
      reason: 'transient',
    })
    expect(callbacks.onDisconnected).toHaveBeenNthCalledWith(2, {
      instanceId: 'instance-session-failures',
      reason: 'transient',
    })
  })

  it('reads and writes auth-state through WaAuthStateStore', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const store = new InMemoryWaAuthStateStore()
    const write = vi.spyOn(store, 'write')
    await store.write('instance-auth', {
      creds: { registrationId: 1 },
      keys: { session: { contact: 'old-session' } },
    })
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: 'instance-auth' })
    const auth = baileysMock.makeWASocket.mock.calls[0]?.[0].auth
    await expect(auth.keys.get('session', ['contact', 'missing'])).resolves.toEqual({
      contact: 'old-session',
    })
    await auth.keys.set({
      session: {
        contact: 'new-session',
        stale: null,
      },
      'app-state-sync-key': {
        key1: { fingerprint: 'stored' },
      },
    })
    await socket.emit('creds.update', { me: { id: 'user@s.whatsapp.net' } })

    expect(write).toHaveBeenCalled()
    await expect(store.read('instance-auth')).resolves.toEqual({
      creds: {
        registrationId: 1,
        me: { id: 'user@s.whatsapp.net' },
      },
      keys: {
        session: { contact: 'new-session' },
        'app-state-sync-key': { key1: { fingerprint: 'stored' } },
      },
    })
  })

  it('routes rejected creds.update persistence to onError', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const store = new InMemoryWaAuthStateStore()
    const error = new Error('auth persistence failed')
    vi.spyOn(store, 'write').mockRejectedValueOnce(error)
    const callbacks: WaTransportCallbacks = {
      onError: vi.fn(),
    }
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: 'instance-creds-error', callbacks })
    await socket.emit('creds.update', { me: { id: 'user@s.whatsapp.net' } })
    await flushAsyncEvents()

    expect(callbacks.onError).toHaveBeenCalledWith({
      instanceId: 'instance-creds-error',
      error,
    })
  })

  it('logs rejected creds.update persistence without onError and does not leak a rejection', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const store = new InMemoryWaAuthStateStore()
    const error = new Error('auth persistence failed')
    vi.spyOn(store, 'write').mockRejectedValueOnce(error)
    const fallbackLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onUnhandledRejection = vi.fn()
    process.on('unhandledRejection', onUnhandledRejection)
    const connector = new BaileysSocketTransportConnector(store)

    try {
      await connector.connect({ instanceId: 'instance-creds-fallback' })
      await socket.emit('creds.update', { me: { id: 'user@s.whatsapp.net' } })
      await flushAsyncEvents()

      expect(fallbackLog).toHaveBeenCalledWith(
        '[wa:instance-creds-fallback] unhandled transport error',
        error,
      )
      expect(onUnhandledRejection).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      fallbackLog.mockRestore()
    }
  })

  it('does not leak an unhandled rejection when onError rejects', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const callbackError = new Error('QR callback failed')
    const errorHookError = new Error('error hook failed')
    const onUnhandledRejection = vi.fn()
    process.on('unhandledRejection', onUnhandledRejection)
    const callbacks: WaTransportCallbacks = {
      onQr: vi.fn().mockRejectedValue(callbackError),
      onError: vi.fn().mockRejectedValue(errorHookError),
    }
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    try {
      await connector.connect({ instanceId: 'instance-error-hook', callbacks })
      await socket.emit('connection.update', { qr: 'qr-fixture' })
      await flushAsyncEvents()

      expect(callbacks.onError).toHaveBeenCalledWith({
        instanceId: 'instance-error-hook',
        error: callbackError,
      })
      expect(onUnhandledRejection).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('does not leak an unhandled rejection when the fallback logger throws', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const callbackError = new Error('QR callback failed')
    const fallbackError = new Error('fallback logger failed')
    const fallbackLog = vi.spyOn(console, 'error').mockImplementation(() => {
      throw fallbackError
    })
    const onUnhandledRejection = vi.fn()
    process.on('unhandledRejection', onUnhandledRejection)
    const callbacks: WaTransportCallbacks = {
      onQr: vi.fn().mockRejectedValue(callbackError),
    }
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    try {
      await connector.connect({ instanceId: 'instance-fallback-error', callbacks })
      await socket.emit('connection.update', { qr: 'qr-fixture' })
      await flushAsyncEvents()

      expect(fallbackLog).toHaveBeenCalledWith(
        '[wa:instance-fallback-error] unhandled transport error',
        callbackError,
      )
      expect(onUnhandledRejection).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      fallbackLog.mockRestore()
    }
  })

  it('roundtrips Baileys binary key material through the JSON auth-state boundary', async () => {
    const firstSocket = createFakeBaileysSocket()
    const secondSocket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket)
    const store = new InMemoryWaAuthStateStore()
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: 'instance-binary' })
    const firstAuth = baileysMock.makeWASocket.mock.calls[0]?.[0].auth
    await firstAuth.keys.set({
      session: {
        contact: new Uint8Array([1, 2, 3]),
      },
    })

    await expect(store.read('instance-binary')).resolves.toEqual({
      creds: {},
      keys: {
        session: {
          contact: {
            __smartmessageWaBinary: 'uint8array',
            data: [1, 2, 3],
          },
        },
      },
    })

    await connector.connect({ instanceId: 'instance-binary' })
    const secondAuth = baileysMock.makeWASocket.mock.calls[1]?.[0].auth
    await expect(secondAuth.keys.get('session', ['contact'])).resolves.toEqual({
      contact: new Uint8Array([1, 2, 3]),
    })
  })

  it('rejects malformed stored auth-state before creating a socket', async () => {
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-malformed', { creds: [], keys: {} })
    const connector = new BaileysSocketTransportConnector(store)

    await expect(connector.connect({ instanceId: 'instance-malformed' })).rejects.toBeInstanceOf(
      BaileysAuthStateMapperError,
    )
    expect(baileysMock.makeWASocket).not.toHaveBeenCalled()
  })
})

type FakeBaileysEvent = 'connection.update' | 'creds.update'
type FakeBaileysListener = (payload: never) => Promise<void> | void

function createFakeBaileysSocket(): {
  ev: { on: (event: FakeBaileysEvent, listener: FakeBaileysListener) => void }
  emit: (event: FakeBaileysEvent, payload: unknown) => Promise<void>
} {
  const listeners = new Map<FakeBaileysEvent, FakeBaileysListener[]>()

  return {
    ev: {
      on: (event, listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
      },
    },
    emit: async (event, payload) => {
      for (const listener of listeners.get(event) ?? []) {
        await listener(payload as never)
      }
    },
  }
}

function createBaileysCloseError(statusCode: number): Error & {
  output: { statusCode: number }
} {
  const error = new Error(`Baileys close ${statusCode}`) as Error & {
    output: { statusCode: number }
  }
  error.output = { statusCode }
  return error
}

async function flushAsyncEvents(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
