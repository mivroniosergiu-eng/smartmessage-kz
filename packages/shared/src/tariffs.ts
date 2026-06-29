/**
 * DRAFT / SPEC — НЕ активный код. Подключается в Фазе 0 (когда появятся pnpm и кодовая база).
 * Источник истины для квот и лимитов тарифов ($200…$1000). Привязка к teamId.
 */
export const TierEntitlementsSchema = z.object({
  tier: z.enum(['starter', 'pro', 'business']), // ориентир: $200 / $500 / $1000
  maxManagers: z.number().int(),
  monthlyBroadcastMessages: z.number().int(),
  monthlyAiGenerations: z.number().int(),
  maxWhatsappAccounts: z.number().int(),
});

export type TierEntitlements = z.infer<typeof TierEntitlementsSchema>;
