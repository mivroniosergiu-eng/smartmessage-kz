import { describe, expect, it } from 'vitest'

import { CONTACT_WA_STATUSES } from '@smartmessage/shared'

import { MockPhoneValidator, isContactWaStatus } from './phone-validator'

describe('MockPhoneValidator', () => {
  it('returns enum-compatible WhatsApp validation statuses', async () => {
    const validator = new MockPhoneValidator(
      new Map([
        ['fixture-confirmed', 'confirmed'],
        ['fixture-not-on-whatsapp', 'not_on_whatsapp'],
        ['fixture-in-progress', 'in_progress'],
        ['fixture-error', 'error'],
      ]),
    )

    const results = await Promise.all(
      ['fixture-confirmed', 'fixture-not-on-whatsapp', 'fixture-in-progress', 'fixture-error'].map((phone) =>
        validator.validate({ phone }),
      ),
    )

    expect(new Set(results.map((result) => result.status))).toEqual(new Set(CONTACT_WA_STATUSES))
    expect(results.every((result) => isContactWaStatus(result.status))).toBe(true)
  })
})
