import { describe, expect, it } from 'vitest'

import { InMemoryWaAccountStatusRepository } from './status-repository'

describe('InMemoryWaAccountStatusRepository', () => {
  it('stores the latest status per instance and keeps ordered history', async () => {
    const repository = new InMemoryWaAccountStatusRepository()

    await repository.markConnecting('instance-1', 'worker-a')
    await repository.markConnected('instance-1', 'worker-a')
    await repository.markDisconnected('instance-1', 'worker-a', 'connection_closed')
    await repository.markConnecting('instance-2', 'worker-b')

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

    await repository.markLoggedOut('instance-logout', 'worker-a')
    await repository.markRestricted('instance-restricted', 'worker-a', restrictedUntil)
    await repository.markBanned('instance-banned', 'worker-a', 'permanent ban')

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
})
