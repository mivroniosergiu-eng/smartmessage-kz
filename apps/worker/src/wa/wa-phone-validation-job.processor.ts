import { Inject, Injectable } from '@nestjs/common'
import {
  VALIDATE_WA_PHONE_JOB_NAME,
  WA_PHONE_VALIDATION_OWNER_QUEUE_PREFIX,
  WA_PHONE_VALIDATION_QUEUE_NAME,
  createWaPhoneValidationOwnerQueueName,
  parseWaPhoneValidationJobPayload,
  parseWaPhoneValidationOwnerJobPayload,
} from '@smartmessage/queue'
import type { Job, WaPhoneValidationOwnerJobPayload } from '@smartmessage/queue'
import type { OwnerRegistry, PhoneValidator, WaOwnership } from '@smartmessage/wa'

import { PrismaWaPhoneValidationRepository } from './prisma-wa-phone-validation.repository'
import { WaPhoneValidationAccountSelector } from './wa-phone-validation-account.selector'
import { WaPhoneValidationQueueService } from './wa-phone-validation-queue.service'
import { WA_OWNER_REGISTRY, WA_PHONE_VALIDATOR, WA_WORKER_ID } from './wa.tokens'

const VALIDATION_TIMEOUT_MS = 10_000

export interface WaPhoneValidationJobResult {
  contactId: string
  status?: 'confirmed' | 'not_on_whatsapp'
  instanceId?: string
  phone?: string
  validationRunId?: string
  terminalSkipped?: true
  ownershipStale?: true
}

export class WaPhoneValidationOwnerUnavailableError extends Error {
  constructor(readonly contactId: string) {
    super(`WA phone validation owner is unavailable: ${contactId}`)
    this.name = 'WaPhoneValidationOwnerUnavailableError'
  }
}

export class WaPhoneValidationTimeoutError extends Error {
  constructor(readonly contactId: string) {
    super(`WA phone validation timed out: ${contactId}`)
    this.name = 'WaPhoneValidationTimeoutError'
  }
}

@Injectable()
export class WaPhoneValidationJobProcessor {
  constructor(
    @Inject(PrismaWaPhoneValidationRepository)
    private readonly repository: PrismaWaPhoneValidationRepository,
    @Inject(WaPhoneValidationAccountSelector)
    private readonly selector: WaPhoneValidationAccountSelector,
    @Inject(WaPhoneValidationQueueService)
    private readonly queueService: WaPhoneValidationQueueService,
    @Inject(WA_PHONE_VALIDATOR) private readonly validator: PhoneValidator,
    @Inject(WA_OWNER_REGISTRY)
    private readonly ownerRegistry: Pick<OwnerRegistry, 'getOwnership'>,
    @Inject(WA_WORKER_ID) private readonly workerId: string,
  ) {}

  async process(
    job: Pick<Job<unknown>, 'name' | 'data'> &
      Partial<Pick<Job<unknown>, 'id' | 'queueName' | 'attemptsMade' | 'opts' | 'timestamp'>>,
  ): Promise<WaPhoneValidationJobResult> {
    if (job.name !== VALIDATE_WA_PHONE_JOB_NAME) {
      throw new TypeError(`Unsupported WA phone validation job: ${job.name}`)
    }
    const queueName = job.queueName ?? WA_PHONE_VALIDATION_QUEUE_NAME
    if (queueName === WA_PHONE_VALIDATION_QUEUE_NAME) return this.processGeneric(job)
    if (!queueName.startsWith(WA_PHONE_VALIDATION_OWNER_QUEUE_PREFIX)) {
      throw new TypeError(`Unsupported WA phone validation queue: ${queueName}`)
    }
    return this.processOwner(job.data, queueName)
  }

  async handleFailed(
    job: Pick<Job<unknown>, 'name' | 'data' | 'attemptsMade' | 'opts'> &
      Partial<Pick<Job<unknown>, 'id' | 'queueName' | 'timestamp' | 'remove'>>,
    error: Error,
  ): Promise<void> {
    if (
      job.name !== VALIDATE_WA_PHONE_JOB_NAME ||
      (job.queueName ?? WA_PHONE_VALIDATION_QUEUE_NAME) !== WA_PHONE_VALIDATION_QUEUE_NAME ||
      (!isFailedAfterAllAttempts(job) && !/stalled/i.test(error.message))
    ) {
      return
    }

    await this.reconcileFailed(job)
  }

  async reconcileFailed(
    job: Pick<Job<unknown>, 'name' | 'data'> &
      Partial<Pick<Job<unknown>, 'id' | 'queueName' | 'timestamp' | 'remove'>>,
  ): Promise<void> {
    if (
      job.name !== VALIDATE_WA_PHONE_JOB_NAME ||
      (job.queueName ?? WA_PHONE_VALIDATION_QUEUE_NAME) !== WA_PHONE_VALIDATION_QUEUE_NAME
    ) {
      return
    }
    const payload = parseWaPhoneValidationJobPayload(job.data)
    await this.repository.markRunError(
      payload.contactId,
      payload.teamId,
      createValidationRunId(job),
    )
    await job.remove?.()
  }

