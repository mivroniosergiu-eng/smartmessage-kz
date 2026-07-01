import { describe, expect, it } from 'vitest'

import { MockSessionManager } from './session'

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

  it('moves session to logged_out and clears auth-state on loggedOut', async () => {
    const manager = new MockSessionManager()
    await manager.connect('instance-2')

    const loggedOut = await manager.handleDisconnect('instance-2', 'logged_out')

    expect(loggedOut.status).toBe('logged_out')
    expect(loggedOut.hasAuthState).toBe(false)
    expect(loggedOut.logoutCount).toBe(1)
    expect(loggedOut.lastDisconnectReason).toBe('logged_out')
  })
})
