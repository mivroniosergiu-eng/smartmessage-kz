import { describe, expect, it } from 'vitest'

import {
  InMemoryWaAuthStateStore,
  WaAuthStatePayloadError,
  type WaAuthStatePayload,
} from './auth-state'

describe('InMemoryWaAuthStateStore', () => {
  it('reads missing auth-state as null and reports has=false', async () => {
    const store = new InMemoryWaAuthStateStore()

    await expect(store.read('missing-instance')).resolves.toBeNull()
    await expect(store.has('missing-instance')).resolves.toBe(false)
  })

  it('writes, reads, and reports auth-state for an instance', async () => {
    const store = new InMemoryWaAuthStateStore()
    const payload: WaAuthStatePayload = {
      version: 1,
      provider: 'future-connector',
      credentials: {
        opaque: true,
        keys: ['one', 'two'],
      },
    }

    await store.write(' instance-1 ', payload)

    await expect(store.has('instance-1')).resolves.toBe(true)
    await expect(store.read('instance-1')).resolves.toEqual(payload)
  })

  it('updates the same instanceId instead of appending state', async () => {
    const store = new InMemoryWaAuthStateStore()

    await store.write('instance-update', { version: 1, token: 'first' })
    await store.write('instance-update', { version: 2, token: 'second' })

    await expect(store.read('instance-update')).resolves.toEqual({
      version: 2,
      token: 'second',
    })
  })

  it('clears only stored auth-state', async () => {
    const store = new InMemoryWaAuthStateStore()
    await store.write('instance-clear', { version: 1 })

    await store.clear(' instance-clear ')

    await expect(store.read('instance-clear')).resolves.toBeNull()
    await expect(store.has('instance-clear')).resolves.toBe(false)
  })

  it('clones payloads across write and read boundaries', async () => {
    const store = new InMemoryWaAuthStateStore()
    const payload: WaAuthStatePayload = { nested: { token: 'initial' } }

    await store.write('instance-clone', payload)
    payload.nested = { token: 'mutated-after-write' }
    const stored = await store.read('instance-clone')
    if (stored) stored.nested = { token: 'mutated-after-read' }

    await expect(store.read('instance-clone')).resolves.toEqual({
      nested: { token: 'initial' },
    })
  })

  it('rejects non-JSON auth-state payload values', async () => {
    const store = new InMemoryWaAuthStateStore()

    await expect(
      store.write('instance-invalid', {
        token: undefined,
      } as unknown as WaAuthStatePayload),
    ).rejects.toBeInstanceOf(WaAuthStatePayloadError)
  })
})
