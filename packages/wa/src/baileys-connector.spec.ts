import { beforeEach, describe, expect, it, vi } from 'vitest'

import { InMemoryWaAuthStateStore } from './auth-state'
import { BaileysAuthStateMapperError } from './baileys-auth-state-mapper'
import { BaileysSocketTransportConnector } from './baileys-connector'
import type { SessionState } from './session'
import {
  WaTransportAlreadyConnectedError,
  WaTransportCloseTimeoutError,
  WaTransportNotConnectedError,
  WaTransportOperationInProgressError,
  type WaTransportCallbacks,
} from './transport'

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

  it('rejects a second active socket for the same normalized instance id', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    await connector.connect({ instanceId: ' instance-owned ' })

    await expect(connector.connect({ instanceId: 'instance-owned' })).rejects.toBeInstanceOf(
      WaTransportAlreadyConnectedError,
    )
    expect(baileysMock.makeWASocket).toHaveBeenCalledOnce()
  })

  it('reserves the normalized instance id while the first socket is opening', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValue(socket)
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    const firstConnect = connector.connect({ instanceId: ' instance-opening ' })
    const competingConnect = connector.connect({ instanceId: 'instance-opening' })

    await expect(competingConnect).rejects.toBeInstanceOf(WaTransportAlreadyConnectedError)
    await expect(firstConnect).resolves.toMatchObject({ instanceId: 'instance-opening' })
    expect(baileysMock.makeWASocket).toHaveBeenCalledOnce()
  })

  it('rejects terminal operations while the socket is still opening', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const store = new InMemoryWaAuthStateStore()
    const readGate = createDeferred<void>()
    const readStarted = createDeferred<void>()
    const originalRead = store.read.bind(store)
    vi.spyOn(store, 'read').mockImplementation(async (instanceId) => {
      readStarted.resolve(undefined)
      await readGate.promise
      return originalRead(instanceId)
    })
    const connector = new BaileysSocketTransportConnector(store)

    const connect = connector.connect({ instanceId: 'instance-opening-terminal' })
    await readStarted.promise

    await expect(connector.closeTransport('instance-opening-terminal')).rejects.toBeInstanceOf(
      WaTransportOperationInProgressError,
    )
    await expect(connector.logout('instance-opening-terminal')).rejects.toBeInstanceOf(
      WaTransportOperationInProgressError,
    )
    readGate.resolve(undefined)
    await expect(connect).resolves.toMatchObject({ status: 'connecting' })
  })

  it('ends the active socket, preserves auth-state, and removes it from the registry on close', async () => {
    const firstSocket = createFakeBaileysSocket()
    const secondSocket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket)
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-close', { creds: { registered: true }, keys: {} })
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: ' instance-close ' })
    await expect(connector.closeTransport('instance-close')).resolves.toEqual({
      instanceId: 'instance-close',
      status: 'disconnected',
      hasAuthState: true,
      logoutCount: 0,
      lastDisconnectReason: 'connection_closed',
    })

    expect(firstSocket.end).toHaveBeenCalledOnce()
    expect(firstSocket.end).toHaveBeenCalledWith(undefined)
    expect(firstSocket.logout).not.toHaveBeenCalled()
    await expect(connector.connect({ instanceId: 'instance-close' })).resolves.toMatchObject({
      status: 'connecting',
    })
    expect(baileysMock.makeWASocket).toHaveBeenCalledTimes(2)
  })

  it('persists an already queued creds update before runtime close completes', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const store = new InMemoryWaAuthStateStore()
    const qrGate = createDeferred<void>()
    const qrStarted = createDeferred<void>()
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({
      instanceId: 'instance-queued-close',
      callbacks: {
        onQr: async () => {
          qrStarted.resolve(undefined)
          await qrGate.promise
        },
      },
    })
    await socket.emit('connection.update', { qr: 'queued-close-qr' })
    await qrStarted.promise
    await socket.emit('creds.update', { registered: true })
    const close = connector.closeTransport('instance-queued-close')
    qrGate.resolve(undefined)
    await close

    await expect(store.read('instance-queued-close')).resolves.toMatchObject({
      creds: { registered: true },
    })
  })

  it('logs out the active socket, clears auth-state, and removes it from the registry', async () => {
    const firstSocket = createFakeBaileysSocket()
    const secondSocket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket)
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-logout', { creds: { registered: true }, keys: {} })
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: ' instance-logout ' })
    await expect(connector.logout('instance-logout')).resolves.toEqual({
      instanceId: 'instance-logout',
      status: 'logged_out',
      hasAuthState: false,
      logoutCount: 1,
      lastDisconnectReason: 'logged_out',
    })

    expect(firstSocket.logout).toHaveBeenCalledOnce()
    expect(firstSocket.end).not.toHaveBeenCalled()
    await expect(store.has('instance-logout')).resolves.toBe(false)
    await expect(connector.connect({ instanceId: 'instance-logout' })).resolves.toMatchObject({
      status: 'connecting',
      hasAuthState: false,
    })
    expect(baileysMock.makeWASocket).toHaveBeenCalledTimes(2)
  })

  it('retries failed explicit logout cleanup before opening a replacement socket', async () => {
    const firstSocket = createFakeBaileysSocket()
    const replacementSocket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(replacementSocket)
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-explicit-clear-retry', {
      creds: { registered: true },
      keys: {},
    })
    const clearError = new Error('explicit auth clear failed')
    vi.spyOn(store, 'clear').mockRejectedValueOnce(clearError)
    const callbacks: WaTransportCallbacks = { onError: vi.fn() }
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: 'instance-explicit-clear-retry', callbacks })
    await expect(connector.logout('instance-explicit-clear-retry')).rejects.toBe(clearError)
    await expect(store.has('instance-explicit-clear-retry')).resolves.toBe(true)

    await expect(
      connector.connect({ instanceId: 'instance-explicit-clear-retry' }),
    ).resolves.toMatchObject({ hasAuthState: false })
    await expect(store.has('instance-explicit-clear-retry')).resolves.toBe(false)
    expect(baileysMock.makeWASocket).toHaveBeenCalledTimes(2)
  })

  it('rejects close and logout before connect with a domain error', async () => {
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    await expect(connector.closeTransport('instance-missing')).rejects.toBeInstanceOf(
      WaTransportNotConnectedError,
    )
    await expect(connector.logout('instance-missing')).rejects.toBeInstanceOf(
      WaTransportNotConnectedError,
    )
    expect(baileysMock.makeWASocket).not.toHaveBeenCalled()
  })

  it('rejects repeated close and repeated logout deterministically', async () => {
    const closeSocket = createFakeBaileysSocket()
    const logoutSocket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(closeSocket).mockReturnValueOnce(logoutSocket)
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    await connector.connect({ instanceId: 'instance-repeat-close' })
    await connector.closeTransport('instance-repeat-close')
    await expect(connector.closeTransport('instance-repeat-close')).rejects.toBeInstanceOf(
      WaTransportNotConnectedError,
    )

    await connector.connect({ instanceId: 'instance-repeat-logout' })
    await connector.logout('instance-repeat-logout')
    await expect(connector.logout('instance-repeat-logout')).rejects.toBeInstanceOf(
      WaTransportNotConnectedError,
    )
  })

  it('reports a close failure, rejects predictably, and does not leak an unhandled rejection', async () => {
    const socket = createFakeBaileysSocket()
    const closeError = new Error('socket end failed')
    socket.end.mockRejectedValueOnce(closeError)
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const onUnhandledRejection = vi.fn()
    process.on('unhandledRejection', onUnhandledRejection)
    const callbacks: WaTransportCallbacks = {
      onError: vi.fn(),
    }
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    try {
      await connector.connect({ instanceId: 'instance-close-error', callbacks })

      await expect(connector.closeTransport('instance-close-error')).rejects.toBe(closeError)
      expect(callbacks.onError).toHaveBeenCalledWith({
        instanceId: 'instance-close-error',
        error: closeError,
      })
      expect(onUnhandledRejection).not.toHaveBeenCalled()
      await expect(connector.connect({ instanceId: 'instance-close-error' })).rejects.toBeInstanceOf(
        WaTransportAlreadyConnectedError,
      )
      await expect(connector.closeTransport('instance-close-error')).resolves.toMatchObject({
        status: 'disconnected',
      })
      await expect(connector.closeTransport('instance-close-error')).rejects.toBeInstanceOf(
        WaTransportNotConnectedError,
      )
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('rejects runtime close when the latest auth-state write failed', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const writeError = new Error('auth write failed')
    const store = new InMemoryWaAuthStateStore()
    vi.spyOn(store, 'write').mockRejectedValueOnce(writeError)
    const callbacks: WaTransportCallbacks = { onError: vi.fn() }
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: 'instance-write-error', callbacks })
    await socket.emit('creds.update', { registered: true })
    await flushAsyncEvents()

    await expect(connector.closeTransport('instance-write-error')).rejects.toBe(writeError)
    expect(socket.end).toHaveBeenCalledOnce()
    expect(socket.end).toHaveBeenCalledWith(undefined)
    expect(callbacks.onError).toHaveBeenCalledWith({
      instanceId: 'instance-write-error',
      error: writeError,
    })
  })

  it('rejects a competing terminal operation while close is in progress', async () => {
    const socket = createFakeBaileysSocket()
    const closeGate = createDeferred<void>()
    socket.end.mockReturnValueOnce(closeGate.promise)
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-terminal-race', { creds: { registered: true }, keys: {} })
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: 'instance-terminal-race' })
    const close = connector.closeTransport('instance-terminal-race')

    await expect(connector.logout('instance-terminal-race')).rejects.toBeInstanceOf(
      WaTransportOperationInProgressError,
    )
    expect(socket.logout).not.toHaveBeenCalled()

    closeGate.resolve(undefined)
    await socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(428), date: new Date() },
    })
    await expect(close).resolves.toMatchObject({
      status: 'disconnected',
      hasAuthState: true,
    })
  })

  it('keeps ownership until the close event when socket.end returns before transport cleanup', async () => {
    const socket = createFakeBaileysSocket()
    socket.end.mockResolvedValueOnce(undefined)
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    await connector.connect({ instanceId: 'instance-deferred-close-event' })
    const close = connector.closeTransport('instance-deferred-close-event')
    await flushAsyncEvents()

    await expect(
      connector.connect({ instanceId: 'instance-deferred-close-event' }),
    ).rejects.toBeInstanceOf(WaTransportAlreadyConnectedError)

    await socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(428), date: new Date() },
    })
    await expect(close).resolves.toMatchObject({ status: 'disconnected' })
  })

  it('keeps ownership until the close event after logout falls back to socket.end', async () => {
    const socket = createFakeBaileysSocket()
    const logoutError = new Error('logout failed')
    socket.logout.mockRejectedValueOnce(logoutError)
    socket.end.mockResolvedValueOnce(undefined)
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    await connector.connect({
      instanceId: 'instance-deferred-logout-close-event',
      callbacks: { onError: vi.fn() },
    })
    const logout = connector.logout('instance-deferred-logout-close-event')
    await flushAsyncEvents()

    await expect(
      connector.connect({ instanceId: 'instance-deferred-logout-close-event' }),
    ).rejects.toBeInstanceOf(WaTransportAlreadyConnectedError)

    await socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(428), date: new Date() },
    })
    await expect(logout).rejects.toBe(logoutError)
  })

  it('fails runtime close when Baileys never emits the transport close event', async () => {
    vi.useFakeTimers()
    try {
      const socket = createFakeBaileysSocket()
      socket.end.mockResolvedValueOnce(undefined)
      baileysMock.makeWASocket.mockReturnValueOnce(socket)
      const callbacks: WaTransportCallbacks = { onError: vi.fn() }
      const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore(), {
        transportCloseTimeoutMs: 1_000,
      })

      await connector.connect({ instanceId: 'instance-close-timeout', callbacks })
      const close = connector.closeTransport('instance-close-timeout')
      let closeError: unknown
      void close.catch((error: unknown) => {
        closeError = error
      })

      await vi.advanceTimersByTimeAsync(1_000)

      expect(closeError).toBeInstanceOf(WaTransportCloseTimeoutError)
      expect(callbacks.onError).toHaveBeenCalledWith({
        instanceId: 'instance-close-timeout',
        error: closeError,
      })
      await expect(connector.connect({ instanceId: 'instance-close-timeout' })).rejects.toBeInstanceOf(
        WaTransportAlreadyConnectedError,
      )
      expect(vi.getTimerCount()).toBe(0)

      await socket.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: createBaileysCloseError(428), date: new Date() },
      })
      await expect(connector.closeTransport('instance-close-timeout')).resolves.toMatchObject({
        status: 'disconnected',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails logout when Baileys never confirms the transport close event', async () => {
    vi.useFakeTimers()
    try {
      const socket = createFakeBaileysSocket()
      socket.logout.mockResolvedValueOnce(undefined)
      baileysMock.makeWASocket.mockReturnValueOnce(socket)
      const callbacks: WaTransportCallbacks = { onError: vi.fn() }
      const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore(), {
        transportCloseTimeoutMs: 1_000,
      })

      await connector.connect({ instanceId: 'instance-logout-timeout', callbacks })
      const logout = connector.logout('instance-logout-timeout')
      let logoutError: unknown
      void logout.catch((error: unknown) => {
        logoutError = error
      })

      await vi.advanceTimersByTimeAsync(1_000)

      expect(logoutError).toBeInstanceOf(WaTransportCloseTimeoutError)
      expect(callbacks.onError).toHaveBeenCalledWith({
        instanceId: 'instance-logout-timeout',
        error: logoutError,
      })
      await expect(
        connector.connect({ instanceId: 'instance-logout-timeout' }),
      ).rejects.toBeInstanceOf(WaTransportAlreadyConnectedError)
    } finally {
      vi.useRealTimers()
    }
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
    const disconnectedSocket = createFakeBaileysSocket()
    const loggedOutSocket = createFakeBaileysSocket()
    baileysMock.makeWASocket
      .mockReturnValueOnce(disconnectedSocket)
      .mockReturnValueOnce(loggedOutSocket)
    const callbacks: WaTransportCallbacks = {
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onLoggedOut: vi.fn(),
    }
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    await connector.connect({ instanceId: 'instance-events', callbacks })
    await disconnectedSocket.emit('connection.update', { connection: 'open' })
    await disconnectedSocket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(428), date: new Date() },
    })
    await flushAsyncEvents()
    await connector.connect({ instanceId: 'instance-events', callbacks })
    await loggedOutSocket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(401), date: new Date() },
    })
    await flushAsyncEvents()

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

  it('clears persisted auth-state before reporting a confirmed logged_out update', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-confirmed-logout', {
      creds: { registered: true },
      keys: {},
    })
    const onLoggedOut = vi.fn(async () => {
      await expect(store.has('instance-confirmed-logout')).resolves.toBe(false)
    })
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({
      instanceId: 'instance-confirmed-logout',
      callbacks: { onLoggedOut },
    })
    await socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(401), date: new Date() },
    })
    await flushAsyncEvents()

    await expect(store.has('instance-confirmed-logout')).resolves.toBe(false)
    expect(onLoggedOut).toHaveBeenCalledOnce()
  })

  it('blocks reconnect until confirmed logged_out cleanup finishes', async () => {
    const firstSocket = createFakeBaileysSocket()
    const secondSocket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket)
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-remote-cleanup', {
      creds: { registered: true },
      keys: {},
    })
    const clearGate = createDeferred<void>()
    const originalClear = store.clear.bind(store)
    vi.spyOn(store, 'clear').mockImplementation(async (instanceId) => {
      await clearGate.promise
      await originalClear(instanceId)
    })
    const loggedOut = createDeferred<void>()
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({
      instanceId: 'instance-remote-cleanup',
      callbacks: { onLoggedOut: () => loggedOut.resolve(undefined) },
    })
    await firstSocket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(401), date: new Date() },
    })
    await Promise.resolve()

    await expect(
      connector.connect({ instanceId: 'instance-remote-cleanup' }),
    ).rejects.toBeInstanceOf(WaTransportAlreadyConnectedError)
    clearGate.resolve(undefined)
    await loggedOut.promise
    await flushAsyncEvents()
    await expect(connector.connect({ instanceId: 'instance-remote-cleanup' })).resolves.toMatchObject({
      hasAuthState: false,
    })
  })

  it('ignores a delayed logged_out update from a replaced socket', async () => {
    const staleSocket = createFakeBaileysSocket()
    const activeSocket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(staleSocket).mockReturnValueOnce(activeSocket)
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-stale-close', { creds: { registered: true }, keys: {} })
    const callbacks: WaTransportCallbacks = { onLoggedOut: vi.fn() }
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: 'instance-stale-close', callbacks })
    await staleSocket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(428), date: new Date() },
    })
    await flushAsyncEvents()
    await connector.connect({ instanceId: 'instance-stale-close', callbacks })

    await staleSocket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(401), date: new Date() },
    })
    await flushAsyncEvents()

    await expect(store.has('instance-stale-close')).resolves.toBe(true)
    expect(callbacks.onLoggedOut).not.toHaveBeenCalled()
    await expect(
      connector.connect({ instanceId: 'instance-stale-close' }),
    ).rejects.toBeInstanceOf(WaTransportAlreadyConnectedError)
  })

  it('drains an in-flight auth write before logout clears persisted state', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const store = new InMemoryWaAuthStateStore()
    const writeGate = createDeferred<void>()
    const originalWrite = store.write.bind(store)
    const writeStarted = createDeferred<void>()
    vi.spyOn(store, 'write').mockImplementation(async (instanceId, state) => {
      writeStarted.resolve(undefined)
      await writeGate.promise
      await originalWrite(instanceId, state)
    })
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: 'instance-write-drain' })
    await socket.emit('creds.update', { registered: true })
    await writeStarted.promise
    const logout = connector.logout('instance-write-drain')
    await Promise.resolve()

    expect(socket.logout).not.toHaveBeenCalled()
    writeGate.resolve(undefined)
    await expect(logout).resolves.toMatchObject({ status: 'logged_out', hasAuthState: false })
    await expect(store.has('instance-write-drain')).resolves.toBe(false)
  })

  it('drains a direct Baileys key write before logout clears persisted state', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const store = new InMemoryWaAuthStateStore()
    const writeGate = createDeferred<void>()
    const originalWrite = store.write.bind(store)
    const writeStarted = createDeferred<void>()
    vi.spyOn(store, 'write').mockImplementation(async (instanceId, state) => {
      writeStarted.resolve(undefined)
      await writeGate.promise
      await originalWrite(instanceId, state)
    })
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: 'instance-key-write-drain' })
    const auth = baileysMock.makeWASocket.mock.calls[0]?.[0].auth
    const keyWrite = auth.keys.set({ session: { contact: new Uint8Array([4, 5, 6]) } })
    await writeStarted.promise
    const logout = connector.logout('instance-key-write-drain')
    await Promise.resolve()

    expect(socket.logout).not.toHaveBeenCalled()
    writeGate.resolve(undefined)
    await keyWrite
    await logout
    await expect(store.has('instance-key-write-drain')).resolves.toBe(false)
  })

  it('reports auth cleanup failure without hiding confirmed logged_out', async () => {
    const socket = createFakeBaileysSocket()
    const replacementSocket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket).mockReturnValueOnce(replacementSocket)
    const clearError = new Error('auth clear failed')
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-clear-error', { creds: { registered: true }, keys: {} })
    vi.spyOn(store, 'clear').mockRejectedValueOnce(clearError)
    const callbacks: WaTransportCallbacks = {
      onLoggedOut: vi.fn(),
      onError: vi.fn(),
    }
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: 'instance-clear-error', callbacks })
    await socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(401), date: new Date() },
    })
    await flushAsyncEvents()

    expect(callbacks.onLoggedOut).toHaveBeenCalledWith({ instanceId: 'instance-clear-error' })
    expect(callbacks.onError).toHaveBeenCalledWith({
      instanceId: 'instance-clear-error',
      error: clearError,
    })
    await expect(store.has('instance-clear-error')).resolves.toBe(true)
    await expect(connector.connect({ instanceId: 'instance-clear-error' })).resolves.toMatchObject({
      hasAuthState: false,
    })
    await expect(store.has('instance-clear-error')).resolves.toBe(false)
  })

  it('does not duplicate remote logged_out side effects during explicit logout', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-explicit-logout-event', {
      creds: { registered: true },
      keys: {},
    })
    const clear = vi.spyOn(store, 'clear')
    const callbacks: WaTransportCallbacks = { onLoggedOut: vi.fn() }
    socket.logout.mockImplementationOnce(async () => {
      await socket.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: createBaileysCloseError(401), date: new Date() },
      })
    })
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: 'instance-explicit-logout-event', callbacks })
    await connector.logout('instance-explicit-logout-event')
    await flushAsyncEvents()

    expect(clear).toHaveBeenCalledOnce()
    expect(callbacks.onLoggedOut).not.toHaveBeenCalled()
  })

  it('holds socket ownership until successful logout emits its close event', async () => {
    const firstSocket = createFakeBaileysSocket()
    const replacementSocket = createFakeBaileysSocket()
    firstSocket.logout.mockResolvedValueOnce(undefined)
    baileysMock.makeWASocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(replacementSocket)
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-logout-close-barrier', {
      creds: { registered: true },
      keys: {},
    })
    const clear = vi.spyOn(store, 'clear')
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: 'instance-logout-close-barrier' })
    const logout = connector.logout('instance-logout-close-barrier')
    await Promise.resolve()

    expect(clear).not.toHaveBeenCalled()
    await expect(
      connector.connect({ instanceId: 'instance-logout-close-barrier' }),
    ).rejects.toBeInstanceOf(WaTransportAlreadyConnectedError)
    await firstSocket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(401), date: new Date() },
    })
    await expect(logout).resolves.toMatchObject({ status: 'logged_out' })
    await expect(
      connector.connect({ instanceId: 'instance-logout-close-barrier' }),
    ).resolves.toMatchObject({ hasAuthState: false })
  })

  it('awaits fallback transport close when Baileys logout fails', async () => {
    const firstSocket = createFakeBaileysSocket()
    const replacementSocket = createFakeBaileysSocket()
    const logoutError = new Error('logout request failed')
    const closeGate = createDeferred<void>()
    const closeStarted = createDeferred<void>()
    firstSocket.logout.mockRejectedValueOnce(logoutError)
    firstSocket.end.mockImplementationOnce(async () => {
      closeStarted.resolve(undefined)
      await closeGate.promise
    })
    baileysMock.makeWASocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(replacementSocket)
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-logout-fallback', {
      creds: { registered: true },
      keys: {},
    })
    const callbacks: WaTransportCallbacks = { onError: vi.fn() }
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: 'instance-logout-fallback', callbacks })
    const logout = connector.logout('instance-logout-fallback')
    await closeStarted.promise

    expect(firstSocket.end).toHaveBeenCalledWith(logoutError)
    await expect(
      connector.connect({ instanceId: 'instance-logout-fallback' }),
    ).rejects.toBeInstanceOf(WaTransportAlreadyConnectedError)
    closeGate.resolve(undefined)
    await firstSocket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(428), date: new Date() },
    })
    await expect(logout).rejects.toBe(logoutError)
    expect(callbacks.onError).toHaveBeenCalledWith({
      instanceId: 'instance-logout-fallback',
      error: logoutError,
    })
    await expect(
      connector.connect({ instanceId: 'instance-logout-fallback' }),
    ).resolves.toMatchObject({ hasAuthState: false })
  })

  it('still clears auth-state and reports logged_out after a failed pending auth write', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const writeError = new Error('pending auth write failed')
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-write-error-logout', {
      creds: { registered: true },
      keys: {},
    })
    vi.spyOn(store, 'write').mockRejectedValueOnce(writeError)
    const callbacks: WaTransportCallbacks = {
      onLoggedOut: vi.fn(),
      onError: vi.fn(),
    }
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: 'instance-write-error-logout', callbacks })
    await socket.emit('creds.update', { registered: false })
    await socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(401), date: new Date() },
    })
    await flushAsyncEvents()

    expect(callbacks.onLoggedOut).toHaveBeenCalledWith({
      instanceId: 'instance-write-error-logout',
    })
    await expect(store.has('instance-write-error-logout')).resolves.toBe(false)
    expect(callbacks.onError).toHaveBeenCalledWith({
      instanceId: 'instance-write-error-logout',
      error: writeError,
    })
  })

  it('persists a queued creds update before a transient remote close completes', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const store = new InMemoryWaAuthStateStore()
    const disconnected = createDeferred<void>()
    const qrGate = createDeferred<void>()
    const qrStarted = createDeferred<void>()
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({
      instanceId: 'instance-queued-remote-close',
      callbacks: {
        onQr: async () => {
          qrStarted.resolve(undefined)
          await qrGate.promise
        },
        onDisconnected: () => disconnected.resolve(undefined),
      },
    })
    await socket.emit('connection.update', { qr: 'queued-remote-close-qr' })
    await qrStarted.promise
    await socket.emit('creds.update', { registered: true })
    await socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(428), date: new Date() },
    })
    qrGate.resolve(undefined)
    await disconnected.promise

    await expect(store.read('instance-queued-remote-close')).resolves.toMatchObject({
      creds: { registered: true },
    })
  })

  it('reports auth persistence failure without hiding transient disconnect', async () => {
    const socket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(socket)
    const writeError = new Error('transient auth write failed')
    const store = new InMemoryWaAuthStateStore()
    vi.spyOn(store, 'write').mockRejectedValueOnce(writeError)
    const callbacks: WaTransportCallbacks = {
      onDisconnected: vi.fn(),
      onError: vi.fn(),
    }
    const connector = new BaileysSocketTransportConnector(store)

    await connector.connect({ instanceId: 'instance-transient-write-error', callbacks })
    await socket.emit('creds.update', { registered: true })
    await socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(428), date: new Date() },
    })
    await flushAsyncEvents()

    expect(callbacks.onDisconnected).toHaveBeenCalledWith({
      instanceId: 'instance-transient-write-error',
      reason: 'connection_closed',
    })
    expect(callbacks.onError).toHaveBeenCalledWith({
      instanceId: 'instance-transient-write-error',
      error: writeError,
    })
  })

  it('releases remote close ownership before invoking reconnect callback', async () => {
    const firstSocket = createFakeBaileysSocket()
    const secondSocket = createFakeBaileysSocket()
    baileysMock.makeWASocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket)
    const reconnected = createDeferred<SessionState>()
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    await connector.connect({
      instanceId: 'instance-callback-reconnect',
      callbacks: {
        onDisconnected: async () => {
          reconnected.resolve(
            await connector.connect({ instanceId: 'instance-callback-reconnect' }),
          )
        },
      },
    })
    await firstSocket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(428), date: new Date() },
    })

    await expect(reconnected.promise).resolves.toMatchObject({ status: 'connecting' })
    expect(baileysMock.makeWASocket).toHaveBeenCalledTimes(2)
  })

  it('maps unclassified Baileys session failures to transient disconnects', async () => {
    const badSessionSocket = createFakeBaileysSocket()
    const replacedSocket = createFakeBaileysSocket()
    baileysMock.makeWASocket
      .mockReturnValueOnce(badSessionSocket)
      .mockReturnValueOnce(replacedSocket)
    const callbacks: WaTransportCallbacks = {
      onDisconnected: vi.fn(),
    }
    const connector = new BaileysSocketTransportConnector(new InMemoryWaAuthStateStore())

    await connector.connect({ instanceId: 'instance-session-failures', callbacks })
    await badSessionSocket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: createBaileysCloseError(baileysMock.DisconnectReason.badSession),
        date: new Date(),
      },
    })
    await flushAsyncEvents()
    await connector.connect({ instanceId: 'instance-session-failures', callbacks })
    await replacedSocket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: createBaileysCloseError(baileysMock.DisconnectReason.connectionReplaced),
        date: new Date(),
      },
    })
    await flushAsyncEvents()

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

    await connector.closeTransport('instance-binary')
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

interface FakeBaileysSocket {
  ev: { on: (event: FakeBaileysEvent, listener: FakeBaileysListener) => void }
  end: ReturnType<typeof vi.fn>
  logout: ReturnType<typeof vi.fn>
  emit: (event: FakeBaileysEvent, payload: unknown) => Promise<void>
}

function createFakeBaileysSocket(): FakeBaileysSocket {
  const listeners = new Map<FakeBaileysEvent, FakeBaileysListener[]>()
  const socket: FakeBaileysSocket = {
    ev: {
      on: (event, listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
      },
    },
    end: vi.fn(async () => {
      await socket.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: createBaileysCloseError(428), date: new Date() },
      })
    }),
    logout: vi.fn(),
    emit: async (event, payload) => {
      for (const listener of listeners.get(event) ?? []) {
        await listener(payload as never)
      }
    },
  }
  socket.logout.mockImplementation(async () => {
    await socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: createBaileysCloseError(401), date: new Date() },
    })
  })

  return socket
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

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })

  return { promise, resolve }
}
