import type { WaAccountRuntimeStatus } from './status-repository'

export type WaQrBootstrapStatus = WaAccountRuntimeStatus | 'qr_pending'

export interface WaQrCodeInput {
  value: string
  createdAt?: Date
  expiresAt: Date
}

export interface WaQrPendingEventInput {
  instanceId: string
  qrCode: string | WaQrCode
  createdAt?: Date
  expiresAt?: Date
}

export interface WaQrPendingEvent {
  type: 'qr_pending'
  instanceId: string
  qrCode: string
  createdAt: Date
  expiresAt: Date
}

export interface WaQrBootstrapState {
  instanceId: string
  status: WaQrBootstrapStatus
  qrCode?: string
  expiresAt?: string
}

export interface WaQrBootstrapRepository {
  activateOwnership(instanceId: string, workerId: string, epoch: bigint): Promise<boolean>
  store(event: WaQrPendingEvent, workerId: string, epoch: bigint): Promise<boolean>
  getLatest(instanceId: string): Promise<WaQrPendingEvent | null>
  clear(instanceId: string, workerId: string, epoch: bigint): Promise<boolean>
}

export class WaQrCode {
  private constructor(
    readonly value: string,
    readonly createdAt: Date,
    readonly expiresAt: Date,
  ) {}

  static create(input: WaQrCodeInput): WaQrCode {
    const value = normalizeNonEmptyString(input.value, 'QR code value')
    const createdAt = cloneDate(input.createdAt ?? new Date())
    const expiresAt = cloneDate(input.expiresAt)

    if (expiresAt.getTime() <= createdAt.getTime()) {
      throw new RangeError('QR code expiresAt must be after createdAt')
    }

    return new WaQrCode(value, createdAt, expiresAt)
  }

  isExpiredAt(now: Date = new Date()): boolean {
    return now.getTime() >= this.expiresAt.getTime()
  }
}

export class InMemoryWaQrBootstrapRepository implements WaQrBootstrapRepository {
  private readonly latest = new Map<string, { event: WaQrPendingEvent; epoch: bigint }>()
  private readonly fences = new Map<string, { workerId: string; epoch: bigint }>()

  async activateOwnership(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    const normalized = normalizeNonEmptyString(instanceId, 'instanceId')
    const current = this.fences.get(normalized)
    if (
      current &&
      (current.epoch > epoch || (current.epoch === epoch && current.workerId !== workerId))
    ) {
      return false
    }
    this.fences.set(normalized, { workerId, epoch })
    if (this.latest.get(normalized)?.epoch !== epoch) this.latest.delete(normalized)
    return true
  }

  async store(event: WaQrPendingEvent, workerId: string, epoch: bigint): Promise<boolean> {
    const instanceId = normalizeNonEmptyString(event.instanceId, 'instanceId')
    if (!this.matchesFence(instanceId, workerId, epoch)) return false
    this.latest.set(instanceId, {
      event: cloneEvent({ ...event, instanceId }),
      epoch,
    })
    return true
  }

  async getLatest(instanceId: string): Promise<WaQrPendingEvent | null> {
    const event = this.latest.get(normalizeNonEmptyString(instanceId, 'instanceId'))

    return event ? cloneEvent(event.event) : null
  }

  async clear(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    const normalized = normalizeNonEmptyString(instanceId, 'instanceId')
    if (!this.matchesFence(normalized, workerId, epoch)) return false
    this.latest.delete(normalized)
    return true
  }

  private matchesFence(instanceId: string, workerId: string, epoch: bigint): boolean {
    const fence = this.fences.get(instanceId)
    return fence?.workerId === workerId && fence.epoch === epoch
  }
}

export function createWaQrPendingEvent(input: WaQrPendingEventInput): WaQrPendingEvent {
  const instanceId = normalizeNonEmptyString(input.instanceId, 'instanceId')
  const qrCode =
    input.qrCode instanceof WaQrCode
      ? input.qrCode
      : WaQrCode.create({
          value: input.qrCode,
          createdAt: input.createdAt,
          expiresAt: requireDate(input.expiresAt, 'expiresAt'),
        })

  return {
    type: 'qr_pending',
    instanceId,
    qrCode: qrCode.value,
    createdAt: cloneDate(qrCode.createdAt),
    expiresAt: cloneDate(qrCode.expiresAt),
  }
}

export function resolveWaQrBootstrapState(input: {
  instanceId: string
  accountStatus: WaAccountRuntimeStatus
  qrEvent?: WaQrPendingEvent | null
  now?: Date
}): WaQrBootstrapState {
  const instanceId = normalizeNonEmptyString(input.instanceId, 'instanceId')
  const qrEvent = input.qrEvent ?? null
  const now = input.now ?? new Date()

  if (
    input.accountStatus === 'connecting' &&
    qrEvent &&
    qrEvent.instanceId === instanceId &&
    qrEvent.expiresAt.getTime() > now.getTime()
  ) {
    return {
      instanceId,
      status: 'qr_pending',
      qrCode: qrEvent.qrCode,
      expiresAt: qrEvent.expiresAt.toISOString(),
    }
  }

  return {
    instanceId,
    status: toBootstrapStatus(input.accountStatus),
  }
}

function toBootstrapStatus(status: WaAccountRuntimeStatus): WaQrBootstrapStatus {
  return status
}

function normalizeNonEmptyString(value: string, fieldName: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`)
  }

  return normalized
}

function requireDate(value: Date | undefined, fieldName: string): Date {
  if (!value) {
    throw new TypeError(`${fieldName} is required`)
  }

  return value
}

function cloneEvent(event: WaQrPendingEvent): WaQrPendingEvent {
  return {
    ...event,
    createdAt: cloneDate(event.createdAt),
    expiresAt: cloneDate(event.expiresAt),
  }
}

function cloneDate(value: Date): Date {
  return new Date(value)
}
