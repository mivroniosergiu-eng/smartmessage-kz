import { describe, expect, it, vi } from 'vitest'

import { InMemoryWaAuthStateStore } from './auth-state'
import {
  BaileysAuthStateMapperError,
  clearBaileysAuthState,
  readBaileysAuthState,
  writeBaileysAuthState,
  type BaileysAuthState,
} from './baileys-auth-state-mapper'

describe('Baileys auth-state mapper', () => {
  it('returns an explicit empty auth-state shape for an empty neutral store', async () => {
    const store = new InMemoryWaAuthStateStore()

    await expect(readBaileysAuthState('instance-empty', store)).resolves.toEqual({
      creds: {},
      keys: {},
    })
  })

  it('writes and reads a Baileys-shaped auth-state roundtrip through the neutral store', async () => {
    const store = new InMemoryWaAuthStateStore()
    const state: BaileysAuthState = {
      creds: {
        noiseKey: { public: 'noise-public', private: 'noise-private' },
        registrationId: 123,
      },
      keys: {
        'pre-key': {
          key1: { id: 1, public: 'pre-key-public' },
          key2: null,
        },
        session: {
          contact1: { chainKey: { counter: 1, key: 'opaque' } },
        },
      },
    }

    await writeBaileysAuthState(' instance-roundtrip ', state, store)

    await expect(readBaileysAuthState('instance-roundtrip', store)).resolves.toEqual(state)
  })

  it('preserves the latest creds and keys on update', async () => {
    const store = new InMemoryWaAuthStateStore()

    await writeBaileysAuthState(
      'instance-update',
      {
        creds: { registrationId: 1 },
        keys: { session: { contact: 'old-session' } },
      },
      store,
    )
    await writeBaileysAuthState(
      'instance-update',
      {
        creds: { registrationId: 2, me: { id: 'future-user' } },
        keys: {
          session: { contact: 'new-session' },
          'app-state-sync-key': { keyId: { fingerprint: 'latest' } },
        },
      },
      store,
    )

    await expect(readBaileysAuthState('instance-update', store)).resolves.toEqual({
      creds: { registrationId: 2, me: { id: 'future-user' } },
      keys: {
        session: { contact: 'new-session' },
        'app-state-sync-key': { keyId: { fingerprint: 'latest' } },
      },
    })
  })

  it('throws an explicit mapper error when the stored payload is malformed', async () => {
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-malformed', { creds: [], keys: {} })

    await expect(readBaileysAuthState('instance-malformed', store)).rejects.toBeInstanceOf(
      BaileysAuthStateMapperError,
    )
  })

  it('delegates clear to the neutral store and reads empty afterwards', async () => {
    const store = new InMemoryWaAuthStateStore()
    const clear = vi.spyOn(store, 'clear')
    await writeBaileysAuthState(
      'instance-clear',
      { creds: { registrationId: 1 }, keys: { session: { contact: 'value' } } },
      store,
    )

    await clearBaileysAuthState(' instance-clear ', store)

    expect(clear).toHaveBeenCalledWith(' instance-clear ')
    await expect(readBaileysAuthState('instance-clear', store)).resolves.toEqual({
      creds: {},
      keys: {},
    })
  })

  it('rejects non-JSON auth-state values before writing', async () => {
    const store = new InMemoryWaAuthStateStore()

    await expect(
      writeBaileysAuthState(
        'instance-invalid',
        {
          creds: { token: undefined },
          keys: {},
        } as unknown as BaileysAuthState,
        store,
      ),
    ).rejects.toBeInstanceOf(BaileysAuthStateMapperError)
    await expect(store.has('instance-invalid')).resolves.toBe(false)
  })
})
