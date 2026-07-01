import { CONTACT_WA_STATUSES } from '@smartmessage/shared'
import type { ContactWaStatus } from '@smartmessage/shared'

export interface ValidatePhonePayload {
  phone: string
}

export interface ValidatePhoneResult {
  phone: string
  status: ContactWaStatus
}

export interface PhoneValidator {
  validate(payload: ValidatePhonePayload): Promise<ValidatePhoneResult>
}

export class MockPhoneValidator implements PhoneValidator {
  constructor(private readonly statusByPhone: ReadonlyMap<string, ContactWaStatus> = new Map()) {}

  async validate(payload: ValidatePhonePayload): Promise<ValidatePhoneResult> {
    return {
      phone: payload.phone,
      status: this.statusByPhone.get(payload.phone) ?? 'confirmed',
    }
  }
}

export function isContactWaStatus(value: string): value is ContactWaStatus {
  return CONTACT_WA_STATUSES.includes(value as ContactWaStatus)
}
