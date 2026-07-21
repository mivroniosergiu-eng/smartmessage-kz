import { describe, expect, it } from 'vitest'

import {
  VALIDATE_WA_PHONE_JOB_NAME,
  WA_PHONE_VALIDATION_OWNER_QUEUE_PREFIX,
  WA_PHONE_VALIDATION_QUEUE_NAME,
  createWaPhoneValidationJobId,
  createWaPhoneValidationOwnerJobId,
  createWaPhoneValidationOwnerQueueName,
  parseWaPhoneValidationJobPayload,
  parseWaPhoneValidationOwnerJobPayload,
} from './index'

describe('WA phone validation queue contract', () => {
  it('exports stable shared and owner-directed queue names', () => {
    expect(WA_PHONE_VALIDATION_QUEUE_NAME).toBe('validate-phone')
    expect(WA_PHONE_VALIDATION_OWNER_QUEUE_PREFIX).toBe('validate-phone-owner.')
    expect(VALIDATE_WA_PHONE_JOB_NAME).toBe('validate-wa-phone')
    expect(createWaPhoneValidationOwnerQueueName(' worker/a ')).toBe(
      'validate-phone-owner.worker%2Fa',
    )
  })

  it('normalizes the tenant-bound generic payload into one stable job per contact', () => {
    const payload = parseWaPhoneValidationJobPayload({
      contactId: ' contact.1 ',
      teamId: ' team/a ',
    })

    expect(payload).toEqual({ contactId: 'contact.1', teamId: 'team/a' })
    expect(createWaPhoneValidationJobId(payload)).toBe(
      'validate-phone.validate-wa-phone.team%2Fa.contact%2E1',
    )
  })

  it('requires an exact account, phone, and owner generation for directed work', () => {
    const payload = parseWaPhoneValidationOwnerJobPayload({
      contactId: ' contact-1 ',
      teamId: ' team-1 ',
      validationRunId: ' run-1 ',
      instanceId: ' instance-1 ',
      phone: ' +77001234567 ',
      expectedOwnerWorkerId: ' worker-1 ',
      expectedOwnerEpoch: '7',
    })

    expect(payload).toEqual({
      contactId: 'contact-1',
      teamId: 'team-1',
      validationRunId: 'run-1',
      instanceId: 'instance-1',
      phone: '+77001234567',
      expectedOwnerWorkerId: 'worker-1',
      expectedOwnerEpoch: '7',
    })
    expect(createWaPhoneValidationOwnerJobId(payload)).toBe(
      'validate-phone-owner.validate-wa-phone.team-1.contact-1.run-1.instance-1.%2B77001234567.worker-1.7',
    )
    expect(createWaPhoneValidationOwnerJobId({ ...payload, validationRunId: 'run-2' })).not.toBe(
      createWaPhoneValidationOwnerJobId(payload),
    )
  })

  it('rejects malformed generic and owner-directed payloads', () => {
    for (const payload of [null, {}, { contactId: '', teamId: 'team-1' }]) {
      expect(() => parseWaPhoneValidationJobPayload(payload)).toThrow(TypeError)
    }

    expect(() =>
      parseWaPhoneValidationOwnerJobPayload({
        contactId: 'contact-1',
        teamId: 'team-1',
        validationRunId: 'run-1',
        instanceId: 'instance-1',
        phone: '+77001234567',
        expectedOwnerWorkerId: 'worker-1',
        expectedOwnerEpoch: '0',
      }),
    ).toThrow(TypeError)
  })
})
