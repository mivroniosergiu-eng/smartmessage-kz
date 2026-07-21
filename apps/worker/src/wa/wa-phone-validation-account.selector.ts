import { Inject, Injectable } from '@nestjs/common'
import type { OwnerRegistry, WaOwnership } from '@smartmessage/wa'

import { PrismaWaPhoneValidationRepository } from './prisma-wa-phone-validation.repository'
import { WA_OWNER_REGISTRY, WA_REDIS_CONNECTION } from './wa.tokens'

interface RedisCursorPort {
  incr(key: string): Promise<number>
}

export interface SelectedWaValidationAccount {
  instanceId: string
  ownership: WaOwnership
}

export class WaPhoneValidationAccountUnavailableError extends Error {
  constructor(readonly teamId: string) {
    super(`No connected owned WA account is available for phone validation: ${teamId}`)
    this.name = 'WaPhoneValidationAccountUnavailableError'
  }
}

@Injectable()
export class WaPhoneValidationAccountSelector {
  constructor(
    @Inject(PrismaWaPhoneValidationRepository)
    private readonly repository: PrismaWaPhoneValidationRepository,
    @Inject(WA_REDIS_CONNECTION) private readonly redis: RedisCursorPort,
    @Inject(WA_OWNER_REGISTRY)
    private readonly ownerRegistry: Pick<OwnerRegistry, 'getOwnership'>,
  ) {}

  async select(teamId: string): Promise<SelectedWaValidationAccount> {
    const accounts = await this.repository.listEligibleAccounts(teamId)
    if (accounts.length === 0) throw new WaPhoneValidationAccountUnavailableError(teamId)

    const cursor = await this.redis.incr(`wa:validate-phone:cursor:${encodeURIComponent(teamId)}`)
    const start = positiveModulo(cursor - 1, accounts.length)
    for (let offset = 0; offset < accounts.length; offset += 1) {
      const account = accounts[(start + offset) % accounts.length]
      if (!account) continue
      const current = await this.ownerRegistry.getOwnership(account.instanceId)
      if (current?.owner === account.ownerWorkerId && current.epoch === account.ownershipEpoch) {
        return { instanceId: account.instanceId, ownership: current }
      }
    }

    throw new WaPhoneValidationAccountUnavailableError(teamId)
  }
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}
