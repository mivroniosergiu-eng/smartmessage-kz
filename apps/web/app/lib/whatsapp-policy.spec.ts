import { describe, expect, it } from 'vitest'

import { isConfirmedWhatsappContact } from './whatsapp-policy'

describe('WhatsApp web policy', () => {
  it.each([null, 'NOT_ON_WHATSAPP', 'IN_PROGRESS', 'ERROR'])(
    'does not allow single-send for %s contacts',
    (status) => {
      expect(isConfirmedWhatsappContact(status)).toBe(false)
    },
  )

  it('allows single-send only for a confirmed contact', () => {
    expect(isConfirmedWhatsappContact('CONFIRMED')).toBe(true)
  })
})
