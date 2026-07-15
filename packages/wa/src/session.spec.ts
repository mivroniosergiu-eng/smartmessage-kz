import { describe, expect, it } from 'vitest'

import {
  DEFAULT_WA_RESTRICTION_MS,
  MAX_WA_RESTRICTION_MS,
  MIN_WA_RESTRICTION_MS,
  MockSessionManager,
  createWaRestrictedUntil,
} from './session'

describe('MockSessionManager', () => {
  it('keeps auth-state and does not logout on transient disconnect', async () => {
    const manager = new MockSessionManager()
    await manager.connect('instance-1')

    const disconnected = await manager.handleDisconnect('instance-1', 'transient')

    expect(disconnected.status).toBe('disconnected')
    expect(disconnected.hasAuthState).toBe(true)
    expect(disconnected.logoutCount).toBe(0)
    expect(disconnected.lastDisconnectReason).toBe('transient')
  })

  it('closes runtime transport without clearing auth-state', async () => {
    const manager = new MockSessionManager()
    await manager.connect('instance-transport')

    const closed = await manager.closeTransport('instance-transport')

    expect(closed.status).toBe('disconnected')
    expect(closed.hasAuthState).toBe(true)
    expect(closed.logoutCount).toBe(0)
    expect(closed.lastDisconnectReason).toBe('connection_closed')
  })

  it('moves session to logged_out and clears auth-state on loggedOut', async () => {
    const manager = new MockSessionManager()
    await manager.connect('instance-2')

    const loggedOut = await manager.handleDisconnect('instance-2', 'logged_out')

    expect(loggedOut.status).toBe('logged_out')
    expect(loggedOut.hasAuthState).toBe(false)
    expect(loggedOut.logoutCount).toBe(1)
    expect(loggedOut.lastDisconnectReason).toBe('logged_out')
  })

  it('keeps logout terminal and clears auth-state', async () => {
    const manager = new MockSessionManager()
    await manager.connect('instance-logout')

    const loggedOut = await manager.logout('instance-logout')

    expect(loggedOut.status).toBe('logged_out')
    expect(loggedOut.hasAuthState).toBe(false)
    expect(loggedOut.logoutCount).toBe(1)
    expect(loggedOut.lastDisconnectReason).toBe('logged_out')
  })

  it('uses the default restriction window and clamps explicit retry delays', () => {
    const now = new Date('2026-07-15T10:00:00.000Z')

    expect(createWaRestrictedUntil(now)).toEqual(
      new Date(now.getTime() + DEFAULT_WA_RESTRICTION_MS),
    )
    expect(createWaRestrictedUntil(now, 1)).toEqual(new Date(now.getTime() + MIN_WA_RESTRICTION_MS))
    expect(createWaRestrictedUntil(now, MAX_WA_RESTRICTION_MS * 2)).toEqual(
      new Date(now.getTime() + MAX_WA_RESTRICTION_MS),
    )
  })

  it('rejects invalid restriction clocks and retry delays', () => {
    expect(() => createWaRestrictedUntil(new Date(Number.NaN))).toThrow(TypeError)
    expect(() => createWaRestrictedUntil(new Date(), 0)).toThrow(RangeError)
  })

  it.each(['restricted', 'banned'] as const)(
    'does not downgrade terminal operational status %s when closing transport',
    async (status) => {
      const manager = new MockSessionManager()
      manager.seed({
        instanceId: `instance-${status}`,
        status,
        hasAuthState: true,
        logoutCount: 0,
        lastDisconnectReason: status,
        ...(status === 'restricted'
          ? { restrictedUntil: new Date('2026-07-16T12:00:00.000Z') }
          : {}),
      })

      await expect(manager.closeTransport(`instance-${status}`)).resolves.toMatchObject({
        status,
        lastDisconnectReason: status,
      })
    },
  )

  it('clears auth without downgrading banned on explicit cleanup logout', async () => {
    const manager = new MockSessionManager()
    manager.seed({
      instanceId: 'instance-banned-cleanup',
      status: 'banned',
      hasAuthState: true,
      logoutCount: 0,
      lastDisconnectReason: 'banned',
    })

    await expect(manager.logout('instance-banned-cleanup')).resolves.toMatchObject({
      status: 'banned',
      hasAuthState: false,
      lastDisconnectReason: 'banned',
    })
  })
})
