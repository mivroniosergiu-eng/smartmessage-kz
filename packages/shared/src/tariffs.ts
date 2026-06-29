import { z } from 'zod'

/** Источник истины для квот и лимитов тарифов ($200…$1000). Активный код (Фаза 0). */
export const TierEntitlementsSchema = z.object({
  tier: z.enum(['starter', 'growth', 'scale']),
  priceUsdMonthly: z.number().int().positive(),
  monthlyBroadcastMessages: z.number().int().nonnegative(),
  monthlyAiGenerations: z.number().int().nonnegative(),
  maxWhatsappAccounts: z.number().int().positive(),
})

export type TierEntitlements = z.infer<typeof TierEntitlementsSchema>
export type Tier = TierEntitlements['tier']

/** Конкретные тарифы: $200 / $500 / $1000 в месяц. */
export const TIERS: Record<Tier, TierEntitlements> = {
  starter: { tier: 'starter', priceUsdMonthly: 200, monthlyBroadcastMessages: 10000, monthlyAiGenerations: 500, maxWhatsappAccounts: 1 },
  growth: { tier: 'growth', priceUsdMonthly: 500, monthlyBroadcastMessages: 50000, monthlyAiGenerations: 2500, maxWhatsappAccounts: 3 },
  scale: { tier: 'scale', priceUsdMonthly: 1000, monthlyBroadcastMessages: 150000, monthlyAiGenerations: 10000, maxWhatsappAccounts: 10 },
}

/** Возвращает лимиты тарифа, валидируя схемой (защита от рассинхрона). */
export function getEntitlements(tier: Tier): TierEntitlements {
  return TierEntitlementsSchema.parse(TIERS[tier])
}
