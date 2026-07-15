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
})
