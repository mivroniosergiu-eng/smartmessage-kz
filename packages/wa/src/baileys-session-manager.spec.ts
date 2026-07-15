import { beforeEach, describe, expect, it, vi } from 'vitest'

import { InMemoryWaAuthStateStore } from './auth-state'
import {
  BaileysSessionManager,
  WaSessionAlreadyActiveError,
  WaSessionConnectForbiddenError,
  WaSessionOperationInProgressError,
  type WaSessionEvents,
} from './baileys-session-manager'
import type { SessionState, WaDisconnectReason } from './session'
import {
  WaTransportAlreadyConnectedError,
  WaTransportNotConnectedError,
  type WaTransportCallbacks,
  type WaTransportFactory,
} from './transport'

describe('BaileysSessionManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('does not touch the transport during construction or initial state reads', async () => {
    const transport = createFakeTransport()
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())

    await expect(manager.getState(' instance-idle ')).resolves.toEqual({
      instanceId: 'instance-idle',
      status: 'idle',
      hasAuthState: false,
      logoutCount: 0,
    })
    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.closeTransport).not.toHaveBeenCalled()
    expect(transport.logout).not.toHaveBeenCalled()
  })

  it('reports persisted auth-state as disconnected after a process restart', async () => {
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-restored', { creds: { registered: true }, keys: {} })
    const manager = new BaileysSessionManager(createFakeTransport(), store)

    await expect(manager.getState('instance-restored')).resolves.toEqual({
      instanceId: 'instance-restored',
      status: 'disconnected',
      hasAuthState: true,
      logoutCount: 0,
    })
  })

  it('stays connecting until the transport publishes an open event', async () => {
    const transport = createFakeTransport()
    const events: WaSessionEvents = { onConnected: vi.fn() }
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore(), events)

    await expect(manager.connect(' instance-connect ')).resolves.toMatchObject({
      instanceId: 'instance-connect',
      status: 'connecting',
    })
    expect(transport.connect).toHaveBeenCalledOnce()

    await transport.emitConnected('instance-connect')

    await expect(manager.getState('instance-connect')).resolves.toMatchObject({
      status: 'connected',
      hasAuthState: true,
    })
    expect(events.onConnected).toHaveBeenCalledWith({
      instanceId: 'instance-connect',
      state: expect.objectContaining({ status: 'connected', hasAuthState: true }),
    })
  })

  it('passes QR with the current registered state without logout or auth cleanup', async () => {
    const transport = createFakeTransport()
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-qr', { creds: { registered: true }, keys: {} })
    mockConnectResultOnce(transport, connectingState('instance-qr', true))
    const events: WaSessionEvents = { onQr: vi.fn() }
    const manager = new BaileysSessionManager(transport, store, events)

    await manager.connect('instance-qr')
    const expiresAt = new Date('2026-07-15T12:00:00.000Z')
    await transport.emitQr('instance-qr', 'qr-fixture', expiresAt)

    expect(events.onQr).toHaveBeenCalledWith({
      instanceId: 'instance-qr',
      qrCode: 'qr-fixture',
      expiresAt,
      state: expect.objectContaining({ status: 'connecting', hasAuthState: true }),
    })
    expect(transport.logout).not.toHaveBeenCalled()
    await expect(store.has('instance-qr')).resolves.toBe(true)
  })

  it.each<WaDisconnectReason>(['transient', 'restart_required', 'connection_closed'])(
    'records %s as disconnected without transport logout or auth loss',
    async (reason) => {
      const transport = createFakeTransport()
      mockConnectResultOnce(transport, connectingState('instance-transient', true))
      const events: WaSessionEvents = { onDisconnected: vi.fn() }
      const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore(), events)

      await manager.connect('instance-transient')
      await transport.emitDisconnected('instance-transient', reason)

      await expect(manager.getState('instance-transient')).resolves.toMatchObject({
        status: 'disconnected',
        hasAuthState: true,
        logoutCount: 0,
        lastDisconnectReason: reason,
      })
      expect(transport.logout).not.toHaveBeenCalled()
      expect(events.onDisconnected).toHaveBeenCalledWith({
        instanceId: 'instance-transient',
        reason,
        state: expect.objectContaining({ status: 'disconnected', hasAuthState: true }),
      })
    },
  )

  it.each([
    ['restricted', 'restricted'],
    ['banned', 'banned'],
  ] as const)('maps %s to its account state without clearing auth', async (reason, status) => {
    const transport = createFakeTransport()
    mockConnectResultOnce(transport, connectingState('instance-account-state', true))
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())

    await manager.connect('instance-account-state')
    await transport.emitDisconnected('instance-account-state', reason)

    await expect(manager.getState('instance-account-state')).resolves.toMatchObject({
      status,
      hasAuthState: true,
      lastDisconnectReason: reason,
    })
    expect(transport.logout).not.toHaveBeenCalled()
  })

  it('records remote logged_out once without calling transport logout again', async () => {
    const transport = createFakeTransport()
    mockConnectResultOnce(transport, connectingState('instance-remote-logout', true))
    const events: WaSessionEvents = { onLoggedOut: vi.fn() }
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore(), events)

    await manager.connect('instance-remote-logout')
    await transport.emitLoggedOut('instance-remote-logout')
    await transport.emitLoggedOut('instance-remote-logout')

    await expect(manager.getState('instance-remote-logout')).resolves.toMatchObject({
      status: 'logged_out',
      hasAuthState: false,
      logoutCount: 1,
      lastDisconnectReason: 'logged_out',
    })
    expect(transport.logout).not.toHaveBeenCalled()
    expect(events.onLoggedOut).toHaveBeenCalledOnce()
  })

  it.each([
    ['transient', 'disconnected'],
    ['logged_out', 'logged_out'],
  ] as const)(
    'delivers a persistence error reported after %s with the retired terminal snapshot',
    async (reason, status) => {
      const transport = createFakeTransport()
      const persistenceError = new Error(`${reason} persistence failed`)
      const events: WaSessionEvents = { onError: vi.fn() }
      const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore(), events)

      await manager.connect('instance-terminal-error')
      const oldCallbacks = transport.latestCallbacks('instance-terminal-error')
      if (reason === 'logged_out') {
        await oldCallbacks.onLoggedOut?.({ instanceId: 'instance-terminal-error' })
      } else {
        await oldCallbacks.onDisconnected?.({
          instanceId: 'instance-terminal-error',
          reason,
        })
      }
      await manager.connect('instance-terminal-error')
      await transport.emitConnected('instance-terminal-error')
      await oldCallbacks.onError?.({
        instanceId: 'instance-terminal-error',
        error: persistenceError,
      })

      expect(events.onError).toHaveBeenCalledWith({
        instanceId: 'instance-terminal-error',
        error: persistenceError,
        state: expect.objectContaining({ status }),
      })
      await expect(manager.getState('instance-terminal-error')).resolves.toMatchObject({
        status: 'connected',
      })
    },
  )

  it('delegates explicit close and logout once and caches their postconditions', async () => {
    const transport = createFakeTransport()
    mockConnectResultOnce(transport, connectingState('instance-close', true))
    mockConnectResultOnce(transport, connectingState('instance-logout', true))
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())

    await manager.connect('instance-close')
    await expect(manager.closeTransport(' instance-close ')).resolves.toMatchObject({
      status: 'disconnected',
      hasAuthState: true,
    })
    await manager.connect('instance-logout')
    await expect(manager.logout(' instance-logout ')).resolves.toMatchObject({
      status: 'logged_out',
      hasAuthState: false,
      logoutCount: 1,
    })

    expect(transport.closeTransport).toHaveBeenCalledOnce()
    expect(transport.closeTransport).toHaveBeenCalledWith('instance-close')
    expect(transport.logout).toHaveBeenCalledOnce()
    expect(transport.logout).toHaveBeenCalledWith('instance-logout')
  })

  it('treats close after remote disconnect and repeated remote logout as idempotent', async () => {
    const transport = createFakeTransport()
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())

    await manager.connect('instance-idempotent-close')
    await transport.emitDisconnected('instance-idempotent-close', 'transient')
    await expect(manager.closeTransport('instance-idempotent-close')).resolves.toMatchObject({
      status: 'disconnected',
    })

    await manager.connect('instance-idempotent-logout')
    await transport.emitLoggedOut('instance-idempotent-logout')
    await expect(manager.logout('instance-idempotent-logout')).resolves.toMatchObject({
      status: 'logged_out',
      logoutCount: 1,
    })

    expect(transport.closeTransport).not.toHaveBeenCalled()
    expect(transport.logout).not.toHaveBeenCalled()
  })

  it('clears stored auth directly when logout is requested without an active transport', async () => {
    const transport = createFakeTransport()
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-offline-logout', { creds: { registered: true }, keys: {} })
    const manager = new BaileysSessionManager(transport, store)

    await expect(manager.logout('instance-offline-logout')).resolves.toMatchObject({
      status: 'logged_out',
      hasAuthState: false,
      logoutCount: 1,
    })

    await expect(store.has('instance-offline-logout')).resolves.toBe(false)
    expect(transport.logout).not.toHaveBeenCalled()
  })

  it('uses first-wins reservation for competing commands', async () => {
    const transport = createFakeTransport()
    const closeGate = createDeferred<SessionState>()
    transport.closeTransport.mockReturnValueOnce(closeGate.promise)
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())

    await manager.connect('instance-command-race')
    const close = manager.closeTransport('instance-command-race')

    await expect(manager.logout('instance-command-race')).rejects.toBeInstanceOf(
      WaSessionOperationInProgressError,
    )
    expect(transport.logout).not.toHaveBeenCalled()

    closeGate.resolve(disconnectedState('instance-command-race', true))
    await expect(close).resolves.toMatchObject({ status: 'disconnected' })
  })

  it.each(['connect', 'closeTransport', 'logout'] as const)(
    'does not let public disconnect handling retire an in-flight %s reservation',
    async (operation) => {
      const transport = createFakeTransport()
      const gate = createDeferred<SessionState>()
      transport[operation].mockImplementationOnce(async (instanceId, callbacks) => {
        if (operation === 'connect') transport.capture(instanceId, callbacks)
        return gate.promise
      })
      const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())
      if (operation !== 'connect') await manager.connect('instance-public-disconnect-race')

      const command = manager[operation]('instance-public-disconnect-race')
      await expect(
        manager.handleDisconnect('instance-public-disconnect-race', 'transient'),
      ).rejects.toBeInstanceOf(WaSessionOperationInProgressError)
      await expect(manager.connect('instance-public-disconnect-race')).rejects.toBeInstanceOf(
        WaSessionOperationInProgressError,
      )

      gate.resolve(
        operation === 'logout'
          ? loggedOutState('instance-public-disconnect-race')
          : operation === 'closeTransport'
            ? disconnectedState('instance-public-disconnect-race', true)
            : connectingState('instance-public-disconnect-race', false),
      )
      await command
    },
  )

  it('does not open a second transport for concurrent or repeated connect', async () => {
    const transport = createFakeTransport()
    const connectGate = createDeferred<SessionState>()
    transport.connect.mockImplementationOnce(async (instanceId, callbacks) => {
      transport.capture(instanceId, callbacks)
      return connectGate.promise
    })
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())

    const first = manager.connect('instance-connect-race')
    await expect(manager.connect('instance-connect-race')).rejects.toBeInstanceOf(
      WaSessionOperationInProgressError,
    )
    connectGate.resolve(connectingState('instance-connect-race', false))
    await first

    await expect(manager.connect('instance-connect-race')).rejects.toBeInstanceOf(
      WaSessionAlreadyActiveError,
    )
    expect(transport.connect).toHaveBeenCalledOnce()
  })

  it('does not let a late connect result overwrite an earlier open callback', async () => {
    const transport = createFakeTransport()
    const gate = createDeferred<SessionState>()
    const connectStarted = createDeferred<void>()
    transport.connect.mockImplementationOnce(async (instanceId, callbacks) => {
      transport.capture(instanceId, callbacks)
      connectStarted.resolve(undefined)
      return gate.promise
    })
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())

    const connect = manager.connect('instance-open-before-result')
    await connectStarted.promise
    await transport.emitConnected('instance-open-before-result')
    gate.resolve(connectingState('instance-open-before-result', false))

    await expect(connect).resolves.toMatchObject({ status: 'connected', hasAuthState: true })
  })

  it('publishes a repeated open callback for one generation only once', async () => {
    const transport = createFakeTransport()
    const events: WaSessionEvents = { onConnected: vi.fn() }
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore(), events)

    await manager.connect('instance-repeated-open')
    await transport.emitConnected('instance-repeated-open')
    await transport.emitConnected('instance-repeated-open')

    expect(events.onConnected).toHaveBeenCalledOnce()
  })

  it('lets a terminal callback reconnect before the original connect result settles', async () => {
    const transport = createFakeTransport()
    const firstGate = createDeferred<SessionState>()
    const firstStarted = createDeferred<void>()
    transport.connect.mockImplementationOnce(async (instanceId, callbacks) => {
      transport.capture(instanceId, callbacks)
      firstStarted.resolve(undefined)
      return firstGate.promise
    })
    let reconnect: Promise<SessionState> | undefined
    const events: WaSessionEvents = {
      onDisconnected: () => {
        reconnect = manager.connect('instance-early-reconnect')
      },
    }
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore(), events)

    const firstConnect = manager.connect('instance-early-reconnect')
    await firstStarted.promise
    await transport.emitDisconnected('instance-early-reconnect', 'transient')
    await reconnect
    await transport.emitConnected('instance-early-reconnect')
    firstGate.resolve(connectingState('instance-early-reconnect', false))

    await expect(firstConnect).resolves.toMatchObject({ status: 'connected' })
    expect(transport.connect).toHaveBeenCalledTimes(2)
  })

  it('retires the old generation before a disconnect observer reconnects', async () => {
    const transport = createFakeTransport()
    let reconnect: Promise<SessionState> | undefined
    const events: WaSessionEvents = {
      onDisconnected: () => {
        reconnect = manager.connect('instance-reconnect')
      },
    }
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore(), events)

    await manager.connect('instance-reconnect')
    const oldCallbacks = transport.latestCallbacks('instance-reconnect')
    await transport.emitDisconnected('instance-reconnect', 'transient')
    await reconnect
    await transport.emitConnected('instance-reconnect')
    await oldCallbacks.onLoggedOut?.({ instanceId: 'instance-reconnect' })

    await expect(manager.getState('instance-reconnect')).resolves.toMatchObject({
      status: 'connected',
      hasAuthState: true,
      logoutCount: 0,
    })
    expect(transport.connect).toHaveBeenCalledTimes(2)
  })

  it('isolates state and callbacks by normalized instance id', async () => {
    const transport = createFakeTransport()
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())

    await manager.connect(' instance-a ')
    await manager.connect('instance-b')
    await transport.emitConnected('instance-a')
    await transport.emitDisconnected('instance-b', 'transient')

    await expect(manager.getState('instance-a')).resolves.toMatchObject({ status: 'connected' })
    await expect(manager.getState('instance-b')).resolves.toMatchObject({ status: 'disconnected' })
  })

  it.each(['connect', 'closeTransport', 'logout'] as const)(
    'propagates %s failures without publishing a false success state',
    async (operation) => {
      const transport = createFakeTransport()
      const error = new Error(`${operation} failed`)
      transport[operation].mockRejectedValueOnce(error)
      const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())
      if (operation !== 'connect') await manager.connect('instance-command-error')
      const before = await manager.getState('instance-command-error')

      await expect(manager[operation]('instance-command-error')).rejects.toBe(error)
      await expect(manager.getState('instance-command-error')).resolves.toEqual(before)
    },
  )

  it('allows a connector-authoritative recovery connect after a terminal command rejects', async () => {
    const transport = createFakeTransport()
    const terminalError = new Error('close failed after transport outcome became uncertain')
    transport.closeTransport.mockRejectedValueOnce(terminalError)
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())

    await manager.connect('instance-terminal-recovery')
    await transport.emitConnected('instance-terminal-recovery')
    await expect(manager.closeTransport('instance-terminal-recovery')).rejects.toBe(terminalError)
    await expect(manager.connect('instance-terminal-recovery')).resolves.toMatchObject({
      status: 'connecting',
    })

    expect(transport.connect).toHaveBeenCalledTimes(2)
  })

  it('reconciles a retrying terminal command when the connector confirms no socket exists', async () => {
    const transport = createFakeTransport()
    transport.closeTransport
      .mockRejectedValueOnce(new Error('close persistence failed after socket close'))
      .mockRejectedValueOnce(new WaTransportNotConnectedError('instance-close-reconcile'))
    transport.logout
      .mockRejectedValueOnce(new Error('logout result failed after socket close'))
      .mockRejectedValueOnce(new WaTransportNotConnectedError('instance-logout-reconcile'))
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())

    await manager.connect('instance-close-reconcile')
    await transport.emitConnected('instance-close-reconcile')
    await expect(manager.closeTransport('instance-close-reconcile')).rejects.toThrow(
      'close persistence failed after socket close',
    )
    await expect(manager.closeTransport('instance-close-reconcile')).resolves.toMatchObject({
      status: 'disconnected',
      lastDisconnectReason: 'connection_closed',
    })

    await manager.connect('instance-logout-reconcile')
    await transport.emitConnected('instance-logout-reconcile')
    await expect(manager.logout('instance-logout-reconcile')).rejects.toThrow(
      'logout result failed after socket close',
    )
    await expect(manager.logout('instance-logout-reconcile')).resolves.toMatchObject({
      status: 'logged_out',
      hasAuthState: false,
      logoutCount: 1,
    })
  })

  it('keeps callbacks of the still-active transport after a recovery connect is rejected', async () => {
    const transport = createFakeTransport()
    transport.closeTransport.mockRejectedValueOnce(new Error('close outcome uncertain'))
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())

    await manager.connect('instance-active-recovery')
    await transport.emitConnected('instance-active-recovery')
    const activeCallbacks = transport.latestCallbacks('instance-active-recovery')
    await expect(manager.closeTransport('instance-active-recovery')).rejects.toThrow(
      'close outcome uncertain',
    )
    transport.connect.mockRejectedValueOnce(
      new WaTransportAlreadyConnectedError('instance-active-recovery'),
    )

    await expect(manager.connect('instance-active-recovery')).rejects.toBeInstanceOf(
      WaTransportAlreadyConnectedError,
    )
    await expect(manager.connect('instance-active-recovery')).rejects.toBeInstanceOf(
      WaSessionAlreadyActiveError,
    )
    await activeCallbacks.onDisconnected?.({
      instanceId: 'instance-active-recovery',
      reason: 'transient',
    })

    await expect(manager.getState('instance-active-recovery')).resolves.toMatchObject({
      status: 'disconnected',
      lastDisconnectReason: 'transient',
    })
  })

  it('reconciles auth-state after a failed terminal command', async () => {
    const transport = createFakeTransport()
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-failed-logout', { creds: { registered: true }, keys: {} })
    transport.logout.mockImplementationOnce(async () => {
      await store.clear('instance-failed-logout')
      throw new Error('logout response failed after auth cleanup')
    })
    const manager = new BaileysSessionManager(transport, store)

    await manager.connect('instance-failed-logout')
    await transport.emitConnected('instance-failed-logout')
    await expect(manager.logout('instance-failed-logout')).rejects.toThrow(
      'logout response failed after auth cleanup',
    )

    await expect(manager.getState('instance-failed-logout')).resolves.toMatchObject({
      hasAuthState: false,
    })
  })

  it('does not apply stale auth reconciliation to a newer connected generation', async () => {
    const transport = createFakeTransport()
    const store = new InMemoryWaAuthStateStore()
    const manager = new BaileysSessionManager(transport, store)

    await manager.connect('instance-stale-reconcile')
    await transport.emitConnected('instance-stale-reconcile')
    const oldCallbacks = transport.latestCallbacks('instance-stale-reconcile')
    const authGate = createDeferred<boolean>()
    const reconcileStarted = createDeferred<void>()
    vi.spyOn(store, 'has').mockImplementationOnce(() => {
      reconcileStarted.resolve(undefined)
      return authGate.promise
    })
    const closeGate = createDeferred<SessionState>()
    const closeStarted = createDeferred<void>()
    transport.closeTransport.mockImplementationOnce(() => {
      closeStarted.resolve(undefined)
      return closeGate.promise
    })

    const close = manager.closeTransport('instance-stale-reconcile')
    await closeStarted.promise
    closeGate.reject(new Error('terminal persistence failed'))
    await reconcileStarted.promise
    await oldCallbacks.onDisconnected?.({
      instanceId: 'instance-stale-reconcile',
      reason: 'transient',
    })
    await manager.connect('instance-stale-reconcile')
    await transport.emitConnected('instance-stale-reconcile')
    authGate.resolve(false)
    await expect(close).rejects.toThrow('terminal persistence failed')

    await expect(manager.getState('instance-stale-reconcile')).resolves.toMatchObject({
      status: 'connected',
      hasAuthState: true,
    })
  })

  it('does not reconnect a banned account', async () => {
    const transport = createFakeTransport()
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())

    await manager.connect('instance-banned')
    await transport.emitDisconnected('instance-banned', 'banned')
    await expect(manager.connect('instance-banned')).rejects.toBeInstanceOf(
      WaSessionConnectForbiddenError,
    )
    expect(transport.connect).toHaveBeenCalledOnce()
  })

  it('keeps the longest restriction window across repeated disconnect events', async () => {
    const transport = createFakeTransport()
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())
    const later = new Date('2026-07-16T12:00:00.000Z')
    const earlier = new Date('2026-07-16T11:00:00.000Z')

    await manager.connect('instance-restricted-window')
    await manager.handleDisconnect('instance-restricted-window', 'restricted', later)
    await manager.handleDisconnect('instance-restricted-window', 'restricted', earlier)

    await expect(manager.getState('instance-restricted-window')).resolves.toMatchObject({
      status: 'restricted',
      lastDisconnectReason: 'restricted',
      restrictedUntil: later,
    })
  })

  it('clears auth on explicit logout without downgrading a banned account', async () => {
    const transport = createFakeTransport()
    const auth = new InMemoryWaAuthStateStore()
    const manager = new BaileysSessionManager(transport, auth)
    await auth.write('instance-banned-logout', { creds: { registered: true }, keys: {} })
    await manager.handleDisconnect('instance-banned-logout', 'banned')

    await expect(manager.logout('instance-banned-logout')).resolves.toMatchObject({
      status: 'banned',
      hasAuthState: false,
      lastDisconnectReason: 'banned',
    })
    await expect(auth.has('instance-banned-logout')).resolves.toBe(false)
    expect(transport.logout).not.toHaveBeenCalled()
  })

  it('physically closes a legacy-banned transport while preserving terminal state', async () => {
    const transport = createFakeTransport()
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())
    await manager.connect('instance-banned-close')
    await manager.handleDisconnect('instance-banned-close', 'banned')

    await expect(manager.closeTransport('instance-banned-close')).resolves.toMatchObject({
      status: 'banned',
      lastDisconnectReason: 'banned',
    })
    await expect(manager.closeTransport('instance-banned-close')).resolves.toMatchObject({
      status: 'banned',
      lastDisconnectReason: 'banned',
    })

    expect(transport.closeTransport).toHaveBeenCalledOnce()
    await expect(manager.getState('instance-banned-close')).resolves.toMatchObject({
      status: 'banned',
      lastDisconnectReason: 'banned',
    })
  })

  it('physically closes a legacy-restricted transport while preserving cooldown state', async () => {
    const transport = createFakeTransport()
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())
    const restrictedUntil = new Date('2026-07-16T12:00:00.000Z')
    await manager.connect('instance-restricted-close')
    await manager.handleDisconnect('instance-restricted-close', 'restricted', restrictedUntil)

    await expect(manager.closeTransport('instance-restricted-close')).resolves.toMatchObject({
      status: 'restricted',
      lastDisconnectReason: 'restricted',
      restrictedUntil,
    })
    await expect(manager.closeTransport('instance-restricted-close')).resolves.toMatchObject({
      status: 'restricted',
      restrictedUntil,
    })

    expect(transport.closeTransport).toHaveBeenCalledOnce()
  })

  it.each([
    ['banned', 'banned'],
    ['logged_out', 'logged_out'],
  ] as const)(
    'does not downgrade terminal %s through legacy disconnect handling',
    async (reason, status) => {
      const transport = createFakeTransport()
      const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())

      await manager.connect(`instance-terminal-${reason}`)
      if (reason === 'logged_out') {
        await transport.emitLoggedOut(`instance-terminal-${reason}`)
      } else {
        await transport.emitDisconnected(`instance-terminal-${reason}`, reason)
      }
      await manager.handleDisconnect(`instance-terminal-${reason}`, 'transient')

      await expect(manager.getState(`instance-terminal-${reason}`)).resolves.toMatchObject({
        status,
        lastDisconnectReason: reason,
      })
    },
  )

  it('routes rejected observers to onError without an unhandled rejection', async () => {
    const transport = createFakeTransport()
    const observerError = new Error('observer failed')
    const onUnhandledRejection = vi.fn()
    process.on('unhandledRejection', onUnhandledRejection)
    const events: WaSessionEvents = {
      onConnected: vi.fn().mockRejectedValue(observerError),
      onError: vi.fn(),
    }
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore(), events)

    try {
      await manager.connect('instance-observer-error')
      await transport.emitConnected('instance-observer-error')

      expect(events.onError).toHaveBeenCalledWith({
        instanceId: 'instance-observer-error',
        error: observerError,
        state: expect.objectContaining({ status: 'connected' }),
      })
      expect(onUnhandledRejection).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('returns cloned snapshots and rejects blank instance ids before transport calls', async () => {
    const transport = createFakeTransport()
    const manager = new BaileysSessionManager(transport, new InMemoryWaAuthStateStore())

    const state = await manager.getState('instance-clone')
    state.status = 'banned'

    await expect(manager.getState('instance-clone')).resolves.toMatchObject({ status: 'idle' })
    await expect(manager.connect('   ')).rejects.toBeInstanceOf(TypeError)
    await expect(manager.closeTransport('')).rejects.toBeInstanceOf(TypeError)
    await expect(manager.logout('\t')).rejects.toBeInstanceOf(TypeError)
    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.closeTransport).not.toHaveBeenCalled()
    expect(transport.logout).not.toHaveBeenCalled()
  })
})

