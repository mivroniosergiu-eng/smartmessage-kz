import 'reflect-metadata'

import { describe, expect, it, vi } from 'vitest'

import {
  WaPhoneValidationAccountSelector,
  WaPhoneValidationAccountUnavailableError,
} from './wa-phone-validation-account.selector'

describe('WaPhoneValidationAccountSelector', () => {
  it('round-robins through DB-eligible accounts with a distributed cursor', async () => {
    const repository = {
      listEligibleAccounts: vi.fn().mockResolvedValue([
        { instanceId: 'instance-a', ownerWorkerId: 'worker-a', ownershipEpoch: 1n },
        { instanceId: 'instance-b', ownerWorkerId: 'worker-b', ownershipEpoch: 2n },
      ]),
    }
    const redis = { incr: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2) }
    const ownerRegistry = {
      getOwnership: vi.fn(async (instanceId: string) =>
        instanceId === 'instance-a'
          ? { owner: 'worker-a', epoch: 1n }
          : { owner: 'worker-b', epoch: 2n },
      ),
    }
    const selector = new WaPhoneValidationAccountSelector(repository as never, redis, ownerRegistry)

    await expect(selector.select('team/a')).resolves.toEqual({
      instanceId: 'instance-a',
      ownership: { owner: 'worker-a', epoch: 1n },
    })
    await expect(selector.select('team/a')).resolves.toEqual({
      instanceId: 'instance-b',
      ownership: { owner: 'worker-b', epoch: 2n },
    })
    expect(redis.incr).toHaveBeenCalledWith('wa:validate-phone:cursor:team%2Fa')
  })

  it('skips a stale DB owner and fails explicitly when no live owner matches', async () => {
    const repository = {
      listEligibleAccounts: vi
        .fn()
        .mockResolvedValue([
          { instanceId: 'instance-a', ownerWorkerId: 'worker-old', ownershipEpoch: 1n },
        ]),
    }
    const selector = new WaPhoneValidationAccountSelector(
      repository as never,
      { incr: vi.fn().mockResolvedValue(1) },
      { getOwnership: vi.fn().mockResolvedValue({ owner: 'worker-new', epoch: 2n }) },
    )

    await expect(selector.select('team-1')).rejects.toBeInstanceOf(
      WaPhoneValidationAccountUnavailableError,
    )
  })
})
