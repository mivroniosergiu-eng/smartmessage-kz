import { CONTACT_WA_STATUSES } from '@smartmessage/shared'
import type { ContactWaStatus } from '@smartmessage/shared'

export interface ValidatePhonePayload {
  instanceId: string
  phone: string
}

export interface ValidatePhoneResult {
  instanceId: string
  phone: string
  status: ContactWaStatus
}

export interface PhoneValidator {
  validate(payload: ValidatePhonePayload): Promise<ValidatePhoneResult>
}

export class WaPhoneValidationUnavailableError extends Error {
  constructor() {
    super('WA phone validator is not configured')
    this.name = 'WaPhoneValidationUnavailableError'
  }
}

export class UnavailablePhoneValidator implements PhoneValidator {
  async validate(_payload: ValidatePhonePayload): Promise<ValidatePhoneResult> {
    throw new WaPhoneValidationUnavailableError()
  }
}

export class MockPhoneValidator implements PhoneValidator {
  constructor(private readonly statusByPhone: ReadonlyMap<string, ContactWaStatus> = new Map()) {}

  async validate(payload: ValidatePhonePayload): Promise<ValidatePhoneResult> {
    const instanceId = normalizeRequiredString(payload.instanceId, 'instanceId')
    const phone = normalizeRequiredString(payload.phone, 'phone')
    return {
      instanceId,
      phone,
      status: this.statusByPhone.get(phone) ?? 'confirmed',
    }
  }
}

export function isContactWaStatus(value: string): value is ContactWaStatus {
  return CONTACT_WA_STATUSES.includes(value as ContactWaStatus)
}

function normalizeRequiredString(value: string, fieldName: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new TypeError(`${fieldName} must be a non-empty string`)
  return normalized
}