interface FakeTransport extends WaTransportFactory {
  connect: ReturnType<typeof vi.fn>
  closeTransport: ReturnType<typeof vi.fn>
  logout: ReturnType<typeof vi.fn>
  capture(instanceId: string, callbacks?: WaTransportCallbacks): void
  latestCallbacks(instanceId: string): WaTransportCallbacks
  emitQr(instanceId: string, qrCode: string, expiresAt: Date): Promise<void>
  emitConnected(instanceId: string): Promise<void>
  emitDisconnected(instanceId: string, reason: WaDisconnectReason): Promise<void>
  emitLoggedOut(instanceId: string): Promise<void>
}

function createFakeTransport(): FakeTransport {
  const callbacks = new Map<string, WaTransportCallbacks[]>()
  const transport = {
    connect: vi.fn(async (instanceId: string, handlers?: WaTransportCallbacks) => {
      transport.capture(instanceId, handlers)
      return connectingState(instanceId, false)
    }),
    closeTransport: vi.fn(async (instanceId: string) => disconnectedState(instanceId, true)),
    logout: vi.fn(async (instanceId: string) => loggedOutState(instanceId)),
    capture: (instanceId: string, handlers: WaTransportCallbacks = {}) => {
      callbacks.set(instanceId, [...(callbacks.get(instanceId) ?? []), handlers])
    },
    latestCallbacks: (instanceId: string) => {
      const handlers = callbacks.get(instanceId)?.at(-1)
      if (!handlers) throw new Error(`No callbacks captured for ${instanceId}`)
      return handlers
    },
    emitQr: async (instanceId: string, qrCode: string, expiresAt: Date) => {
      await transport.latestCallbacks(instanceId).onQr?.({ instanceId, qrCode, expiresAt })
    },
    emitConnected: async (instanceId: string) => {
      await transport.latestCallbacks(instanceId).onConnected?.({
        instanceId,
        state: { ...connectingState(instanceId, true), status: 'connected' },
      })
    },
    emitDisconnected: async (instanceId: string, reason: WaDisconnectReason) => {
      await transport.latestCallbacks(instanceId).onDisconnected?.({ instanceId, reason })
    },
    emitLoggedOut: async (instanceId: string) => {
      await transport.latestCallbacks(instanceId).onLoggedOut?.({ instanceId })
    },
  } satisfies FakeTransport

  return transport
}

function mockConnectResultOnce(transport: FakeTransport, result: SessionState): void {
  transport.connect.mockImplementationOnce(async (instanceId, callbacks) => {
    transport.capture(instanceId, callbacks)
    return result
  })
}

function connectingState(instanceId: string, hasAuthState: boolean): SessionState {
  return { instanceId, status: 'connecting', hasAuthState, logoutCount: 0 }
}

function disconnectedState(instanceId: string, hasAuthState: boolean): SessionState {
  return {
    instanceId,
    status: 'disconnected',
    hasAuthState,
    logoutCount: 0,
    lastDisconnectReason: 'connection_closed',
  }
}

function loggedOutState(instanceId: string): SessionState {
  return {
    instanceId,
    status: 'logged_out',
    hasAuthState: false,
    logoutCount: 1,
    lastDisconnectReason: 'logged_out',
  }
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}
