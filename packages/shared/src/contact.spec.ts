import { describe, it, expect } from 'vitest'
import {
  ContactWaStatusSchema,
  CONTACT_WA_STATUSES,
  isSendableStatus,
  isTerminalStatus,
} from './contact'

describe('ContactWaStatus contract', () => {
  it('принимает все валидные статусы', () => {
    for (const s of CONTACT_WA_STATUSES) {
      expect(ContactWaStatusSchema.parse(s)).toBe(s)
    }
  })

  it('отклоняет невалидный статус', () => {
    expect(ContactWaStatusSchema.safeParse('banned').success).toBe(false)
  })

  it('только confirmed подлежит рассылке', () => {
    expect(isSendableStatus('confirmed')).toBe(true)
    expect(isSendableStatus('in_progress')).toBe(false)
    expect(isSendableStatus('not_on_whatsapp')).toBe(false)
    expect(isSendableStatus('error')).toBe(false)
    expect(isSendableStatus(null)).toBe(false)
  })

  it('confirmed и not_on_whatsapp терминальны, остальные — нет', () => {
    expect(isTerminalStatus('confirmed')).toBe(true)
    expect(isTerminalStatus('not_on_whatsapp')).toBe(true)
    expect(isTerminalStatus('in_progress')).toBe(false)
    expect(isTerminalStatus('error')).toBe(false)
    expect(isTerminalStatus(null)).toBe(false)
  })
})
