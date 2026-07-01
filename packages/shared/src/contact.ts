import { z } from 'zod'

/**
 * Контракт статуса проверки номера через WhatsApp `onWhatsApp` (используется в Фазе 1).
 * `null` означает «ещё не проверен». Зеркалит enum `ContactWaStatus` в schema.prisma.
 */
export const CONTACT_WA_STATUSES = [
  'in_progress',
  'confirmed',
  'not_on_whatsapp',
  'error',
] as const

export const ContactWaStatusSchema = z.enum(CONTACT_WA_STATUSES)
export type ContactWaStatus = z.infer<typeof ContactWaStatusSchema>

/** Может ли контакт с данным статусом участвовать в рассылке. */
export function isSendableStatus(status: ContactWaStatus | null): boolean {
  return status === 'confirmed'
}

/** Является ли статус терминальным (повторная валидация не требуется). */
export function isTerminalStatus(status: ContactWaStatus | null): boolean {
  return status === 'confirmed' || status === 'not_on_whatsapp'
}
