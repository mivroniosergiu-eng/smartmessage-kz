import { describe, it, expect } from 'vitest'
import { TIERS, getEntitlements, TierEntitlementsSchema } from './tariffs'

describe('tariffs', () => {
  it('все валидны по схеме', () => {
    for (const tier of Object.values(TIERS)) {
      expect(() => TierEntitlementsSchema.parse(tier)).not.toThrow()
    }
  })
  it('цены $200/$500/$1000', () => {
    expect(TIERS.starter.priceUsdMonthly).toBe(200)
    expect(TIERS.growth.priceUsdMonthly).toBe(500)
    expect(TIERS.scale.priceUsdMonthly).toBe(1000)
  })
  it('getEntitlements', () => expect(getEntitlements('growth').maxWhatsappAccounts).toBe(3))
  it('лимиты растут', () => expect(TIERS.starter.monthlyBroadcastMessages).toBeLessThan(TIERS.scale.monthlyBroadcastMessages))
})