  private async processGeneric(
    job: Pick<Job<unknown>, 'data'> &
      Partial<Pick<Job<unknown>, 'id' | 'attemptsMade' | 'opts' | 'timestamp'>>,
  ): Promise<WaPhoneValidationJobResult> {
    const payload = parseWaPhoneValidationJobPayload(job.data)
    const validationRunId = createValidationRunId(job)
    let preparedPhone: string | undefined
    try {
      const contact = await this.repository.prepare(
        payload.contactId,
        payload.teamId,
        validationRunId,
      )
      preparedPhone = contact.phone
      if (contact.terminalStatus) {
        return {
          contactId: contact.contactId,
          status: contact.terminalStatus,
          terminalSkipped: true,
        }
      }

      const selected = await this.selector.select(contact.teamId)
      const ownerPayload: WaPhoneValidationOwnerJobPayload = {
        contactId: contact.contactId,
        teamId: contact.teamId,
        validationRunId: contact.validationRunId,
        instanceId: selected.instanceId,
        phone: contact.phone,
        expectedOwnerWorkerId: selected.ownership.owner,
        expectedOwnerEpoch: selected.ownership.epoch.toString(),
      }
      const result = parseOwnerResult(
        contact.contactId,
        contact.phone,
        selected.instanceId,
        ownerPayload.validationRunId,
        await this.queueService.enqueueForOwner(ownerPayload),
      )
      if (result.ownershipStale) {
        throw new WaPhoneValidationOwnerUnavailableError(contact.contactId)
      }
      await this.repository.complete(
        contact.contactId,
        contact.teamId,
        contact.phone,
        contact.validationRunId,
        result.status,
      )
      return {
        contactId: contact.contactId,
        instanceId: result.instanceId,
        phone: result.phone,
        status: result.status,
      }
    } catch (error: unknown) {
      if (isFinalAttempt(job) && preparedPhone) {
        await this.repository.markError(
          payload.contactId,
          payload.teamId,
          preparedPhone,
          validationRunId,
        )
      }
      throw error
    }
  }

  private async processOwner(
    rawPayload: unknown,
    queueName: string,
  ): Promise<WaPhoneValidationJobResult> {
    const payload = parseWaPhoneValidationOwnerJobPayload(rawPayload)
    const expectedQueue = createWaPhoneValidationOwnerQueueName(payload.expectedOwnerWorkerId)
    if (queueName !== expectedQueue || this.workerId !== payload.expectedOwnerWorkerId) {
      throw new TypeError(`WA phone validation owner job is on the wrong queue: ${queueName}`)
    }

    const expectedOwnership: WaOwnership = {
      owner: payload.expectedOwnerWorkerId,
      epoch: BigInt(payload.expectedOwnerEpoch),
    }
    const current = await this.ownerRegistry.getOwnership(payload.instanceId)
    if (!sameOwnership(current, expectedOwnership)) {
      return {
        contactId: payload.contactId,
        instanceId: payload.instanceId,
        phone: payload.phone,
        validationRunId: payload.validationRunId,
        ownershipStale: true,
      }
    }

    await this.repository.assertOwnerTarget(payload)
    const result = await completeWithin(
      this.validator.validate({ instanceId: payload.instanceId, phone: payload.phone }),
      VALIDATION_TIMEOUT_MS,
      payload.contactId,
    )
    if (
      result.instanceId !== payload.instanceId ||
      result.phone !== payload.phone ||
      !isTerminalValidationStatus(result.status)
    ) {
      throw new TypeError(`Invalid WA phone validation result: ${payload.contactId}`)
    }

    const ownershipAfterValidation = await this.ownerRegistry.getOwnership(payload.instanceId)
    if (!sameOwnership(ownershipAfterValidation, expectedOwnership)) {
      return {
        contactId: payload.contactId,
        instanceId: payload.instanceId,
        phone: payload.phone,
        validationRunId: payload.validationRunId,
        ownershipStale: true,
      }
    }
    await this.repository.assertOwnerTarget(payload)

    return {
      contactId: payload.contactId,
      instanceId: payload.instanceId,
      phone: payload.phone,
      validationRunId: payload.validationRunId,
      status: result.status,
    }
  }
}

function parseOwnerResult(
  contactId: string,
  phone: string,
  instanceId: string,
  validationRunId: string,
  value: unknown,
): {
  instanceId: string
  phone: string
  status: 'confirmed' | 'not_on_whatsapp'
  ownershipStale?: true
} {
  if (
    !isRecord(value) ||
    value.contactId !== contactId ||
    value.instanceId !== instanceId ||
    value.phone !== phone ||
    value.validationRunId !== validationRunId
  ) {
    throw new TypeError(`Invalid WA phone validation owner result: ${contactId}`)
  }
  if (value.ownershipStale === true) {
    return { instanceId, phone, status: 'confirmed', ownershipStale: true }
  }
  if (!isTerminalValidationStatus(value.status)) {
    throw new TypeError(`Invalid WA phone validation owner result: ${contactId}`)
  }
  return { instanceId, phone, status: value.status }
}

function isFinalAttempt(job: Partial<Pick<Job<unknown>, 'attemptsMade' | 'opts'>>): boolean {
  const attempts = job.opts?.attempts
  return typeof attempts === 'number' && (job.attemptsMade ?? 0) + 1 >= attempts
}

function isFailedAfterAllAttempts(job: Pick<Job<unknown>, 'attemptsMade' | 'opts'>): boolean {
  const attempts = job.opts.attempts
  return typeof attempts === 'number' && job.attemptsMade >= attempts
}

function createValidationRunId(job: Partial<Pick<Job<unknown>, 'id' | 'timestamp'>>): string {
  const id = job.id?.trim()
  if (!id || !Number.isSafeInteger(job.timestamp) || (job.timestamp ?? -1) < 0) {
    throw new TypeError('Generic WA phone validation job requires stable id and timestamp')
  }
  return `${id}@${String(job.timestamp)}`
}

function isTerminalValidationStatus(status: unknown): status is 'confirmed' | 'not_on_whatsapp' {
  return status === 'confirmed' || status === 'not_on_whatsapp'
}

function sameOwnership(current: WaOwnership | null, expected: WaOwnership): boolean {
  return current?.owner === expected.owner && current.epoch === expected.epoch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function completeWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
  contactId: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new WaPhoneValidationTimeoutError(contactId)), timeoutMs)
    timeout.unref?.()
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
