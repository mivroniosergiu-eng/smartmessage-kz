import { describe, expect, it } from 'vitest'

import { InMemoryWaAccountStatusRepository } from './status-repository'

describe('InMemoryWaAccountStatusRepository', () => {
  it('stores the latest status per instance and keeps ordered history', async () => {
    const repository = new InMemoryWaAccountStatusRepository()
    await repository.activateOwnership('instance-1', 'worker-a', 1n)
    await repository.activateOwnership('instance-2', 'worker-b', 1n)

    await repository.markConnecting('instance-1', 'worker-a', 1n)
    await repository.markConnected('instance-1', 'worker-a', 1n)
    await repository.markDisconnected('instance-1', 'worker-a', 'connection_closed', 1n)
    await repository.markConnecting('instance-2', 'worker-b', 1n)

    expect(repository.getHistory('instance-1').map((entry) => entry.status)).toEqual([
      'connecting',
      'connected',
      'disconnected',
    ])
    expect(repository.getLast('instance-1')).toMatchObject({
      instanceId: 'instance-1',
      workerId: 'worker-a',
      status: 'disconnected',
      reason: 'connection_closed',
    })
    expect(repository.getLast('instance-2')).toMatchObject({
      instanceId: 'instance-2',
      workerId: 'worker-b',
      status: 'connecting',
    })
  })

  it('stores logged_out, restricted, and banned statuses with expected details', async () => {
    const repository = new InMemoryWaAccountStatusRepository()
    const restrictedUntil = new Date('2026-07-02T12:00:00.000Z')
    await repository.activateOwnership('instance-logout', 'worker-a', 1n)
    await repository.activateOwnership('instance-restricted', 'worker-a', 1n)
    await repository.activateOwnership('instance-banned', 'worker-a', 1n)

    await repository.markLoggedOut('instance-logout', 'worker-a', 1n)
    await repository.markRestricted('instance-restricted', 'worker-a', restrictedUntil, 1n)
    await repository.markBanned('instance-banned', 'worker-a', 'permanent ban', 1n)

    expect(repository.getLast('instance-logout')).toMatchObject({
      instanceId: 'instance-logout',
      workerId: 'worker-a',
      status: 'logged_out',
    })
    expect(repository.getLast('instance-restricted')).toMatchObject({
      instanceId: 'instance-restricted',
      workerId: 'worker-a',
      status: 'restricted',
      restrictedUntil,
    })
    expect(repository.getLast('instance-banned')).toMatchObject({
      instanceId: 'instance-banned',
      workerId: 'worker-a',
      status: 'banned',
      reason: 'permanent ban',
    })
  })

  it('rejects a stale epoch after a newer owner fence is active', async () => {
    const repository = new InMemoryWaAccountStatusRepository()
    await repository.activateOwnership('instance-fenced', 'worker-a', 1n)
    await repository.markConnected('instance-fenced', 'worker-a', 1n)
    await repository.activateOwnership('instance-fenced', 'worker-b', 2n)
    await repository.markConnecting('instance-fenced', 'worker-b', 2n)

    await expect(
      repository.markDisconnected('instance-fenced', 'worker-a', 'late', 1n),
    ).resolves.toBe(false)
    expect(repository.getLast('instance-fenced')).toMatchObject({
      workerId: 'worker-b',
      status: 'connecting',
      epoch: 2n,
    })
  })

  it('keeps banned monotonic and idempotent within the active fence', async () => {
    const repository = new InMemoryWaAccountStatusRepository()
    await repository.activateOwnership('instance-monotonic-ban', 'worker-a', 1n)
    await repository.markBanned('instance-monotonic-ban', 'worker-a', 'permanent_ban', 1n)

    await expect(
      repository.markDisconnected('instance-monotonic-ban', 'worker-a', 'shutdown', 1n),
    ).resolves.toBe(true)
    await expect(repository.markLoggedOut('instance-monotonic-ban', 'worker-a', 1n)).resolves.toBe(
      true,
    )
    await repository.markBanned('instance-monotonic-ban', 'worker-a', 'duplicate', 1n)

    expect(repository.getLast('instance-monotonic-ban')).toMatchObject({
      status: 'banned',
      reason: 'permanent_ban',
    })
    expect(repository.getHistory('instance-monotonic-ban')).toHaveLength(1)
  })

  it('never shortens a persisted restriction window', async () => {
    const repository = new InMemoryWaAccountStatusRepository()
    const later = new Date('2026-07-16T12:00:00.000Z')
    const earlier = new Date('2026-07-16T11:00:00.000Z')
    await repository.activateOwnership('instance-restriction-max', 'worker-a', 1n)
    await repository.markRestricted('instance-restriction-max', 'worker-a', later, 1n)
    await repository.markRestricted('instance-restriction-max', 'worker-a', earlier, 1n)

    expect(repository.getLast('instance-restriction-max')).toMatchObject({
      status: 'restricted',
      restrictedUntil: later,
    })
  })
})
